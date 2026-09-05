import "./style.css";

const FULL_RESOLUTION = 512;
const PREVIEW_RESOLUTION = 64;
type RenderResolution = "preview" | "full";
type PendingRenderRequest = { id: number; resolution: RenderResolution };
type WhiteBalance = { temp: number; tint: number };
type RenderCacheEntry = { key: string; pixels: Uint8ClampedArray };
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
  reflectance: number;
  hue: number;
  saturation: number;
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
  sourceProfile: number;
  sourceReflectance: number;
  sourceHue: number;
  sourceSaturation: number;
  temp: number;
  tint: number;
  sourceBackground: number;
  values: Float64Array;
  background: number;
  backgroundPreserved: boolean;
};
type WorkerErrorResponse = { kind: "worker-error"; id: number; operation: string };

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
  displaySrgb: [number, number, number];
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
const WHITE_BALANCE_CACHE_PRECISION = 1e9;

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
const whiteBalanceStore = document.querySelector<HTMLButtonElement>("#white-balance-store")!;
const whiteBalanceRecall = document.querySelector<HTMLButtonElement>("#white-balance-recall")!;
const profileSelect = document.querySelector<HTMLSelectElement>("#profile")!;
const hueStickContainer = document.querySelector<HTMLElement>("#hue-sticks")!;
const reflectanceStick = document.querySelector<HTMLElement>("#reflectance-stick")!;
const saturationStick = document.querySelector<HTMLElement>("#saturation-stick")!;
const colorcheckerName = document.querySelector<HTMLElement>("#colorchecker-name")!;
const canvas = document.querySelector<HTMLCanvasElement>("#gamut-slice")!;
const indicatorCanvas = document.querySelector<HTMLCanvasElement>("#gamut-indicators")!;
// Keep the transparent overlay at full resolution even while the raster is
// reduced to the 64x64 drag preview. Its CSS size matches the raster, so the
// geometry stays aligned while its pixels are never cleared by raster swaps.
if (indicatorCanvas.width !== FULL_RESOLUTION || indicatorCanvas.height !== FULL_RESOLUTION) {
  indicatorCanvas.width = FULL_RESOLUTION;
  indicatorCanvas.height = FULL_RESOLUTION;
}
let contextCandidate: CanvasRenderingContext2D | null = null;
try {
  contextCandidate = canvas.getContext("2d", { alpha: true, colorSpace: "display-p3" });
} catch {
  // Some older engines reject the color-space option instead of ignoring it.
}
contextCandidate ??= canvas.getContext("2d");
if (!contextCandidate) throw new Error("The gamut slice requires a 2D canvas context.");
const context: CanvasRenderingContext2D = contextCandidate;
let indicatorContextCandidate: CanvasRenderingContext2D | null = null;
try {
  indicatorContextCandidate = indicatorCanvas.getContext("2d", { alpha: true, colorSpace: "display-p3" });
} catch {
  // Some older engines reject the color-space option instead of ignoring it.
}
indicatorContextCandidate ??= indicatorCanvas.getContext("2d");
if (!indicatorContextCandidate) throw new Error("The gamut-slice indicator layer requires a 2D canvas context.");
const indicatorContext: CanvasRenderingContext2D = indicatorContextCandidate;
let contextAttributes: CanvasRenderingContext2DSettings = {};
try {
  if (typeof context.getContextAttributes === "function") {
    contextAttributes = context.getContextAttributes();
  }
} catch {
  // Treat an engine that cannot report its attributes as sRGB-only.
}
let displayP3Canvas = contextAttributes.colorSpace === "display-p3";
let indicatorContextAttributes: CanvasRenderingContext2DSettings = {};
try {
  if (typeof indicatorContext.getContextAttributes === "function") {
    indicatorContextAttributes = indicatorContext.getContextAttributes();
  }
} catch {
  // Treat an engine that cannot report its attributes as sRGB-only.
}
const indicatorDisplayP3Canvas = indicatorContextAttributes.colorSpace === "display-p3";
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
// ColorChecker generation is independent of the picked-color evaluator. Keep
// its requests coalesced so a fast white-balance drag cannot queue one costly
// 18-patch solve for every pointer event.
const colorcheckerWorkerIndex = workers.length > 1 ? workers.length - 1 : 0;
const colorcheckerWorker = workers[colorcheckerWorkerIndex];
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
let imageRenderKey = "";
let generation = 0;
let pendingRows = 0;
let neutralDisplay: [number, number, number] = [0.5, 0.5, 0.5];
let neutralDisplaySrgb: [number, number, number] = [0.5, 0.5, 0.5];
let adaptedNeutralHue = 0;
let adaptedNeutralSaturation = 0;
let adaptedHue = 0;
let adaptedSaturation = 0;
let colorcheckerPoints: ColorCheckerPoint[] = [];
let colorcheckerPointsKey = "";
let colorcheckerPointsProfile = -1;
// The initial controls are the direct-sRGB Dark Skin reference. Keep its
// identity selected from the first ColorChecker response so the patch name is
// visible at startup and is refreshed with each profile's point data.
let snappedPatchIndex: number | null = 0;
const hueStickElements: HTMLElement[] = [];
let frameQueued = false;
// Gamut slices depend on profile, reflectance, white-balance state, and output
// color space.
// Keep one settled full-resolution slice for the D65 identity and one for the
// currently stored white balance. Hue/Sat edits can redraw indicators without
// asking the workers to regenerate either background.
let cachedIdentityRender: RenderCacheEntry | undefined;
let cachedStoredRender: RenderCacheEntry | undefined;
// A non-cached full render is retained briefly so Store can promote it to the
// stored slot without calculating the same slice a second time.
let lastCompletedFullRender: RenderCacheEntry | undefined;
let activeRenderId = -1;
let activeRenderKey = "";
let activeRenderPixels: Uint8ClampedArray | undefined;
let activeRenderResolution: RenderResolution = "full";
let activeRenderWidth = FULL_RESOLUTION;
let activeRenderHeight = FULL_RESOLUTION;
let activeRenderProfile = -1;
let activeRenderDisplayP3 = false;
let activeRenderWhiteBalance: WhiteBalance = { temp: TEMPERATURE_DEFAULT, tint: TINT_DEFAULT };
let activeRenderPendingWorkers = new Set<number>();
let activeRenderCancelRequested = false;
let pendingRenderRequest: PendingRenderRequest | undefined;
let latestColorcheckerRequest = 0;
let colorcheckerPostedRequest = -1;
let colorcheckerPostQueued = false;
let colorcheckerInFlight = false;
let latestSetRequest = 0;
let latestSetRevision = -1;
let latestProfileConversion = 0;
let sliderProfile = Number(profileSelect.value);
let profileConversionPending = false;
let profileConversionRevision = -1;
let uiRevision = 0;
// Keep the 50 K presentation after a slider edit, even when the range loses
// focus before the next label refresh. Direct numeric entry switches back to
// the exact integer Kelvin presentation.
let temperatureReadoutUsesSliderStep = true;
let storedWhiteBalance: WhiteBalance | undefined;
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
let queuedRenderResolution: RenderResolution | undefined = "full";
// Keep the last accepted indicator geometry visible while a newer evaluation
// is in flight. This avoids flashing the overlay off between slider events.
let evaluatedStateKey = "";
let indicatorReady = false;

for (const patch of COLORCHECKER_NAMES) {
  const marker = document.createElement("span");
  marker.className = "hue-stick";
  marker.title = patch;
  hueStickContainer.append(marker);
  hueStickElements.push(marker);
}

function currentState() {
  return {
    reflectance: finiteClamped(reflectanceValueFromSlider(), 0, REFLECTANCE_MAX),
    hue: finiteClamped(Number(hue.value), 0, 360),
    saturation: finiteClamped(saturationValueFromSlider(), 0, SATURATION_MAX),
  };
}

function displayState() {
  return {
    temp: finiteClamped(temperatureValueFromSlider(), TEMPERATURE_MIN, TEMPERATURE_MAX),
    tint: finiteClamped(tintValueFromSlider(), TINT_MIN, TINT_MAX),
  };
}

function finiteClamped(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
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

function sameNumber(first: number, second: number, tolerance = 1.0e-12): boolean {
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= tolerance;
}

function profileUsesDisplayP3(profile: number): boolean {
  return profile !== 1 && profile !== 3 && displayP3Canvas;
}

function normalizedWhiteBalanceValue(value: number): number {
  return Math.round(value * WHITE_BALANCE_CACHE_PRECISION) / WHITE_BALANCE_CACHE_PRECISION;
}

function renderKey(
  profile: number,
  reflectanceValue: number,
  useDisplayP3: boolean,
  display = displayState(),
): string {
  const temp = normalizedWhiteBalanceValue(display.temp);
  const tint = normalizedWhiteBalanceValue(display.tint);
  return `${profile}|${reflectanceValue}|${temp}|${tint}|${useDisplayP3 ? "p3" : "srgb"}`;
}

function evaluationKey(
  profile = currentProfile(),
  state = currentState(),
  display = displayState(),
  background = backgroundValueFromSlider(),
): string {
  return [
    profile,
    state.reflectance,
    state.hue,
    state.saturation,
    normalizedWhiteBalanceValue(display.temp),
    normalizedWhiteBalanceValue(display.tint),
    normalizedWhiteBalanceValue(finiteClamped(background, 0, BACKGROUND_MAX)),
  ].join("|");
}

function colorcheckerKey(profile = currentProfile(), display = displayState()): string {
  return `${profile}|${normalizedWhiteBalanceValue(display.temp)}|${normalizedWhiteBalanceValue(display.tint)}`;
}

function invalidateEvaluation() {
  // Do not repaint the canvas here. The last accepted composited indicators
  // stay visible until the replacement evaluator response arrives; clearing
  // the base on every input is what made the overlay flicker while dragging.
}

function sameWhiteBalance(first: WhiteBalance | undefined, second: WhiteBalance | undefined): boolean {
  return first !== undefined
    && second !== undefined
    && normalizedWhiteBalanceValue(first.temp) === normalizedWhiteBalanceValue(second.temp)
    && normalizedWhiteBalanceValue(first.tint) === normalizedWhiteBalanceValue(second.tint);
}

function renderCacheForWhiteBalance(display: WhiteBalance): RenderCacheEntry | undefined {
  if (sameWhiteBalance(display, { temp: TEMPERATURE_DEFAULT, tint: TINT_DEFAULT })) {
    return cachedIdentityRender;
  }
  if (sameWhiteBalance(display, storedWhiteBalance)) {
    return cachedStoredRender;
  }
  return undefined;
}

function cachedRenderPixelsForState(display: WhiteBalance, key: string): Uint8ClampedArray | undefined {
  const entry = renderCacheForWhiteBalance(display);
  if (entry?.key === key) return entry.pixels;
  // A full slice is independent of Hue, Sat, and Background. Retain the most
  // recently completed arbitrary white-balance slice as a transient cache so
  // editing those controls only repaints indicators/readouts.
  return lastCompletedFullRender?.key === key ? lastCompletedFullRender.pixels : undefined;
}

function ensureImage(width: number, height: number, useDisplayP3: boolean) {
  if (image.width === width && image.height === height && imageDisplayP3 === useDisplayP3) return;
  imageRenderKey = "";
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
  whiteBalanceRecall.disabled = storedWhiteBalance === undefined;
  if (storedWhiteBalance) {
    const storedDescription = `${formatTemperature(storedWhiteBalance.temp)} K, tint ${formatTint(storedWhiteBalance.tint)}`;
    whiteBalanceRecall.title = `Recall ${storedDescription}`;
    whiteBalanceRecall.setAttribute("aria-label", `Recall stored display white balance: ${storedDescription}`);
  } else {
    whiteBalanceRecall.removeAttribute("title");
    whiteBalanceRecall.setAttribute("aria-label", "Recall stored display white balance");
  }
}

function hueDistance(first: number, second: number): number {
  const distance = Math.abs(first - second) % 360;
  return Math.min(distance, 360 - distance);
}

function updateStickMarkers() {
  // Hue/Refl/Sat coordinates are pre-adaptation data, so they remain valid
  // while a new white-balance-specific dot raster is being calculated.
  const pointsReady = colorcheckerPointsProfile === currentProfile() && colorcheckerPoints.length > 0;
  const patch = pointsReady && snappedPatchIndex !== null
    ? colorcheckerPoints[snappedPatchIndex]
    : undefined;
  hueStickElements.forEach((marker, index) => {
    const present = pointsReady && colorcheckerPoints[index] !== undefined;
    marker.hidden = !present;
    marker.classList.toggle("active", present && index === snappedPatchIndex);
  });
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

function colorcheckerSourceReady(): boolean {
  return colorcheckerPointsProfile === currentProfile() && colorcheckerPoints.length > 0;
}

function snapHueInput() {
  if (!colorcheckerSourceReady()) return;
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
  if (!colorcheckerSourceReady() || snappedPatchIndex === null) return;
  const patch = colorcheckerPoints[snappedPatchIndex];
  if (Math.abs(reflectanceValueFromSlider() - patch.reflectance) <= REFLECTANCE_SNAP_DISTANCE) {
    setReflectanceValue(Number(patch.reflectance.toFixed(3)));
  }
  updateStickMarkers();
}

function snapSaturationInput() {
  ensureHuePatchSelection();
  if (!colorcheckerSourceReady() || snappedPatchIndex === null) return;
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
  resolution?: RenderResolution,
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
  scheduleControlUpdate(resolution);
}

function cssDisplayColor(
  rgb: [number, number, number] | number[],
  useDisplayP3 = profileUsesDisplayP3(currentProfile()),
  fallbackRgb: [number, number, number] | number[] = rgb,
  targetSupportsDisplayP3 = displayP3Canvas,
): string {
  const values = rgb.map((value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
  const fallback = fallbackRgb.map((value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
  // Canvas color parsing follows the backing canvas capability, not CSS
  // feature detection. Fall back to sRGB when the canvas cannot represent
  // Display-P3 so an unsupported declaration never leaves the old fill style
  // in place.
  if (useDisplayP3 && targetSupportsDisplayP3 && displayP3Css) {
    return `color(display-p3 ${values[0]} ${values[1]} ${values[2]})`;
  }
  return `rgb(${fallback.map((value) => Math.round(value * 255)).join(" ")})`;
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
  const clamped = finiteClamped(value, 0, REFLECTANCE_MAX);
  return encodeSrgbTransferExtended(clamped) / encodeSrgbTransferExtended(REFLECTANCE_MAX);
}

function reflectanceValueFromSlider(): number {
  const position = Math.max(0, Math.min(REFLECTANCE_SLIDER_MAX, Number(reflectance.value)));
  return finiteClamped(decodeSrgbTransferExtended(position * encodeSrgbTransferExtended(REFLECTANCE_MAX)), 0, REFLECTANCE_MAX);
}

function setReflectanceValue(value: number) {
  reflectance.value = reflectanceSliderPosition(value).toString();
}

function setHueValue(value: number) {
  hue.value = finiteClamped(value, 0, 360).toString();
}

function saturationSliderPosition(value: number): number {
  const clamped = finiteClamped(value, 0, SATURATION_MAX);
  const transferMaximum = SATURATION_MAX / SATURATION_TRANSFER_SCALE;
  return encodeSrgbTransferExtended(clamped / SATURATION_TRANSFER_SCALE)
    / encodeSrgbTransferExtended(transferMaximum);
}

function saturationValueFromSlider(): number {
  const position = Math.max(0, Math.min(SATURATION_SLIDER_MAX, Number(saturation.value)));
  const transferMaximum = SATURATION_MAX / SATURATION_TRANSFER_SCALE;
  return finiteClamped(
    decodeSrgbTransferExtended(position * encodeSrgbTransferExtended(transferMaximum))
      * SATURATION_TRANSFER_SCALE,
    0,
    SATURATION_MAX,
  );
}

function setSaturationValue(value: number) {
  saturation.value = saturationSliderPosition(value).toString();
}

function temperatureSliderPosition(value: number): number {
  const clamped = finiteClamped(value, TEMPERATURE_MIN, TEMPERATURE_MAX);
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
  const rawPosition = Number(temperature.value);
  const position = Number.isFinite(rawPosition)
    ? Math.max(0, Math.min(1, rawPosition))
    : temperatureSliderPosition(TEMPERATURE_DEFAULT);
  const mireds = position <= 0.5
    ? TEMPERATURE_DEFAULT_MIREDS
      + (1 - position * 2) * (TEMPERATURE_MIREDS_MAX - TEMPERATURE_DEFAULT_MIREDS)
    : TEMPERATURE_DEFAULT_MIREDS
      - (position * 2 - 1) * (TEMPERATURE_DEFAULT_MIREDS - TEMPERATURE_MIREDS_MIN);
  return Math.round(Math.max(TEMPERATURE_MIN, Math.min(TEMPERATURE_MAX, 1_000_000 / mireds)));
}

function setTemperatureValue(value: number) {
  const finite = finiteClamped(value, TEMPERATURE_MIN, TEMPERATURE_MAX);
  temperature.value = temperatureSliderPosition(Math.round(finite)).toString();
}

function tintSliderPosition(value: number): number {
  const clamped = finiteClamped(value, TINT_MIN, TINT_MAX);
  const centered = clamped / TINT_MAX;
  const curved = Math.sign(centered) * Math.abs(centered) ** TINT_PRESENTATION_EXPONENT;
  return 0.5 + 0.5 * curved;
}

function tintValueFromSlider(): number {
  const rawPosition = Number(tint.value);
  const position = Number.isFinite(rawPosition) ? Math.max(0, Math.min(1, rawPosition)) : 0.5;
  const centered = position * 2 - 1;
  const value = Math.sign(centered)
    * Math.abs(centered) ** (1 / TINT_PRESENTATION_EXPONENT)
    * TINT_MAX;
  return Math.max(TINT_MIN, Math.min(TINT_MAX, value));
}

function setTintValue(value: number) {
  tint.value = tintSliderPosition(finiteClamped(value, TINT_MIN, TINT_MAX)).toString();
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
  return encodeDisplayChannel(finiteClamped(value, 0, BACKGROUND_MAX) / BACKGROUND_MAX);
}

function backgroundValueFromSlider(): number {
  return finiteClamped(decodeDisplayChannel(Number(backgroundBrightness.value)) * BACKGROUND_MAX, 0, BACKGROUND_MAX);
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

function clearBackgroundSnap() {
  backgroundSnapValue = null;
  backgroundStick.hidden = true;
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

function hasUsableBackgroundEncoding(values: number[], requestedValue: number): boolean {
  if (!values.every(Number.isFinite)) return false;
  // An all-zero payload is valid only for a genuinely black background. The
  // core also uses an all-zero vector for an unrecoverable evaluation, so do
  // not let that error path black out a non-black surround.
  return requestedValue <= 1.0e-12 || values.some((value) => Math.abs(value) > 1.0e-12);
}

function updatePreview(values: Float64Array) {
  indicatorReady = true;
  const valid = values[0] > 0.5;
  const directSrgb = currentProfile() === 3;
  const useDisplayP3 = profileUsesDisplayP3(currentProfile());
  const displayOffset = useDisplayP3 ? 8 : 14;
  const neutralOffset = useDisplayP3 ? 11 : 17;
  neutralDisplay = [values[neutralOffset], values[neutralOffset + 1], values[neutralOffset + 2]].map((value) =>
    Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
  ) as [number, number, number];
  neutralDisplaySrgb = [values[17], values[18], values[19]].map((value) =>
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
  const requestedBackground = Math.max(0, Math.min(BACKGROUND_MAX, backgroundValueFromSlider()));
  if (hasUsableBackgroundEncoding(background, requestedBackground)
    && hasUsableBackgroundEncoding(backgroundSrgb, requestedBackground)) {
    const value = requestedBackground;
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
  evaluatedStateKey = evaluationKey();
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
  uiRevision += 1;
  invalidateEvaluation();
  clearBackgroundSnap();
  latestProfileConversion += 1;
  profileConversionPending = false;
  generation += 1;
  cancelActiveRender(generation);
  latestSetRequest += 1;
  latestSetRevision = uiRevision;
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
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(value);
  } catch {
    try {
      acescgEncodedValue.focus();
      acescgEncodedValue.select();
      document.execCommand?.("copy");
    } catch {
      // Clipboard access is optional; the input remains selected for manual
      // copying when both browser APIs are unavailable.
    }
  }
}

function restoreCachedRender(): boolean {
  const state = currentState();
  const profile = currentProfile();
  const useDisplayP3 = profileUsesDisplayP3(profile);
  const key = renderKey(profile, state.reflectance, useDisplayP3);
  const pixels = displayedResolution === "full"
    ? cachedRenderPixelsForState(displayState(), key)
    : undefined;
  if (!pixels) {
    return false;
  }
  ensureRenderSurface(displayedResolution, useDisplayP3);
  image.data.set(pixels);
  imageRenderKey = key;
  context.putImageData(image, 0, 0);
  return true;
}

function drawIndicators() {
  // Indicators live on a separate transparent canvas. Replacing/resizing the
  // raster below it can therefore never expose a blank line, picked dot, or
  // ColorChecker layer while a newer evaluation is pending.
  if (!indicatorReady) return;
  const state = currentState();
  const profile = currentProfile();
  // During an input burst the previous indicator frame remains untouched.
  // Wait for the evaluator and raster that match the new complete state before
  // publishing replacement geometry, so stale geometry never flashes over a
  // different gamut slice.
  if (evaluatedStateKey !== evaluationKey()) return;
  const useDisplayP3 = profileUsesDisplayP3(profile);
  const rasterKey = renderKey(profile, state.reflectance, useDisplayP3);
  if (imageRenderKey !== rasterKey) return;
  const width = indicatorCanvas.width;
  const height = indicatorCanvas.height;
  if (width <= 0 || height <= 0) return;
  indicatorContext.clearRect(0, 0, width, height);
  // Keep the last accepted ColorChecker dots visible while a newer
  // white-balance solve is in flight. The response replaces the complete set
  // in one paint, avoiding a blank interval between old and new dots.
  const drawColorchecker = colorcheckerPointsProfile === profile
    && colorcheckerPoints.length === COLORCHECKER_NAMES.length;
  const angle = (adaptedHue * Math.PI) / 180;
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
    ? cssDisplayColor([1, 1, 1], useDisplayP3, [1, 1, 1], indicatorDisplayP3Canvas)
    : cssDisplayColor(
        neutralDisplay,
        useDisplayP3,
        neutralDisplaySrgb,
        indicatorDisplayP3Canvas,
      );
  indicatorContext.save();
  if (drawColorchecker) for (const patch of colorcheckerPoints) {
    const patchAngle = (patch.adaptedHue * Math.PI) / 180;
    const patchRadius = (patch.adaptedSaturation / 100) * radius;
    const patchX = centerX - patchRadius * Math.sin(patchAngle);
    const patchY = centerY - patchRadius * Math.cos(patchAngle);
    // Availability is diagnostic only: every fixed reference keeps its exact
    // position and forward-rendered dot color, including out-of-cone sources.
    indicatorContext.fillStyle = cssDisplayColor(
      patch.display,
      useDisplayP3,
      patch.displaySrgb,
      indicatorDisplayP3Canvas,
    );
    indicatorContext.beginPath();
    indicatorContext.arc(patchX, patchY, COLORCHECKER_DOT_RADIUS * (width / FULL_RESOLUTION), 0, 2 * Math.PI);
    indicatorContext.fill();
  }
  indicatorContext.strokeStyle = color;
  indicatorContext.fillStyle = color;
  const indicatorScale = width / FULL_RESOLUTION;
  indicatorContext.lineWidth = Math.max(0.5, 3 * indicatorScale);
  const neutralAngle = (adaptedNeutralHue * Math.PI) / 180;
  const neutralRadius = (adaptedNeutralSaturation / 100) * radius;
  const neutralX = centerX - neutralRadius * Math.sin(neutralAngle);
  const neutralY = centerY - neutralRadius * Math.cos(neutralAngle);
  indicatorContext.beginPath();
  indicatorContext.moveTo(neutralX, neutralY);
  indicatorContext.lineTo(dotX, dotY);
  indicatorContext.stroke();
  indicatorContext.beginPath();
  indicatorContext.arc(dotX, dotY, Math.max(2, 8 * indicatorScale), 0, 2 * Math.PI);
  indicatorContext.fill();
  indicatorContext.restore();
}

function parseColorcheckerPoints(values: Float64Array, profile: number): ColorCheckerPoint[] {
  const points: ColorCheckerPoint[] = [];
  const adaptedLength = COLORCHECKER_NAMES.length * 12;
  const legacyLength = COLORCHECKER_NAMES.length * 10;
  if (values.length !== adaptedLength && values.length !== legacyLength) return [];
  const stride = values.length === adaptedLength ? 12 : 10;
  for (let offset = 0; offset + stride - 1 < values.length && points.length < COLORCHECKER_NAMES.length; offset += stride) {
    const displayOffset = profileUsesDisplayP3(profile) ? 3 : 6;
    const sourceHue = values[offset];
    const sourceSaturation = values[offset + 1];
    const sourceReflectance = values[offset + 2];
    const display = [values[offset + displayOffset], values[offset + displayOffset + 1], values[offset + displayOffset + 2]];
    const displaySrgb = [values[offset + 6], values[offset + 7], values[offset + 8]];
    const available = values[offset + 9];
    const adaptedHue = stride === 12 ? values[offset + 10] : sourceHue;
    const adaptedSaturation = stride === 12 ? values[offset + 11] : sourceSaturation;
    if (
      ![sourceHue, sourceSaturation, sourceReflectance, ...display, ...displaySrgb, available, adaptedHue, adaptedSaturation]
        .every(Number.isFinite)
      || sourceHue < 0 || sourceHue > 360
      || sourceSaturation < 0 || sourceSaturation > SATURATION_MAX
      || sourceReflectance < 0 || sourceReflectance > REFLECTANCE_MAX
      || adaptedHue < 0 || adaptedHue > 360
      || adaptedSaturation < 0 || adaptedSaturation > SATURATION_MAX
    ) {
      return [];
    }
    points.push({
      name: COLORCHECKER_NAMES[points.length],
      hue: sourceHue,
      saturation: sourceSaturation,
      reflectance: sourceReflectance,
      display: display as [number, number, number],
      displaySrgb: displaySrgb as [number, number, number],
      available: available > 0.5,
      adaptedHue,
      adaptedSaturation,
    });
  }
  if (points.length !== COLORCHECKER_NAMES.length) return [];
  hueStickElements.forEach((marker, index) => {
    const patch = points[index];
    marker.style.left = patch ? `${(patch.hue / 360) * 100}%` : "0%";
  });
  return points;
}

function requestPreview(id: number) {
  const state = currentState();
  const profile = currentProfile();
  const display = displayState();
  const background = backgroundValueFromSlider();
  workers[0].postMessage({ kind: "evaluate", id, profile, ...state, ...display, background });
}

function queueColorcheckerRequest() {
  if (colorcheckerPostQueued || colorcheckerInFlight) return;
  colorcheckerPostQueued = true;
  requestAnimationFrame(() => {
    colorcheckerPostQueued = false;
    if (colorcheckerInFlight || colorcheckerPostedRequest === latestColorcheckerRequest) return;
    const requestId = latestColorcheckerRequest;
    const nextProfile = currentProfile();
    const nextDisplay = displayState();
    colorcheckerPostedRequest = requestId;
    colorcheckerInFlight = true;
    colorcheckerWorker.postMessage({ kind: "colorchecker", id: requestId, profile: nextProfile, ...nextDisplay });
  });
}

function requestColorchecker() {
  latestColorcheckerRequest += 1;
  const profile = currentProfile();
  if (colorcheckerPointsProfile !== profile) {
    colorcheckerPoints = [];
    colorcheckerPointsProfile = -1;
  }
  colorcheckerPointsKey = "";
  updateStickMarkers();
  drawIndicators();
  queueColorcheckerRequest();
}

function requestProfileConversion() {
  const profile = currentProfile();
  if (profile === sliderProfile) {
    latestProfileConversion += 1;
    profileConversionPending = false;
    profileConversionRevision = uiRevision;
    cancelActiveRender();
    clearBackgroundSnap();
    updateProfileFooter();
    updateLabels();
    updateStickMarkers();
    requestColorchecker();
    scheduleUpdate();
    return;
  }
  const state = currentState();
  const sourceIsDirectSrgb = sliderProfile === 3;
  const retained = sourceIsDirectSrgb ? retainedOutputSrgbEncoded : retainedAcescgEncoded;
  // Invalidate a pending hex-entry response. A profile switch can return to
  // the same profile ID before that response arrives, so the profile check
  // alone is not sufficient to establish that it still belongs to the UI
  // state being edited.
  latestSetRequest += 1;
  latestProfileConversion += 1;
  profileConversionRevision = uiRevision;
  profileConversionPending = true;
  invalidateEvaluation();
  clearBackgroundSnap();
  const cancellationId = Math.max(generation + 1, activeRenderId + 1);
  generation = cancellationId;
  cancelActiveRender(cancellationId);
  updateProfileFooter();
  updateLabels();
  updateStickMarkers();
  workers[0].postMessage({
    kind: "profile-convert",
    id: latestProfileConversion,
    profile,
    sourceProfile: sliderProfile,
    sourceHue: state.hue,
    sourceSaturation: state.saturation,
    background: backgroundValueFromSlider(),
    reflectance: state.reflectance,
    red: retained[0],
    green: retained[1],
    blue: retained[2],
    ...displayState(),
  });
}

function cancelActiveRender(cancellationId?: number) {
  // Row workers cannot be interrupted while a WASM call is synchronous, but
  // the cancellation marker prevents queued obsolete blocks from starting.
  const cancelId = cancellationId ?? Math.max(generation, activeRenderId + 1);
  workers.forEach((worker) => worker.postMessage({ kind: "cancel-render", id: cancelId }));
  pendingRenderRequest = undefined;
  activeRenderPixels = undefined;
  pendingRows = 0;
  activeRenderPendingWorkers.clear();
  activeRenderId = -1;
  activeRenderKey = "";
  activeRenderProfile = -1;
  activeRenderDisplayP3 = false;
  activeRenderCancelRequested = false;
}

function failActiveRender() {
  activeRenderPixels = undefined;
  activeRenderPendingWorkers.clear();
  pendingRows = 0;
  pendingRenderRequest = undefined;
  activeRenderId = -1;
  activeRenderKey = "";
  activeRenderProfile = -1;
  activeRenderDisplayP3 = false;
  activeRenderCancelRequested = false;
}

function failEvaluation(id: number) {
  if (id !== generation) return;
  evaluatedStateKey = "";
  preview.classList.add("preview-unavailable");
  preview.style.backgroundColor = "#000";
  drawIndicators();
}

function failProfileConversion(id: number) {
  if (id !== latestProfileConversion || !profileConversionPending) return;
  profileConversionPending = false;
  profileSelect.value = sliderProfile.toString();
  updateProfileFooter();
  updateLabels();
  requestColorchecker();
  scheduleUpdate();
}

function handleWorkerError(response: WorkerErrorResponse) {
  switch (response.operation) {
    case "render":
      // A stale row failure must not tear down a newer frame that has already
      // replaced it in the assembly buffer.
      if (response.id === activeRenderId) failActiveRender();
      return;
    case "evaluate":
      failEvaluation(response.id);
      return;
    case "colorchecker":
      if (response.id === colorcheckerPostedRequest) {
        colorcheckerInFlight = false;
        if (latestColorcheckerRequest !== response.id) queueColorcheckerRequest();
      }
      return;
    case "set":
      // Keep the last committed color visible when a hex conversion fails.
      // The user can correct the field and submit again.
      return;
    case "profile-convert":
      failProfileConversion(response.id);
      return;
    default:
      return;
  }
}

function scheduleControlUpdate(resolution?: RenderResolution, refreshColorchecker = false) {
  uiRevision += 1;
  invalidateEvaluation();
  if (profileConversionPending) {
    // Until the target profile conversion commits, the current Refl/Hue/Sat
    // values still belong to sliderProfile. Re-run conversion against the
    // latest edited source state instead of evaluating the target prematurely.
    queueAnimationFrame();
    return;
  }
  if (refreshColorchecker) requestColorchecker();
  scheduleEvaluation(resolution, false);
}

function requestRender(id: number, resolution: RenderResolution) {
  const state = currentState();
  const profile = currentProfile();
  const useDisplayP3 = profileUsesDisplayP3(profile);
  const display = displayState();
  const size = resolutionSize(resolution);
  const cacheKey = renderKey(profile, state.reflectance, useDisplayP3, display);
  if (activeRenderPixels) {
    if (
      activeRenderKey === cacheKey
      && activeRenderResolution === resolution
      && activeRenderWidth === size
      && activeRenderHeight === size
      && !activeRenderCancelRequested
    ) {
      // The in-flight render already describes the newest state, so discard
      // any older request that was waiting behind it.
      pendingRenderRequest = undefined;
      return;
    }
    // Keep only the newest request while the current raster is assembled.
    // It will be launched after the current render has been published.
    pendingRenderRequest = { id, resolution };
    if (resolution === "preview" && activeRenderResolution === "full" && !activeRenderCancelRequested) {
      activeRenderCancelRequested = true;
      const cancelId = Math.max(id, activeRenderId + 1);
      workers.forEach((worker) => worker.postMessage({ kind: "cancel-render", id: cancelId }));
    } else if (resolution === "full" && activeRenderResolution === "full" && !activeRenderCancelRequested) {
      // A new settled full slice supersedes an older settled slice just as a
      // drag preview does. Waiting for the obsolete 512x512 frame makes Reset,
      // Recall, and profile changes appear unresponsive.
      activeRenderCancelRequested = true;
      const cancelId = Math.max(id, activeRenderId + 1);
      workers.forEach((worker) => worker.postMessage({ kind: "cancel-render", id: cancelId }));
    }
    return;
  }
  const cachedPixels = resolution === "full"
    ? cachedRenderPixelsForState(display, cacheKey)
    : undefined;
  if (cachedPixels) {
    ensureRenderSurface(resolution, useDisplayP3);
    image.data.set(cachedPixels);
    imageRenderKey = cacheKey;
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
  activeRenderPendingWorkers = new Set(workers.map((_, index) => index));
  activeRenderCancelRequested = false;
  activeRenderId = id;
  activeRenderKey = cacheKey;
  activeRenderProfile = profile;
  activeRenderDisplayP3 = useDisplayP3;
  activeRenderResolution = resolution;
  activeRenderWidth = size;
  activeRenderHeight = size;
  activeRenderWhiteBalance = display;
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
      ...display,
    });
  });
}

function queueAnimationFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    if (profileConversionPending) {
      if (profileConversionRevision !== uiRevision) requestProfileConversion();
      return;
    }
    const nextResolution = queuedRenderResolution;
    queuedRenderResolution = undefined;
    generation += 1;
    const id = generation;
    requestPreview(id);
    if (nextResolution) requestRender(id, nextResolution);
  });
}

function launchPendingRender() {
  const pending = pendingRenderRequest;
  if (!pending) return;
  pendingRenderRequest = undefined;
  requestRender(pending.id, pending.resolution);
}

function scheduleEvaluation(resolution?: RenderResolution, _alreadyInvalidated = false) {
  if (!_alreadyInvalidated) invalidateEvaluation();
  if (resolution) queuedRenderResolution = resolution;
  updateLabels();
  queueAnimationFrame();
}

function scheduleUpdate(resolution: RenderResolution = "full") {
  invalidateEvaluation();
  queuedRenderResolution = resolution;
  // Keep the currently published raster on screen while the replacement is
  // assembled in its own buffer.
  updateLabels();
  queueAnimationFrame();
}

workers.forEach((worker, workerIndex) => {
  worker.onmessage = (event: MessageEvent<RenderResponse | RenderCancelledResponse | EvaluateResponse | ColorCheckerResponse | SetResponse | ProfileConvertResponse | WorkerErrorResponse>) => {
    const response = event.data;
    if (response.kind === "worker-error") {
      handleWorkerError(response);
      return;
    }
    if (response.kind === "colorchecker") {
      if (response.id !== colorcheckerPostedRequest) return;
      colorcheckerInFlight = false;
      const isCurrent = response.id === latestColorcheckerRequest
        && response.profile === currentProfile();
      const display = displayState();
      if (isCurrent && response.temp === display.temp && response.tint === display.tint) {
        if (!ArrayBuffer.isView(response.points)) {
          if (latestColorcheckerRequest !== response.id) queueColorcheckerRequest();
          return;
        }
        const parsed = parseColorcheckerPoints(response.points, response.profile);
        if (parsed.length === COLORCHECKER_NAMES.length) {
          colorcheckerPoints = parsed;
          colorcheckerPointsProfile = response.profile;
          colorcheckerPointsKey = colorcheckerKey(response.profile, display);
          updateStickMarkers();
          drawIndicators();
        }
      }
      if (latestColorcheckerRequest !== response.id) queueColorcheckerRequest();
      return;
    }
    if (response.kind === "set") {
      if (response.profile !== currentProfile()) return;
      if (response.id !== latestSetRequest) return;
      if (response.id !== latestSetRequest || latestSetRevision !== uiRevision) return;
      const display = displayState();
      if (response.temp !== display.temp || response.tint !== display.tint) return;
      if (!ArrayBuffer.isView(response.values)) return;
      const coordinatesFinite = response.values.length >= 4
        && Array.from(response.values.slice(1, 4)).every(Number.isFinite);
      if (!coordinatesFinite) {
        return;
      }
      setReflectanceValue(response.values[1]);
      setHueValue(response.values[2]);
      setSaturationValue(response.values[3]);
      clearBackgroundSnap();
      uiRevision += 1;
      invalidateEvaluation();
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
        profileConversionRevision !== uiRevision
        || response.sourceProfile !== sliderProfile
        || !sameNumber(response.sourceReflectance, currentState().reflectance)
        || !sameNumber(response.sourceHue, currentState().hue)
        || !sameNumber(response.sourceSaturation, currentState().saturation)
        || !sameNumber(response.temp, display.temp)
        || !sameNumber(response.tint, display.tint)
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
      if (!ArrayBuffer.isView(response.values)) {
        profileSelect.value = sliderProfile.toString();
        updateProfileFooter();
        requestColorchecker();
        scheduleUpdate();
        return;
      }
      const coordinatesFinite = response.values.length >= 4
        && Array.from(response.values.slice(1, 4)).every(Number.isFinite);
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
      setHueValue(response.values[2]);
      setSaturationValue(response.values[3]);
      backgroundBrightness.max = BACKGROUND_SLIDER_MAX.toString();
      backgroundBrightness.value = backgroundSliderPosition(response.background).toString();
      sliderProfile = response.profile;
      requestColorchecker();
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
      const state = currentState();
      if (
        response.reflectance !== state.reflectance
        || response.hue !== state.hue
        || response.saturation !== state.saturation
      ) return;
      if (!ArrayBuffer.isView(response.values)) {
        failEvaluation(response.id);
        return;
      }
      if (response.values.length < 37) {
        failEvaluation(response.id);
        return;
      }
      evaluatedStateKey = evaluationKey(response.profile, state, display, response.background);
      updatePreview(response.values);
      return;
    }
    if (response.kind === "render-cancelled") {
      // A worker can observe a newer render generation before it starts an
      // older row block. Account for that block explicitly so the main thread
      // can discard the partial frame and launch the pending generation.
      if (response.id !== activeRenderId || !activeRenderPixels) return;
      if (response.profile !== activeRenderProfile) return;
      if (
        response.width !== activeRenderWidth
        || response.height !== activeRenderHeight
      ) return;
      if (!activeRenderPendingWorkers.delete(workerIndex)) return;
      pendingRows = activeRenderPendingWorkers.size;
      if (pendingRows === 0) {
        activeRenderPendingWorkers.clear();
        activeRenderPixels = undefined;
        activeRenderId = -1;
        activeRenderKey = "";
        activeRenderProfile = -1;
        activeRenderDisplayP3 = false;
        activeRenderCancelRequested = false;
        launchPendingRender();
      }
      return;
    }
    if (response.kind !== "render") return;
    // A slice render remains valid across Hue/Sat preview generations.
    if (response.id !== activeRenderId || !activeRenderPixels) return;
    if (response.profile !== activeRenderProfile) return;
    if (
      response.width !== activeRenderWidth
      || response.height !== activeRenderHeight
    ) return;
    const offset = response.yStart * activeRenderWidth * 4;
    const rowsPerWorker = Math.ceil(activeRenderHeight / workers.length);
    const expectedStart = workerIndex * rowsPerWorker;
    const expectedEnd = Math.min(activeRenderHeight, expectedStart + rowsPerWorker);
    const expectedLength = Math.max(0, expectedEnd - expectedStart) * activeRenderWidth * 4;
    if (
      response.yStart !== expectedStart
      || !Number.isInteger(response.yStart)
      || response.yStart < 0
      || response.yStart > activeRenderHeight
      || offset < 0
      || !(response.pixels instanceof Uint8Array)
      || offset + response.pixels.length > activeRenderPixels.length
      || response.pixels.length !== expectedLength
    ) {
      failActiveRender();
      return;
    }
    if (!activeRenderPendingWorkers.delete(workerIndex)) return;
    activeRenderPixels.set(response.pixels, offset);
    pendingRows = activeRenderPendingWorkers.size;
    if (pendingRows === 0) {
      const completedKey = activeRenderKey;
      const completedResolution = activeRenderResolution;
      const completedPixels = activeRenderPixels;
      if (completedResolution === "full") {
        const completedRender = { key: completedKey, pixels: completedPixels };
        lastCompletedFullRender = completedRender;
        if (activeRenderWhiteBalance.temp === TEMPERATURE_DEFAULT && activeRenderWhiteBalance.tint === TINT_DEFAULT) {
          cachedIdentityRender = completedRender;
        } else if (sameWhiteBalance(activeRenderWhiteBalance, storedWhiteBalance)) {
          cachedStoredRender = completedRender;
        }
      }
      ensureRenderSurface(completedResolution, activeRenderDisplayP3);
      image.data.set(completedPixels);
      imageRenderKey = completedKey;
      // Publish the fully assembled raster to the base canvas. Indicators are
      // painted on their separate transparent layer below, so this operation
      // cannot erase them.
      context.putImageData(image, 0, 0);
      activeRenderPixels = undefined;
      activeRenderId = -1;
      activeRenderKey = "";
      activeRenderProfile = -1;
      activeRenderDisplayP3 = false;
      activeRenderCancelRequested = false;
      // Keep the last accepted overlay composited even when this frame was
      // superseded while it was rendering. The pending frame will replace it
      // without exposing a blank indicator interval.
      drawIndicators();
      const pending = pendingRenderRequest;
      activeRenderPendingWorkers.clear();
      if (pending) {
        launchPendingRender();
      }
    }
  };
  worker.onerror = () => {
    // A failed raster worker only invalidates the in-flight raster. Preserve a
    // valid picked-color preview and let the next control update retry the
    // slice. Worker zero owns evaluation/profile conversion, while the
    // selected ColorChecker worker owns the patch solve.
    if (activeRenderPixels) failActiveRender();
    if (workerIndex === 0) {
      failEvaluation(generation);
      failProfileConversion(latestProfileConversion);
    }
    if (workerIndex === colorcheckerWorkerIndex && colorcheckerInFlight) {
      colorcheckerInFlight = false;
      if (latestColorcheckerRequest !== colorcheckerPostedRequest) queueColorcheckerRequest();
    }
  };
});

reflectance.addEventListener("input", () => {
  snapReflectanceInput();
  scheduleControlUpdate("preview");
});
function settleReflectanceInput() {
  // Pointer/keyboard settlement is explicit because snapping may leave the
  // control at its previously committed value and suppress a native change.
  scheduleControlUpdate("full");
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
  scheduleControlUpdate();
});
saturation.addEventListener("input", () => {
  snapSaturationInput();
  scheduleControlUpdate();
});
function settleDisplayWhiteBalanceInput() {
  scheduleControlUpdate("full", true);
}
temperature.addEventListener("input", () => {
  temperatureReadoutUsesSliderStep = true;
  snapTemperatureInput();
  temperatureNumber.value = formatTemperature(temperatureValueFromSlider(), true);
  scheduleControlUpdate("preview", true);
});
tint.addEventListener("input", () => {
  snapTintInput();
  tintNumber.value = formatTint(tintValueFromSlider());
  scheduleControlUpdate("preview", true);
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
temperatureNumber.addEventListener("input", () => {
  const raw = temperatureNumber.value.trim();
  if (raw.length === 0) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  temperatureReadoutUsesSliderStep = false;
  setTemperatureValue(Math.max(TEMPERATURE_MIN, Math.min(TEMPERATURE_MAX, value)));
  snapTemperatureInput();
  scheduleControlUpdate("preview", true);
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
  scheduleControlUpdate("full", true);
});
tintNumber.addEventListener("input", () => {
  const raw = tintNumber.value.trim();
  if (raw.length === 0) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  setTintValue(Math.max(TINT_MIN, Math.min(TINT_MAX, value)));
  snapTintInput();
  scheduleControlUpdate("preview", true);
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
  scheduleControlUpdate("full", true);
});
whiteBalanceReset.addEventListener("click", () => {
  temperatureReadoutUsesSliderStep = true;
  setTemperatureValue(TEMPERATURE_DEFAULT);
  setTintValue(TINT_DEFAULT);
  scheduleControlUpdate("full", true);
});
whiteBalanceStore.addEventListener("click", () => {
  const nextWhiteBalance = { ...displayState() };
  const previousWhiteBalance = storedWhiteBalance;
  storedWhiteBalance = nextWhiteBalance;
  if (!sameWhiteBalance(previousWhiteBalance, nextWhiteBalance)) {
    cachedStoredRender = undefined;
  }
  const state = currentState();
  const key = renderKey(currentProfile(), state.reflectance, profileUsesDisplayP3(currentProfile()));
  if (lastCompletedFullRender?.key === key) {
    cachedStoredRender = lastCompletedFullRender;
  }
  updateLabels();
  scheduleControlUpdate("full");
});
whiteBalanceRecall.addEventListener("click", () => {
  if (!storedWhiteBalance) return;
  temperatureReadoutUsesSliderStep = false;
  setTemperatureValue(storedWhiteBalance.temp);
  setTintValue(storedWhiteBalance.tint);
  scheduleControlUpdate("full", true);
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
    "preview",
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
    "full",
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
    undefined,
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
    undefined,
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
    undefined,
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
    undefined,
  );
});
backgroundBrightness.addEventListener("input", () => {
  snapBackgroundInput();
  // The adapted surround can be chromatic. Keep the last committed color on
  // screen until the evaluator returns instead of flashing a temporary
  // unadapted gray value on every pointer event.
  backgroundBrightnessValue.textContent = Math.max(0, Math.min(BACKGROUND_MAX, backgroundValueFromSlider())).toFixed(3);
  uiRevision += 1;
  invalidateEvaluation();
  if (profileConversionPending) {
    queueAnimationFrame();
    return;
  }
  scheduleEvaluation();
});
profileSelect.addEventListener("change", () => {
  uiRevision += 1;
  requestProfileConversion();
});
acescgCopy.addEventListener("click", () => void copyEncodedValue());
acescgSet.addEventListener("click", requestSetFromEncoded);
acescgEncodedValue.addEventListener("input", () => {
  latestSetRequest += 1;
  uiRevision += 1;
  acescgEncodedValue.setCustomValidity("");
});
acescgEncodedValue.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    requestSetFromEncoded();
  }
});
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
