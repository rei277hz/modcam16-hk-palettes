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
const resetButton = $("#reset-button") as HTMLButtonElement;
const fileSummary = $("#file-summary");
const metadataSummary = $("#metadata-summary");
const metadataWarning = $("#metadata-warning");
const gamutSelect = $("#source-gamut") as HTMLSelectElement;
const transferSelect = $("#source-transfer") as HTMLSelectElement;
const gamutNote = $("#gamut-note");
const transferNote = $("#transfer-note");
const confirmColor = $("#confirm-color") as HTMLInputElement;
const interpretationError = $("#interpretation-error");
const profileSelect = $("#aces-profile") as HTMLSelectElement;
const reflInput = $("#refl") as HTMLInputElement;
const blurInput = $("#blur-sigma") as HTMLInputElement;
const optionsError = $("#options-error");
const calculateButton = $("#calculate-button") as HTMLButtonElement;
const cancelButton = $("#cancel-button") as HTMLButtonElement;
const workerBadge = $("#worker-badge");
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

function createWorker(): Worker {
  const instance = new Worker(new URL("./decompose_worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = (event: MessageEvent<WorkerMessage>) => onWorkerMessage(event.data);
  instance.onerror = (event) => {
    workerBadge.textContent = "Worker error";
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
  resetButton.disabled = !selectedFile || busy;
  gamutSelect.disabled = busy;
  transferSelect.disabled = busy;
  confirmColor.disabled = busy;
  profileSelect.disabled = busy;
  reflInput.disabled = busy;
  blurInput.disabled = busy;
  if (busy) workerBadge.textContent = "Calculating";
  else if (selectedFile) workerBadge.textContent = "Worker ready";
}

function canCalculate(): boolean {
  const manualOverride = Boolean(gamutSelect.value && transferSelect.value && confirmColor.checked);
  const manualSelectionPresent = Boolean(gamutSelect.value || transferSelect.value || confirmColor.checked);
  return Boolean(
    selectedFile
      && selectedFormat
      && validOptions()
      && (manualOverride || (automaticIccAvailable && !manualSelectionPresent)),
  );
}

function validOptions(): boolean {
  const refl = Number(reflInput.value);
  const blur = Number(blurInput.value);
  return Number.isFinite(refl) && refl > 0 && refl <= 1.2 && Number.isFinite(blur) && blur >= 0 && blur <= 100;
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
  clearPreview(basePreviewImage);
  clearPreview(exposurePreviewImage);
  baseSize.textContent = "Waiting for calculation";
  exposureSize.textContent = "Waiting for calculation";
  basePreviewSize.textContent = "Waiting for calculation";
  exposurePreviewSize.textContent = "Waiting for calculation";
  emptyReport.hidden = false;
  reportContent.hidden = true;
}

function resetAll(): void {
  if (activeJob !== undefined) worker.postMessage({ kind: "cancel", id: activeJob });
  activeJob = undefined;
  selectedFile = undefined;
  selectedFormat = "";
  fileInput.value = "";
  fileSummary.textContent = "No image selected.";
  metadataSummary.innerHTML = "";
  metadataSummary.hidden = true;
  metadataWarning.hidden = true;
  metadataWarning.textContent = "";
  gamutSelect.value = "";
  transferSelect.value = "";
  confirmColor.checked = false;
  automaticIccAvailable = false;
  gamutNote.textContent = "No source gamut selected.";
  transferNote.textContent = "No transfer selected.";
  interpretationError.hidden = true;
  optionsError.hidden = true;
  progressStage.textContent = "Waiting for an image";
  progressPercent.value = "0";
  progressPercent.textContent = "0%";
  progressBar.value = 0;
  progressCounters.textContent = "No pixels processed.";
  processingStatus.hidden = true;
  resetResults();
  setBusy(false);
  updateCalculateState();
}

function renderSummary(summary: SourceSummary): void {
  selectedFormat = summary.format;
  automaticIccAvailable = Boolean(summary.automatic_icc);
  const rows = [
    ["Format", summary.format.toUpperCase()],
    ["Dimensions", `${formatCount(summary.width)} × ${formatCount(summary.height)}`],
    ["Metadata", summary.metadata_source ?? "No unambiguous profile metadata"],
    ["Detected gamut", summary.gamut ?? "Not detected"],
    ["Detected transfer", summary.transfer ?? "Not detected"],
  ];
  metadataSummary.innerHTML = rows.map(([label, value]) => `<dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd>`).join("");
  metadataSummary.hidden = false;
  const warnings = summary.warnings ?? [];
  if (warnings.length) {
    metadataWarning.textContent = warnings.join(" ");
    metadataWarning.hidden = false;
  }
  gamutSelect.value = "";
  transferSelect.value = "";
  confirmColor.checked = false;
  if (summary.automatic_icc) {
    const source = summary.metadata_source ?? "embedded ICC";
    gamutNote.textContent = `Automatic decode available from ${source}; leave this blank to use it or choose a manual override.`;
    transferNote.textContent = `Automatic decode available from ${source}; leave this blank to use it or choose a manual override.`;
  } else if (summary.gamut && summary.transfer) {
    gamutNote.textContent = `Reference metadata only (${summary.gamut}); select it and confirm only to override the automatic ICC path.`;
    transferNote.textContent = `Reference metadata only (${summary.transfer}); select it and confirm only to override the automatic ICC path.`;
  } else {
    gamutNote.textContent = "Manual selection required; no usable ICC profile was detected.";
    transferNote.textContent = "Manual selection required; no usable ICC profile was detected.";
  }
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
  reportSummary.textContent = `${formatCount(report.width)} × ${formatCount(report.height)} pixels · ${profile} · Refl ${report.refl.toFixed(5)} · blur sigma ${report.blur_sigma.toFixed(2)}`;
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
  if (!format) {
    selectedFile = undefined;
    selectedFormat = "";
    fileSummary.textContent = "Unsupported file type. Choose EXR, JPEG, PNG, HEIC, or HEIF.";
    setBusy(false);
    return;
  }
  selectedFile = file;
  selectedFormat = format;
  resetButton.disabled = false;
  fileSummary.textContent = `${file.name} · ${formatBytes(file.size)} · inspecting metadata…`;
  metadataSummary.hidden = true;
  metadataWarning.hidden = true;
  progressStage.textContent = "Inspecting metadata";
  progressBar.value = 0;
  progressPercent.textContent = "0%";
  try {
    await inspectFile(file, format);
    fileSummary.textContent = `${file.name} · ${formatBytes(file.size)}`;
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
  updateCalculateState();
}

async function calculate(): Promise<void> {
  if (!selectedFile || !selectedFormat) return;
  interpretationError.hidden = true;
  optionsError.hidden = true;
  const manualOverride = Boolean(gamutSelect.value && transferSelect.value && confirmColor.checked);
  const manualSelectionPresent = Boolean(gamutSelect.value || transferSelect.value || confirmColor.checked);
  if (manualSelectionPresent && !manualOverride) {
    interpretationError.textContent = "Either leave the source fields blank to use the embedded ICC profile, or select both values and confirm the manual override.";
    interpretationError.hidden = false;
    return;
  }
  if (!manualOverride && !automaticIccAvailable) {
    interpretationError.textContent = "This file does not provide a usable embedded ICC profile. Select both source values and confirm the override.";
    interpretationError.hidden = false;
    return;
  }
  if (!validOptions()) {
    optionsError.textContent = "Refl must be greater than zero and blur sigma must be between 0 and 100.";
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
    blur_sigma: Number(blurInput.value),
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

uploadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void chooseFile(file); });
resetButton.addEventListener("click", resetAll);
calculateButton.addEventListener("click", () => void calculate());
cancelButton.addEventListener("click", cancel);
downloadBase.addEventListener("click", () => download(baseUrl, "base-acescg-fp16", "exr"));
downloadExposure.addEventListener("click", () => download(exposureUrl, "exposure-acescg-fp16", "exr"));
downloadBasePreview.addEventListener("click", () => download(basePreviewUrl, "base-preview-p3d65-srgb", "jpg"));
downloadExposurePreview.addEventListener("click", () => download(exposurePreviewUrl, "exposure-preview-p3d65-srgb", "jpg"));
for (const control of [gamutSelect, transferSelect, confirmColor, profileSelect, reflInput, blurInput]) {
  control.addEventListener("input", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
  control.addEventListener("change", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
}
window.addEventListener("beforeunload", () => { revokeUrls(); worker.terminate(); });
setBusy(false);
