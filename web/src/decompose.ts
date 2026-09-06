import "./decompose.css";

type SourceSummary = {
  format: string;
  width: number;
  height: number;
  gamut?: string | null;
  transfer?: string | null;
  metadata_source?: string | null;
  automatic_icc?: boolean;
  warnings?: string[];
};

type Request = { format: string; gamut?: string | null; transfer?: string | null; profile: number; refl: number; blur_sigma: number };
type Report = {
  width: number;
  height: number;
  pixel_count: number;
  profile: number;
  refl: number;
  blur_sigma: number;
  projected_pixels: number;
  clipped_pixels: number;
  non_finite_pixels: number;
  exposure_min: number;
  exposure_max: number;
  exposure_mean: number;
  base_min: number;
  base_max: number;
  base_mean: number;
  target_j_hk: number;
  solver_status: string;
  compute_backend: string;
  gpu_adapter?: string | null;
  gpu_validation?: string | null;
  batch_size: number;
  preview_transform: string;
  preview_encoding: string;
  preview_backend: string;
  preview_transform_ms: number;
  warnings: string[];
};
type ProgressMessage = { kind: "progress"; id: number; stage: string; percent: number; counters?: Record<string, number | undefined> };
type WorkerMessage =
  | ProgressMessage
  | { kind: "inspect-result"; id: number; summary: SourceSummary }
  | { kind: "result"; id: number; report: Report; base_exr: Uint8Array; exposure_exr: Uint8Array; exposure_rgb_exr: Uint8Array; base_preview_jpeg: Uint8Array; exposure_preview_jpeg: Uint8Array }
  | { kind: "error"; id: number; message: string }
  | { kind: "cancelled"; id: number };

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element ${selector}`);
  return element;
};

const fileInput = $("#file-input") as HTMLInputElement;
const uploadButton = $("#upload-button") as HTMLButtonElement;
const metadataSummary = $("#metadata-summary");
const metadataWarning = $("#metadata-warning");
const gamutSelect = $("#source-gamut") as HTMLSelectElement;
const transferSelect = $("#source-transfer") as HTMLSelectElement;
const interpretationFields = $("#interpretation-fields") as HTMLDivElement;
const overrideSource = $("#override-source") as HTMLButtonElement;
const interpretationError = $("#interpretation-error");
const profileSelect = $("#aces-profile") as HTMLSelectElement;
const reflInput = $("#refl") as HTMLInputElement;
const optionsError = $("#options-error");
const calculateButton = $("#calculate-button") as HTMLButtonElement;
const cancelButton = $("#cancel-button") as HTMLButtonElement;
const workerBadge = $("#worker-badge");
const webGpuHelp = $("#webgpu-help");
const progressStage = $("#progress-stage");
const progressPercent = $("#progress-percent") as HTMLOutputElement;
const progressBar = $("#progress-bar") as HTMLProgressElement;
const progressCounters = $("#progress-counters");
const processingStatus = $("#processing-status");
const emptyReport = $("#empty-report");
const reportContent = $("#report-content");
const reportSummary = $("#report-summary");
const reportWarnings = $("#report-warnings");
const reportMetrics = $("#report-metrics");
const downloadBase = $("#download-base") as HTMLButtonElement;
const downloadExposure = $("#download-exposure") as HTMLButtonElement;
const downloadExposureRgb = $("#download-exposure-rgb") as HTMLButtonElement;
const downloadBasePreview = $("#download-base-preview") as HTMLButtonElement;
const downloadExposurePreview = $("#download-exposure-preview") as HTMLButtonElement;
const basePreviewTrigger = $("#base-preview-trigger") as HTMLButtonElement;
const exposurePreviewTrigger = $("#exposure-preview-trigger") as HTMLButtonElement;
const previewOverlay = $("#preview-overlay") as HTMLDivElement;
const previewOverlayImage = $("#preview-overlay-image") as HTMLImageElement;
const previewOverlayLabel = $("#preview-overlay-label");
const closePreviewButton = $("#close-preview") as HTMLButtonElement;
const basePreviewImage = $("#base-preview-image") as HTMLImageElement;
const exposurePreviewImage = $("#exposure-preview-image") as HTMLImageElement;
const baseSize = $("#base-size");
const exposureSize = $("#exposure-size");
const exposureRgbSize = $("#exposure-rgb-size");
const basePreviewSize = $("#base-preview-size");
const exposurePreviewSize = $("#exposure-preview-size");

let worker = createWorker();
let selectedFile: File | undefined;
let selectedFormat = "";
let inspectionId = 0;
let jobId = 0;
let activeJob: number | undefined;
let automaticIccAvailable = false;
let sourceOverrideActive = false;
let baseBytes: Uint8Array | undefined;
let exposureBytes: Uint8Array | undefined;
let exposureRgbBytes: Uint8Array | undefined;
let basePreviewBytes: Uint8Array | undefined;
let exposurePreviewBytes: Uint8Array | undefined;
let baseUrl: string | undefined;
let exposureUrl: string | undefined;
let exposureRgbUrl: string | undefined;
let basePreviewUrl: string | undefined;
let exposurePreviewUrl: string | undefined;
let webGpuHelpPinned = false;

function setWebGpuHelpVisible(visible: boolean): void {
  webGpuHelp.hidden = !visible;
  workerBadge.setAttribute("aria-expanded", String(visible));
}

function createWorker(): Worker {
  const instance = new Worker(new URL("./decompose_worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = (event: MessageEvent<WorkerMessage>) => onWorkerMessage(event.data);
  instance.onerror = (event) => {
    showStatus(event.message || "The decomposition worker failed.", true);
    setBusy(false);
  };
  return instance;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatCount(value: number): string { return new Intl.NumberFormat().format(Math.max(0, Math.round(value))); }
function formatPercent(value: number, total: number): string { return total > 0 ? `${(value / total * 100).toFixed(2)}%` : "0%"; }
function escapeText(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }

function detectFormat(file: File): string | undefined {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".png") || file.type === "image/png") return "png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || file.type === "image/jpeg") return "jpeg";
  if (lower.endsWith(".exr") || file.type === "image/x-exr") return "exr";
  if (lower.endsWith(".heic") || file.type === "image/heic") return "heic";
  if (lower.endsWith(".heif") || file.type === "image/heif") return "heif";
  return undefined;
}

function revokeUrls(): void {
  if (baseUrl) URL.revokeObjectURL(baseUrl);
  if (exposureUrl) URL.revokeObjectURL(exposureUrl);
  if (exposureRgbUrl) URL.revokeObjectURL(exposureRgbUrl);
  if (basePreviewUrl) URL.revokeObjectURL(basePreviewUrl);
  if (exposurePreviewUrl) URL.revokeObjectURL(exposurePreviewUrl);
  baseUrl = undefined;
  exposureUrl = undefined;
  exposureRgbUrl = undefined;
  basePreviewUrl = undefined;
  exposurePreviewUrl = undefined;
}

function clearPreview(image: HTMLImageElement): void {
  image.src = "";
  image.hidden = true;
}

function closePreview(): void {
  previewOverlay.hidden = true;
  previewOverlayImage.src = "";
  document.body.classList.remove("preview-open");
}

function openPreview(kind: "base" | "exposure"): void {
  const url = kind === "base" ? basePreviewUrl : exposurePreviewUrl;
  if (!url) return;
  previewOverlayImage.src = url;
  previewOverlayImage.alt = kind === "base" ? "Enlarged base preview JPEG" : "Enlarged exposure preview JPEG";
  previewOverlayLabel.textContent = kind === "base" ? "Base preview · P3-D65 / sRGB" : "Exposure preview · P3-D65 / sRGB";
  downloadBasePreview.hidden = kind !== "base";
  downloadExposurePreview.hidden = kind !== "exposure";
  previewOverlay.hidden = false;
  document.body.classList.add("preview-open");
  closePreviewButton.focus();
}

function showPreview(image: HTMLImageElement, url: string | undefined): void {
  if (!url) {
    clearPreview(image);
    return;
  }
  image.src = url;
  image.hidden = false;
}

function showStatus(message: string, error = false): void {
  processingStatus.hidden = false;
  processingStatus.textContent = message;
  processingStatus.classList.toggle("callout-error", error);
  processingStatus.classList.toggle("callout-warning", !error);
}

function setBusy(busy: boolean): void {
  calculateButton.disabled = busy || !canCalculate();
  cancelButton.hidden = !busy;
  uploadButton.disabled = busy;
  gamutSelect.disabled = busy;
  transferSelect.disabled = busy;
  profileSelect.disabled = busy;
  reflInput.disabled = busy;
}

function canCalculate(): boolean {
  const manualOverride = sourceOverrideActive && Boolean(gamutSelect.value && transferSelect.value);
  const manualSelectionPresent = sourceOverrideActive && Boolean(gamutSelect.value || transferSelect.value);
  return Boolean(
    selectedFile
      && selectedFormat
      && validOptions()
      && (manualOverride || (automaticIccAvailable && !manualSelectionPresent)),
  );
}

function validOptions(): boolean {
  const refl = Number(reflInput.value);
  return Number.isFinite(refl) && refl > 0 && refl <= 1.2;
}

function normalizeReflDisplay(): void {
  const value = Number(reflInput.value);
  if (Number.isFinite(value)) reflInput.value = value.toFixed(3);
}

function updateCalculateState(): void {
  calculateButton.disabled = !canCalculate() || cancelButton.hidden === false;
}

function resetResults(): void {
  revokeUrls();
  baseBytes = undefined;
  exposureBytes = undefined;
  exposureRgbBytes = undefined;
  basePreviewBytes = undefined;
  exposurePreviewBytes = undefined;
  downloadBase.disabled = true;
  downloadExposure.disabled = true;
  downloadExposureRgb.disabled = true;
  downloadBasePreview.disabled = true;
  downloadExposurePreview.disabled = true;
  basePreviewTrigger.disabled = true;
  exposurePreviewTrigger.disabled = true;
  closePreview();
  clearPreview(basePreviewImage);
  clearPreview(exposurePreviewImage);
  baseSize.textContent = "Waiting for calculation";
  exposureSize.textContent = "Waiting for calculation";
  basePreviewSize.textContent = "Waiting for calculation";
  exposurePreviewSize.textContent = "Waiting for calculation";
  emptyReport.hidden = false;
  reportContent.hidden = true;
}

function renderSummary(summary: SourceSummary): void {
  selectedFormat = summary.format;
  automaticIccAvailable = Boolean(summary.automatic_icc);
  sourceOverrideActive = !automaticIccAvailable;
  interpretationFields.hidden = automaticIccAvailable;
  overrideSource.hidden = !automaticIccAvailable;
  const rows = [
    ["File", selectedFile?.name ?? "Unknown"],
    ["Size", selectedFile ? formatBytes(selectedFile.size) : "Unknown"],
    ["Format", summary.format.toUpperCase()],
    ["Dimensions", `${formatCount(summary.width)} × ${formatCount(summary.height)}`],
    ["Metadata", summary.metadata_source ?? "Profile metadata unavailable"],
  ];
  metadataSummary.innerHTML = rows.map(([label, value]) => `<dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd>`).join("");
  metadataSummary.hidden = false;
  const warnings = summary.warnings ?? [];
  if (warnings.length) {
    metadataWarning.textContent = warnings.join(" ");
    metadataWarning.hidden = false;
  }
  // Metadata is a starting point for the two override controls. An embedded
  // ICC profile remains authoritative until the user changes either value.
  gamutSelect.value = summary.gamut ?? "";
  transferSelect.value = summary.transfer ?? "";
  updateCalculateState();
}

function onWorkerMessage(message: WorkerMessage): void {
  if (message.id !== inspectionId && message.id !== activeJob) return;
  if (message.kind === "progress") {
    progressStage.textContent = message.stage;
    progressBar.value = Math.max(progressBar.value, Math.min(100, message.percent));
    progressPercent.value = String(progressBar.value);
    progressPercent.textContent = `${Math.round(progressBar.value)}%`;
    const counters = message.counters;
    if (counters) {
      const pieces: string[] = [];
      if (counters.processed !== undefined) pieces.push(`${formatCount(counters.processed)} pixels`);
      if (counters.projected !== undefined) pieces.push(`${formatCount(counters.projected)} projected`);
      if (counters.clipped !== undefined) pieces.push(`${formatCount(counters.clipped)} clipped`);
      if (counters.non_finite !== undefined) pieces.push(`${formatCount(counters.non_finite)} non-finite`);
      if (counters.encoded_bytes !== undefined) pieces.push(`${formatBytes(counters.encoded_bytes)} encoded`);
      progressCounters.textContent = pieces.join(" · ") || "Preparing pixels…";
    }
    return;
  }
  if (message.kind === "inspect-result") {
    renderSummary(message.summary);
    progressStage.textContent = "Ready for confirmation";
    progressBar.value = 0;
    progressPercent.value = "0";
    progressPercent.textContent = "0%";
    progressCounters.textContent = "Metadata inspection complete.";
    return;
  }
  if (message.kind === "cancelled") {
    activeJob = undefined;
    setBusy(false);
    showStatus("Calculation cancelled. No output files were retained.");
    progressStage.textContent = "Cancelled";
    return;
  }
  if (message.kind === "error") {
    activeJob = undefined;
    setBusy(false);
    showStatus(message.message, true);
    progressStage.textContent = "Error";
    return;
  }
  activeJob = undefined;
  baseBytes = message.base_exr;
  exposureBytes = message.exposure_exr;
  exposureRgbBytes = message.exposure_rgb_exr;
  basePreviewBytes = message.base_preview_jpeg;
  exposurePreviewBytes = message.exposure_preview_jpeg;
  revokeUrls();
  const basePart = new Uint8Array(baseBytes);
  const exposurePart = new Uint8Array(exposureBytes);
  const exposureRgbPart = new Uint8Array(exposureRgbBytes);
  const basePreviewPart = new Uint8Array(basePreviewBytes);
  const exposurePreviewPart = new Uint8Array(exposurePreviewBytes);
  baseUrl = URL.createObjectURL(new Blob([basePart.buffer as ArrayBuffer], { type: "image/x-exr" }));
  exposureUrl = URL.createObjectURL(new Blob([exposurePart.buffer as ArrayBuffer], { type: "image/x-exr" }));
  exposureRgbUrl = URL.createObjectURL(new Blob([exposureRgbPart.buffer as ArrayBuffer], { type: "image/x-exr" }));
  basePreviewUrl = URL.createObjectURL(new Blob([basePreviewPart.buffer as ArrayBuffer], { type: "image/jpeg" }));
  exposurePreviewUrl = URL.createObjectURL(new Blob([exposurePreviewPart.buffer as ArrayBuffer], { type: "image/jpeg" }));
  showPreview(basePreviewImage, basePreviewUrl);
  showPreview(exposurePreviewImage, exposurePreviewUrl);
  renderReport(message.report);
  downloadBase.disabled = false;
  downloadExposure.disabled = false;
  downloadExposureRgb.disabled = false;
  downloadBasePreview.disabled = false;
  downloadExposurePreview.disabled = false;
  basePreviewTrigger.disabled = false;
  exposurePreviewTrigger.disabled = false;
  baseSize.textContent = formatBytes(baseBytes.byteLength);
  exposureSize.textContent = formatBytes(exposureBytes.byteLength);
  exposureRgbSize.textContent = formatBytes(exposureRgbBytes.byteLength);
  basePreviewSize.textContent = formatBytes(basePreviewBytes.byteLength);
  exposurePreviewSize.textContent = formatBytes(exposurePreviewBytes.byteLength);
  setBusy(false);
  showStatus("Calculation complete. All five outputs are ready.");
}

function renderReport(report: Report): void {
  const profile = profileSelect.selectedOptions[0]?.textContent ?? String(report.profile);
  reportSummary.textContent = `${formatCount(report.width)} × ${formatCount(report.height)} pixels · ${profile} · Refl ${report.refl.toFixed(5)}`;
  const confirmedSource = gamutSelect.value && transferSelect.value
    ? `${gamutSelect.value} / ${transferSelect.value}`
    : automaticIccAvailable
      ? "Embedded ICC profile"
      : "Manual selection required";
  const metrics: Array<[string, string]> = [
    ["Pixel count", formatCount(report.pixel_count)],
    ["Confirmed source", confirmedSource],
    ["Projected pixels", `${formatCount(report.projected_pixels)} (${formatPercent(report.projected_pixels, report.pixel_count)})`],
    ["Clipped exposure", `${formatCount(report.clipped_pixels)} (${formatPercent(report.clipped_pixels, report.pixel_count)})`],
    ["Non-finite pixels", `${formatCount(report.non_finite_pixels)} (${formatPercent(report.non_finite_pixels, report.pixel_count)})`],
    ["Exposure range", `${report.exposure_min.toFixed(4)} to ${report.exposure_max.toFixed(4)} stops`],
    ["Exposure mean", report.exposure_mean.toFixed(4)],
    ["Base range", `${report.base_min.toFixed(4)} to ${report.base_max.toFixed(4)}`],
    ["Base mean", report.base_mean.toFixed(4)],
    ["Target J_HK", report.target_j_hk.toFixed(4)],
    ["Solver", report.solver_status],
    ["Compute backend", report.compute_backend],
    ["Batch size", formatCount(report.batch_size)],
    ["Preview transform", report.preview_transform],
    ["Preview encoding", report.preview_encoding],
    ["Preview backend", `${report.preview_backend} (${report.preview_transform_ms.toFixed(1)} ms)`],
    ["Base output", "Linear ACEScg/AP1 RGB, fp16"],
    ["Exposure output", "Normalized fp16 exposure channel"],
    ["Exposure RGB output", "Direct scalar s replicated to linear ACEScg RGB, fp16"],
    ["Base preview", "Display P3 JPEG, sRGB transfer"],
    ["Exposure preview", "Display P3 JPEG, sRGB transfer"],
  ];
  if (report.gpu_adapter) metrics.push(["GPU adapter", report.gpu_adapter]);
  if (report.gpu_validation) metrics.push(["GPU validation", report.gpu_validation]);
  reportMetrics.innerHTML = metrics.map(([label, value]) => `<div><dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd></div>`).join("");
  const warnings = report.warnings ?? [];
  reportWarnings.hidden = warnings.length === 0;
  reportWarnings.textContent = warnings.length ? warnings.join(" ") : "";
  emptyReport.hidden = true;
  reportContent.hidden = false;
}

async function inspectFile(file: File, format: string): Promise<void> {
  const bytes = await file.arrayBuffer();
  const id = ++inspectionId;
  worker.postMessage({ kind: "inspect", id, format, bytes }, [bytes]);
}

async function chooseFile(file: File): Promise<void> {
  const format = detectFormat(file);
  resetResults();
  sourceOverrideActive = false;
  if (!format) {
    selectedFile = undefined;
    selectedFormat = "";
    showStatus("Unsupported file type. Choose EXR, JPEG, PNG, HEIC, or HEIF.", true);
    setBusy(false);
    return;
  }
  selectedFile = file;
  selectedFormat = format;
  metadataSummary.hidden = true;
  metadataWarning.hidden = true;
  progressStage.textContent = "Inspecting metadata";
  progressBar.value = 0;
  progressPercent.textContent = "0%";
  try {
    await inspectFile(file, format);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
  updateCalculateState();
}

async function calculate(): Promise<void> {
  if (!selectedFile || !selectedFormat) return;
  interpretationError.hidden = true;
  optionsError.hidden = true;
  const manualOverride = sourceOverrideActive && Boolean(gamutSelect.value && transferSelect.value);
  const manualSelectionPresent = sourceOverrideActive && Boolean(gamutSelect.value || transferSelect.value);
  if (manualSelectionPresent && !manualOverride) {
    interpretationError.textContent = "Select both source values, or leave both blank to use the embedded ICC profile.";
    interpretationError.hidden = false;
    return;
  }
  if (!manualOverride && !automaticIccAvailable) {
    interpretationError.textContent = "This file does not provide a usable embedded ICC profile. Select both source values.";
    interpretationError.hidden = false;
    return;
  }
  if (!validOptions()) {
    optionsError.textContent = "Refl must be greater than zero and no greater than 1.2.";
    optionsError.hidden = false;
    return;
  }
  resetResults();
  const id = ++jobId;
  activeJob = id;
  setBusy(true);
  progressStage.textContent = "Starting worker";
  progressBar.value = 0;
  progressPercent.value = "0";
  progressPercent.textContent = "0%";
  progressCounters.textContent = "Preparing pixels…";
  showStatus("The calculation is running locally in a dedicated worker.");
  const bytes = await selectedFile.arrayBuffer();
  const request: Request = {
    format: selectedFormat,
    gamut: manualOverride ? gamutSelect.value : null,
    transfer: manualOverride ? transferSelect.value : null,
    profile: Number(profileSelect.value),
    refl: Number(reflInput.value),
    blur_sigma: 0,
  };
  worker.postMessage({ kind: "calculate", id, format: selectedFormat, bytes, request }, [bytes]);
}

function cancel(): void {
  if (activeJob === undefined) return;
  const cancelledId = activeJob;
  worker.postMessage({ kind: "cancel", id: cancelledId });
  // Rust/WASM calls are synchronous inside a worker. Terminate the current
  // worker so cancellation also interrupts an in-flight large image job.
  worker.terminate();
  worker = createWorker();
  activeJob = undefined;
  setBusy(false);
  showStatus("Calculation cancelled. Worker buffers were released.");
  progressStage.textContent = "Cancelled";
}

function download(url: string | undefined, suffix: string, extension: string): void {
  if (!url || !selectedFile) return;
  const baseName = selectedFile.name.replace(/\.[^.]+$/, "");
  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}-${suffix}.${extension}`;
  link.click();
}

async function savePreview(kind: "base" | "exposure"): Promise<void> {
  const bytes = kind === "base" ? basePreviewBytes : exposurePreviewBytes;
  const url = kind === "base" ? basePreviewUrl : exposurePreviewUrl;
  const suffix = kind === "base" ? "base-preview-p3d65-srgb" : "exposure-preview-p3d65-srgb";
  if (!bytes || !selectedFile) return;
  const file = new File([new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" })], `${selectedFile.name.replace(/\.[^.]+$/, "")}-${suffix}.jpg`, { type: "image/jpeg" });
  const sharing = navigator as Navigator & { share?: (data: { files: File[]; title?: string }) => Promise<void>; canShare?: (data: { files: File[] }) => boolean };
  if (sharing.share && (!sharing.canShare || sharing.canShare({ files: [file] }))) {
    try {
      await sharing.share({ files: [file], title: kind === "base" ? "Base preview JPEG" : "Exposure preview JPEG" });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  download(url, suffix, "jpg");
}

uploadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void chooseFile(file); });
calculateButton.addEventListener("click", () => void calculate());
cancelButton.addEventListener("click", cancel);
downloadBase.addEventListener("click", () => download(baseUrl, "base-acescg-fp16", "exr"));
downloadExposure.addEventListener("click", () => download(exposureUrl, "exposure-acescg-fp16", "exr"));
downloadBasePreview.addEventListener("click", () => void savePreview("base"));
downloadExposurePreview.addEventListener("click", () => void savePreview("exposure"));
basePreviewTrigger.addEventListener("click", () => openPreview("base"));
exposurePreviewTrigger.addEventListener("click", () => openPreview("exposure"));
closePreviewButton.addEventListener("click", closePreview);
previewOverlay.querySelector("[data-close-preview]")?.addEventListener("click", closePreview);
window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !previewOverlay.hidden) closePreview(); });
for (const control of [gamutSelect, transferSelect, profileSelect, reflInput]) {
  control.addEventListener("input", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
  control.addEventListener("change", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
}
reflInput.addEventListener("change", normalizeReflDisplay);
reflInput.addEventListener("blur", normalizeReflDisplay);
overrideSource.addEventListener("click", () => {
  sourceOverrideActive = true;
  interpretationFields.hidden = false;
  overrideSource.hidden = true;
  gamutSelect.focus();
  updateCalculateState();
});
workerBadge.addEventListener("mouseenter", () => setWebGpuHelpVisible(true));
workerBadge.addEventListener("mouseleave", () => { if (!webGpuHelpPinned) setWebGpuHelpVisible(false); });
workerBadge.addEventListener("focus", () => setWebGpuHelpVisible(true));
workerBadge.addEventListener("blur", () => { if (!webGpuHelpPinned) setWebGpuHelpVisible(false); });
workerBadge.addEventListener("click", () => {
  webGpuHelpPinned = !webGpuHelpPinned;
  setWebGpuHelpVisible(webGpuHelpPinned);
});
document.addEventListener("click", (event) => {
  if (webGpuHelpPinned && !workerBadge.contains(event.target as Node) && !webGpuHelp.contains(event.target as Node)) {
    webGpuHelpPinned = false;
    setWebGpuHelpVisible(false);
  }
});
webGpuHelp.addEventListener("click", (event) => event.stopPropagation());
window.addEventListener("beforeunload", () => { revokeUrls(); worker.terminate(); });
const browserNavigator = navigator as Navigator & { gpu?: unknown };
const webGpuAvailable = Boolean(browserNavigator.gpu && (typeof isSecureContext === "undefined" || isSecureContext));
workerBadge.textContent = webGpuAvailable ? "WebGPU available" : "WebGPU unavailable";
webGpuHelp.textContent = webGpuAvailable
  ? "WebGPU lets the worker run the validated modCAM16-HK solve and exact ACES 2.0 preview transforms on the device GPU. This can substantially reduce processing time. Results are still checked against the accurate CPU reference, and a browser or device failure can fall back to Rust/WASM CPU processing."
  : "WebGPU is unavailable in this browser context, so the worker uses the accurate Rust/WASM CPU implementation. Results stay local and correct, but large images can take longer to process.";
setBusy(false);
