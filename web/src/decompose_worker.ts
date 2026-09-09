import { checkpoint, setDebugMemory } from "./debug_worker";
import init, { DisplayPreview, build_report, cpu_preview_ap0, cpu_preview_pixels, encode_preview_pixels, gpu_preview_ap0, gpu_preview_pixels, gpu_probe, gpu_solve_chunk, inspect, new_bounded_display_preview, prepare, prepare_heic_pixels, prepare_jpeg_preview, solve_chunk } from "./wasm/decomposition/modcam16_decomposition_wasm.js";
import { batchPixelLimit, convertExrRow } from "./decomposition_buffers";
import { sourceBatches } from "./source_batches";
import { ScanlineExrWriter } from "./exr_zip";
import { IndexedDbAccess, listScratchFiles, readScratchFile, removeIndexedDbFile, removeScratchFile } from "./scratch_store";
import libheif from "libheif-js/wasm-bundle";

type DecompositionRequest = {
  format: string;
  gamut?: string | null;
  transfer?: string | null;
  profile: number;
  refl: number;
  blur_sigma: number;
};

type JobMessage = {
  kind: "inspect" | "calculate" | "preview";
  id: number;
  format: string;
  bytes?: ArrayBuffer;
  request?: DecompositionRequest;
  generation?: number;
  mode?: "embedded" | "manual" | "raw-muted";
};

type CancelMessage = { kind: "cancel"; id: number };
type SolveMessage = {
  kind: "solve";
  id: number;
  width: number;
  height: number;
  source: string;
  request: DecompositionRequest;
  warnings: string[];
};
type WorkerMessage = JobMessage | SolveMessage | CancelMessage;

type Progress = {
  kind: "progress";
  id: number;
  stage: string;
  percent: number;
  counters?: { processed?: number; projected?: number; clipped?: number; non_finite?: number; encoded_bytes?: number };
};

type SolveStats = {
  projected_pixels: number;
  clipped_pixels: number;
  non_finite_pixels: number;
  exposure_min: number;
  exposure_max: number;
  exposure_sum: number;
  base_min: number;
  base_max: number;
  base_sum: number;
  finite_pixels: number;
  compute_backend?: string;
  gpu_adapter?: string | null;
  gpu_validation?: string | null;
  batch_size?: number;
  preview_backend?: string;
  preview_transform_ms?: number;
};

type GpuProbe = { available: boolean; adapter_name?: string; max_batch_pixels?: number };
type GpuValidation = { adapter: string; batchSize: number; key: string; maxBaseError: number; maxExposureErrorStops: number; maxExposureScalarErrorStops: number; maxPreviewError: number };
type OutputFile = { name: string; size: number; kind: string };

type FileSink = { write(data: Uint8Array, offset?: number): Promise<void>; close(): Promise<void>; size: number; name: string };

class OpfsSink implements FileSink {
  size = 0;
  private closed = false;
  private constructor(private readonly access: any, private readonly synchronous: boolean, readonly name: string) {}
  static async create(name: string): Promise<OpfsSink> {
    checkpoint("Open OPFS output", { name });
    let sink: OpfsSink | undefined;
    let handle: any;
    try {
      const root = await (navigator.storage as any).getDirectory();
      handle = await root.getFileHandle(name, { create: true });
    } catch (error) {
      console.warn("OPFS file handle creation failed; using IndexedDB scratch storage", { name }, error);
    }
    // Some browsers expose createSyncAccessHandle but reject it at runtime
    // (for example when the file is temporarily locked by another worker).
    // Fall back to the asynchronous writable stream instead of failing the
    // complete calculation on that capability check.
    if (handle?.createSyncAccessHandle) {
      try {
        const access = await handle.createSyncAccessHandle();
        try {
          access.truncate(0);
          await removeIndexedDbFile(name);
          sink = new OpfsSink(access, true, name);
        } catch (error) {
          try { await access.close(); } catch { /* best effort */ }
          console.warn("OPFS sync handle initialization failed; trying writable stream", { name }, error);
        }
      } catch (error) {
        console.warn("OPFS sync handle unavailable; trying writable stream", { name }, error);
      }
    }
    if (!sink && handle?.createWritable) {
      try {
        const writable = await handle.createWritable({ keepExistingData: false });
        await removeIndexedDbFile(name);
        sink = new OpfsSink(writable, false, name);
      } catch (error) {
        console.warn("OPFS writable stream unavailable; using IndexedDB scratch storage", { name }, error);
      }
    }
    if (!sink) {
      const access = new IndexedDbAccess(name);
      await access.truncate(0);
      sink = new OpfsSink(access, false, name);
      checkpoint("IndexedDB scratch output opened", { name });
    }
    openSinks.add(sink);
    checkpoint("OPFS output opened", { name, synchronous: sink.synchronous });
    return sink;
  }
  async write(data: Uint8Array, offset = this.size): Promise<void> {
    if (this.synchronous) {
      let written = 0;
      while (written < data.byteLength) {
        const result = this.access.write(data.subarray(written), { at: offset + written });
        if (!Number.isInteger(result) || result <= 0) throw new Error("Local storage write did not complete.");
        written += result;
      }
    } else {
      if (offset !== this.size && typeof this.access.seek !== "function") throw new Error("The OPFS streaming writer cannot seek.");
      if (offset !== this.size) await this.access.seek(offset);
      await this.access.write(data);
    }
    this.size = Math.max(this.size, offset + data.byteLength);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (typeof this.access.flush === "function") await this.access.flush();
    } finally {
      try { await this.access.close(); } finally { openSinks.delete(this); }
    }
    checkpoint("OPFS output closed", { name: this.name, bytes: this.size });
  }
}

const openSinks = new Set<OpfsSink>();
async function closeSinks(): Promise<void> {
  for (const sink of openSinks) await sink.close().catch(error => console.warn("OPFS close failed", { name: sink.name }, error));
}

async function createOutputWriters(id: number, width: number, height: number): Promise<{ writers: { base: ScanlineExrWriter; exposure: ScanlineExrWriter; exposureNormEv: ScanlineExrWriter }; outputs: OutputFile[] }> {
  const prefix = `decomposition-${id}`;
  const specs = [
    ["base.exr", ["B", "G", "R"], "base", "base"],
    ["exposure.exr", ["exposure"], "exposureNormEv", "exposure_norm-ev"],
    ["exposure-rgb.exr", ["B", "G", "R"], "exposure", "exposure"],
  ] as const;
  const writers: Partial<{ base: ScanlineExrWriter; exposure: ScanlineExrWriter; exposureNormEv: ScanlineExrWriter }> = {};
  const outputs: OutputFile[] = [];
  for (const [suffix, channels, key, component] of specs) {
    const name = `${prefix}-${suffix}`;
    const sink = await OpfsSink.create(name);
    writers[key] = await ScanlineExrWriter.create(sink, width, height, [...channels], component);
    outputs.push({ name, size: 0, kind: component === "base" ? "base-exr" : component === "exposure" ? "exposure-exr" : "exposure-normalized-ev" });
  }
  return { writers: writers as { base: ScanlineExrWriter; exposure: ScanlineExrWriter; exposureNormEv: ScanlineExrWriter }, outputs };
}

async function cleanupOutputFiles(id: number, preserveSource = false): Promise<void> {
  const storage = (navigator as any).storage;
  const prefix = `decomposition-${id}-`;
  try {
    for (const name of await listScratchFiles()) {
      if (name.startsWith(prefix) && !(preserveSource && name.startsWith(`${prefix}source-`))) await removeScratchFile(name);
    }
  } catch { /* best effort cleanup */ }
}

async function cleanupPreviousOutputs(currentId: number): Promise<void> {
  try {
    for (const name of await listScratchFiles()) {
      if (name.startsWith("decomposition-") && !name.startsWith(`decomposition-${currentId}-`)) await removeScratchFile(name);
    }
  } catch { /* best effort */ }
}

async function removeOpfsFile(name: string): Promise<void> {
  await removeScratchFile(name);
}

function uniqueSourceName(id: number): string {
  const suffix = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `decomposition-${id}-source-${suffix}.f32`;
}

async function openSourceFile(name: string): Promise<File> {
  return readScratchFile(name, "application/octet-stream");
}

async function ensureScratchQuota(width: number, height: number): Promise<void> {
  const storage = (navigator as any).storage;
  const hasOpfs = typeof storage?.getDirectory === "function";
  const hasIndexedDb = typeof indexedDB !== "undefined";
  if (!hasOpfs && !hasIndexedDb) throw new Error("This browser cannot provide local scratch storage for a full-resolution job.");
  const estimate = storage.estimate ? await storage.estimate() : undefined;
  const required = width * height * 28 + Math.min(width * height, 2048 * 2048) * 12 + 32 * 1024 * 1024;
  checkpoint("Scratch storage quota", { width, height, required, estimate });
  if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < required) {
    throw new Error(`Insufficient local storage for this full-resolution job (need about ${formatBytes(required)} free).`);
  }
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let wasmReady: Promise<void> | undefined;
let gpuProbeResult: Promise<GpuProbe | undefined> | undefined;
let gpuProbeFailure: string | undefined;
const gpuValidationCache = new Map<string, GpuValidation>();
const cancelled = new Set<number>();
const sourceBytes = new Map<number, Uint8Array>();
const previewGenerations = new Map<number, number>();
const heifSources = new Map<number, Awaited<ReturnType<typeof decodeHeif>>>();
// DNG development is expensive and produces a large AP0 raster. Keep that
// prepared object alive between the initial source preview and the subsequent
// decomposition request so the same selected file is decoded only once.
const preparedSources = new Map<number, { image: any; warnings: string[] }>();

function clearPreparedSources(keepId?: number): void {
  for (const [id, entry] of preparedSources) {
    if (id !== keepId) {
      try { entry.image.free(); } catch { /* best effort during replacement */ }
      preparedSources.delete(id);
    }
  }
}


function postProgress(id: number, stage: string, percent: number, counters?: Progress["counters"]): void {
  checkpoint("Progress", { id, stage, percent: Math.round(percent * 10) / 10, counters });
  const event: Progress = { kind: "progress", id, stage, percent, counters };
  scope.postMessage(event);
}

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    checkpoint("Initialize decomposition WASM");
    wasmReady = init().then(exports => { setDebugMemory(exports.memory); checkpoint("Decomposition WASM ready"); });
  }
  return wasmReady;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function emptyStats(): SolveStats {
  return {
    projected_pixels: 0,
    clipped_pixels: 0,
    non_finite_pixels: 0,
    exposure_min: Number.POSITIVE_INFINITY,
    exposure_max: Number.NEGATIVE_INFINITY,
    exposure_sum: 0,
    base_min: Number.POSITIVE_INFINITY,
    base_max: Number.NEGATIVE_INFINITY,
    base_sum: 0,
    finite_pixels: 0,
  };
}

function addStats(total: SolveStats, chunk: SolveStats): void {
  total.projected_pixels += chunk.projected_pixels;
  total.clipped_pixels += chunk.clipped_pixels;
  total.non_finite_pixels += chunk.non_finite_pixels;
  total.exposure_min = Math.min(total.exposure_min, chunk.exposure_min);
  total.exposure_max = Math.max(total.exposure_max, chunk.exposure_max);
  total.exposure_sum += chunk.exposure_sum;
  total.base_min = Math.min(total.base_min, chunk.base_min);
  total.base_max = Math.max(total.base_max, chunk.base_max);
  total.base_sum += chunk.base_sum;
  total.finite_pixels += chunk.finite_pixels;
}

async function probeGpu(): Promise<GpuProbe | undefined> {
  gpuProbeResult ??= (async () => {
    const browserGlobal = globalThis as unknown as {
      isSecureContext?: boolean;
      navigator?: { gpu?: unknown };
      location?: { protocol?: string };
    };
    if (browserGlobal.isSecureContext === false) {
      gpuProbeFailure = `WebGPU requires a secure context; this page uses ${browserGlobal.location?.protocol || "an insecure origin"}.`;
      return undefined;
    }
    if (!browserGlobal.navigator?.gpu) {
      gpuProbeFailure = "WebGPU is not exposed in this worker (the browser may expose it only on the main thread or may require HTTPS).";
      return undefined;
    }
    try {
      checkpoint("Probe GPU adapter");
      const result = await gpu_probe();
      checkpoint("GPU probe result", result);
      return result as GpuProbe;
    } catch (error) {
      console.warn("GPU probe failed", error);
      gpuProbeFailure = formatError(error);
      return undefined;
    }
  })();
  return gpuProbeResult;
}

const VALIDATION_PIXELS = new Float32Array([
  0.0, 0.0, 0.0,
  0.001, 0.02, 0.12,
  0.15, 0.25, 0.4,
  0.5, 0.5, 0.5,
  1.0, 0.25, 0.03125,
  4.0, 2.0, 0.5,
  -0.05, 0.2, 0.7,
  20.0, 20.0, 20.0,
  // Values generated once with the fixed seed 0x4d43414d and kept literal so
  // validation remains reproducible across browsers and worker restarts.
  0.6123, 0.0417, 1.8731,
  3.1042, 0.0081, 0.2274,
  0.0922, 1.4418, 0.3186,
  7.75, 2.125, 0.015625,
]);

async function validateGpu(request: DecompositionRequest, probe: GpuProbe): Promise<GpuValidation | undefined> {
  if (!probe.available) return undefined;
  let selected: GpuValidation | undefined;
  for (const profile of [0, 1, 2, 4]) {
    const profileRequest = { ...request, profile };
    const key = `${profile}:${request.refl.toPrecision(9)}`;
    const cached = gpuValidationCache.get(key);
    if (cached) {
      if (profile === request.profile) selected = cached;
      continue;
    }
    checkpoint("Validate GPU profile", { profile, request: profileRequest });
    const cpu = solve_chunk(VALIDATION_PIXELS, profileRequest);
    const gpu = await gpu_solve_chunk(VALIDATION_PIXELS, profileRequest);
    const cpuBase = cpu.base instanceof Float32Array ? cpu.base : new Float32Array(cpu.base);
    const gpuBase = gpu.base instanceof Float32Array ? gpu.base : new Float32Array(gpu.base);
    const cpuExposure = cpu.exposure instanceof Float32Array ? cpu.exposure : new Float32Array(cpu.exposure);
    const gpuExposure = gpu.exposure instanceof Float32Array ? gpu.exposure : new Float32Array(gpu.exposure);
    const cpuExposureScalar = cpu.exposure_scalar instanceof Float32Array ? cpu.exposure_scalar : new Float32Array(cpu.exposure_scalar);
    const gpuExposureScalar = gpu.exposure_scalar instanceof Float32Array ? gpu.exposure_scalar : new Float32Array(gpu.exposure_scalar);
    let maxBaseError = 0;
    let maxExposureErrorStops = 0;
    let maxExposureScalarErrorStops = 0;
    for (let i = 0; i < cpuBase.length; i += 1) maxBaseError = Math.max(maxBaseError, Math.abs(cpuBase[i] - gpuBase[i]));
    for (let i = 0; i < cpuExposure.length; i += 1) maxExposureErrorStops = Math.max(maxExposureErrorStops, Math.abs(cpuExposure[i] - gpuExposure[i]) * 20);
    for (let i = 0; i < cpuExposureScalar.length; i += 1) {
      const cpuScalar = cpuExposureScalar[i], gpuScalar = gpuExposureScalar[i];
      if (cpuScalar === 0 || gpuScalar === 0) maxExposureScalarErrorStops = Math.max(maxExposureScalarErrorStops, cpuScalar === gpuScalar ? 0 : 1000);
      else maxExposureScalarErrorStops = Math.max(maxExposureScalarErrorStops, Math.abs(Math.log2(cpuScalar) - Math.log2(gpuScalar)));
    }
    const cpuStats = cpu.stats as SolveStats;
    const gpuStats = gpu.stats as SolveStats;
    if (maxBaseError > 0.0002 || maxExposureErrorStops > 0.002 || maxExposureScalarErrorStops > 0.002
        || cpuStats.projected_pixels !== gpuStats.projected_pixels
        || cpuStats.clipped_pixels !== gpuStats.clipped_pixels
        || cpuStats.non_finite_pixels !== gpuStats.non_finite_pixels) {
      throw new Error(`WebGPU validation for ACES profile ${profile} exceeded the CPU reference tolerance (base ${maxBaseError}, norm EV ${maxExposureErrorStops} stops, scalar ${maxExposureScalarErrorStops} stops).`);
    }
    let maxPreviewError = 0;
    if (profile === 4) {
      const cpuPreview = cpu_preview_pixels(cpuBase, cpuExposureScalar, request.refl);
      const gpuPreview = await gpu_preview_pixels(cpuBase, cpuExposureScalar, request.refl);
      const gpuDisplay = await gpu_preview_ap0(cpuBase);
      const cpuBasePreview = cpuPreview.base instanceof Uint8Array ? cpuPreview.base : new Uint8Array(cpuPreview.base);
      const gpuBasePreview = gpuPreview.base instanceof Uint8Array ? gpuPreview.base : new Uint8Array(gpuPreview.base);
      const cpuExposurePreview = cpuPreview.exposure instanceof Uint8Array ? cpuPreview.exposure : new Uint8Array(cpuPreview.exposure);
      const gpuExposurePreview = gpuPreview.exposure instanceof Uint8Array ? gpuPreview.exposure : new Uint8Array(gpuPreview.exposure);
      for (let i = 0; i < cpuBasePreview.length; i += 1) {
        maxPreviewError = Math.max(maxPreviewError, Math.abs(cpuBasePreview[i] - gpuBasePreview[i]), Math.abs(cpuExposurePreview[i] - gpuExposurePreview[i]), Math.abs(cpuBasePreview[i] - gpuDisplay[i]));
      }
      if (maxPreviewError > 1) throw new Error(`WebGPU ACES 2.0 P3-D65 preview validation exceeded the exact CPU reference by ${maxPreviewError} encoded levels.`);
    }
    const validation: GpuValidation = {
      adapter: probe.adapter_name || "WebGPU adapter",
      batchSize: batchPixelLimit(VALIDATION_PIXELS.length / 3, true, probe),
      key,
      maxBaseError,
      maxExposureErrorStops,
      maxExposureScalarErrorStops,
      maxPreviewError,
    };
    checkpoint("GPU profile validated", validation);
    gpuValidationCache.set(key, validation);
    if (profile === request.profile) selected = validation;
  }
  return selected;
}

function textHasGainMap(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return text.includes("urn:com:apple:photo:2020:aux:hdrgainmap") || text.includes("HDRGainMap");
}

/** Read the ISO-BMFF colr/nclx CICP pair when no ICC profile is embedded. */
function parseNclx(bytes: Uint8Array): { gamut: string; transfer: string } | undefined {
  for (let i = 0; i + 11 < bytes.length; i++) {
    if (bytes[i] !== 0x6e || bytes[i + 1] !== 0x63 || bytes[i + 2] !== 0x6c || bytes[i + 3] !== 0x78) continue;
    const primaries = (bytes[i + 4] << 8) | bytes[i + 5];
    const transfer = (bytes[i + 6] << 8) | bytes[i + 7];
    const gamut = primaries === 1 ? "Rec.709 / sRGB" : primaries === 9 ? "Rec.2020" : primaries === 12 ? "Display P3 / P3-D65" : undefined;
    const tr = transfer === 13 ? "sRGB" : transfer === 16 ? "PQ / ST 2084" : transfer === 18 ? "HLG / BT.2100" : transfer === 1 || transfer === 14 || transfer === 15 ? "BT.709 / BT.2020" : transfer === 8 ? "Linear" : undefined;
    if (gamut && tr) return { gamut, transfer: tr };
  }
  return undefined;
}

async function renderSourcePreview(message: JobMessage): Promise<void> {
  if (!message.request || !message.mode) throw new Error("Missing source preview interpretation.");
  const id = message.id;
  let prepared: any;
  let cachedPrepared = false;
  let display: DisplayPreview | undefined;
  let decoded: Awaited<ReturnType<typeof decodeHeif>> | undefined;
  try {
    if (message.bytes) sourceBytes.set(id, new Uint8Array(message.bytes));
    const bytes = sourceBytes.get(id);
    if (!bytes) throw new Error("The source preview cache is unavailable; reload the image to continue.");
    const generation = message.generation ?? 0;
    const isCurrent = () => previewGenerations.get(id) === generation;
    if (!isCurrent()) return;
    const sourceRequest = message.mode === "raw-muted"
      ? { ...message.request, gamut: "Rec.709 / sRGB", transfer: "sRGB" }
      : message.request;
    checkpoint("Prepare source preview", { id, generation, format: message.format, mode: message.mode, bytes: bytes.byteLength, request: sourceRequest });
    if (message.format === "heic" || message.format === "heif") {
      decoded = heifSources.get(id) ?? await decodeHeif(bytes, id);
      heifSources.set(id, decoded);
      if (cancelled.has(id)) return;
      const request = { ...message.request };
      if (message.mode === "embedded" && !decoded.icc.length && decoded.gamut && decoded.transfer) {
        request.gamut = decoded.gamut;
        request.transfer = decoded.transfer;
      }
      if (message.mode === "raw-muted") {
        request.gamut = "Rec.709 / sRGB";
        request.transfer = "sRGB";
      }
      prepared = prepare_heic_pixels(
        decoded.pixels,
        decoded.width,
        decoded.height,
        request,
        decoded.icc,
        decoded.gain?.pixels ?? new Float32Array(),
        decoded.gain?.width ?? 0,
        decoded.gain?.height ?? 0,
        decoded.exif,
      );
    } else if (message.format === "jpeg") {
      prepared = prepare_jpeg_preview(bytes, sourceRequest, 1024);
    } else {
      const cached = message.format === "dng" ? preparedSources.get(id) : undefined;
      if (cached) {
        prepared = cached.image;
        cachedPrepared = true;
      } else {
        prepared = prepare(bytes, sourceRequest);
        if (message.format === "dng") {
          preparedSources.set(id, { image: prepared, warnings: Array.isArray(prepared.warnings) ? prepared.warnings : [] });
          cachedPrepared = true;
        }
      }
    }
    const width = Number(prepared.width), height = Number(prepared.height);
    checkpoint("Source preview prepared; begin display transform", { id, generation, width, height });
    display = new_bounded_display_preview(width, height, 1024);
    const chunks: Uint8Array[] = [];
    const rowsPerBatch = Math.max(1, Math.min(height, Math.floor(256 * 1024 / Math.max(1, width))));
    let rowsSinceYield = 0;
    for (let y = 0; y < height; y += rowsPerBatch) {
      if (cancelled.has(id) || !isCurrent()) return;
      const rows = Math.min(rowsPerBatch, height - y);
      const pixels = prepared.read_pixels(y * width, rows * width);
      const reduced = display.append_rgb(pixels);
      if (reduced.length) chunks.push(cpu_preview_ap0(reduced));
      rowsSinceYield += rows;
      if (rowsSinceYield >= 16) {
        rowsSinceYield = 0;
        await yieldToUi();
      }
    }
    if (!isCurrent()) return;
    display.finish();
    const rgb = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { rgb.set(chunk, offset); offset += chunk.byteLength; }
    checkpoint("Encode source preview JPEG", { id, generation, width: display.width, height: display.height, rgbBytes: rgb.byteLength });
    const jpeg = encode_preview_pixels(rgb, display.width, display.height);
    checkpoint("Source preview JPEG complete", { id, generation, jpegBytes: jpeg.byteLength });
    const buffer = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
    if (!isCurrent()) return;
    scope.postMessage({ kind: "source-preview", id, generation, width: display.width, height: display.height, mode: message.mode, jpeg: buffer }, [buffer]);
  } finally {
    display?.free();
    if (!cachedPrepared) prepared?.free();
    // Cached HEIF samples stay alive for subsequent interpretation changes.
  }
}

function nativeRgb16(image: any): { width: number; height: number; pixels: Float32Array; bitDepth: number } {
  const module = (libheif as any);
  const decoded = module.heif_js_decode_image2(image, module.heif_colorspace_RGB, module.heif_chroma_interleaved_RRGGBB_LE);
  if (!decoded || decoded.code || !decoded.channels?.length) throw new Error("libheif-js could not decode native RGB samples.");
  const channel = decoded.channels.find((c: any) => Number(c.id) === Number(module.heif_channel_interleaved)) ?? decoded.channels[0];
  const width = Number(decoded.width), height = Number(decoded.height), bits = Number(channel.bits_per_pixel || 16);
  const bytes = channel.data instanceof Uint8Array ? channel.data : new Uint8Array(channel.data);
  const pixels = new Float32Array(width * height * 3), stride = Number(channel.stride || width * 6), max = (2 ** bits) - 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let y = 0, out = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++, out += 3) {
      const off = row + x * 6;
      pixels[out] = view.getUint16(off, true) / max;
      pixels[out + 1] = view.getUint16(off + 2, true) / max;
      pixels[out + 2] = view.getUint16(off + 4, true) / max;
    }
  }
  module.heif_image_release(decoded.image);
  return { width, height, pixels, bitDepth: bits };
}

function nativeAuxiliary(module: any, context: any, primary: any): { pixels: Float32Array; width: number; height: number } | undefined {
  const ptr = primary.$$?.ptr;
  const count = Number(module._heif_image_handle_get_number_of_auxiliary_images(ptr, 0));
  if (!count) return undefined;
  const idsPtr = module._malloc(count * 4);
  const actual = Number(module._heif_image_handle_get_list_of_auxiliary_image_IDs(ptr, 0, idsPtr, count));
  try {
    for (let i = 0; i < actual; i++) {
      const auxId = module.HEAPU32[(idsPtr >> 2) + i];
      const handle = module.heif_js_context_get_image_handle(context, auxId);
      if (!handle || handle.code) continue;
      const typeOut = module._malloc(4), err = module._malloc(32);
      let auxType = "";
      try {
        module._heif_image_handle_get_auxiliary_type(err, handle.$$?.ptr, typeOut);
        const typePtr = module.HEAPU32[typeOut >> 2];
        if (typePtr) auxType = new TextDecoder().decode(module.HEAPU8.subarray(typePtr, typePtr + 160)).split("\0")[0];
      } finally { module._free(typeOut); module._free(err); }
      if (auxType !== "urn:com:apple:photo:2020:aux:hdrgainmap") continue;
      const decoded = nativeRgb16(handle);
      // Apple gain maps are grayscale; use the first channel after decoding
      // the auxiliary as native RGB to support both grayscale and RGB encoders.
      const gain = new Float32Array(decoded.width * decoded.height);
      for (let p = 0; p < gain.length; p++) gain[p] = decoded.pixels[p * 3];
      return { pixels: gain, width: decoded.width, height: decoded.height };
    }
  } finally {
    module._free(idsPtr);
  }
  return undefined;
}

function extractExif(module: any, primary: any): Uint8Array {
  const ptr = primary.$$?.ptr;
  const count = Number(module._heif_image_handle_get_number_of_metadata_blocks(ptr, 0));
  if (!count) return new Uint8Array();
  const idsPtr = module._malloc(count * 4);
  const actual = Number(module._heif_image_handle_get_list_of_metadata_block_IDs(ptr, 0, idsPtr, count));
  try {
    for (let i = 0; i < actual; i++) {
      const mid = module.HEAPU32[(idsPtr >> 2) + i];
      const typePtr = module._heif_image_handle_get_metadata_type(ptr, mid);
      const type = new TextDecoder().decode(module.HEAPU8.subarray(typePtr, typePtr + 8)).split("\0")[0];
      if (type !== "Exif") continue;
      const size = Number(module._heif_image_handle_get_metadata_size(ptr, mid));
      const dst = module._malloc(size), err = module._malloc(32);
      try {
        module._heif_image_handle_get_metadata(err, ptr, mid, dst);
        return new Uint8Array(module.HEAPU8.slice(dst, dst + size));
      } finally { module._free(dst); module._free(err); }
    }
  } finally { module._free(idsPtr); }
  return new Uint8Array();
}

async function decodeHeif(bytes: Uint8Array, id: number): Promise<{ width: number; height: number; pixels: Float32Array; icc: Uint8Array; gamut?: string; transfer?: string; gain?: { pixels: Float32Array; width: number; height: number }; exif: Uint8Array; warnings: string[] }> {
  postProgress(id, "Decode HEIF/HEIC", 12);
  const module = libheif as any;
  const decoder = new module.HeifDecoder();
  checkpoint("libheif decode container", { id, bytes: bytes.byteLength });
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) throw new Error("The HEIF file contains no decodable image.");
  const image = module.heif_js_context_get_primary_image_handle(decoder.decoder);
  if (!image || image.code) throw new Error("The HEIF file contains no decodable primary image.");
  checkpoint("libheif decode native RGB", { id });
  const native = nativeRgb16(image);
  checkpoint("libheif native RGB ready", { id, width: native.width, height: native.height, bitDepth: native.bitDepth, pixelBytes: native.pixels.byteLength });
  const width = native.width, height = native.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("The HEIF image has invalid dimensions.");
  }
  const ptr = image.$$?.ptr;
  const profileSize = Number(module._heif_image_handle_get_raw_color_profile_size(ptr));
  let icc = new Uint8Array();
  if (profileSize > 0) {
    const dst = module._malloc(profileSize), err = module._malloc(32);
    module._heif_image_handle_get_raw_color_profile(err, ptr, dst);
    icc = new Uint8Array(module.HEAPU8.slice(dst, dst + profileSize));
    module._free(dst); module._free(err);
  }
  const exif = extractExif(module, image);
  checkpoint("Read HEIF metadata and auxiliary gain map", { id, iccBytes: icc.length, exifBytes: exif.length, gainMapDetected: textHasGainMap(bytes) });
  const gain = textHasGainMap(bytes) ? nativeAuxiliary(module, decoder.decoder, image) : undefined;
  checkpoint("HEIF decode complete", { id, width, height, gainWidth: gain?.width, gainHeight: gain?.height });
  const nclx = parseNclx(bytes);
  const warnings: string[] = [];
  if (textHasGainMap(bytes) && !gain) warnings.push("Apple HDR gain-map metadata was detected, but its auxiliary image could not be decoded.");
  return { width, height, pixels: native.pixels, icc, gamut: nclx?.gamut, transfer: nclx?.transfer, gain, exif, warnings };
}

async function solvePreparedFromOpfs(message: SolveMessage): Promise<void> {
  const { id, width, height } = message;
  let gpuValidation: GpuValidation | undefined;
  let gpuValidationFailure: string | undefined;
  const warnings = [...message.warnings];
  postProgress(id, "Initialize WebGPU", 20);
  const probe = await probeGpu();
  if (probe?.available) {
    postProgress(id, "Validate WebGPU against CPU reference", 21);
    try {
      gpuValidation = await validateGpu(message.request, probe);
    } catch (error) {
      console.warn("GPU validation failed; use CPU", error, { id });
      gpuValidationFailure = formatError(error);
      warnings.push(`WebGPU was not enabled because validation against the original f64 CPU modCAM16-HK implementation failed: ${gpuValidationFailure}`);
    }
  } else if (gpuProbeFailure) {
    warnings.push(`WebGPU was not enabled; the worker will use wasm-cpu: ${gpuProbeFailure}`);
  }
  let useGpu = Boolean(gpuValidation);
  if (useGpu && batchPixelLimit(width, true, probe) === 0) {
    useGpu = false;
    warnings.push("This image's row exceeds the WebGPU batch limit; processing will use wasm-cpu.");
  }
  checkpoint("Select solve backend", { id, width, height, useGpu, gpuValidation, gpuProbeFailure });
  let backend = useGpu ? "webgpu" : "wasm-cpu";
  let batchSize = batchPixelLimit(width, useGpu, probe);
  await cleanupPreviousOutputs(id);
  await ensureScratchQuota(width, height);
  let output = await createOutputWriters(id, width, height);
  let { writers } = output;
  let basePreviewRaw = await OpfsSink.create(`decomposition-${id}-base-preview.rgb`);
  let exposurePreviewRaw = await OpfsSink.create(`decomposition-${id}-exposure-preview.rgb`);
  let baseDisplayRaw = await OpfsSink.create(`decomposition-${id}-base-display.rgb`);
  let exposureDisplayRaw = await OpfsSink.create(`decomposition-${id}-exposure-display.rgb`);
  let baseDisplay = new DisplayPreview(width, height);
  let exposureDisplay = new DisplayPreview(width, height);
  const displayWidth = baseDisplay.width, displayHeight = baseDisplay.height;
  const previewStartedAt = performance.now();
  let previewUseGpu = useGpu;
  const transformDisplay = async (ap0: Float32Array): Promise<Uint8Array> => {
    if (!ap0.length) return new Uint8Array();
    if (previewUseGpu) {
      try { return await gpu_preview_ap0(ap0); }
      catch (error) {
        throw new Error(`WebGPU display preview transform failed: ${formatError(error)}`);
      }
    }
    return cpu_preview_ap0(ap0);
  };
  let stats = emptyStats();
  stats.compute_backend = backend;
  stats.gpu_adapter = gpuValidation?.adapter ?? probe?.adapter_name ?? null;
  stats.gpu_validation = gpuValidation
    ? `CPU reference: original f64 modCAM16-HK and exact ACES 2.0 P3-D65; max base error ${gpuValidation.maxBaseError.toExponential(3)}, max norm EV error ${gpuValidation.maxExposureErrorStops.toExponential(3)} stops, max scalar error ${gpuValidation.maxExposureScalarErrorStops.toExponential(3)} stops, max preview error ${gpuValidation.maxPreviewError} encoded levels`
    : gpuValidationFailure ? `failed: ${gpuValidationFailure}` : null;
  stats.batch_size = batchSize;
  const totalPixels = width * height;
  const sourceFile = await openSourceFile(message.source);
  postProgress(id, "Decompose pixels", 25, { processed: 0, projected: 0, clipped: 0, non_finite: 0 });
  let batches = sourceBatches(sourceFile, totalPixels, batchSize);
  let lastYield = performance.now();
  try {
    while (true) {
      if (cancelled.has(id)) return;
      const next = await batches.next();
      if (next.done) break;
      const batch = next.value;
      const { start, stop } = batch;
      if (cancelled.has(id)) return;
      const pixelCount = stop - start;
      checkpoint("Solve batch start", {
        id,
        start,
        stop,
        backend,
        inputBytes: batch.pixels.byteLength,
        gpuInputBytes: useGpu ? pixelCount * 16 : undefined,
        gpuOutputBytes: useGpu ? pixelCount * 16 : undefined,
        gpuFlagsBytes: useGpu ? pixelCount * 4 : undefined,
        gpuReadbackBytes: useGpu ? pixelCount * 20 : undefined,
      });
      const batchStartedAt = performance.now();
      let solved: any;
      try {
        solved = useGpu ? await gpu_solve_chunk(batch.pixels, message.request) : solve_chunk(batch.pixels, message.request);
        batch.pixels = new Float32Array(0);
        let chunkBase = solved.base instanceof Float32Array ? solved.base : new Float32Array(solved.base);
        let chunkExposureNormEv = solved.exposure instanceof Float32Array ? solved.exposure : new Float32Array(solved.exposure);
        let chunkExposure = solved.exposure_scalar instanceof Float32Array ? solved.exposure_scalar : new Float32Array(solved.exposure_scalar);
        checkpoint("Solve batch complete; transform output previews", { id, start, stop, backend, solveMs: performance.now() - batchStartedAt, previewUseGpu });
        const preview = previewUseGpu
          ? await gpu_preview_pixels(chunkBase, chunkExposure, message.request.refl)
          : cpu_preview_pixels(chunkBase, chunkExposure, message.request.refl);
        checkpoint("Write batch previews and EXR rows", { id, start, stop });
        await basePreviewRaw.write(preview.base instanceof Uint8Array ? preview.base : new Uint8Array(preview.base));
        await exposurePreviewRaw.write(preview.exposure instanceof Uint8Array ? preview.exposure : new Uint8Array(preview.exposure));
        // Average the solved scene-linear AP0 and linear exposure canvas first.
        // Only completed display rows pass through the existing ACES transform.
        await baseDisplayRaw.write(await transformDisplay(baseDisplay.append_rgb(chunkBase)));
        await exposureDisplayRaw.write(await transformDisplay(exposureDisplay.append_exposure(chunkExposure, message.request.refl)));
        for (let row = 0; row < (stop - start) / width; row++) {
          const y = Math.floor(start / width) + row;
          const rows = convertExrRow(chunkBase, chunkExposureNormEv, row * width, width, chunkExposure);
          await writers.base.writeRow(y, { B: rows.baseB, G: rows.baseG, R: rows.baseR });
          await writers.exposure.writeRow(y, { B: rows.exposure, G: rows.exposure, R: rows.exposure });
          await writers.exposureNormEv.writeRow(y, { exposure: rows.exposureNormEv });
        }
        addStats(stats, solved.stats as SolveStats);
        chunkBase = new Float32Array(0); chunkExposureNormEv = new Float32Array(0); chunkExposure = new Float32Array(0); solved = undefined;
      } catch (error) {
        console.error("GPU batch or preview failed", error, { id, start, stop, backend, previewUseGpu });
        batch.pixels = new Float32Array(0);
        if (!useGpu) throw error;
        await batches.return();
        warnings.push(`WebGPU failed during processing and the complete job was restarted on wasm-cpu: ${formatError(error)}`);
        useGpu = false;
        previewUseGpu = false;
        backend = "wasm-cpu";
        batchSize = batchPixelLimit(width, false);
        await closeSinks(); await cleanupOutputFiles(id, true);
        output = await createOutputWriters(id, width, height);
        writers = output.writers;
        basePreviewRaw = await OpfsSink.create(`decomposition-${id}-base-preview.rgb`);
        exposurePreviewRaw = await OpfsSink.create(`decomposition-${id}-exposure-preview.rgb`);
        baseDisplayRaw = await OpfsSink.create(`decomposition-${id}-base-display.rgb`);
        exposureDisplayRaw = await OpfsSink.create(`decomposition-${id}-exposure-display.rgb`);
        baseDisplay.free(); exposureDisplay.free();
        baseDisplay = new DisplayPreview(width, height);
        exposureDisplay = new DisplayPreview(width, height);
        stats = emptyStats(); stats.compute_backend = backend; stats.gpu_adapter = gpuValidation?.adapter ?? null; stats.gpu_validation = `GPU failed and processing restarted on wasm-cpu: ${formatError(error)}`; stats.batch_size = batchSize;
        batches = sourceBatches(sourceFile, totalPixels, batchSize);
        postProgress(id, "Restarting on wasm-cpu", 25, { processed: 0, projected: 0, clipped: 0, non_finite: 0 });
        continue;
      }
      postProgress(id, useGpu ? "Decompose pixels (WebGPU)" : "Decompose pixels (wasm-cpu)", 25 + (stop / totalPixels) * 65, { processed: stop, projected: stats.projected_pixels, clipped: stats.clipped_pixels, non_finite: stats.non_finite_pixels });
      if (performance.now() - lastYield >= 50) {
        await yieldToUi();
        lastYield = performance.now();
      }
    }
    try {
      baseDisplay.finish();
      exposureDisplay.finish();
    } catch (error) {
      throw new Error(`Display preview resampling failed: ${formatError(error)}`);
    }
  } finally {
    await batches.return();
    baseDisplay.free(); exposureDisplay.free();
  }
  stats.preview_backend = previewUseGpu ? "webgpu" : "wasm-cpu";
  stats.preview_transform_ms = performance.now() - previewStartedAt;
  postProgress(id, "Finalize EXR files", 93, { processed: totalPixels, projected: stats.projected_pixels, clipped: stats.clipped_pixels, non_finite: stats.non_finite_pixels });
  await writers.base.close(); await writers.exposure.close(); await writers.exposureNormEv.close();
  await basePreviewRaw.close(); await exposurePreviewRaw.close();
  await baseDisplayRaw.close(); await exposureDisplayRaw.close();
  checkpoint("Build analytic report", { id, width, height, stats, warnings });
  const report = build_report(width, height, message.request, stats, warnings);
  const outputs = output.outputs.map((entry, index) => ({ ...entry, size: [writers.base.size, writers.exposureNormEv.size, writers.exposure.size][index] }));
  postProgress(id, "Prepare preview JPEGs", 94, { processed: totalPixels });
  scope.postMessage({ kind: "preview-encode", id, width, height, displayWidth, displayHeight, report, outputs, storage: "opfs" });
}

async function handle(message: WorkerMessage): Promise<void> {
  const { id } = message;
  let prepared: any;
  const startedAt = performance.now();
  checkpoint("Request start", { ...message, bytes: "bytes" in message ? message.bytes?.byteLength : undefined });
  try {
    await ensureWasm();
    if (cancelled.has(id)) return;
    if (message.kind === "solve") {
      await solvePreparedFromOpfs(message);
      return;
    }
    if (message.kind === "preview") {
      await renderSourcePreview(message);
      return;
    }
    if (message.kind === "cancel") return;
    const format = message.format;
    if (!message.bytes) throw new Error("The worker did not receive image bytes.");
    let bytes = new Uint8Array(message.bytes);
    if (message.kind === "inspect") {
      for (const key of sourceBytes.keys()) if (key !== id) sourceBytes.delete(key);
      for (const key of heifSources.keys()) if (key !== id) heifSources.delete(key);
      clearPreparedSources(id);
      sourceBytes.set(id, bytes);
      postProgress(id, "Inspect metadata", 8);
      if (format === "heic" || format === "heif") {
        const decoded = await decodeHeif(bytes, id);
        scope.postMessage({ kind: "inspect-result", id, summary: { format, width: decoded.width, height: decoded.height, gamut: decoded.gamut ?? null, transfer: decoded.transfer ?? null, metadata_source: decoded.icc.length ? "HEIF ICC profile" : decoded.gamut ? "HEIF nclx metadata" : null, automatic_icc: decoded.icc.length > 0, embedded_available: decoded.icc.length > 0 || Boolean(decoded.gamut && decoded.transfer), warnings: decoded.warnings } });
      } else if (format === "dng") {
        // DNG inspection necessarily decodes/develops the raw raster to verify
        // its embedded calibration and opcode chain. Retain that object for
        // the preview and calculation so the expensive development happens
        // only once per selected file.
        const dngRequest = { format: "dng", gamut: null, transfer: null, profile: 4, refl: 0.5, blur_sigma: 0 };
        checkpoint("WASM DNG preparation start", { id, bytes: bytes.byteLength });
        const prepared = prepare(bytes, dngRequest);
        const summary = prepared.summary ?? null;
        if (!summary) throw new Error("DNG decoder did not return source metadata.");
        preparedSources.set(id, { image: prepared, warnings: Array.isArray(prepared.warnings) ? prepared.warnings : [] });
        checkpoint("WASM DNG preparation complete", {
          id,
          width: Number(prepared.width),
          height: Number(prepared.height),
          warnings: Array.isArray(prepared.warnings) ? prepared.warnings : [],
          summary,
        });
        const transform = summary.dng_transform;
        if (transform) {
          checkpoint("DNG color transform diagnostics", {
            id,
            sourceWhiteXYZ: transform.source_white_xyz,
            rawRange: transform.raw_sample_range,
            normalizedRange: transform.normalized_sample_range,
            demosaicedRange: transform.demosaiced_rgb_range,
            postVignetteRange: transform.post_vignette_rgb_range,
            finalAP0Range: transform.final_ap0_range,
            representativeCameraRGB: transform.representative_camera_rgb,
            representativeAP0: transform.representative_ap0,
            matrixFirstWeight: transform.color_matrix_first_weight,
            forwardMatrixUsed: transform.forward_matrix_used,
          });
        }
        scope.postMessage({ kind: "inspect-result", id, summary });
      } else {
        checkpoint("WASM inspect start", { id, format, bytes: bytes.byteLength });
        const summary = inspect(bytes, format);
        checkpoint("WASM inspect complete", { id, summary });
        scope.postMessage({ kind: "inspect-result", id, summary });
      }
      postProgress(id, "Ready for confirmation", 15);
      return;
    }
    if (!message.request) throw new Error("Missing decomposition options.");
    postProgress(id, "Decode and prepare pixels", 18);
    let warnings: string[] = [];
    if (format === "heic" || format === "heif") {
      const decoded = heifSources.get(id) ?? await decodeHeif(bytes, id);
      heifSources.set(id, decoded);
      if (cancelled.has(id)) return;
      const gain = decoded.gain;
      const effectiveRequest = { ...message.request };
      if (!effectiveRequest.gamut && !effectiveRequest.transfer && !decoded.icc.length && decoded.gamut && decoded.transfer) {
        effectiveRequest.gamut = decoded.gamut;
        effectiveRequest.transfer = decoded.transfer;
      }
      checkpoint("WASM prepare HEIF pixels", { id, width: decoded.width, height: decoded.height, request: effectiveRequest });
      prepared = prepare_heic_pixels(decoded.pixels, decoded.width, decoded.height, effectiveRequest, decoded.icc, gain?.pixels ?? new Float32Array(), gain?.width ?? 0, gain?.height ?? 0, decoded.exif);
      // libheif's JS buffers are separate from the Rust-owned prepared image.
      // Release them as soon as conversion finishes, before batch solving.
      warnings = decoded.warnings;
    } else {
      checkpoint("WASM prepare source", { id, format, bytes: bytes.byteLength, request: message.request });
      if (format === "dng") {
        const cached = preparedSources.get(id);
        if (cached) {
          prepared = cached.image;
          warnings = cached.warnings;
          preparedSources.delete(id);
        } else {
          prepared = prepare(bytes, message.request);
          warnings = Array.isArray(prepared?.warnings) ? prepared.warnings : [];
        }
      } else {
        prepared = prepare(bytes, message.request);
        warnings = Array.isArray(prepared?.warnings) ? prepared.warnings : [];
      }
    }
    if (cancelled.has(id)) return;
    const width = Number(prepared.width);
    const height = Number(prepared.height);
    const preparedWarnings = Array.isArray(prepared.warnings) ? prepared.warnings : [];
    // The cached DNG image carries the same warning list exposed by the
    // prepared object.  Merge both sources while keeping report diagnostics
    // stable when a preparation was reused between inspection and solving.
    warnings = [...new Set([...warnings, ...preparedWarnings])];
    checkpoint("Source prepared", { id, width, height, warnings });
    await ensureScratchQuota(width, height);
    const sourceName = uniqueSourceName(id);
    const sourceSink = await OpfsSink.create(sourceName);
    const sourceBatch = batchPixelLimit(width, true);
    let lastProgress = 0;
    for (let start = 0; start < width * height; start += sourceBatch) {
      if (cancelled.has(id)) return;
      const count = Math.min(sourceBatch, width * height - start);
      const chunk = prepared.read_pixels(start, count);
      await sourceSink.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (performance.now() - lastProgress >= 50 || start + count === width * height) {
        postProgress(id, "Prepare source batches", 18 + ((start + count) / (width * height)) * 4, { processed: start + count });
        await yieldToUi();
        lastProgress = performance.now();
      }
    }
    await sourceSink.close();
    prepared.free();
    prepared = undefined;
    bytes = new Uint8Array(0);
    message.bytes = new ArrayBuffer(0);
    postProgress(id, "Prepared source stored locally", 23, { processed: width * height });
    scope.postMessage({ kind: "source-ready", id, width, height, source: sourceName, request: message.request, warnings });
    return;
  } catch (error) {
    console.error("Request failed", { id, kind: message.kind, generation: "generation" in message ? message.generation : undefined, elapsedMs: performance.now() - startedAt }, error);
    // A preview request is read-only. It must not close decomposition sinks or
    // remove a source raster when a stale request reaches a worker handoff.
    if (message.kind !== "preview") {
      await closeSinks();
      await cleanupOutputFiles(id);
    }
    if (!cancelled.has(id)) scope.postMessage({ kind: "error", id, generation: message.kind === "preview" ? message.generation : undefined, message: formatError(error) });
  } finally {
    if (message.kind !== "preview") await closeSinks();
    prepared?.free();
    checkpoint("Request finished", { id, kind: message.kind, elapsedMs: performance.now() - startedAt });
  }
}

scope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.kind === "preview") previewGenerations.set(message.id, message.generation ?? 0);
  if (message.kind === "cancel") {
    cancelled.add(message.id);
    void cleanupOutputFiles(message.id);
    scope.postMessage({ kind: "cancelled", id: message.id });
    return;
  }
  void handle(message).catch(error => console.error("Request cleanup failed", { id: message.id, kind: message.kind }, error));
};
