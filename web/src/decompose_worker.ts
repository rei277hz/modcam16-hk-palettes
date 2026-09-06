import init, { cpu_preview_pixels, encode_exr_outputs, encode_preview_pixels, gpu_preview_pixels, gpu_probe, gpu_solve_chunk, inspect, prepare, prepare_heic_pixels, solve_chunk } from "./wasm/decomposition/modcam16_decomposition_wasm.js";
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
  kind: "inspect" | "calculate";
  id: number;
  format: string;
  bytes: ArrayBuffer;
  request?: DecompositionRequest;
};

type CancelMessage = { kind: "cancel"; id: number };
type WorkerMessage = JobMessage | CancelMessage;

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
type GpuValidation = { adapter: string; batchSize: number; key: string; maxBaseError: number; maxExposureErrorStops: number; maxPreviewError: number };
type EncodedOutputs = {
  report: any;
  base_exr: Uint8Array | ArrayBuffer;
  exposure_exr: Uint8Array | ArrayBuffer;
  exposure_rgb_exr: Uint8Array | ArrayBuffer;
  base_preview_jpeg: Uint8Array | ArrayBuffer;
  exposure_preview_jpeg: Uint8Array | ArrayBuffer;
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let wasmReady: Promise<void> | undefined;
let gpuProbeResult: Promise<GpuProbe | undefined> | undefined;
let gpuProbeFailure: string | undefined;
const gpuValidationCache = new Map<string, GpuValidation>();
const cancelled = new Set<number>();

function postProgress(id: number, stage: string, percent: number, counters?: Progress["counters"]): void {
  const event: Progress = { kind: "progress", id, stage, percent, counters };
  scope.postMessage(event);
}

function ensureWasm(): Promise<void> {
  wasmReady ??= init().then(() => undefined);
  return wasmReady;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const result = await gpu_probe();
      return result as GpuProbe;
    } catch (error) {
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
    const cpu = solve_chunk(VALIDATION_PIXELS, profileRequest);
    const gpu = await gpu_solve_chunk(VALIDATION_PIXELS, profileRequest);
    const cpuBase = cpu.base instanceof Float32Array ? cpu.base : new Float32Array(cpu.base);
    const gpuBase = gpu.base instanceof Float32Array ? gpu.base : new Float32Array(gpu.base);
    const cpuExposure = cpu.exposure instanceof Float32Array ? cpu.exposure : new Float32Array(cpu.exposure);
    const gpuExposure = gpu.exposure instanceof Float32Array ? gpu.exposure : new Float32Array(gpu.exposure);
    let maxBaseError = 0;
    let maxExposureErrorStops = 0;
    for (let i = 0; i < cpuBase.length; i += 1) maxBaseError = Math.max(maxBaseError, Math.abs(cpuBase[i] - gpuBase[i]));
    for (let i = 0; i < cpuExposure.length; i += 1) maxExposureErrorStops = Math.max(maxExposureErrorStops, Math.abs(cpuExposure[i] - gpuExposure[i]) * 20);
    const cpuStats = cpu.stats as SolveStats;
    const gpuStats = gpu.stats as SolveStats;
    if (maxBaseError > 0.0002 || maxExposureErrorStops > 0.002
        || cpuStats.projected_pixels !== gpuStats.projected_pixels
        || cpuStats.clipped_pixels !== gpuStats.clipped_pixels
        || cpuStats.non_finite_pixels !== gpuStats.non_finite_pixels) {
      throw new Error(`WebGPU validation for ACES profile ${profile} exceeded the CPU reference tolerance (base ${maxBaseError}, exposure ${maxExposureErrorStops} stops).`);
    }
    let maxPreviewError = 0;
    if (profile === 4) {
      const cpuPreview = cpu_preview_pixels(cpuBase, cpuExposure, request.refl);
      const gpuPreview = await gpu_preview_pixels(cpuBase, cpuExposure, request.refl);
      const cpuBasePreview = cpuPreview.base instanceof Uint8Array ? cpuPreview.base : new Uint8Array(cpuPreview.base);
      const gpuBasePreview = gpuPreview.base instanceof Uint8Array ? gpuPreview.base : new Uint8Array(gpuPreview.base);
      const cpuExposurePreview = cpuPreview.exposure instanceof Uint8Array ? cpuPreview.exposure : new Uint8Array(cpuPreview.exposure);
      const gpuExposurePreview = gpuPreview.exposure instanceof Uint8Array ? gpuPreview.exposure : new Uint8Array(gpuPreview.exposure);
      for (let i = 0; i < cpuBasePreview.length; i += 1) {
        maxPreviewError = Math.max(maxPreviewError, Math.abs(cpuBasePreview[i] - gpuBasePreview[i]), Math.abs(cpuExposurePreview[i] - gpuExposurePreview[i]));
      }
      if (maxPreviewError > 1) throw new Error(`WebGPU ACES 2.0 P3-D65 preview validation exceeded the exact CPU reference by ${maxPreviewError} encoded levels.`);
    }
    const validation: GpuValidation = {
      adapter: probe.adapter_name || "WebGPU adapter",
      batchSize: Math.max(1, Math.floor(probe.max_batch_pixels || 262144)),
      key,
      maxBaseError,
      maxExposureErrorStops,
      maxPreviewError,
    };
    gpuValidationCache.set(key, validation);
    if (profile === request.profile) selected = validation;
  }
  return selected;
}

function textHasGainMap(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return text.includes("urn:com:apple:photo:2020:aux:hdrgainmap") || text.includes("HDRGainMap");
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

async function decodeHeif(bytes: Uint8Array, id: number): Promise<{ width: number; height: number; pixels: Float32Array; icc: Uint8Array; gain?: { pixels: Float32Array; width: number; height: number }; exif: Uint8Array; warnings: string[] }> {
  postProgress(id, "Decode HEIF/HEIC", 12);
  const module = libheif as any;
  const decoder = new module.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) throw new Error("The HEIF file contains no decodable image.");
  const image = module.heif_js_context_get_primary_image_handle(decoder.decoder);
  if (!image || image.code) throw new Error("The HEIF file contains no decodable primary image.");
  const native = nativeRgb16(image);
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
  const gain = textHasGainMap(bytes) ? nativeAuxiliary(module, decoder.decoder, image) : undefined;
  const warnings: string[] = [`libheif-js native RGB decode preserved ${native.bitDepth}-bit samples in 16-bit storage.`];
  if (textHasGainMap(bytes) && !gain) warnings.push("Apple HDR gain-map metadata was detected, but its auxiliary image could not be decoded.");
  if (gain) warnings.push("Apple HDR gain-map auxiliary decoded and will be reconstructed before ACES conversion.");
  return { width, height, pixels: native.pixels, icc, gain, exif, warnings };
}

async function handle(message: JobMessage): Promise<void> {
  const { id, format } = message;
  try {
    await ensureWasm();
    if (cancelled.has(id)) return;
    const bytes = new Uint8Array(message.bytes);
    if (message.kind === "inspect") {
      postProgress(id, "Inspect metadata", 8);
      if (format === "heic" || format === "heif") {
        const decoded = await decodeHeif(bytes, id);
        scope.postMessage({ kind: "inspect-result", id, summary: { format, width: decoded.width, height: decoded.height, gamut: null, transfer: null, metadata_source: decoded.icc.length ? "HEIF ICC profile" : "libheif-js nclx metadata", automatic_icc: decoded.icc.length > 0, warnings: decoded.warnings } });
      } else {
        const summary = inspect(bytes, format);
        scope.postMessage({ kind: "inspect-result", id, summary });
      }
      postProgress(id, "Ready for confirmation", 15);
      return;
    }
    if (!message.request) throw new Error("Missing decomposition options.");
    postProgress(id, "Decode and prepare pixels", 18);
    let prepared: any;
    let warnings: string[] = [];
    if (format === "heic" || format === "heif") {
      const decoded = await decodeHeif(bytes, id);
      if (cancelled.has(id)) return;
      const gain = decoded.gain;
      prepared = prepare_heic_pixels(decoded.pixels, decoded.width, decoded.height, message.request, decoded.icc, gain?.pixels ?? new Float32Array(), gain?.width ?? 0, gain?.height ?? 0, decoded.exif);
      warnings = decoded.warnings;
    } else {
      prepared = prepare(bytes, message.request);
      warnings = Array.isArray(prepared?.warnings) ? prepared.warnings : [];
    }
    if (cancelled.has(id)) return;
    const width = Number(prepared.width);
    const height = Number(prepared.height);
    const pixels = prepared.pixels instanceof Float32Array ? prepared.pixels : new Float32Array(prepared.pixels);
    const preparedWarnings = Array.isArray(prepared.warnings) ? prepared.warnings : [];
    warnings = [...warnings, ...preparedWarnings];
    let gpuValidation: GpuValidation | undefined;
    let gpuValidationFailure: string | undefined;
    postProgress(id, "Initialize WebGPU", 20);
    const probe = await probeGpu();
    if (probe?.available) {
      postProgress(id, "Validate WebGPU against CPU reference", 21);
      try {
        gpuValidation = await validateGpu(message.request, probe);
      } catch (error) {
        gpuValidationFailure = formatError(error);
        warnings.push(`WebGPU was not enabled because validation against the original f64 CPU modCAM16-HK implementation failed: ${gpuValidationFailure}`);
      }
    } else if (gpuProbeFailure) {
      warnings.push(`WebGPU was not enabled; the worker will use wasm-cpu: ${gpuProbeFailure}`);
    }
    let useGpu = Boolean(gpuValidation);
    let backend = useGpu ? "webgpu" : "wasm-cpu";
    let batchSize = useGpu ? gpuValidation!.batchSize : 4096;
    const base = new Float32Array(width * height * 3);
    const exposure = new Float32Array(width * height);
    let stats = emptyStats();
    stats.compute_backend = backend;
    stats.gpu_adapter = gpuValidation?.adapter ?? probe?.adapter_name ?? null;
    stats.gpu_validation = gpuValidation
      ? `CPU reference: original f64 modCAM16-HK and exact ACES 2.0 P3-D65; max base error ${gpuValidation.maxBaseError.toExponential(3)}, max exposure error ${gpuValidation.maxExposureErrorStops.toExponential(3)} stops, max preview error ${gpuValidation.maxPreviewError} encoded levels`
      : gpuValidationFailure ? `failed: ${gpuValidationFailure}` : null;
    stats.batch_size = batchSize;
    // CPU uses deliberately yielded 4,096-pixel chunks. WebGPU uses the
    // adapter's largest validated storage batch to amortize readback costs.
    const totalPixels = width * height;
    postProgress(id, "Decompose pixels", 25, {
      processed: 0,
      projected: 0,
      clipped: 0,
      non_finite: 0,
    });
    let start = 0;
    while (start < totalPixels) {
      if (cancelled.has(id)) return;
      const stop = Math.min(totalPixels, start + batchSize);
      const chunk = pixels.slice(start * 3, stop * 3);
      let solved: any;
      try {
        solved = useGpu ? await gpu_solve_chunk(chunk, message.request) : solve_chunk(chunk, message.request);
      } catch (error) {
        if (!useGpu) throw error;
        // A device loss or adapter limit failure invalidates every in-flight
        // GPU result. Restart the complete image on the authoritative CPU
        // implementation so outputs never combine two numerical paths.
        warnings.push(`WebGPU stopped during processing and the complete job was restarted on wasm-cpu: ${formatError(error)}`);
        useGpu = false;
        backend = "wasm-cpu";
        batchSize = 4096;
        base.fill(0);
        exposure.fill(0);
        stats = emptyStats();
        stats.compute_backend = backend;
        stats.gpu_adapter = gpuValidation?.adapter ?? null;
        stats.gpu_validation = "GPU validation passed; processing fell back to original f64 CPU modCAM16-HK after a device error";
        stats.batch_size = batchSize;
        start = 0;
        postProgress(id, "Restarting on wasm-cpu", 25, { processed: 0, projected: 0, clipped: 0, non_finite: 0 });
        continue;
      }
      const chunkBase = solved.base instanceof Float32Array ? solved.base : new Float32Array(solved.base);
      const chunkExposure = solved.exposure instanceof Float32Array ? solved.exposure : new Float32Array(solved.exposure);
      base.set(chunkBase, start * 3);
      exposure.set(chunkExposure, start);
      addStats(stats, solved.stats as SolveStats);
      postProgress(id, useGpu ? "Decompose pixels (WebGPU)" : "Decompose pixels (wasm-cpu)", 25 + (stop / totalPixels) * 65, {
        processed: stop,
        projected: stats.projected_pixels,
        clipped: stats.clipped_pixels,
        non_finite: stats.non_finite_pixels,
      });
      start = stop;
      await yieldToUi();
    }
    if (cancelled.has(id)) return;
    const previewBasePixels = new Uint8Array(totalPixels * 3);
    const previewExposurePixels = new Uint8Array(totalPixels * 3);
    let previewUseGpu = useGpu;
    let previewBatch = previewUseGpu ? gpuValidation!.batchSize : 4096;
    let previewStart = 0;
    const previewStartedAt = performance.now();
    while (previewStart < totalPixels) {
      if (cancelled.has(id)) return;
      const stop = Math.min(totalPixels, previewStart + previewBatch);
      const stage = `ACES 2.0 P3-D65 preview transform (${previewUseGpu ? "WebGPU" : "wasm-cpu"})`;
      postProgress(id, stage, 90 + (previewStart / totalPixels) * 2, { processed: previewStart });
      let preview: any;
      try {
        const chunkBase = base.slice(previewStart * 3, stop * 3);
        const chunkExposure = exposure.slice(previewStart, stop);
        preview = previewUseGpu
          ? await gpu_preview_pixels(chunkBase, chunkExposure, message.request.refl)
          : cpu_preview_pixels(chunkBase, chunkExposure, message.request.refl);
      } catch (error) {
        if (!previewUseGpu) throw error;
        warnings.push(`WebGPU preview transform failed; both previews were restarted on the exact CPU ACES 2.0 implementation: ${formatError(error)}`);
        previewUseGpu = false;
        previewBatch = 4096;
        previewStart = 0;
        continue;
      }
      const chunkBase = preview.base instanceof Uint8Array ? preview.base : new Uint8Array(preview.base);
      const chunkExposure = preview.exposure instanceof Uint8Array ? preview.exposure : new Uint8Array(preview.exposure);
      previewBasePixels.set(chunkBase, previewStart * 3);
      previewExposurePixels.set(chunkExposure, previewStart * 3);
      previewStart = stop;
      postProgress(id, stage, 90 + (stop / totalPixels) * 2, { processed: stop });
      await yieldToUi();
    }
    stats.preview_backend = previewUseGpu ? "webgpu" : "wasm-cpu";
    stats.preview_transform_ms = performance.now() - previewStartedAt;
    if (cancelled.has(id)) return;
    postProgress(id, "Encode base and exposure EXRs", 93, { processed: totalPixels, projected: stats.projected_pixels, clipped: stats.clipped_pixels, non_finite: stats.non_finite_pixels });
    await yieldToUi();
    const result = encode_exr_outputs(base, exposure, width, height, message.request, stats, warnings);
    if (cancelled.has(id)) return;
    postProgress(id, "Encode base preview JPEG", 95, { processed: totalPixels });
    await yieldToUi();
    const basePreviewJpeg = encode_preview_pixels(previewBasePixels, width, height);
    if (cancelled.has(id)) return;
    postProgress(id, "Encode exposure preview JPEG", 98, { processed: totalPixels });
    await yieldToUi();
    const exposurePreviewJpeg = encode_preview_pixels(previewExposurePixels, width, height);
    const baseBytes = result.base_exr instanceof Uint8Array ? result.base_exr : new Uint8Array(result.base_exr);
    const exposureBytes = result.exposure_exr instanceof Uint8Array ? result.exposure_exr : new Uint8Array(result.exposure_exr);
    const exposureRgbBytes = result.exposure_rgb_exr instanceof Uint8Array ? result.exposure_rgb_exr : new Uint8Array(result.exposure_rgb_exr);
    const basePreviewBytes = basePreviewJpeg instanceof Uint8Array ? basePreviewJpeg : new Uint8Array(basePreviewJpeg);
    const exposurePreviewBytes = exposurePreviewJpeg instanceof Uint8Array ? exposurePreviewJpeg : new Uint8Array(exposurePreviewJpeg);
    postProgress(id, "Complete", 100, {
      processed: totalPixels,
      projected: result.report?.projected_pixels,
      clipped: result.report?.clipped_pixels,
      non_finite: result.report?.non_finite_pixels,
      encoded_bytes: baseBytes.byteLength + exposureBytes.byteLength + exposureRgbBytes.byteLength + basePreviewBytes.byteLength + exposurePreviewBytes.byteLength,
    });
    scope.postMessage({ kind: "result", id, report: result.report, base_exr: baseBytes, exposure_exr: exposureBytes, exposure_rgb_exr: exposureRgbBytes, base_preview_jpeg: basePreviewBytes, exposure_preview_jpeg: exposurePreviewBytes }, [baseBytes.buffer, exposureBytes.buffer, exposureRgbBytes.buffer, basePreviewBytes.buffer, exposurePreviewBytes.buffer]);
  } catch (error) {
    if (!cancelled.has(id)) scope.postMessage({ kind: "error", id, message: formatError(error) });
  }
}

scope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.kind === "cancel") {
    cancelled.add(message.id);
    scope.postMessage({ kind: "cancelled", id: message.id });
    return;
  }
  void handle(message);
};
