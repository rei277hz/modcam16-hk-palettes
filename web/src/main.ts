import "./style.css";

const FULL_RESOLUTION = 512;
const PREVIEW_RESOLUTION = 64;
type RenderResolution = "preview" | "full";
type PendingRenderRequest = { id: number; resolution: RenderResolution };
// Keep rendering parallel without creating an unbounded number of WASM instances.
const WORKER_COUNT = Math.max(1, Math.min(16, navigator.hardwareConcurrency || 2));

type RenderResponse = {
  kind: "render";
  id: number;
  profile: number;
  width: number;
  height: number;
  yStart: number;
  pixels: Uint8Array;
};
type RenderCancelledResponse = {
  kind: "render-cancelled";
  id: number;
  profile: number;
  width: number;
  height: number;
  yStart: number;
};
type EvaluateResponse = {
  kind: "evaluate";
  id: number;
  profile: number;
  temp: number;
  tint: number;
  background: number;
  values: Float64Array;
};
type ColorCheckerResponse = { kind: "colorchecker"; id: number; profile: number; temp: number; tint: number; points: Float64Array };
type SetResponse = { kind: "set"; id: number; profile: number; temp: number; tint: number; values: Float64Array };
type ProfileConvertResponse = {
  kind: "profile-convert";
  id: number;
  profile: number;
  temp: number;
  tint: number;
  sourceBackground: number;
  values: Float64Array;
  background: number;
  backgroundPreserved: boolean;
};

const COLORCHECKER_NAMES = [
  "Dark Skin", "Light Skin", "Blue Sky", "Foliage", "Blue Flower", "Bluish Green",
  "Orange", "Purplish Blue", "Moderate Red", "Purple", "Yellow Green", "Orange Yellow",
  "Blue", "Green", "Red", "Yellow", "Magenta", "Cyan",
] as const;

type ColorCheckerPoint = {
  name: string;
  hue: number;
  saturation: number;
  reflectance: number;
  display: [number, number, number];
  available: boolean;
  adaptedHue: number;
  adaptedSaturation: number;
};

const HUE_SNAP_DISTANCE = 2;
const HUE_SNAP_RELEASE_DISTANCE = 2.5;
const REFLECTANCE_SNAP_DISTANCE = 0.02;
const SATURATION_SNAP_DISTANCE = 2;
const BACKGROUND_SNAP_DISTANCE_RATIO = 0.02;
const COLORCHECKER_DOT_RADIUS = 3;
const REFLECTANCE_MAX = 1.2;
const REFLECTANCE_SLIDER_MAX = 1;
const SATURATION_MAX = 100;
const SATURATION_TRANSFER_SCALE = 50;
const SATURATION_SLIDER_MAX = 1;
const BACKGROUND_MAX = 1.2;
const BACKGROUND_SLIDER_MAX = 1;
const TEMPERATURE_MIN = 2000;
const TEMPERATURE_MAX = 20000;
const TEMPERATURE_DEFAULT = 6500;
const TEMPERATURE_MIREDS_MIN = 1_000_000 / TEMPERATURE_MAX;
const TEMPERATURE_MIREDS_MAX = 1_000_000 / TEMPERATURE_MIN;
const TEMPERATURE_DEFAULT_MIREDS = 1_000_000 / TEMPERATURE_DEFAULT;
const TEMPERATURE_SNAP_DISTANCE = 500;
const TEMPERATURE_SLIDER_DISPLAY_STEP = 50;
const TINT_MIN = -100;
const TINT_MAX = 100;
const TINT_DEFAULT = 0;
// A square-root presentation curve gives the small, useful tint values more
// physical slider travel while retaining the full +/-100 range at the ends.
const TINT_PRESENTATION_EXPONENT = 0.5;
const TINT_SNAP_DISTANCE = 0.5;

const reflectance = document.querySelector<HTMLInputElement>("#reflectance")!;
const hue = document.querySelector<HTMLInputElement>("#hue")!;
const saturation = document.querySelector<HTMLInputElement>("#saturation")!;
const reflectanceNumber = document.querySelector<HTMLInputElement>("#reflectance-number")!;
const hueNumber = document.querySelector<HTMLInputElement>("#hue-number")!;
const saturationNumber = document.querySelector<HTMLInputElement>("#saturation-number")!;
const temperature = document.querySelector<HTMLInputElement>("#temperature")!;
const temperatureNumber = document.querySelector<HTMLInputElement>("#temperature-number")!;
const temperatureStick = document.querySelector<HTMLElement>("#temperature-stick")!;
const tint = document.querySelector<HTMLInputElement>("#tint")!;
const tintNumber = document.querySelector<HTMLInputElement>("#tint-number")!;
const tintStick = document.querySelector<HTMLElement>("#tint-stick")!;
const whiteBalanceReset = document.querySelector<HTMLButtonElement>("#white-balance-reset")!;
const profileSelect = document.querySelector<HTMLSelectElement>("#profile")!;
const hueStickContainer = document.querySelector<HTMLElement>("#hue-sticks")!;
const reflectanceStick = document.querySelector<HTMLElement>("#reflectance-stick")!;
const saturationStick = document.querySelector<HTMLElement>("#saturation-stick")!;
const colorcheckerName = document.querySelector<HTMLElement>("#colorchecker-name")!;
const canvas = document.querySelector<HTMLCanvasElement>("#gamut-slice")!;
const context = canvas.getContext("2d", { alpha: true, colorSpace: "display-p3" })!;
let displayP3Canvas = context.getContextAttributes().colorSpace === "display-p3";
let displayP3Css = false;
try {
  displayP3Css = typeof CSS !== "undefined"
    && typeof CSS.supports === "function"
    && CSS.supports("background-color", "color(display-p3 1 0 0)");
} catch {
  displayP3Css = false;
}
const preview = document.querySelector<HTMLElement>("#preview")!;
const previewSurround = document.querySelector<HTMLElement>("#preview-surround")!;
const backgroundBrightness = document.querySelector<HTMLInputElement>("#background-brightness")!;
const backgroundBrightnessValue = document.querySelector<HTMLElement>("#background-brightness-value")!;
const backgroundStick = document.querySelector<HTMLElement>("#background-stick")!;
const rgbLabel = document.querySelector<HTMLElement>("#rgb-label")!;
const encodedLabel = document.querySelector<HTMLElement>("#encoded-label")!;
const acescgValue = document.querySelector<HTMLElement>("#acescg-value")!;
const acescgEncodedValue = document.querySelector<HTMLInputElement>("#acescg-encoded-value")!;
const acescgCopy = document.querySelector<HTMLButtonElement>("#acescg-copy")!;
const acescgSet = document.querySelector<HTMLButtonElement>("#acescg-set")!;
const appFooter = document.querySelector<HTMLElement>(".app-footer")!;

const PROFILE_DETAILS = [
  {
    source: "Rec.2020 (P3-D65 limited)",
    transform: "ACES 2.0 - HDR 1000 nits (Rec.2020)",
  },
  {
    source: "Rec.709",
    transform: "ACES 2.0 - SDR 100 nits (Rec.709)",
  },
  {
    source: "P3-D65",
    transform: "ACES 2.0 - HDR 1000 nits (P3 D65)",
  },
  {
    source: "Rec.709",
    transform: "No view transform",
  },
  {
    source: "P3-D65",
    transform: "ACES 2.0 - SDR 100 nits (P3 D65)",
  },
] as const;

const workers = Array.from({ length: WORKER_COUNT }, () =>
  new Worker(new URL("./render_worker.ts", import.meta.url), { type: "module" }),
);
let image: ImageData;
try {
  image = new ImageData(FULL_RESOLUTION, FULL_RESOLUTION, { colorSpace: displayP3Canvas ? "display-p3" : "srgb" });
} catch {
  // Older browsers may expose a 2D canvas but reject ImageData colorSpace.
  displayP3Canvas = false;
  try {
    image = new ImageData(FULL_RESOLUTION, FULL_RESOLUTION, { colorSpace: "srgb" });
  } catch {
    image = new ImageData(FULL_RESOLUTION, FULL_RESOLUTION);
  }
}
let imageDisplayP3 = displayP3Canvas;
let generation = 0;
let pendingRows = 0;
let neutralDisplay: [number, number, number] = [0.5, 0.5, 0.5];
let adaptedNeutralHue = 0;
let adaptedNeutralSaturation = 0;
let adaptedHue = 0;
let adaptedSaturation = 0;
let colorcheckerPoints: ColorCheckerPoint[] = [];
// The initial controls are the direct-sRGB Dark Skin reference. Keep its
// identity selected from the first ColorChecker response so the patch name is
// visible at startup and is refreshed with each profile's point data.
let snappedPatchIndex: number | null = 0;
const hueStickElements: HTMLElement[] = [];
let frameQueued = false;
let renderError = false;
// Gamut slices depend on profile, reflectance, white-balance state, and output
// color space.
// Keep the current slice so Hue/Sat edits can redraw indicators without
// asking the workers to regenerate the background.
let cachedRenderKey: string | undefined;
let cachedRenderPixels: Uint8ClampedArray | undefined;
let activeRenderId = -1;
let activeRenderKey = "";
let activeRenderPixels: Uint8ClampedArray | undefined;
let activeRenderResolution: RenderResolution = "full";
let activeRenderWidth = FULL_RESOLUTION;
let activeRenderHeight = FULL_RESOLUTION;
let pendingRenderRequest: PendingRenderRequest | undefined;
let latestSetRequest = 0;
let latestProfileConversion = 0;
let sliderProfile = Number(profileSelect.value);
let profileConversionPending = false;
// Keep the 50 K presentation after a slider edit, even when the range loses
// focus before the next label refresh. Direct numeric entry switches back to
// the exact integer Kelvin presentation.
let temperatureReadoutUsesSliderStep = true;
let backgroundSnapValue: number | null = null;
let retainedOutputSrgbEncoded: [number, number, number] = [
  encodeDisplayChannel(0.5),
  encodeDisplayChannel(0.5),
  encodeDisplayChannel(0.5),
];
let retainedAcescgEncoded: [number, number, number] = [
  encodeDisplayChannel(0.5),
  encodeDisplayChannel(0.5),
  encodeDisplayChannel(0.5),
];
let displayedResolution: RenderResolution = "full";
let queuedRenderResolution: RenderResolution = "full";

for (const patch of COLORCHECKER_NAMES) {
  const marker = document.createElement("span");
  marker.className = "hue-stick";
  marker.title = patch;
  hueStickContainer.append(marker);
  hueStickElements.push(marker);
}

function currentState() {
  return {
    reflectance: reflectanceValueFromSlider(),
    hue: Number(hue.value),
    saturation: saturationValueFromSlider(),
  };
}

function displayState() {
  return { temp: temperatureValueFromSlider(), tint: tintValueFromSlider() };
}

function formatTemperature(value: number, sliderPresentation = false): string {
  const finite = Number.isFinite(value) ? value : TEMPERATURE_DEFAULT;
  const rounded = sliderPresentation
    ? Math.round(finite / TEMPERATURE_SLIDER_DISPLAY_STEP) * TEMPERATURE_SLIDER_DISPLAY_STEP
    : Math.round(finite);
  return Math.max(TEMPERATURE_MIN, Math.min(TEMPERATURE_MAX, rounded)).toString();
}

function formatTint(value: number): string {
  const finite = Number.isFinite(value) ? value : TINT_DEFAULT;
  return Math.max(TINT_MIN, Math.min(TINT_MAX, Math.round(finite))).toString();
}

function currentProfile(): number {
  const profile = Number(profileSelect.value);
  return Number.isInteger(profile) && profile >= 0 && profile < PROFILE_DETAILS.length ? profile : 3;
}

function profileUsesDisplayP3(profile: number): boolean {
  return profile !== 1 && profile !== 3 && displayP3Canvas;
}

function renderKey(profile: number, reflectanceValue: number, useDisplayP3: boolean): string {
  const display = displayState();
  return `${profile}|${reflectanceValue}|${display.temp}|${display.tint}|${useDisplayP3 ? "p3" : "srgb"}`;
}

function ensureImage(width: number, height: number, useDisplayP3: boolean) {
  if (image.width === width && image.height === height && imageDisplayP3 === useDisplayP3) return;
  try {
    image = new ImageData(width, height, { colorSpace: useDisplayP3 ? "display-p3" : "srgb" });
    imageDisplayP3 = useDisplayP3;
  } catch {
    // Keep the browser's default (sRGB) image data when explicit color-space
    // ImageData is unavailable.
    image = new ImageData(width, height);
    imageDisplayP3 = false;
    displayP3Canvas = false;
  }
}

function resolutionSize(resolution: RenderResolution): number {
  return resolution === "preview" ? PREVIEW_RESOLUTION : FULL_RESOLUTION;
}

function ensureRenderSurface(resolution: RenderResolution, useDisplayP3: boolean) {
  const size = resolutionSize(resolution);
  displayedResolution = resolution;
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  ensureImage(size, size, useDisplayP3);
}

function prepareRenderSurface(resolution: RenderResolution, useDisplayP3: boolean) {
  ensureImage(resolutionSize(resolution), resolutionSize(resolution), useDisplayP3);
}

function updateProfileFooter() {
  const details = PROFILE_DETAILS[currentProfile()];
  appFooter.textContent = currentProfile() === 3
    ? "* The Linear Rec.709 (sRGB) value is directly picked by the Refl, Hue, and Sat sliders."
    : `* The ACEScg value and ColorChecker dots go through the same ${details.transform} transform. Adjusting Refl, Hue, and Sat picks the post-transform color.`;
}

function updateLabels() {
  const state = currentState();
  const directSrgb = currentProfile() === 3;
  const display = displayState();
  rgbLabel.innerHTML = directSrgb ? "Linear Rec.709 (sRGB)<sup>*</sup>" : "ACEScg<sup>*</sup>";
  encodedLabel.textContent = directSrgb ? "sRGB Encoded Rec.709 (sRGB)" : "sRGB Encoded AP1";
  acescgEncodedValue.setAttribute(
    "aria-label",
    directSrgb ? "Six sRGB Encoded Rec.709 (sRGB) hex digits" : "Six sRGB Encoded ACEScg AP1 hex digits",
  );
  // Keep an actively edited field intact, including an empty/intermediate
  // value, so slider updates cannot prevent deletion or decimal entry.
  if (document.activeElement !== reflectanceNumber) reflectanceNumber.value = state.reflectance.toFixed(3);
  if (document.activeElement !== hueNumber) hueNumber.value = state.hue.toFixed(3);
  if (document.activeElement !== saturationNumber) saturationNumber.value = state.saturation.toFixed(3);
  if (document.activeElement !== temperatureNumber) {
    temperatureNumber.value = formatTemperature(display.temp, temperatureReadoutUsesSliderStep);
  }
  if (document.activeElement !== tintNumber) tintNumber.value = formatTint(display.tint);
  temperature.setAttribute("aria-valuenow", formatTemperature(display.temp, temperatureReadoutUsesSliderStep));
  temperature.setAttribute("aria-valuetext", `${formatTemperature(display.temp, temperatureReadoutUsesSliderStep)} K`);
  tint.setAttribute("aria-valuenow", formatTint(display.tint));
  tint.setAttribute("aria-valuetext", formatTint(display.tint));
  whiteBalanceReset.disabled = display.temp === TEMPERATURE_DEFAULT && display.tint === TINT_DEFAULT;
}

function hueDistance(first: number, second: number): number {
  const distance = Math.abs(first - second) % 360;
  return Math.min(distance, 360 - distance);
}

function updateStickMarkers() {
  const patch = snappedPatchIndex === null ? undefined : colorcheckerPoints[snappedPatchIndex];
  hueStickElements.forEach((marker, index) => marker.classList.toggle("active", index === snappedPatchIndex));
  if (!patch) {
    reflectanceStick.hidden = true;
    saturationStick.hidden = true;
    colorcheckerName.hidden = true;
    colorcheckerName.textContent = "";
    return;
  }
  reflectanceStick.hidden = false;
  saturationStick.hidden = false;
  colorcheckerName.hidden = false;
  colorcheckerName.textContent = patch.name;
  reflectanceStick.style.left = `${reflectanceSliderPosition(patch.reflectance) * 100}%`;
  saturationStick.style.left = `${saturationSliderPosition(patch.saturation) * 100}%`;
}

function snapHueInput() {
  if (colorcheckerPoints.length === 0) return;
  const rawHue = Number(hue.value);
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  colorcheckerPoints.forEach((patch, index) => {
    const distance = hueDistance(rawHue, patch.hue);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  const releaseDistance = nearest === snappedPatchIndex
    ? HUE_SNAP_RELEASE_DISTANCE
    : HUE_SNAP_DISTANCE;
  if (nearest >= 0 && nearestDistance <= releaseDistance) {
    snappedPatchIndex = nearest;
    hue.value = colorcheckerPoints[nearest].hue.toFixed(3);
  } else {
    snappedPatchIndex = null;
  }
  updateStickMarkers();
}

function ensureHuePatchSelection() {
  if (snappedPatchIndex === null) snapHueInput();
}

function snapReflectanceInput() {
  ensureHuePatchSelection();
  if (snappedPatchIndex === null) return;
  const patch = colorcheckerPoints[snappedPatchIndex];
  if (Math.abs(reflectanceValueFromSlider() - patch.reflectance) <= REFLECTANCE_SNAP_DISTANCE) {
    setReflectanceValue(Number(patch.reflectance.toFixed(3)));
  }
  updateStickMarkers();
}

function snapSaturationInput() {
  ensureHuePatchSelection();
  if (snappedPatchIndex === null) return;
  const patch = colorcheckerPoints[snappedPatchIndex];
  if (Math.abs(saturationValueFromSlider() - patch.saturation) <= SATURATION_SNAP_DISTANCE) {
    setSaturationValue(Number(patch.saturation.toFixed(3)));
  }
  updateStickMarkers();
}

function applyNumberInput(
  input: HTMLInputElement,
  minimum: number,
  maximum: number,
  setValue: (value: number) => void,
  getValue: () => number,
  snap: () => void,
  normalize: boolean,
) {
  const raw = input.value.trim();
  if (raw.length === 0) return;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return;
  }
  setValue(Math.max(minimum, Math.min(maximum, parsed)));
  snap();
  if (normalize) input.value = getValue().toString();
  scheduleUpdate();
}

function cssDisplayColor(
  rgb: [number, number, number] | number[],
  useDisplayP3 = profileUsesDisplayP3(currentProfile()),
): string {
  const values = rgb.map((value) => Math.max(0, Math.min(1, value)));
  if (useDisplayP3) {
    return `color(display-p3 ${values[0]} ${values[1]} ${values[2]})`;
  }
  return `rgb(${values.map((value) => Math.round(value * 255)).join(" ")})`;
}

function setElementColor(
  element: HTMLElement,
  rgb: [number, number, number] | number[],
  useDisplayP3 = profileUsesDisplayP3(currentProfile()),
  fallbackRgb: [number, number, number] | number[] = rgb,
) {
  const values = rgb.map((value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
  const fallback = fallbackRgb.map((value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
  // Keep an sRGB declaration as a fallback. Some browsers expose a Display-P3
  // canvas while still rejecting CSS `color(display-p3 ...)`; assigning the
  // fallback first prevents the surround/preview from becoming transparent.
  element.style.backgroundColor = `rgb(${fallback.map((value) => Math.round(value * 255)).join(" ")})`;
  const p3 = `color(display-p3 ${values[0]} ${values[1]} ${values[2]})`;
  if (useDisplayP3 && displayP3Css) {
    element.style.backgroundColor = p3;
  }
}

function formatRgb(values: ArrayLike<number>): string {
  return `(${Array.from(values, (value) => Number.isFinite(value) ? value.toFixed(3) : "nan").join(", ")})`;
}

function formatEncodedHex(values: ArrayLike<number>): string {
  const bytes = Array.from(values, (value) => Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(1, value)) * 255)
    : 0);
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function encodeSrgbTransferExtended(value: number): number {
  const linear = Math.max(0, value);
  return linear <= 0.0031308
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function decodeSrgbTransferExtended(value: number): number {
  const encoded = Math.max(0, value);
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function encodeDisplayChannel(value: number): number {
  return encodeSrgbTransferExtended(Math.max(0, Math.min(1, value)));
}

function decodeDisplayChannel(value: number): number {
  return decodeSrgbTransferExtended(Math.max(0, Math.min(1, value)));
}

function reflectanceSliderPosition(value: number): number {
  const clamped = Math.max(0, Math.min(REFLECTANCE_MAX, value));
  return encodeSrgbTransferExtended(clamped) / encodeSrgbTransferExtended(REFLECTANCE_MAX);
}

function reflectanceValueFromSlider(): number {
  const position = Math.max(0, Math.min(REFLECTANCE_SLIDER_MAX, Number(reflectance.value)));
  return decodeSrgbTransferExtended(position * encodeSrgbTransferExtended(REFLECTANCE_MAX));
}

function setReflectanceValue(value: number) {
  reflectance.value = reflectanceSliderPosition(value).toString();
}

function saturationSliderPosition(value: number): number {
  const clamped = Math.max(0, Math.min(SATURATION_MAX, value));
  const transferMaximum = SATURATION_MAX / SATURATION_TRANSFER_SCALE;
  return encodeSrgbTransferExtended(clamped / SATURATION_TRANSFER_SCALE)
    / encodeSrgbTransferExtended(transferMaximum);
}

function saturationValueFromSlider(): number {
  const position = Math.max(0, Math.min(SATURATION_SLIDER_MAX, Number(saturation.value)));
  const transferMaximum = SATURATION_MAX / SATURATION_TRANSFER_SCALE;
  return decodeSrgbTransferExtended(position * encodeSrgbTransferExtended(transferMaximum))
    * SATURATION_TRANSFER_SCALE;
}

function setSaturationValue(value: number) {
  saturation.value = saturationSliderPosition(value).toString();
}

function temperatureSliderPosition(value: number): number {
  const clamped = Math.max(TEMPERATURE_MIN, Math.min(TEMPERATURE_MAX, value));
  // Correlated colour temperature is much closer to linear in reciprocal
  // temperature (mireds) than in kelvins. Normalize the two mired spans
  // independently around D65 so 6500 K is the visual midpoint while warm and
  // cool excursions get equal slider travel and response.
  const mireds = 1_000_000 / clamped;
  if (mireds >= TEMPERATURE_DEFAULT_MIREDS) {
    return 0.5 * (1 - (mireds - TEMPERATURE_DEFAULT_MIREDS)
      / (TEMPERATURE_MIREDS_MAX - TEMPERATURE_DEFAULT_MIREDS));
  }
  return 0.5 + 0.5 * (TEMPERATURE_DEFAULT_MIREDS - mireds)
    / (TEMPERATURE_DEFAULT_MIREDS - TEMPERATURE_MIREDS_MIN);
}

function temperatureValueFromSlider(): number {
  const position = Math.max(0, Math.min(1, Number(temperature.value)));
  const mireds = position <= 0.5
    ? TEMPERATURE_DEFAULT_MIREDS
      + (1 - position * 2) * (TEMPERATURE_MIREDS_MAX - TEMPERATURE_DEFAULT_MIREDS)
    : TEMPERATURE_DEFAULT_MIREDS
      - (position * 2 - 1) * (TEMPERATURE_DEFAULT_MIREDS - TEMPERATURE_MIREDS_MIN);
  return Math.round(Math.max(TEMPERATURE_MIN, Math.min(TEMPERATURE_MAX, 1_000_000 / mireds)));
}

function setTemperatureValue(value: number) {
  temperature.value = temperatureSliderPosition(Math.round(value)).toString();
}

function tintSliderPosition(value: number): number {
  const clamped = Math.max(TINT_MIN, Math.min(TINT_MAX, value));
  const centered = clamped / TINT_MAX;
  const curved = Math.sign(centered) * Math.abs(centered) ** TINT_PRESENTATION_EXPONENT;
  return 0.5 + 0.5 * curved;
}

function tintValueFromSlider(): number {
  const position = Math.max(0, Math.min(1, Number(tint.value)));
  const centered = position * 2 - 1;
  const value = Math.sign(centered)
    * Math.abs(centered) ** (1 / TINT_PRESENTATION_EXPONENT)
    * TINT_MAX;
  return Math.max(TINT_MIN, Math.min(TINT_MAX, value));
}

function setTintValue(value: number) {
  tint.value = tintSliderPosition(Math.max(TINT_MIN, Math.min(TINT_MAX, value))).toString();
}

function updateDisplaySnapMarkers() {
  temperatureStick.style.left = `${temperatureSliderPosition(TEMPERATURE_DEFAULT) * 100}%`;
  tintStick.style.left = `${tintSliderPosition(TINT_DEFAULT) * 100}%`;
}

function snapTemperatureInput() {
  if (Math.abs(temperatureValueFromSlider() - TEMPERATURE_DEFAULT) <= TEMPERATURE_SNAP_DISTANCE) {
    setTemperatureValue(TEMPERATURE_DEFAULT);
  }
}

function snapTintInput() {
  if (Math.abs(tintValueFromSlider() - TINT_DEFAULT) <= TINT_SNAP_DISTANCE) {
    setTintValue(TINT_DEFAULT);
  }
}

function backgroundSliderPosition(value: number): number {
  return encodeDisplayChannel(Math.max(0, Math.min(BACKGROUND_MAX, value)) / BACKGROUND_MAX);
}

function backgroundValueFromSlider(): number {
  return decodeDisplayChannel(Number(backgroundBrightness.value)) * BACKGROUND_MAX;
}

function updateBackgroundSnap(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > BACKGROUND_MAX) {
    backgroundSnapValue = null;
    backgroundStick.hidden = true;
    return;
  }
  backgroundSnapValue = value;
  backgroundStick.hidden = false;
  backgroundStick.style.left = `${backgroundSliderPosition(value) * 100}%`;
}

function snapBackgroundInput() {
  if (backgroundSnapValue === null) return;
  const snapDistance = BACKGROUND_SNAP_DISTANCE_RATIO * BACKGROUND_MAX;
  if (Math.abs(backgroundValueFromSlider() - backgroundSnapValue) <= snapDistance) {
    backgroundBrightness.value = backgroundSliderPosition(backgroundSnapValue).toString();
  }
}

function updateBackground() {
  const value = Math.max(0, Math.min(BACKGROUND_MAX, backgroundValueFromSlider()));
  backgroundBrightnessValue.textContent = value.toFixed(3);
  const encoded = encodeDisplayChannel(value);
  setElementColor(previewSurround, [encoded, encoded, encoded]);
}

function updatePreview(values: Float64Array) {
  const valid = values[0] > 0.5;
  const directSrgb = currentProfile() === 3;
  const useDisplayP3 = profileUsesDisplayP3(currentProfile());
  const displayOffset = useDisplayP3 ? 8 : 14;
  const neutralOffset = useDisplayP3 ? 11 : 17;
  neutralDisplay = [values[neutralOffset], values[neutralOffset + 1], values[neutralOffset + 2]].map((value) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
  ) as [number, number, number];
  if (directSrgb) {
    const outputSrgbLinear = [values[2], values[3], values[4]];
    const outputSrgbEncoded = [values[14], values[15], values[16]];
    acescgValue.textContent = formatRgb(outputSrgbLinear);
    if (document.activeElement !== acescgEncodedValue) {
      acescgEncodedValue.value = formatEncodedHex(outputSrgbEncoded);
    }
    if (values.length >= 33) {
      const retained = [values[30], values[31], values[32]];
      if (retained.every(Number.isFinite)) retainedOutputSrgbEncoded = retained as [number, number, number];
    }
  } else {
    const acescgLinear = [values[2], values[3], values[4]];
    const acescgEncoded = [values[20], values[21], values[22]];
    acescgValue.textContent = formatRgb(acescgLinear);
    if (document.activeElement !== acescgEncodedValue) {
      acescgEncodedValue.value = formatEncodedHex(acescgEncoded);
    }
    // Keep the finite pre-adaptation color for profile switches even when the
    // adapted display sample is unavailable; the retained channel is never a
    // fallback/zero value in that case.
    if (values.length >= 33) {
      const retained = [values[30], values[31], values[32]];
      if (retained.every(Number.isFinite)) retainedAcescgEncoded = retained as [number, number, number];
    }
  }
  updateBackgroundSnap(values[23]);
  if (values.length >= 37) {
    adaptedNeutralHue = Number.isFinite(values[33]) ? values[33] : 0;
    adaptedNeutralSaturation = Number.isFinite(values[34]) ? values[34] : 0;
    adaptedHue = Number.isFinite(values[35]) ? values[35] : 0;
    adaptedSaturation = Number.isFinite(values[36]) ? values[36] : 0;
  } else {
    adaptedNeutralHue = 0;
    adaptedNeutralSaturation = 0;
    adaptedHue = currentState().hue;
    adaptedSaturation = currentState().saturation;
  }
  const backgroundOffset = useDisplayP3 ? 24 : 27;
  const background = [values[backgroundOffset], values[backgroundOffset + 1], values[backgroundOffset + 2]];
  const backgroundSrgb = [values[27], values[28], values[29]];
  if (background.every(Number.isFinite) && backgroundSrgb.every(Number.isFinite)) {
    const value = Math.max(0, Math.min(BACKGROUND_MAX, backgroundValueFromSlider()));
    backgroundBrightnessValue.textContent = value.toFixed(3);
    setElementColor(previewSurround, background, useDisplayP3, backgroundSrgb);
  } else {
    updateBackground();
  }
  const display = [values[displayOffset], values[displayOffset + 1], values[displayOffset + 2]];
  const displaySrgb = [values[14], values[15], values[16]];
  preview.classList.toggle("preview-unavailable", !valid);
  if (valid) {
    setElementColor(preview, display, useDisplayP3, displaySrgb);
  } else {
    preview.style.backgroundColor = "#000";
  }
  drawIndicators();
}

function parseEncodedHex(value: string): [number, number, number] | undefined {
  const match = /^([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const encoded = match[1];
  return [
    Number.parseInt(encoded.slice(0, 2), 16) / 255,
    Number.parseInt(encoded.slice(2, 4), 16) / 255,
    Number.parseInt(encoded.slice(4, 6), 16) / 255,
  ];
}

function requestSetFromEncoded() {
  const rgb = parseEncodedHex(acescgEncodedValue.value);
  if (!rgb) {
    acescgEncodedValue.setCustomValidity("Enter six sRGB hex digits, for example 7FA2D4.");
    acescgEncodedValue.reportValidity();
    return;
  }
  acescgEncodedValue.setCustomValidity("");
  latestProfileConversion += 1;
  profileConversionPending = false;
  latestSetRequest += 1;
  workers[0].postMessage({
    kind: "set",
    id: latestSetRequest,
    profile: currentProfile(),
    red: rgb[0],
    green: rgb[1],
    blue: rgb[2],
    ...displayState(),
  });
}

async function copyEncodedValue() {
  const value = acescgEncodedValue.value;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    acescgEncodedValue.focus();
    acescgEncodedValue.select();
    document.execCommand("copy");
  }
}

function restoreCachedRender(): boolean {
  const state = currentState();
  const profile = currentProfile();
  const useDisplayP3 = profileUsesDisplayP3(profile);
  const key = renderKey(profile, state.reflectance, useDisplayP3);
  const pixels = displayedResolution === "full" && cachedRenderKey === key
    ? cachedRenderPixels
    : undefined;
  if (!pixels) {
    return false;
  }
  ensureRenderSurface(displayedResolution, useDisplayP3);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return true;
}

function drawIndicators() {
  // Keep the last complete frame on screen while the next row set is being
  // assembled. A render generation is published atomically at completion.
  if (activeRenderPixels || image.width !== canvas.width || image.height !== canvas.height) return;
  restoreCachedRender();
  // Redraw the base raster before placing indicators so repeated previews do
  // not accumulate stale lines and dots.
  context.putImageData(image, 0, 0);
  const state = currentState();
  const angle = (adaptedHue * Math.PI) / 180;
  const width = canvas.width;
  const height = canvas.height;
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const radius = Math.min(width, height) / 2;
  const dotRadius = (adaptedSaturation / 100) * radius;
  const dotX = centerX - dotRadius * Math.sin(angle);
  const dotY = centerY - dotRadius * Math.cos(angle);
  // Above unity the neutral source is outside the display cube. Keep the
  // picking overlay visible as white instead of inheriting the unavailable
  // neutral preview's black fallback.
  const color = state.reflectance > 1.0
    ? cssDisplayColor([1, 1, 1], profileUsesDisplayP3(currentProfile()))
    : cssDisplayColor(neutralDisplay, profileUsesDisplayP3(currentProfile()));
  context.save();
  for (const patch of colorcheckerPoints) {
    const patchAngle = (patch.adaptedHue * Math.PI) / 180;
    const patchRadius = (patch.adaptedSaturation / 100) * radius;
    const patchX = centerX - patchRadius * Math.sin(patchAngle);
    const patchY = centerY - patchRadius * Math.cos(patchAngle);
    // Availability is diagnostic only: every fixed reference keeps its exact
    // position and forward-rendered dot color, including out-of-cone sources.
    context.fillStyle = cssDisplayColor(patch.display, profileUsesDisplayP3(currentProfile()));
    context.beginPath();
    context.arc(patchX, patchY, COLORCHECKER_DOT_RADIUS * (width / FULL_RESOLUTION), 0, 2 * Math.PI);
    context.fill();
  }
  context.strokeStyle = color;
  context.fillStyle = color;
  const indicatorScale = width / FULL_RESOLUTION;
  context.lineWidth = Math.max(0.5, 3 * indicatorScale);
  const neutralAngle = (adaptedNeutralHue * Math.PI) / 180;
  const neutralRadius = (adaptedNeutralSaturation / 100) * radius;
  const neutralX = centerX - neutralRadius * Math.sin(neutralAngle);
  const neutralY = centerY - neutralRadius * Math.cos(neutralAngle);
  context.beginPath();
  context.moveTo(neutralX, neutralY);
  context.lineTo(dotX, dotY);
  context.stroke();
  context.beginPath();
  context.arc(dotX, dotY, Math.max(2, 8 * indicatorScale), 0, 2 * Math.PI);
  context.fill();
  context.restore();
}

function parseColorcheckerPoints(values: Float64Array, profile: number): ColorCheckerPoint[] {
  const points: ColorCheckerPoint[] = [];
  const stride = values.length >= COLORCHECKER_NAMES.length * 12 ? 12 : 10;
  for (let offset = 0; offset + stride - 1 < values.length && points.length < COLORCHECKER_NAMES.length; offset += stride) {
    const displayOffset = profileUsesDisplayP3(profile) ? 3 : 6;
    points.push({
      name: COLORCHECKER_NAMES[points.length],
      hue: values[offset],
      saturation: values[offset + 1],
      reflectance: values[offset + 2],
      display: [values[offset + displayOffset], values[offset + displayOffset + 1], values[offset + displayOffset + 2]],
      available: values[offset + 9] > 0.5,
      adaptedHue: stride === 12 ? values[offset + 10] : values[offset],
      adaptedSaturation: stride === 12 ? values[offset + 11] : values[offset + 1],
    });
  }
  hueStickElements.forEach((marker, index) => {
    const patch = points[index];
    marker.style.left = patch ? `${(patch.hue / 360) * 100}%` : "0%";
  });
  return points;
}

function requestPreview(id: number) {
  const state = currentState();
  workers[0].postMessage({ kind: "evaluate", id, profile: currentProfile(), ...state, ...displayState(), background: backgroundValueFromSlider() });
}

function requestColorchecker() {
  workers[0].postMessage({ kind: "colorchecker", id: 0, profile: currentProfile(), ...displayState() });
}

function requestProfileConversion() {
  const profile = currentProfile();
  const state = currentState();
  const sourceIsDirectSrgb = sliderProfile === 3;
  const retained = sourceIsDirectSrgb ? retainedOutputSrgbEncoded : retainedAcescgEncoded;
  // Invalidate a pending hex-entry response. A profile switch can return to
  // the same profile ID before that response arrives, so the profile check
  // alone is not sufficient to establish that it still belongs to the UI
  // state being edited.
  latestSetRequest += 1;
  latestProfileConversion += 1;
  profileConversionPending = true;
  generation += 1;
  updateProfileFooter();
  updateLabels();
  updateStickMarkers();
  requestColorchecker();
  workers[0].postMessage({
    kind: "profile-convert",
    id: latestProfileConversion,
    profile,
    sourceProfile: sliderProfile,
    background: backgroundValueFromSlider(),
    reflectance: state.reflectance,
    red: retained[0],
    green: retained[1],
    blue: retained[2],
    ...displayState(),
  });
}

function requestRender(id: number, resolution: RenderResolution) {
  const state = currentState();
  const profile = currentProfile();
  const useDisplayP3 = profileUsesDisplayP3(profile);
  const size = resolutionSize(resolution);
  const cacheKey = renderKey(profile, state.reflectance, useDisplayP3);
  if (activeRenderPixels) {
    if (
      activeRenderKey === cacheKey
      && activeRenderResolution === resolution
      && activeRenderWidth === size
      && activeRenderHeight === size
    ) {
      // The in-flight render already describes the newest state, so discard
      // any older request that was waiting behind it.
      pendingRenderRequest = undefined;
      return;
    }
    // Keep only the newest request while the current raster is assembled.
    // It will be launched after the current render has been published.
    pendingRenderRequest = { id, resolution };
    return;
  }
  prepareRenderSurface(resolution, useDisplayP3);
  const cachedPixels = resolution === "full" && cachedRenderKey === cacheKey
    ? cachedRenderPixels
    : undefined;
  if (cachedPixels) {
    ensureRenderSurface(resolution, useDisplayP3);
    image.data.set(cachedPixels);
    context.putImageData(image, 0, 0);
    drawIndicators();
    return;
  }
  if (
    activeRenderKey === cacheKey
    && activeRenderResolution === resolution
    && activeRenderPixels
  ) return;
  pendingRows = workers.length;
  activeRenderId = id;
  activeRenderKey = cacheKey;
  activeRenderResolution = resolution;
  activeRenderWidth = size;
  activeRenderHeight = size;
  activeRenderPixels = new Uint8ClampedArray(size * size * 4);
  const rowsPerWorker = Math.ceil(size / workers.length);
  workers.forEach((worker, index) => {
    const yStart = index * rowsPerWorker;
    const yEnd = Math.min(size, yStart + rowsPerWorker);
    worker.postMessage({
      kind: "render",
      id,
      profile,
      ...state,
      width: size,
      height: size,
      yStart,
      yEnd,
      displayP3: useDisplayP3,
      ...displayState(),
    });
  });
}

function queueAnimationFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    if (profileConversionPending) return;
    const nextResolution = queuedRenderResolution;
    queuedRenderResolution = "full";
    generation += 1;
    const id = generation;
    requestPreview(id);
    requestRender(id, nextResolution);
  });
}

function launchPendingRender() {
  const pending = pendingRenderRequest;
  if (!pending) return;
  pendingRenderRequest = undefined;
  requestRender(pending.id, pending.resolution);
}

function scheduleUpdate(resolution: RenderResolution = "full") {
  queuedRenderResolution = resolution;
  // Prepare the next ImageData without resizing the visible canvas. The
  // replacement surface is committed only after its rows are complete.
  const profile = currentProfile();
  const useDisplayP3 = profileUsesDisplayP3(profile);
  const state = currentState();
  const requestedKey = renderKey(profile, state.reflectance, useDisplayP3);
  if (!activeRenderPixels || (activeRenderKey === requestedKey && activeRenderResolution === resolution)) {
    prepareRenderSurface(resolution, useDisplayP3);
  }
  updateLabels();
  queueAnimationFrame();
}

workers.forEach((worker) => {
  worker.onmessage = (event: MessageEvent<RenderResponse | RenderCancelledResponse | EvaluateResponse | ColorCheckerResponse | SetResponse | ProfileConvertResponse>) => {
    const response = event.data;
    if (response.kind === "colorchecker") {
      if (response.profile !== currentProfile()) return;
      const display = displayState();
      if (response.temp !== display.temp || response.tint !== display.tint) return;
      colorcheckerPoints = parseColorcheckerPoints(response.points, response.profile);
      updateStickMarkers();
      drawIndicators();
      return;
    }
    if (response.kind === "set") {
      if (response.profile !== currentProfile()) return;
      if (response.id !== latestSetRequest) return;
      const display = displayState();
      if (response.temp !== display.temp || response.tint !== display.tint) return;
      const coordinatesFinite = Array.from(response.values.slice(1, 4)).every(Number.isFinite);
      if (!coordinatesFinite) {
        return;
      }
      setReflectanceValue(response.values[1]);
      hue.value = response.values[2].toString();
      setSaturationValue(response.values[3]);
      sliderProfile = response.profile;
      if (response.values[0] > 0.5) {
        snapHueInput();
        snapReflectanceInput();
        snapSaturationInput();
      } else {
        // Do not snap an unrepresentable entry onto a nearby reference; keep
        // the finite boundary coordinates returned by the core visible.
        snappedPatchIndex = null;
        updateStickMarkers();
      }
      scheduleUpdate();
      return;
    }
    if (response.kind === "profile-convert") {
      if (response.profile !== currentProfile()) return;
      if (response.id !== latestProfileConversion) return;
      const display = displayState();
      const currentBackground = backgroundValueFromSlider();
      if (
        response.temp !== display.temp
        || response.tint !== display.tint
        || Math.abs(response.sourceBackground - currentBackground) > 1.0e-9
      ) {
        // The retained foreground is unchanged by white balance, but a
        // background edit while conversion is in flight changes the offset
        // that must be converted. Re-run the same target conversion against
        // the latest background instead of applying a stale result.
        requestProfileConversion();
        return;
      }
      profileConversionPending = false;
      const coordinatesFinite = Array.from(response.values.slice(1, 4)).every(Number.isFinite);
      const backgroundFinite = Number.isFinite(response.background);
      // A false validity bit is an explicit, editable out-of-gamut state.
      // Keep finite boundary coordinates for every profile direction and let
      // the normal evaluator provide the unavailable preview. Only malformed
      // conversion results should roll the profile selection back.
      if (!backgroundFinite || !coordinatesFinite) {
        profileSelect.value = sliderProfile.toString();
        updateProfileFooter();
        requestColorchecker();
        scheduleUpdate();
        return;
      }
      setReflectanceValue(response.values[1]);
      hue.value = response.values[2].toString();
      setSaturationValue(response.values[3]);
      backgroundBrightness.max = BACKGROUND_SLIDER_MAX.toString();
      backgroundBrightness.value = backgroundSliderPosition(response.background).toString();
      sliderProfile = response.profile;
      updateStickMarkers();
      updateBackground();
      updateLabels();
      // Re-evaluate the adapted sliders so the preview always comes from
      // the selected profile's normal output path.
      scheduleUpdate();
      return;
    }
    if (response.kind === "evaluate") {
      if (response.id !== generation) return;
      if (response.profile !== currentProfile()) return;
      const display = displayState();
      if (response.temp !== display.temp || response.tint !== display.tint) return;
      if (Math.abs(response.background - backgroundValueFromSlider()) > 1.0e-9) return;
      updatePreview(response.values);
      return;
    }
    if (response.kind === "render-cancelled") {
      // A worker can observe a newer render generation before it starts an
      // older row block. Account for that block explicitly so the main thread
      // can discard the partial frame and launch the pending generation.
      if (response.id !== activeRenderId || !activeRenderPixels) return;
      if (
        response.width !== activeRenderWidth
        || response.height !== activeRenderHeight
      ) return;
      pendingRows -= 1;
      if (pendingRows === 0) {
        activeRenderPixels = undefined;
        launchPendingRender();
      }
      return;
    }
    if (response.kind !== "render") return;
    // A slice render remains valid across Hue/Sat preview generations.
    if (response.id !== activeRenderId || !activeRenderPixels) return;
    if (
      response.width !== activeRenderWidth
      || response.height !== activeRenderHeight
    ) return;
    const offset = response.yStart * activeRenderWidth * 4;
    image.data.set(response.pixels, offset);
    activeRenderPixels.set(response.pixels, offset);
    pendingRows -= 1;
    if (pendingRows === 0) {
      const completedKey = activeRenderKey;
      const completedResolution = activeRenderResolution;
      const completedPixels = activeRenderPixels;
      if (completedResolution === "full") {
        cachedRenderKey = completedKey;
        cachedRenderPixels = completedPixels;
      }
      activeRenderPixels = undefined;
      const state = currentState();
      const profile = currentProfile();
      const currentKey = renderKey(profile, state.reflectance, profileUsesDisplayP3(profile));
      if (completedKey === currentKey) {
        ensureRenderSurface(completedResolution, profileUsesDisplayP3(profile));
        drawIndicators();
      }
      const pending = pendingRenderRequest;
      if (pending) {
        launchPendingRender();
      }
    }
  };
  worker.onerror = () => {
    if (renderError) return;
    renderError = true;
    preview.classList.add("preview-unavailable");
    preview.style.backgroundColor = "#000";
  };
});

reflectance.addEventListener("input", () => {
  snapReflectanceInput();
  scheduleUpdate("preview");
});
function settleReflectanceInput() {
  // Pointer/keyboard settlement is explicit because snapping may leave the
  // control at its previously committed value and suppress a native change.
  scheduleUpdate("full");
}
reflectance.addEventListener("change", settleReflectanceInput);
reflectance.addEventListener("pointerup", settleReflectanceInput);
reflectance.addEventListener("pointercancel", settleReflectanceInput);
reflectance.addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
    settleReflectanceInput();
  }
});
hue.addEventListener("input", () => {
  snapHueInput();
  scheduleUpdate();
});
saturation.addEventListener("input", () => {
  snapSaturationInput();
  scheduleUpdate();
});
function settleDisplayWhiteBalanceInput() {
  scheduleUpdate("full");
}
temperature.addEventListener("input", () => {
  temperatureReadoutUsesSliderStep = true;
  snapTemperatureInput();
  temperatureNumber.value = formatTemperature(temperatureValueFromSlider(), true);
  requestColorchecker();
  scheduleUpdate("preview");
});
tint.addEventListener("input", () => {
  snapTintInput();
  tintNumber.value = formatTint(tintValueFromSlider());
  requestColorchecker();
  scheduleUpdate("preview");
});
temperature.addEventListener("change", settleDisplayWhiteBalanceInput);
temperature.addEventListener("pointerup", settleDisplayWhiteBalanceInput);
temperature.addEventListener("pointercancel", settleDisplayWhiteBalanceInput);
tint.addEventListener("change", settleDisplayWhiteBalanceInput);
tint.addEventListener("pointerup", settleDisplayWhiteBalanceInput);
tint.addEventListener("pointercancel", settleDisplayWhiteBalanceInput);
temperature.addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
    settleDisplayWhiteBalanceInput();
  }
});
tint.addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
    settleDisplayWhiteBalanceInput();
  }
});
temperatureNumber.addEventListener("change", () => {
  const raw = temperatureNumber.value.trim();
  if (raw.length > 0) {
    const value = Number(raw);
    if (Number.isFinite(value)) {
      temperatureReadoutUsesSliderStep = false;
      setTemperatureValue(Math.max(TEMPERATURE_MIN, Math.min(TEMPERATURE_MAX, value)));
      snapTemperatureInput();
    }
  }
  temperatureNumber.value = formatTemperature(temperatureValueFromSlider());
  requestColorchecker(); scheduleUpdate("full");
});
tintNumber.addEventListener("change", () => {
  const raw = tintNumber.value.trim();
  if (raw.length > 0) {
    const value = Number(raw);
    if (Number.isFinite(value)) {
      setTintValue(Math.max(TINT_MIN, Math.min(TINT_MAX, value)));
      snapTintInput();
    }
  }
  tintNumber.value = formatTint(tintValueFromSlider());
  requestColorchecker(); scheduleUpdate("full");
});
whiteBalanceReset.addEventListener("click", () => {
  temperatureReadoutUsesSliderStep = true;
  setTemperatureValue(TEMPERATURE_DEFAULT);
  setTintValue(TINT_DEFAULT);
  requestColorchecker();
  scheduleUpdate("full");
});
reflectanceNumber.addEventListener("input", () => {
  applyNumberInput(
    reflectanceNumber,
    0,
    REFLECTANCE_MAX,
    setReflectanceValue,
    reflectanceValueFromSlider,
    snapReflectanceInput,
    false,
  );
});
reflectanceNumber.addEventListener("change", () => {
  if (reflectanceNumber.value.trim().length === 0) {
    reflectanceNumber.value = reflectanceValueFromSlider().toString();
  }
  applyNumberInput(
    reflectanceNumber,
    0,
    REFLECTANCE_MAX,
    setReflectanceValue,
    reflectanceValueFromSlider,
    snapReflectanceInput,
    true,
  );
});
hueNumber.addEventListener("input", () => {
  applyNumberInput(
    hueNumber,
    0,
    360,
    (value) => { hue.value = value.toString(); },
    () => Number(hue.value),
    snapHueInput,
    false,
  );
});
hueNumber.addEventListener("change", () => {
  if (hueNumber.value.trim().length === 0) hueNumber.value = hue.value;
  applyNumberInput(
    hueNumber,
    0,
    360,
    (value) => { hue.value = value.toString(); },
    () => Number(hue.value),
    snapHueInput,
    true,
  );
});
saturationNumber.addEventListener("input", () => {
  applyNumberInput(
    saturationNumber,
    0,
    SATURATION_MAX,
    setSaturationValue,
    saturationValueFromSlider,
    snapSaturationInput,
    false,
  );
});
saturationNumber.addEventListener("change", () => {
  if (saturationNumber.value.trim().length === 0) {
    saturationNumber.value = saturationValueFromSlider().toString();
  }
  applyNumberInput(
    saturationNumber,
    0,
    SATURATION_MAX,
    setSaturationValue,
    saturationValueFromSlider,
    snapSaturationInput,
    true,
  );
});
backgroundBrightness.addEventListener("input", () => {
  snapBackgroundInput();
  backgroundBrightnessValue.textContent = Math.max(0, Math.min(BACKGROUND_MAX, backgroundValueFromSlider())).toFixed(3);
  generation += 1;
  requestPreview(generation);
});
profileSelect.addEventListener("change", () => {
  requestProfileConversion();
});
acescgCopy.addEventListener("click", () => void copyEncodedValue());
acescgSet.addEventListener("click", requestSetFromEncoded);
acescgEncodedValue.addEventListener("input", () => acescgEncodedValue.setCustomValidity(""));
reflectance.max = REFLECTANCE_SLIDER_MAX.toString();
saturation.max = SATURATION_SLIDER_MAX.toString();
setReflectanceValue(Number(reflectanceNumber.value));
setSaturationValue(Number(saturationNumber.value));
temperature.min = "0";
temperature.max = "1";
temperature.value = temperatureSliderPosition(TEMPERATURE_DEFAULT).toString();
tint.min = "0";
tint.max = "1";
tint.value = tintSliderPosition(TINT_DEFAULT).toString();
updateDisplaySnapMarkers();
updateBackground();
updateProfileFooter();
updateLabels();
requestColorchecker();
scheduleUpdate();
