import { appendDebug, syncDiagnosticScroll } from "./debug_panel";
import type { DebugMessage } from "./debug_log";
import { listScratchFiles, readScratchFile, removeScratchFile } from "./scratch_store";
import "./decompose.css";

type SourceSummary = {
  format: string;
  width: number;
  height: number;
  gamut?: string | null;
  transfer?: string | null;
  metadata_source?: string | null;
  automatic_icc?: boolean;
  embedded_available?: boolean;
  orientation?: number | null;
  camera_model?: string | null;
  photometry?: string | null;
  bit_depth?: number | null;
  compression?: string | null;
  dng_transform?: {
    color_matrix_first_weight: number;
    forward_matrix_used: boolean;
    as_shot_neutral: [number, number, number];
    white_balance_multipliers: [number, number, number];
    source_white_xyz: [number, number, number];
    raw_sample_range: [number, number];
    normalized_sample_range: [number, number];
    demosaiced_rgb_range: number[][];
    post_vignette_rgb_range: number[][];
    final_ap0_range: number[][];
    representative_camera_rgb: number[][];
    representative_ap0: number[][];
    camera_to_xyz_d50: number[][];
    cat02_d50_to_d65: number[][];
    camera_to_d65: number[][];
    camera_to_ap0: number[][];
    white_balance_integrated: boolean;
  } | null;
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
  | DebugMessage
  | ProgressMessage
  | { kind: "inspect-result"; id: number; summary: SourceSummary }
  | { kind: "source-preview"; id: number; generation: number; width: number; height: number; mode: "embedded" | "manual" | "raw-muted"; jpeg: ArrayBuffer }
  | { kind: "source-ready"; id: number; width: number; height: number; source: string; request: Request; warnings: string[] }
  | { kind: "preview-encode"; id: number; width: number; height: number; displayWidth: number; displayHeight: number; report: Report; outputs: OutputFile[]; storage: "opfs" }
  | { kind: "result"; id: number; report: Report; outputs: OutputFile[]; storage: "opfs" }
  | { kind: "error"; id: number; message: string; generation?: number }
  | { kind: "cancelled"; id: number };

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element ${selector}`);
  return element;
};

const fileInput = $("#file-input") as HTMLInputElement;
const sourcePreviewFrame = $("#source-preview-frame") as HTMLButtonElement;
const sourcePreviewEmpty = $("#source-preview-empty");
const sourcePreviewImage = $("#source-preview-image") as HTMLImageElement;
const sourcePreviewState = $("#source-preview-state");
const interpretationGroup = $(".interpretation-group") as HTMLDivElement;
const interpretationControls = $(".interpretation-controls") as HTMLDivElement;
const gamutSelect = $("#source-gamut") as HTMLSelectElement;
const transferSelect = $("#source-transfer") as HTMLSelectElement;
const transferField = $("#source-transfer-field") as HTMLLabelElement;
const gamutAction = $("#source-gamut-action");
const sourceFormatIndicator = $("#source-format-indicator");
const profileSelect = $("#aces-profile") as HTMLSelectElement;
const reflInput = $("#refl") as HTMLInputElement;
const optionsError = $("#options-error");
const calculateButton = $("#calculate-button") as HTMLButtonElement;
const reconstructionProfile = $("#reconstruction-profile");
const progressStage = $("#progress-stage");
const progressPercent = $("#progress-percent") as HTMLOutputElement;
const progressBar = $("#progress-bar") as HTMLProgressElement;
const progressCounters = $("#progress-counters");
const processingStatus = $("#processing-status");
const emptyReport = $("#empty-report");
const reportContent = $("#report-content");
const reportSummary = $("#report-summary");
const reportWarnings = $("#report-warnings");
const reportMetricsLeft = $("#report-metrics-left");
const reportMetricsRight = $("#report-metrics-right");
const reportToggle = $("#report-toggle") as HTMLButtonElement;
const reportRow = $(".report-row");
const reportMobileViewport = window.matchMedia("(max-width: 800px)");
const downloadBase = $("#download-base") as HTMLButtonElement;
const downloadExposure = $("#download-exposure") as HTMLButtonElement;
const downloadExposureNormEv = $("#download-exposure-norm-ev") as HTMLButtonElement;
const basePreviewTrigger = $("#base-preview-trigger") as HTMLButtonElement;
const exposurePreviewTrigger = $("#exposure-preview-trigger") as HTMLButtonElement;
const previewOverlay = $("#preview-overlay") as HTMLDivElement;
const previewOverlayImage = $("#preview-overlay-image") as HTMLImageElement;
const previewOverlayTitle = $("#preview-overlay-title");
const previewOverlayMeta = $("#preview-overlay-meta");
const saveOverlayPreview = $("#save-overlay-preview") as HTMLButtonElement;
const previewSaveStatus = $("#preview-save-status");
const closePreviewButton = $("#close-preview") as HTMLButtonElement;
const basePreviewImage = $("#base-preview-image") as HTMLImageElement;
const exposurePreviewImage = $("#exposure-preview-image") as HTMLImageElement;
const baseSize = $("#base-size");
const exposureSize = $("#exposure-size");
const exposureNormEvSize = $("#exposure-norm-ev-size");

let worker = createWorker();
let selectedFile: File | undefined;
let selectedFormat = "";
let sourceInspected = false;
let inspectionId = 0;
let jobId = 0;
let activeJob: number | undefined;
let embeddedAvailable = false;
let embeddedLabel = "Use embedded interpretation";
let primaryEmbeddedSelection = false;
let interpretationMode: "embedded" | "manual" | "unresolved" = "unresolved";
let sourcePreviewGeneration = 0;
let sourcePreviewUrl: string | undefined;
let sourcePreviewTimer: number | undefined;
let sourceCacheReadyId: number | undefined;
let baseUrl: string | undefined;
let exposureNormEvUrl: string | undefined;
let exposureUrl: string | undefined;
let basePreviewUrl: string | undefined;
let exposurePreviewUrl: string | undefined;
let baseFullPreviewUrl: string | undefined;
let exposureFullPreviewUrl: string | undefined;
let baseFullPreviewFile: File | undefined;
let exposureFullPreviewFile: File | undefined;
let baseDisplayDimensions = "";
let exposureDisplayDimensions = "";
let openPreviewKind: "base" | "exposure" | undefined;
let sharingPreview = false;
let previewEncoding: AbortController | undefined;

function createWorker(): Worker {
  console.info("Create decomposition worker");
  const instance = new Worker(new URL("./decompose_worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = (event: MessageEvent<WorkerMessage>) => {
    if (event.data.kind === "debug-log") { appendDebug(event.data.entry); return; }
    if (instance === worker) void onWorkerMessage(event.data);
  };
  instance.onerror = (event) => {
    console.error("Decomposition worker uncaught error", event.error ?? event.message, { file: event.filename, line: event.lineno, column: event.colno, inspectionId, activeJob, stage: progressStage.textContent });
    if (instance !== worker) return;
    activeJob = undefined;
    progressStage.textContent = "Error";
    showStatus(event.message || "The decomposition worker failed.", true);
    setBusy(false);
  };
  instance.onmessageerror = () => console.error("Unable to deserialize decomposition worker message", { inspectionId, activeJob });
  return instance;
}

function replaceWorker(): void {
  console.info("Replace decomposition worker", { inspectionId, activeJob, stage: progressStage.textContent });
  worker.terminate();
  // The File remains on the main thread; only the worker's byte cache expires.
  sourceCacheReadyId = undefined;
  sourcePreviewGeneration += 1;
  worker = createWorker();
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
  if (lower.endsWith(".dng") || file.type === "image/x-adobe-dng" || file.type === "image/dng") return "dng";
  if (lower.endsWith(".png") || file.type === "image/png") return "png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || file.type === "image/jpeg") return "jpeg";
  if (lower.endsWith(".exr") || file.type === "image/x-exr") return "exr";
  if (lower.endsWith(".heic") || file.type === "image/heic") return "heic";
  if (lower.endsWith(".heif") || file.type === "image/heif") return "heif";
  return undefined;
}

function revokeOutputUrls(): void {
  if (baseUrl) URL.revokeObjectURL(baseUrl);
  if (exposureNormEvUrl) URL.revokeObjectURL(exposureNormEvUrl);
  if (exposureUrl) URL.revokeObjectURL(exposureUrl);
  if (basePreviewUrl) URL.revokeObjectURL(basePreviewUrl);
  if (exposurePreviewUrl) URL.revokeObjectURL(exposurePreviewUrl);
  if (baseFullPreviewUrl) URL.revokeObjectURL(baseFullPreviewUrl);
  if (exposureFullPreviewUrl) URL.revokeObjectURL(exposureFullPreviewUrl);
  baseUrl = undefined;
  exposureNormEvUrl = undefined;
  exposureUrl = undefined;
  basePreviewUrl = undefined;
  exposurePreviewUrl = undefined;
  baseFullPreviewUrl = undefined;
  exposureFullPreviewUrl = undefined;
  baseFullPreviewFile = undefined;
  exposureFullPreviewFile = undefined;
}

function revokeUrls(): void {
  revokeOutputUrls();
  if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
  sourcePreviewUrl = undefined;
}

function clearPreview(image: HTMLImageElement): void {
  image.removeAttribute("src");
  image.hidden = true;
}

function setSourcePreviewState(state: "empty" | "loading" | "ready" | "muted" | "error", message = ""): void {
  sourcePreviewFrame.classList.toggle("source-preview-muted", state === "muted");
  sourcePreviewFrame.classList.toggle("source-preview-loading", state === "loading");
  sourcePreviewFrame.classList.toggle("source-preview-error", state === "error");
  sourcePreviewEmpty.hidden = state !== "empty";
  sourcePreviewState.hidden = !message;
  sourcePreviewState.textContent = message;
  sourcePreviewFrame.setAttribute("aria-label", state === "empty" ? "Load an image" : "Replace source image");
}

function clearSourcePreview(): void {
  if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
  sourcePreviewUrl = undefined;
  sourcePreviewImage.removeAttribute("src");
  sourcePreviewImage.hidden = true;
  setSourcePreviewState("empty");
}

function showRawSourcePreview(file: File): void {
  if (!/^image\/(png|jpeg|heic|heif)/i.test(file.type) && !/\.(png|jpe?g|heic|heif)$/i.test(file.name)) {
    setSourcePreviewState("muted", "Choose an interpretation to preview this image.");
    return;
  }
  if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
  sourcePreviewUrl = URL.createObjectURL(file);
  sourcePreviewImage.src = sourcePreviewUrl;
  sourcePreviewImage.hidden = false;
  setSourcePreviewState("muted", "Raw decoder preview · interpretation required");
}

function interpretationFromSelectors(): "embedded" | "manual" | "unresolved" {
  if (gamutSelect.value === "embedded" && embeddedAvailable) return "embedded";
  if (gamutSelect.value && transferSelect.value && gamutSelect.value !== "embedded") return "manual";
  return "unresolved";
}

function syncTransferControl(busy = activeJob !== undefined): void {
  const embedded = gamutSelect.value === "embedded" && embeddedAvailable;
  const manualPrimaries = Boolean(gamutSelect.value && gamutSelect.value !== "embedded");
  transferField.hidden = !manualPrimaries;
  transferSelect.disabled = busy || !manualPrimaries;
  gamutAction.hidden = !sourceInspected || embeddedAvailable || manualPrimaries;
  if (embedded && transferSelect.value !== "sRGB") transferSelect.value = "sRGB";
}

function updateInterpretationState(): void {
  syncTransferControl();
  interpretationMode = interpretationFromSelectors();
  const unresolved = interpretationMode === "unresolved";
  if (sourcePreviewImage.src) {
    setSourcePreviewState(unresolved ? "muted" : "ready", unresolved ? "Complete both selectors to update the preview." : "");
  }
  updateCalculateState();
}

function setEmbeddedOption(summary: SourceSummary): void {
  embeddedAvailable = Boolean(summary.embedded_available ?? summary.automatic_icc);
  embeddedLabel = summary.metadata_source ? `Use embedded ${summary.metadata_source.replace(/^(PNG|JPEG|HEIF|EXR)\s+/i, "")}` : "Use embedded interpretation";
  const option = gamutSelect.querySelector<HTMLOptionElement>('option[value="embedded"]');
  if (option) {
    option.disabled = !embeddedAvailable;
    option.textContent = embeddedLabel;
  }
}

function closePreview(): void {
  previewOverlay.hidden = true;
  previewOverlayImage.removeAttribute("src");
  saveOverlayPreview.hidden = true;
  previewSaveStatus.hidden = true;
  previewSaveStatus.textContent = "";
  openPreviewKind = undefined;
  document.body.classList.remove("preview-open");
}

function isAppleTouchDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

async function savePreviewFile(kind: "base" | "exposure"): Promise<void> {
  const url = kind === "base" ? baseFullPreviewUrl : exposureFullPreviewUrl;
  const file = kind === "base" ? baseFullPreviewFile : exposureFullPreviewFile;
  if (!url || !file || sharingPreview) return;
  previewSaveStatus.hidden = true;
  const shareData: ShareData = { files: [file] };
  let canShare = false;
  try {
    canShare = typeof navigator.share === "function"
      && (!navigator.canShare || navigator.canShare(shareData));
  } catch { /* Unsupported file sharing uses the platform fallback below. */ }
  if (canShare) {
    sharingPreview = true;
    saveOverlayPreview.disabled = true;
    try {
      // The named JPEG is prepared with the results. No file read or other
      // asynchronous work may precede share(), preserving Safari's tap gesture.
      await navigator.share(shareData);
    } catch (error) {
      // Cancellation must never trigger a fallback download. Other failures
      // need a new user gesture instead of an asynchronously opened popup.
      if (!(error instanceof Error && error.name === "AbortError") && openPreviewKind === kind) {
        previewSaveStatus.textContent = "Unable to open the save options. Tap Save full-size JPEG to try again.";
        previewSaveStatus.hidden = false;
      }
    } finally {
      sharingPreview = false;
      saveOverlayPreview.disabled = !(openPreviewKind === "base" ? baseFullPreviewFile : exposureFullPreviewFile);
    }
    return;
  }
  if (isAppleTouchDevice()) {
    // HTTP pages do not expose Web Share. Safari's image context menu still
    // offers Save to Photos in a full-size image tab opened from this tap.
    const imageTab = window.open(url, "_blank");
    if (imageTab) imageTab.opener = null;
    previewSaveStatus.textContent = imageTab
      ? "In the image tab, touch and hold the image, then choose Save to Photos."
      : "Allow pop-ups, then tap Save full-size JPEG again to open the image for saving to Photos.";
    previewSaveStatus.hidden = false;
    return;
  }
  download(url, `${kind}-preview-display-p3`, "jpg");
}

function openPreview(kind: "base" | "exposure"): void {
  const url = kind === "base" ? basePreviewUrl : exposurePreviewUrl;
  if (!url) return;
  previewOverlayImage.src = url;
  previewOverlayImage.alt = kind === "base" ? "Enlarged base preview JPEG" : "Enlarged exposure preview JPEG";
  previewOverlayTitle.textContent = kind === "base" ? "Base preview" : "Exposure preview";
  previewOverlayMeta.textContent = `Display P3 · ${kind === "base" ? baseDisplayDimensions : exposureDisplayDimensions}`;
  openPreviewKind = kind;
  saveOverlayPreview.hidden = false;
  saveOverlayPreview.disabled = sharingPreview || !(kind === "base" ? baseFullPreviewFile : exposureFullPreviewFile);
  previewSaveStatus.hidden = true;
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
  if (error) console.error("Status", message);
  else console.info("Status", message);
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
  sourcePreviewFrame.disabled = busy;
  gamutSelect.disabled = busy;
  syncTransferControl(busy);
  profileSelect.disabled = busy;
  reflInput.disabled = busy;
}

function canCalculate(): boolean {
  return Boolean(
    selectedFile
      && selectedFormat
      && validOptions()
      && interpretationMode !== "unresolved",
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

function updateReconstructionProfile(): void {
  const selected = profileSelect.selectedOptions[0]?.textContent?.trim();
  if (selected) reconstructionProfile.textContent = selected;
}

function updateCalculateState(): void {
  calculateButton.disabled = activeJob !== undefined || !canCalculate();
}

function resetResults(): void {
  closePreview();
  setReportExpanded(false);
  clearPreview(basePreviewImage);
  clearPreview(exposurePreviewImage);
  revokeOutputUrls();
  downloadBase.disabled = true;
  downloadExposureNormEv.disabled = true;
  downloadExposure.disabled = true;
  basePreviewTrigger.disabled = true;
  exposurePreviewTrigger.disabled = true;
  baseDisplayDimensions = "";
  exposureDisplayDimensions = "";
  for (const size of [baseSize, exposureSize, exposureNormEvSize]) {
    size.textContent = "Waiting";
  }
  emptyReport.hidden = false;
  reportContent.hidden = true;
  reportToggle.disabled = true;
}

function setReportExpanded(expanded: boolean): void {
  reportRow.classList.toggle("report-expanded", expanded);
  reportToggle.setAttribute("aria-expanded", String(expanded));
  reportToggle.setAttribute("aria-label", expanded ? "Collapse analytic report" : "Expand analytic report");
  const mobile = reportMobileViewport.matches;
  document.documentElement.classList.toggle("report-open", mobile && expanded);
  document.body.classList.toggle("report-open", mobile && expanded);
  syncDiagnosticScroll();
}

function renderSummary(summary: SourceSummary): void {
  console.info("Image inspection complete", { inspectionId, summary });
  selectedFormat = summary.format;
  sourceInspected = true;
  // DNG is already developed to linear ACES2065-1/AP0 by the WASM decoder;
  // there is no user-selectable source transfer or gamut to expose.
  const isDng = summary.format.toLowerCase() === "dng";
  interpretationGroup.hidden = false;
  interpretationControls.hidden = isDng;
  sourceCacheReadyId = inspectionId;
  setEmbeddedOption(summary);
  gamutSelect.value = embeddedAvailable ? "embedded" : "";
  transferSelect.value = embeddedAvailable ? "sRGB" : "";
  primaryEmbeddedSelection = embeddedAvailable;
  interpretationMode = embeddedAvailable ? "embedded" : "unresolved";
  const orientation = summary.orientation && summary.orientation > 1 ? ` · orientation ${summary.orientation}` : "";
  sourceFormatIndicator.textContent = isDng
    ? `DNG · ${summary.width} × ${summary.height}${orientation}${summary.camera_model ? ` · ${summary.camera_model}` : ""}${summary.photometry ? ` · ${summary.photometry}` : ""}${summary.bit_depth ? ` · ${summary.bit_depth}-bit` : ""}${summary.compression ? ` · ${summary.compression}` : ""} · embedded camera calibration · linear ACES2065-1/AP0`
    : selectedFormat.toUpperCase();
  sourceFormatIndicator.hidden = false;
  updateInterpretationState();
  scheduleSourcePreview();
  updateCalculateState();
}

function scheduleSourcePreview(): void {
  if (sourcePreviewTimer !== undefined) window.clearTimeout(sourcePreviewTimer);
  sourcePreviewTimer = window.setTimeout(() => {
    sourcePreviewTimer = undefined;
    void requestSourcePreview();
  }, 100);
}

async function requestSourcePreview(): Promise<void> {
  // The decomposition flow replaces the preparation worker after it stores
  // the source raster. A preview queued across that handoff would arrive in
  // a fresh worker without the source-byte cache, so keep preview work out of
  // the calculation lifecycle entirely.
  if (activeJob !== undefined || !selectedFile || !selectedFormat) return;
  const generation = ++sourcePreviewGeneration;
  const mode = interpretationMode === "embedded"
    ? "embedded"
    : interpretationMode === "manual"
      ? "manual"
      : "raw-muted";
  const request: Request = {
    format: selectedFormat,
    gamut: mode === "manual" ? gamutSelect.value : null,
    transfer: mode === "manual" ? transferSelect.value : null,
    profile: 4,
    refl: 0.5,
    blur_sigma: 0,
  };
  setSourcePreviewState("loading", mode === "raw-muted" ? "Preparing raw preview…" : "Updating preview…");
  console.info("Source preview requested", { inspectionId, generation, mode, request, cached: sourceCacheReadyId === inspectionId });
  try {
    const message: { kind: "preview"; id: number; generation: number; format: string; request: Request; mode: "embedded" | "manual" | "raw-muted"; bytes?: ArrayBuffer } = { kind: "preview", id: inspectionId, generation, format: selectedFormat, request, mode };
    if (sourceCacheReadyId !== inspectionId) {
      const bytes = await selectedFile.arrayBuffer();
      if (generation !== sourcePreviewGeneration || activeJob !== undefined) return;
      message.bytes = bytes;
      worker.postMessage(message, [bytes]);
      sourceCacheReadyId = inspectionId;
    } else {
      worker.postMessage(message);
    }
  } catch (error) {
    console.error("Source preview request failed", error, { inspectionId, generation });
    if (generation === sourcePreviewGeneration) setSourcePreviewState("error", error instanceof Error ? error.message : String(error));
  }
}

let previewEncoderId = 0;
type EncodedPreview = { size: number; width: number; height: number };
function encodePreviewFile(input: string, output: string, width: number, height: number, signal: AbortSignal, sourceWidth = width, sourceHeight = height): Promise<EncodedPreview> {
  console.info("Create JPEG encoder worker", { input, output, width, height, sourceWidth, sourceHeight });
  signal.throwIfAborted();
  const encoder = new Worker(new URL("./preview_encoder_worker.ts", import.meta.url), { type: "module" });
  const id = ++previewEncoderId;
  return new Promise<EncodedPreview>((resolve, reject) => {
    const finish = () => { encoder.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(new DOMException("Preview encoding cancelled.", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    encoder.onmessage = (event: MessageEvent<DebugMessage | { kind: string; id: number; size: number; width: number; height: number; message?: string }>) => {
      if ("entry" in event.data) { appendDebug(event.data.entry); return; }
      if (event.data.id !== id) return;
      if (event.data.kind === "complete") { finish(); resolve({ size: event.data.size, width: event.data.width, height: event.data.height }); }
      else if (event.data.kind === "error") { finish(); reject(new Error(event.data.message ?? "Preview JPEG encoding failed.")); }
    };
    encoder.onerror = (event) => {
      console.error("JPEG encoder uncaught error", event.error ?? event.message, { id, input, output, width, height, file: event.filename, line: event.lineno, column: event.colno });
      finish(); reject(event.error instanceof Error ? event.error : new Error(event.message || "Preview JPEG worker failed."));
    };
    encoder.onmessageerror = () => { finish(); reject(new Error("Unable to deserialize JPEG encoder worker message.")); };
    encoder.postMessage({ id, input, output, width, height, sourceWidth, sourceHeight });
  });
}

async function encodeDisplayPreviewFile(input: string, output: string, width: number, height: number, signal: AbortSignal): Promise<EncodedPreview> {
  try {
    return await encodePreviewFile(input, output, width, height, signal);
  } catch (firstError) {
    if (signal.aborted) throw firstError;
    // iOS Safari can terminate a worker while the 2048-pixel RGB plane is
    // copied into the encoder's WASM heap. Retry in a new worker with a
    // bounded raster and keep the aspect ratio. The encoded dimensions are
    // returned to the caller and become the displayed preview metadata.
    const maxEdge = 1024;
    if (Math.max(width, height) <= maxEdge) throw firstError;
    const scale = maxEdge / Math.max(width, height);
    const retryWidth = Math.max(1, Math.round(width * scale));
    const retryHeight = Math.max(1, Math.round(height * scale));
    console.warn("Display JPEG encoder worker failed; retrying with bounded raster", {
      input, output, firstError, width, height, retryWidth, retryHeight,
    });
    return encodePreviewFile(input, output, retryWidth, retryHeight, signal, width, height);
  }
}

async function cleanupOpfsJob(id: number): Promise<void> {
  try {
    for (const name of await listScratchFiles()) {
      if (name.startsWith(`decomposition-${id}-`)) await removeScratchFile(name);
    }
  } catch { /* best effort during cancellation */ }
}

async function onWorkerMessage(message: WorkerMessage): Promise<void> {
  if (message.kind === "debug-log") { appendDebug(message.entry); return; }
  if (message.id !== inspectionId && message.id !== activeJob) return;
  if (message.kind === "source-preview") {
    if (message.generation !== sourcePreviewGeneration) return;
    console.info("Source preview received", { id: message.id, generation: message.generation, width: message.width, height: message.height, mode: message.mode, bytes: message.jpeg.byteLength });
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    sourcePreviewUrl = URL.createObjectURL(new Blob([message.jpeg], { type: "image/jpeg" }));
    sourcePreviewImage.src = sourcePreviewUrl;
    sourcePreviewImage.hidden = false;
    setSourcePreviewState(message.mode === "raw-muted" ? "muted" : "ready", message.mode === "raw-muted" ? "Raw decoder preview · interpretation required" : "");
    return;
  }
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
    console.info("Prepared source received; handing off to solve worker", { id: message.id, width: message.width, height: message.height, request: message.request, warnings: message.warnings });
    progressStage.textContent = "Decompose pixels";
    progressBar.value = 25;
    progressPercent.value = "25";
    progressPercent.textContent = "25%";
    progressCounters.textContent = "Starting bounded batches";
    // Preparation/decoding has its own worker lifetime. Terminating it here
    // releases the decoder and prepared raster before solve batches begin.
    replaceWorker();
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
    console.info("Solve complete; handing off to JPEG encoders", { id: message.id, width: message.width, height: message.height, displayWidth: message.displayWidth, displayHeight: message.displayHeight, report: message.report });
    // Each JPEG encoder gets its own lifetime. Never display full-size JPEGs
    // in the page: only the two capped files may be decoded by image elements.
    replaceWorker();
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
        progressCounters.textContent = display ? "Display preview" : "Full-resolution JPEG";
        const result = display
          ? await encodeDisplayPreviewFile(`decomposition-${message.id}-${component}-${suffix}.rgb`, name, message.displayWidth, message.displayHeight, encoding.signal)
          : await encodePreviewFile(`decomposition-${message.id}-${component}-${suffix}.rgb`, name, message.width, message.height, encoding.signal);
        if (activeJob !== message.id) { await cleanupOpfsJob(message.id); return; }
        outputs.push({ name, ...result, kind: `${component}-${suffix}-jpeg` });
      }
      await removeScratchFile(`decomposition-${message.id}-base-preview.rgb`);
      await removeScratchFile(`decomposition-${message.id}-exposure-preview.rgb`);
      await removeScratchFile(`decomposition-${message.id}-base-display.rgb`);
      await removeScratchFile(`decomposition-${message.id}-exposure-display.rgb`);
      for (const name of await listScratchFiles()) {
        if (name === `decomposition-${message.id}-source.f32` || name.startsWith(`decomposition-${message.id}-source-`)) {
          await removeScratchFile(name);
        }
      }
      await onWorkerMessage({ kind: "result", id: message.id, report: message.report, outputs, storage: "opfs" });
    } catch (error) {
      console.error("JPEG output pipeline failed", error, { id: message.id, stage: progressStage.textContent });
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
  if (message.kind === "error" && message.generation !== undefined) {
    console.error("Source preview failed", message);
    if (message.generation === sourcePreviewGeneration) setSourcePreviewState("error", message.message);
    return;
  }
  if (message.kind === "error") {
    console.error("Decomposition failed", message, { stage: progressStage.textContent });
    activeJob = undefined;
    setBusy(false);
    showStatus(message.message, true);
    progressStage.textContent = "Error";
    return;
  }
  activeJob = undefined;
  let files: Map<string, OutputFile>;
  console.info("Open completed output files", { id: message.id, outputs: message.outputs });
  try {
    files = new Map(message.outputs.map((entry) => [entry.kind, entry]));
    const openFile = async (kind: string, mime: string, name?: string): Promise<File | undefined> => {
      const entry = files.get(kind);
      if (!entry) return undefined;
      // OPFS getFile() takes no MIME options. Tag the bytes explicitly so file
      // sharing and Safari image tabs recognize the JPEG without re-encoding.
      const file = await readScratchFile(entry.name, mime);
      return new File([file], name ?? entry.name, { type: mime });
    };
    const openUrl = async (kind: string, mime: string): Promise<string | undefined> => {
      const file = await openFile(kind, mime);
      return file ? URL.createObjectURL(file) : undefined;
    };
    revokeOutputUrls();
    baseUrl = await openUrl("base-exr", "image/x-exr");
    exposureNormEvUrl = await openUrl("exposure-normalized-ev", "image/x-exr");
    exposureUrl = await openUrl("exposure-exr", "image/x-exr");
    basePreviewUrl = await openUrl("base-display-jpeg", "image/jpeg");
    exposurePreviewUrl = await openUrl("exposure-display-jpeg", "image/jpeg");
    const baseName = selectedFile!.name.replace(/\.[^.]+$/, "");
    baseFullPreviewFile = await openFile("base-preview-jpeg", "image/jpeg", `${baseName}-base-preview-display-p3.jpg`);
    exposureFullPreviewFile = await openFile("exposure-preview-jpeg", "image/jpeg", `${baseName}-exposure-preview-display-p3.jpg`);
    baseFullPreviewUrl = baseFullPreviewFile ? URL.createObjectURL(baseFullPreviewFile) : undefined;
    exposureFullPreviewUrl = exposureFullPreviewFile ? URL.createObjectURL(exposureFullPreviewFile) : undefined;
    const displayLabel = (kind: string): string => {
      const file = files.get(kind);
      return file?.width && file.height ? `${file.width} × ${file.height}` : "Unavailable";
    };
    baseDisplayDimensions = displayLabel("base-display-jpeg");
    exposureDisplayDimensions = displayLabel("exposure-display-jpeg");
  } catch (error) {
    console.error("Opening output files failed", error, { id: message.id });
    setBusy(false);
    showStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  showPreview(basePreviewImage, basePreviewUrl);
  showPreview(exposurePreviewImage, exposurePreviewUrl);
  renderReport(message.report);
  downloadBase.disabled = false;
  downloadExposureNormEv.disabled = false;
  downloadExposure.disabled = false;
  basePreviewTrigger.disabled = false;
  exposurePreviewTrigger.disabled = false;
  baseSize.textContent = formatBytes(files.get("base-exr")?.size ?? 0);
  exposureNormEvSize.textContent = formatBytes(files.get("exposure-normalized-ev")?.size ?? 0);
  exposureSize.textContent = formatBytes(files.get("exposure-exr")?.size ?? 0);
  setBusy(false);
  progressBar.value = 100;
  progressPercent.value = "100";
  progressPercent.textContent = "100%";
  progressStage.textContent = "Complete";
  showStatus("Calculation complete. Outputs are ready.");
  if (sourcePreviewFrame.classList.contains("source-preview-loading") || !sourcePreviewUrl) scheduleSourcePreview();
}

function renderReport(report: Report): void {
  const profile = profileSelect.selectedOptions[0]?.textContent ?? String(report.profile);
  reportSummary.textContent = `${formatCount(report.width)} × ${formatCount(report.height)} pixels · ${profile} · Refl ${report.refl.toFixed(3)}`;
  const normalizePrimaries = (value: string): string => {
    if (/display\s+p3|p3-d65/i.test(value)) return "P3-D65";
    if (/rec\.?\s*\.??709|sRGB/i.test(value)) return "Rec.709";
    return value.replace(/\s+primaries?$/i, "").trim();
  };
  const normalizeTransfer = (value: string): string => {
    if (/sRGB/i.test(value)) return "sRGB";
    return value.replace(/\s+encoding$/i, "").trim();
  };
  const confirmedSource = interpretationMode === "manual"
    ? `${normalizePrimaries(gamutSelect.value)} / ${normalizeTransfer(transferSelect.value)}`
    : interpretationMode === "embedded"
      ? embeddedLabel
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
    ["Base output", "Linear ACEScg RGB, fp16"],
    ["Exposure output", "Scalar exposure replicated across linear ACEScg RGB, fp16"],
    ["Exposure norm EV output", "norm EV, scalar fp16"],
    ["Base preview", "P3-D65 JPEG, sRGB encoding"],
    ["Exposure preview", "P3-D65 JPEG, sRGB encoding"],
  ];
  if (report.gpu_adapter) metrics.push(["GPU adapter", report.gpu_adapter]);
  if (report.gpu_validation) metrics.push(["GPU validation", report.gpu_validation]);
  const midpoint = Math.ceil(metrics.length / 2);
  const renderMetrics = (items: Array<[string, string]>): string => items.map(([label, value]) => `<div><dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd></div>`).join("");
  reportMetricsLeft.innerHTML = renderMetrics(metrics.slice(0, midpoint));
  reportMetricsRight.innerHTML = renderMetrics(metrics.slice(midpoint));
  const warnings = report.warnings ?? [];
  reportWarnings.hidden = warnings.length === 0;
  reportWarnings.textContent = warnings.length ? warnings.join(" ") : "";
  emptyReport.hidden = true;
  reportContent.hidden = false;
  reportToggle.disabled = false;
  setReportExpanded(!reportMobileViewport.matches);
}

async function inspectFile(file: File, format: string): Promise<void> {
  console.info("Read source bytes for inspection", { inspectionId, name: file.name, size: file.size, type: file.type, format });
  const id = inspectionId;
  const bytes = await file.arrayBuffer();
  console.info("Source bytes read", { id, bytes: bytes.byteLength });
  if (id !== inspectionId) return;
  worker.postMessage({ kind: "inspect", id, format, bytes }, [bytes]);
}

async function chooseFile(file: File): Promise<void> {
  console.info("Source selected", file);
  const format = detectFormat(file);
  resetResults();
  inspectionId += 1;
  replaceWorker();
  if (sourcePreviewTimer !== undefined) window.clearTimeout(sourcePreviewTimer);
  clearSourcePreview();
  sourceCacheReadyId = undefined;
  sourceInspected = false;
  interpretationGroup.hidden = true;
  sourceFormatIndicator.textContent = "";
  sourceFormatIndicator.hidden = true;
  embeddedAvailable = false;
  primaryEmbeddedSelection = false;
  interpretationMode = "unresolved";
  gamutSelect.value = "";
  transferSelect.value = "";
  const option = gamutSelect.querySelector<HTMLOptionElement>('option[value="embedded"]');
  if (option) option.disabled = true;
  syncTransferControl();
  if (!format) {
    selectedFile = undefined;
    selectedFormat = "";
    showStatus("Unsupported file type. Choose DNG, EXR, JPEG, PNG, HEIC, or HEIF.", true);
    setBusy(false);
    return;
  }
  selectedFile = file;
  selectedFormat = format;
  setSourcePreviewState("loading", "Loading image…");
  progressStage.textContent = "Inspecting metadata";
  progressBar.value = 0;
  progressPercent.textContent = "0%";
  try {
    await inspectFile(file, format);
  } catch (error) {
    console.error("Image inspection request failed", error);
    showStatus(error instanceof Error ? error.message : String(error), true);
    showRawSourcePreview(file);
  }
  updateCalculateState();
}

async function calculate(): Promise<void> {
  if (!selectedFile || !selectedFormat) return;
  optionsError.hidden = true;
  interpretationMode = interpretationFromSelectors();
  if (interpretationMode === "unresolved") {
    return;
  }
  if (!validOptions()) {
    optionsError.textContent = "Refl must be greater than zero and no greater than 1.2.";
    optionsError.hidden = false;
    return;
  }
  if (sourcePreviewTimer !== undefined) {
    window.clearTimeout(sourcePreviewTimer);
    sourcePreviewTimer = undefined;
  }
  sourcePreviewGeneration += 1;
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
    gamut: interpretationMode === "manual" ? gamutSelect.value : null,
    transfer: interpretationMode === "manual" ? transferSelect.value : null,
    profile: Number(profileSelect.value),
    refl: Number(reflInput.value),
    blur_sigma: 0,
  };
  console.info("Decomposition requested", { id, inspectionId, name: selectedFile.name, bytes: bytes.byteLength, interpretationMode, request });
  worker.postMessage({ kind: "calculate", id, format: selectedFormat, bytes, request }, [bytes]);
}

function cancel(): void {
  if (activeJob === undefined) return;
  const cancelledId = activeJob;
  console.warn("Cancel requested; terminating worker", { id: cancelledId, stage: progressStage.textContent });
  worker.postMessage({ kind: "cancel", id: cancelledId });
  // Rust/WASM calls are synchronous inside a worker. Terminate the current
  // worker so cancellation also interrupts an in-flight large image job.
  replaceWorker();
  previewEncoding?.abort();
  previewEncoding = undefined;
  void cleanupOpfsJob(cancelledId);
  activeJob = undefined;
  setBusy(false);
  showStatus("Calculation cancelled. Worker buffers were released.");
  progressStage.textContent = "Cancelled";
  if (sourcePreviewFrame.classList.contains("source-preview-loading") || !sourcePreviewUrl) scheduleSourcePreview();
}

function download(url: string | undefined, suffix: string, extension: string): void {
  if (!url || !selectedFile) return;
  const baseName = selectedFile.name.replace(/\.[^.]+$/, "");
  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}-${suffix}.${extension}`;
  link.click();
}

sourcePreviewFrame.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void chooseFile(file); });
calculateButton.addEventListener("click", () => { if (activeJob !== undefined) cancel(); else void calculate(); });
downloadBase.addEventListener("click", () => download(baseUrl, "base-acescg-fp16", "exr"));
downloadExposureNormEv.addEventListener("click", () => download(exposureNormEvUrl, "exposure-norm-ev", "exr"));
downloadExposure.addEventListener("click", () => download(exposureUrl, "exposure-acescg-fp16", "exr"));
saveOverlayPreview.addEventListener("click", () => {
  if (openPreviewKind) void savePreviewFile(openPreviewKind);
});
basePreviewTrigger.addEventListener("click", () => openPreview("base"));
exposurePreviewTrigger.addEventListener("click", () => openPreview("exposure"));
closePreviewButton.addEventListener("click", closePreview);
previewOverlay.querySelector("[data-close-preview]")?.addEventListener("click", closePreview);
previewOverlay.addEventListener("click", (event) => {
  const target = event.target as Node;
  if (target === previewOverlay || target === previewOverlayImage || (target instanceof HTMLElement && target.closest("button"))) return;
  // Keep the enlarged view dismissible from any backdrop or empty panel area.
  if (!(target instanceof HTMLButtonElement)) closePreview();
});
window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !previewOverlay.hidden) closePreview(); });
for (const control of [transferSelect, profileSelect, reflInput]) {
  control.addEventListener("input", () => { optionsError.hidden = true; updateInterpretationState(); if (control === transferSelect) scheduleSourcePreview(); });
  control.addEventListener("change", () => { optionsError.hidden = true; updateInterpretationState(); if (control === transferSelect) scheduleSourcePreview(); });
}
profileSelect.addEventListener("change", updateReconstructionProfile);
for (const eventName of ["input", "change"] as const) gamutSelect.addEventListener(eventName, () => {
  const wasEmbedded = primaryEmbeddedSelection;
  primaryEmbeddedSelection = gamutSelect.value === "embedded" && embeddedAvailable;
  const manualPrimaries = Boolean(gamutSelect.value && !primaryEmbeddedSelection);
  if (manualPrimaries && (wasEmbedded || !transferSelect.value)) transferSelect.value = "sRGB";
  optionsError.hidden = true;
  updateInterpretationState();
  scheduleSourcePreview();
});
reflInput.addEventListener("change", normalizeReflDisplay);
reflInput.addEventListener("blur", normalizeReflDisplay);
reportToggle.addEventListener("click", () => setReportExpanded(!reportRow.classList.contains("report-expanded")));
reportMobileViewport.addEventListener("change", () => setReportExpanded(false));
window.addEventListener("beforeunload", () => { revokeUrls(); worker.terminate(); previewEncoding?.abort(); });
updateReconstructionProfile();
setBusy(false);
