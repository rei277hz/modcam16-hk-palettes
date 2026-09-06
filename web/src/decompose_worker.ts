import init, { encode_outputs, inspect, prepare, prepare_pixels, solve_chunk } from "./wasm/decomposition/modcam16_decomposition_wasm.js";
import libheif from "libheif-js/wasm-bundle";

type DecompositionRequest = {
  format: string;
  gamut: string;
  transfer: string;
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
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let wasmReady: Promise<void> | undefined;
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

function textHasGainMap(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return text.includes("urn:com:apple:photo:2020:aux:hdrgainmap") || text.includes("HDRGainMap");
}

function imageDisplay(image: any, width: number, height: number): Promise<Uint8ClampedArray> {
  const data = new Uint8ClampedArray(width * height * 4);
  return new Promise((resolve, reject) => {
    image.display({ data, width, height }, (displayed: any) => {
      if (!displayed) {
        reject(new Error("libheif-js could not render the HEIF image."));
        return;
      }
      resolve(data);
    });
  });
}

async function decodeHeif(bytes: Uint8Array, id: number): Promise<{ width: number; height: number; pixels: Float32Array; warnings: string[] }> {
  postProgress(id, "Decode HEIF/HEIC", 12);
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) throw new Error("The HEIF file contains no decodable image.");
  const image = images[0];
  const width = Number(image.get_width());
  const height = Number(image.get_height());
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("The HEIF image has invalid dimensions.");
  }
  const rgba = await imageDisplay(image, width, height);
  const pixels = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
    pixels[p] = rgba[i] / 255;
    pixels[p + 1] = rgba[i + 1] / 255;
    pixels[p + 2] = rgba[i + 2] / 255;
  }
  const warnings = [
    "libheif-js supplied an 8-bit display RGB buffer; confirm the source gamut and transfer manually.",
  ];
  if (images.length > 1) warnings.push(`${images.length - 1} auxiliary HEIF image(s) were present; only the primary image is exposed by this decoder bridge.`);
  if (textHasGainMap(bytes)) warnings.push("Apple HDR gain-map metadata was detected. The pinned libheif-js high-level API does not expose the auxiliary gain image or headroom values, so no gain-map composition was applied.");
  return { width, height, pixels, warnings };
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
        scope.postMessage({ kind: "inspect-result", id, summary: { format, width: decoded.width, height: decoded.height, gamut: null, transfer: null, metadata_source: "libheif-js", warnings: decoded.warnings } });
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
      prepared = prepare_pixels(decoded.pixels, decoded.width, decoded.height, message.request);
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
    const base = new Float32Array(width * height * 3);
    const exposure = new Float32Array(width * height);
    const stats = emptyStats();
    // A J_HK solve is deliberately yielded in small chunks. A large chunk
    // keeps WASM call overhead low but can starve the worker event loop for
    // many seconds on large EXRs, hiding progress and delaying cancellation.
    const chunkPixels = 4096;
    const totalPixels = width * height;
    postProgress(id, "Decompose pixels", 25, {
      processed: 0,
      projected: 0,
      clipped: 0,
      non_finite: 0,
    });
    for (let start = 0; start < totalPixels; start += chunkPixels) {
      if (cancelled.has(id)) return;
      const stop = Math.min(totalPixels, start + chunkPixels);
      const chunk = pixels.slice(start * 3, stop * 3);
      const solved = solve_chunk(chunk, message.request);
      const chunkBase = solved.base instanceof Float32Array ? solved.base : new Float32Array(solved.base);
      const chunkExposure = solved.exposure instanceof Float32Array ? solved.exposure : new Float32Array(solved.exposure);
      base.set(chunkBase, start * 3);
      exposure.set(chunkExposure, start);
      addStats(stats, solved.stats as SolveStats);
      postProgress(id, "Decompose pixels", 25 + (stop / totalPixels) * 65, {
        processed: stop,
        projected: stats.projected_pixels,
        clipped: stats.clipped_pixels,
        non_finite: stats.non_finite_pixels,
      });
      await yieldToUi();
    }
    if (cancelled.has(id)) return;
    postProgress(id, "Encode base and exposure EXR", 92, { processed: totalPixels, projected: stats.projected_pixels, clipped: stats.clipped_pixels, non_finite: stats.non_finite_pixels });
    const result = encode_outputs(base, exposure, width, height, message.request, stats, warnings);
    const baseBytes = result.base_exr instanceof Uint8Array ? result.base_exr : new Uint8Array(result.base_exr);
    const exposureBytes = result.exposure_exr instanceof Uint8Array ? result.exposure_exr : new Uint8Array(result.exposure_exr);
    postProgress(id, "Complete", 100, {
      processed: totalPixels,
      projected: result.report?.projected_pixels,
      clipped: result.report?.clipped_pixels,
      non_finite: result.report?.non_finite_pixels,
      encoded_bytes: baseBytes.byteLength + exposureBytes.byteLength,
    });
    scope.postMessage({ kind: "result", id, report: result.report, base_exr: baseBytes, exposure_exr: exposureBytes }, [baseBytes.buffer, exposureBytes.buffer]);
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
