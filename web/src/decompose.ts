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
type OutputFile = { name: string; size: number; kind: string; width?: number; height?: number };
type WorkerMessage =
  | ProgressMessage
  | { kind: "inspect-result"; id: number; summary: SourceSummary }
  | { kind: "source-ready"; id: number; width: number; height: number; source: string; request: Request; warnings: string[] }
  | { kind: "preview-encode"; id: number; width: number; height: number; displayWidth: number; displayHeight: number; report: Report; outputs: OutputFile[]; storage: "opfs" }
  | { kind: "result"; id: number; report: Report; outputs: OutputFile[]; storage: "opfs" }
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
const webGpuFootnote = $("#webgpu-footnote");
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
const basePreviewTrigger = $("#base-preview-trigger") as HTMLButtonElement;
const exposurePreviewTrigger = $("#exposure-preview-trigger") as HTMLButtonElement;
const previewOverlay = $("#preview-overlay") as HTMLDivElement;
const previewOverlayImage = $("#preview-overlay-image") as HTMLImageElement;
const previewOverlayLabel = $("#preview-overlay-label");
const closePreviewButton = $("#close-preview") as HTMLButtonElement;
const basePreviewImage = $("#base-preview-image") as HTMLImageElement;
const exposurePreviewImage = $("#exposure-preview-image") as HTMLImageElement;
const downloadBasePreview = $("#download-base-preview") as HTMLButtonElement;
const downloadExposurePreview = $("#download-exposure-preview") as HTMLButtonElement;
const basePreviewSize = $("#base-preview-size");
const exposurePreviewSize = $("#exposure-preview-size");
const baseSize = $("#base-size");
const exposureSize = $("#exposure-size");
const exposureRgbSize = $("#exposure-rgb-size");

let worker = createWorker();
let selectedFile: File | undefined;
let selectedFormat = "";
let inspectionId = 0;
let jobId = 0;
let activeJob: number | undefined;
let automaticIccAvailable = false;
let sourceOverrideActive = false;
let baseUrl: string | undefined;
let exposureUrl: string | undefined;
let exposureRgbUrl: string | undefined;
let basePreviewUrl: string | undefined;
let exposurePreviewUrl: string | undefined;
let baseFullPreviewUrl: string | undefined;
let exposureFullPreviewUrl: string | undefined;
let previewEncoding: AbortController | undefined;

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
  if (baseFullPreviewUrl) URL.revokeObjectURL(baseFullPreviewUrl);
  if (exposureFullPreviewUrl) URL.revokeObjectURL(exposureFullPreviewUrl);
  baseUrl = undefined;
  exposureUrl = undefined;
  exposureRgbUrl = undefined;
  basePreviewUrl = undefined;
  exposurePreviewUrl = undefined;
  baseFullPreviewUrl = undefined;
  exposureFullPreviewUrl = undefined;
}

function clearPreview(image: HTMLImageElement): void {
  image.removeAttribute("src");
  image.hidden = true;
}

function closePreview(): void {
  previewOverlay.hidden = true;
  previewOverlayImage.removeAttribute("src");
  document.body.classList.remove("preview-open");
}

function openPreview(kind: "base" | "exposure"): void {
  const url = kind === "base" ? basePreviewUrl : exposurePreviewUrl;
  if (!url) return;
  previewOverlayImage.src = url;
  previewOverlayImage.alt = kind === "base" ? "Enlarged base preview JPEG" : "Enlarged exposure preview JPEG";
  previewOverlayLabel.textContent = kind === "base" ? "Base preview (Display P3)" : "Exposure preview (Display P3)";
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
  calculateButton.disabled = !busy && !canCalculate();
  calculateButton.textContent = busy ? "Cancel" : "Decompose";
  calculateButton.classList.toggle("button-primary", !busy);
  calculateButton.classList.toggle("button-danger", busy);
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
  calculateButton.disabled = activeJob !== undefined || !canCalculate();
}

function resetResults(): void {
  closePreview();
  clearPreview(basePreviewImage);
  clearPreview(exposurePreviewImage);
  revokeUrls();
  downloadBase.disabled = true;
  downloadExposure.disabled = true;
  downloadExposureRgb.disabled = true;
  basePreviewTrigger.disabled = true;
  exposurePreviewTrigger.disabled = true;
  downloadBasePreview.disabled = true;
  downloadExposurePreview.disabled = true;
  for (const size of [baseSize, exposureRgbSize, exposureSize, basePreviewSize, exposurePreviewSize]) {
    size.textContent = "Waiting";
  }
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

let previewEncoderId = 0;
type EncodedPreview = { size: number; width: number; height: number };
function encodePreviewFile(input: string, output: string, width: number, height: number, signal: AbortSignal): Promise<EncodedPreview> {
  signal.throwIfAborted();
  const encoder = new Worker(new URL("./preview_encoder_worker.ts", import.meta.url), { type: "module" });
  const id = ++previewEncoderId;
  return new Promise<EncodedPreview>((resolve, reject) => {
    const finish = () => { encoder.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(new DOMException("Preview encoding cancelled.", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    encoder.onmessage = (event: MessageEvent<{ kind: string; id: number; size: number; width: number; height: number; message?: string }>) => {
      if (event.data.id !== id) return;
      if (event.data.kind === "complete") { finish(); resolve({ size: event.data.size, width: event.data.width, height: event.data.height }); }
      else if (event.data.kind === "error") { finish(); reject(new Error(event.data.message ?? "Preview JPEG encoding failed.")); }
    };
    encoder.onerror = (event) => { finish(); reject(new Error(event.message || "Preview JPEG worker failed.")); };
    encoder.postMessage({ id, input, output, width, height });
  });
}

async function cleanupOpfsJob(id: number): Promise<void> {
  try {
    const root = await (navigator.storage as any).getDirectory();
    for await (const [name] of root.entries()) {
      if (name.startsWith(`decomposition-${id}-`)) await root.removeEntry(name);
    }
  } catch { /* best effort during cancellation */ }
}

async function onWorkerMessage(message: WorkerMessage): Promise<void> {
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
  if (message.kind === "source-ready") {
    progressStage.textContent = "Decompose pixels";
    progressBar.value = 25;
    progressPercent.value = "25";
    progressPercent.textContent = "25%";
    progressCounters.textContent = "Starting bounded batches";
    // Preparation/decoding has its own worker lifetime. Terminating it here
    // releases the decoder and prepared raster before solve batches begin.
    worker.terminate();
    worker = createWorker();
    worker.postMessage({ kind: "solve", id: message.id, width: message.width, height: message.height, source: message.source, request: message.request, warnings: message.warnings });
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
  if (message.kind === "preview-encode") {
    // Each JPEG encoder gets its own lifetime. Never display full-size JPEGs
    // in the page: only the two capped files may be decoded by image elements.
    worker.terminate();
    const encoding = new AbortController();
    previewEncoding = encoding;
    try {
      const outputs = [...message.outputs];
      for (const [index, spec] of [
        { component: "base", display: true }, { component: "exposure", display: true },
        { component: "base", display: false }, { component: "exposure", display: false },
      ].entries()) {
        const { component, display } = spec;
        const suffix = display ? "display" : "preview";
        const name = `decomposition-${message.id}-${component}-${suffix}.jpg`;
        progressStage.textContent = `Encode ${component} ${display ? "display" : "full-size"} JPEG`;
        progressBar.value = 94 + index * 1.5;
        progressPercent.value = String(progressBar.value);
        progressPercent.textContent = `${Math.round(progressBar.value)}%`;
        progressCounters.textContent = display ? "2048-pixel display preview" : "Full-resolution JPEG";
        const result = await encodePreviewFile(`decomposition-${message.id}-${component}-${suffix}.rgb`, name,
          display ? message.displayWidth : message.width, display ? message.displayHeight : message.height, encoding.signal);
        if (activeJob !== message.id) { await cleanupOpfsJob(message.id); return; }
        outputs.push({ name, ...result, kind: `${component}-${suffix}-jpeg` });
      }
      const root = await (navigator.storage as any).getDirectory();
      await root.removeEntry(`decomposition-${message.id}-base-preview.rgb`).catch(() => undefined);
      await root.removeEntry(`decomposition-${message.id}-exposure-preview.rgb`).catch(() => undefined);
      await root.removeEntry(`decomposition-${message.id}-base-display.rgb`).catch(() => undefined);
      await root.removeEntry(`decomposition-${message.id}-exposure-display.rgb`).catch(() => undefined);
      await root.removeEntry(`decomposition-${message.id}-source.f32`).catch(() => undefined);
      await onWorkerMessage({ kind: "result", id: message.id, report: message.report, outputs, storage: "opfs" });
    } catch (error) {
      await cleanupOpfsJob(message.id);
      if (activeJob === message.id) {
        activeJob = undefined;
        setBusy(false);
        showStatus(error instanceof Error ? error.message : String(error), true);
        progressStage.textContent = "Error";
      }
    } finally {
      if (previewEncoding === encoding) {
        previewEncoding = undefined;
        worker = createWorker();
      }
    }
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
  let files: Map<string, OutputFile>;
  try {
    const root = await (navigator.storage as any).getDirectory();
    files = new Map(message.outputs.map((entry) => [entry.kind, entry]));
    const openUrl = async (kind: string, mime: string): Promise<string | undefined> => {
      const entry = files.get(kind);
      if (!entry) return undefined;
      const handle = await root.getFileHandle(entry.name);
      return URL.createObjectURL(await handle.getFile({ type: mime }));
    };
    revokeUrls();
    baseUrl = await openUrl("base-exr", "image/x-exr");
    exposureUrl = await openUrl("exposure-normalized-ev", "image/x-exr");
    exposureRgbUrl = await openUrl("exposure-exr", "image/x-exr");
    basePreviewUrl = await openUrl("base-display-jpeg", "image/jpeg");
    exposurePreviewUrl = await openUrl("exposure-display-jpeg", "image/jpeg");
    baseFullPreviewUrl = await openUrl("base-preview-jpeg", "image/jpeg");
    exposureFullPreviewUrl = await openUrl("exposure-preview-jpeg", "image/jpeg");
  } catch (error) {
    setBusy(false);
    showStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  showPreview(basePreviewImage, basePreviewUrl);
  showPreview(exposurePreviewImage, exposurePreviewUrl);
  renderReport(message.report);
  downloadBase.disabled = false;
  downloadExposure.disabled = false;
  downloadExposureRgb.disabled = false;
  basePreviewTrigger.disabled = false;
  exposurePreviewTrigger.disabled = false;
  downloadBasePreview.disabled = !baseFullPreviewUrl;
  downloadExposurePreview.disabled = !exposureFullPreviewUrl;
  const jpegLabel = (kind: string): string => {
    const file = files.get(kind);
    return file ? `${file.width} × ${file.height} · ${formatBytes(file.size)}` : "Unavailable";
  };
  basePreviewSize.textContent = jpegLabel("base-preview-jpeg");
  exposurePreviewSize.textContent = jpegLabel("exposure-preview-jpeg");
  baseSize.textContent = formatBytes(files.get("base-exr")?.size ?? 0);
  exposureSize.textContent = formatBytes(files.get("exposure-normalized-ev")?.size ?? 0);
  exposureRgbSize.textContent = formatBytes(files.get("exposure-exr")?.size ?? 0);
  setBusy(false);
  progressBar.value = 100;
  progressPercent.value = "100";
  progressPercent.textContent = "100%";
  progressStage.textContent = "Complete";
  showStatus("Calculation complete. Outputs are ready.");
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
    ["Exposure output", "Direct scalar s replicated to linear ACEScg RGB, fp16"],
    ["Exposure normalized output", "Single-channel fp16 EV value remapped to [0, 1]"],
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
    interpretationError.textContent = "Select gamut and transfer manually: this file has no usable embedded ICC profile.";
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
  previewEncoding?.abort();
  previewEncoding = undefined;
  void cleanupOpfsJob(cancelledId);
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
calculateButton.addEventListener("click", () => { if (activeJob !== undefined) cancel(); else void calculate(); });
downloadBase.addEventListener("click", () => download(baseUrl, "base-acescg-fp16", "exr"));
downloadExposure.addEventListener("click", () => download(exposureUrl, "exposure-normalized-ev", "exr"));
downloadExposureRgb.addEventListener("click", () => download(exposureRgbUrl, "exposure-acescg-fp16", "exr"));
downloadBasePreview.addEventListener("click", () => download(baseFullPreviewUrl, "base-preview-display-p3", "jpg"));
downloadExposurePreview.addEventListener("click", () => download(exposureFullPreviewUrl, "exposure-preview-display-p3", "jpg"));
basePreviewTrigger.addEventListener("click", () => openPreview("base"));
exposurePreviewTrigger.addEventListener("click", () => openPreview("exposure"));
closePreviewButton.addEventListener("click", closePreview);
previewOverlay.querySelector("[data-close-preview]")?.addEventListener("click", closePreview);
previewOverlay.addEventListener("click", (event) => {
  const target = event.target as Node;
  if (target === previewOverlay || target === previewOverlayImage || (target instanceof HTMLElement && target.closest("#close-preview"))) return;
  // Keep the enlarged view dismissible from any backdrop or empty panel area.
  if (!(target instanceof HTMLButtonElement)) closePreview();
});
window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !previewOverlay.hidden) closePreview(); });
for (const control of [gamutSelect, transferSelect, profileSelect, reflInput]) {
  control.addEventListener("input", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
  control.addEventListener("change", () => { interpretationError.hidden = true; optionsError.hidden = true; updateCalculateState(); });
}
gamutSelect.addEventListener("change", () => {
  if (gamutSelect.value === "Rec.709 / sRGB" || gamutSelect.value === "Display P3 / P3-D65") {
    transferSelect.value = "sRGB";
  }
  interpretationError.hidden = true;
  updateCalculateState();
});
reflInput.addEventListener("change", normalizeReflDisplay);
reflInput.addEventListener("blur", normalizeReflDisplay);
overrideSource.addEventListener("click", () => {
  sourceOverrideActive = true;
  interpretationFields.hidden = false;
  overrideSource.hidden = true;
  gamutSelect.focus();
  updateCalculateState();
});
window.addEventListener("beforeunload", () => { revokeUrls(); worker.terminate(); previewEncoding?.abort(); });
const browserNavigator = navigator as Navigator & { gpu?: unknown };
const webGpuAvailable = Boolean(browserNavigator.gpu && (typeof isSecureContext === "undefined" || isSecureContext));
webGpuFootnote.textContent = webGpuAvailable
  ? "* (WebGPU available) We use WebGPU to accelerate decomposition and preview generation."
  : "* (WebGPU unavailable) We use a CPU-based WASM implementation, so decomposition and preview generation may take longer.";
setBusy(false);
