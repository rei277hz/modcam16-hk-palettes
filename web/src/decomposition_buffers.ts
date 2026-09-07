const AP0_TO_AP1 = [
  [1.4514393, -0.23651075, -0.21492857],
  [-0.07655377, 1.1762297, -0.09967593],
  [0.008316148, -0.00603245, 0.9977163],
] as const;

function floatToHalf(value: number): number {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
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
  const nav = globalThis as any;
  const mobile = /iPhone|iPad|iPod|Android/i.test(String(nav.navigator?.userAgent || ""));
  const memory = Number(nav.navigator?.deviceMemory || 0);
  const cap = mobile || (memory > 0 && memory <= 4) ? (gpu ? 8192 : 1024) : (gpu ? 32768 : 4096);
  return Math.max(width, Math.min(cap, Math.floor(probe?.max_batch_pixels || cap)));
}

export function convertExrRow(base: Float32Array, exposure: Float32Array, offset: number, width: number): { baseR: Uint16Array; baseG: Uint16Array; baseB: Uint16Array; exposure: Uint16Array } {
  const baseR = new Uint16Array(width), baseG = new Uint16Array(width), baseB = new Uint16Array(width), exposureOut = new Uint16Array(width);
  for (let x = 0; x < width; x++) {
    const i = offset + x;
    const r = base[i * 3], g = base[i * 3 + 1], b = base[i * 3 + 2];
    const ap1r = AP0_TO_AP1[0][0] * r + AP0_TO_AP1[0][1] * g + AP0_TO_AP1[0][2] * b;
    const ap1g = AP0_TO_AP1[1][0] * r + AP0_TO_AP1[1][1] * g + AP0_TO_AP1[1][2] * b;
    const ap1b = AP0_TO_AP1[2][0] * r + AP0_TO_AP1[2][1] * g + AP0_TO_AP1[2][2] * b;
    baseR[x] = floatToHalf(ap1r); baseG[x] = floatToHalf(ap1g); baseB[x] = floatToHalf(ap1b);
    exposureOut[x] = floatToHalf(Math.pow(2, exposure[i] * 20 - 10));
  }
  return { baseR, baseG, baseB, exposure: exposureOut };
}
