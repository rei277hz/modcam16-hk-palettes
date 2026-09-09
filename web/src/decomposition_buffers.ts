const AP0_TO_AP1 = [
  [1.4514393, -0.23651075, -0.21492857],
  [-0.07655377, 1.1762297, -0.09967593],
  [0.008316148, -0.00603245, 0.9977163],
] as const;

// These views are reused because this conversion runs for every channel of
// every output pixel. Allocating a typed-array pair per call dominates the
// scanline writer for large images.
const floatBits = new Float32Array(1);
const uintBits = new Uint32Array(floatBits.buffer);

function floatToHalf(value: number): number {
  floatBits[0] = value;
  const bits = uintBits[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13);
}

export function batchPixelLimit(width: number, gpu: boolean, probe?: { max_batch_pixels?: number }): number {
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error("Invalid source width.");
  // CPU calls are synchronous, so keep their budget smaller for responsiveness.
  // Keep GPU allocations conservative on mobile WebGPU implementations. A
  // solve batch also needs output, flags, and readback buffers; 131,072
  // pixels keeps each padded vec4 buffer near 2 MiB instead of the 8 MiB
  // allocation rejected by the affected Android device.
  const target = gpu ? 131_072 : 32_768;
  const adapterLimit = gpu ? probe?.max_batch_pixels ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (!(adapterLimit >= width)) return 0; // The caller selects CPU when a GPU row cannot fit.
  return Math.floor(Math.min(Math.max(width, target), adapterLimit) / width) * width;
}

export function convertExrRow(base: Float32Array, exposureNormEv: Float32Array, offset: number, width: number, exposure: Float32Array): { baseR: Uint16Array; baseG: Uint16Array; baseB: Uint16Array; exposureNormEv: Uint16Array; exposure: Uint16Array } {
  const baseR = new Uint16Array(width), baseG = new Uint16Array(width), baseB = new Uint16Array(width), exposureNormEvOut = new Uint16Array(width), exposureOut = new Uint16Array(width);
  for (let x = 0; x < width; x++) {
    const i = offset + x;
    const r = base[i * 3], g = base[i * 3 + 1], b = base[i * 3 + 2];
    const ap1r = AP0_TO_AP1[0][0] * r + AP0_TO_AP1[0][1] * g + AP0_TO_AP1[0][2] * b;
    const ap1g = AP0_TO_AP1[1][0] * r + AP0_TO_AP1[1][1] * g + AP0_TO_AP1[1][2] * b;
    const ap1b = AP0_TO_AP1[2][0] * r + AP0_TO_AP1[2][1] * g + AP0_TO_AP1[2][2] * b;
    baseR[x] = floatToHalf(ap1r); baseG[x] = floatToHalf(ap1g); baseB[x] = floatToHalf(ap1b);
    // Keep the two encodings independent. `exposureNormEv` is the normalized EV
    // channel and is guaranteed to remain in [0, 1]; the RGB exposure output
    // receives the solver's original scene-linear scalar directly. Rebuilding
    // the scalar from a clamped normalized EV loses out-of-range exposure.
    const normalized = exposureNormEv[i];
    exposureNormEvOut[x] = floatToHalf(Number.isNaN(normalized) ? 0 : Math.min(1, Math.max(0, normalized)));
    exposureOut[x] = floatToHalf(exposure[i]);
  }
  return { baseR, baseG, baseB, exposureNormEv: exposureNormEvOut, exposure: exposureOut };
}
