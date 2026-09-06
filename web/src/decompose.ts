import "./decompose.css";

type SourceSummary = {
  format: string;
  width: number;
  height: number;
  gamut?: string | null;
  transfer?: string | null;
  metadata_source?: string | null;
  warnings?: string[];
};

type Request = { format: string; gamut: string; transfer: string; profile: number; refl: number; blur_sigma: number };
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
  warnings: string[];
};
type ProgressMessage = { kind: "progress"; id: number; stage: string; percent: number; counters?: Record<string, number | undefined> };
type WorkerMessage =
  | ProgressMessage
  | { kind: "inspect-result"; id: number; summary: SourceSummary }
  | { kind: "result"; id: number; report: Report; base_exr: Uint8Array; exposure_exr: Uint8Array }
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
const baseSize = $("#base-size");
const exposureSize = $("#exposure-size");

let worker = createWorker();
let selectedFile: File | undefined;
let selectedFormat = "";
let inspectionId = 0;
let jobId = 0;
let activeJob: number | undefined;
let baseBytes: Uint8Array | undefined;
let exposureBytes: Uint8Array | undefined;
let baseUrl: string | undefined;
let exposureUrl: string | undefined;

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
  baseUrl = undefined;
  exposureUrl = undefined;
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
  return Boolean(selectedFile && selectedFormat && gamutSelect.value && transferSelect.value && confirmColor.checked && validOptions());
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
  downloadBase.disabled = true;
  downloadExposure.disabled = true;
  baseSize.textContent = "Waiting for calculation";
  exposureSize.textContent = "Waiting for calculation";
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
  if (summary.gamut && gamutSelect.querySelector(`option[value="${CSS.escape(summary.gamut)}"]`)) {
    gamutSelect.value = summary.gamut;
    gamutNote.textContent = `Detected from ${summary.metadata_source ?? "metadata"}; confirmation is still required.`;
  } else {
    gamutNote.textContent = "Manual selection required; no unambiguous gamut was detected.";
  }
  if (summary.transfer && transferSelect.querySelector(`option[value="${CSS.escape(summary.transfer)}"]`)) {
    transferSelect.value = summary.transfer;
    transferNote.textContent = `Detected from ${summary.metadata_source ?? "metadata"}; confirmation is still required.`;
  } else {
    transferNote.textContent = "Manual selection required; no unambiguous transfer was detected.";
  }
  confirmColor.checked = false;
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
  revokeUrls();
  const basePart = new Uint8Array(baseBytes);
  const exposurePart = new Uint8Array(exposureBytes);
  baseUrl = URL.createObjectURL(new Blob([basePart.buffer as ArrayBuffer], { type: "image/x-exr" }));
  exposureUrl = URL.createObjectURL(new Blob([exposurePart.buffer as ArrayBuffer], { type: "image/x-exr" }));
  renderReport(message.report);
  downloadBase.disabled = false;
  downloadExposure.disabled = false;
  baseSize.textContent = formatBytes(baseBytes.byteLength);
  exposureSize.textContent = formatBytes(exposureBytes.byteLength);
  setBusy(false);
  showStatus("Calculation complete. Both OpenEXR files are ready.");
}

function renderReport(report: Report): void {
  const profile = profileSelect.selectedOptions[0]?.textContent ?? String(report.profile);
  reportSummary.textContent = `${formatCount(report.width)} × ${formatCount(report.height)} pixels · ${profile} · Refl ${report.refl.toFixed(5)} · blur sigma ${report.blur_sigma.toFixed(2)}`;
  const metrics: Array<[string, string]> = [
    ["Pixel count", formatCount(report.pixel_count)],
    ["Confirmed source", `${gamutSelect.value} / ${transferSelect.value}`],
    ["Projected pixels", `${formatCount(report.projected_pixels)} (${formatPercent(report.projected_pixels, report.pixel_count)})`],
    ["Clipped exposure", `${formatCount(report.clipped_pixels)} (${formatPercent(report.clipped_pixels, report.pixel_count)})`],
    ["Non-finite pixels", `${formatCount(report.non_finite_pixels)} (${formatPercent(report.non_finite_pixels, report.pixel_count)})`],
    ["Exposure range", `${report.exposure_min.toFixed(4)} to ${report.exposure_max.toFixed(4)} stops`],
    ["Exposure mean", report.exposure_mean.toFixed(4)],
    ["Base range", `${report.base_min.toFixed(4)} to ${report.base_max.toFixed(4)}`],
    ["Base mean", report.base_mean.toFixed(4)],
    ["Target J_HK", report.target_j_hk.toFixed(4)],
    ["Solver", report.solver_status],
    ["Base output", "Linear ACEScg/AP1 RGB, fp16"],
    ["Exposure output", "Normalized fp16 exposure channel"],
  ];
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
  if (!gamutSelect.value || !transferSelect.value || !confirmColor.checked) {
    interpretationError.textContent = "Select and explicitly confirm both the source gamut and gamma/transfer.";
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
  const request: Request = { format: selectedFormat, gamut: gamutSelect.value, transfer: transferSelect.value, profile: Number(profileSelect.value), refl: Number(reflInput.value), blur_sigma: Number(blurInput.value) };
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

function download(url: string | undefined, suffix: string): void {
  if (!url || !selectedFile) return;
  const baseName = selectedFile.name.replace(/\.[^.]+$/, "");
  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}-${suffix}-acescg-fp16.exr`;
  link.click();
}

uploadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void chooseFile(file); });
resetButton.addEventListener("click", resetAll);
calculateButton.addEventListener("click", () => void calculate());
cancelButton.addEventListener("click", cancel);
downloadBase.addEventListener("click", () => download(baseUrl, "base"));
downloadExposure.addEventListener("click", () => download(exposureUrl, "exposure"));
for (const control of [gamutSelect, transferSelect, confirmColor, profileSelect, reflInput, blurInput]) {
  control.addEventListener("input", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
  control.addEventListener("change", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
}
window.addEventListener("beforeunload", () => { revokeUrls(); worker.terminate(); });
setBusy(false);
