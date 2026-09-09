// Accurate f32 port of the shared ACES 2.0 fixed-function forward transform
// and the original modCAM16-HK exposure solve. The profile constants and
// OCIO-derived lookup tables are serialized by color_core::gpu_parameter_blob.

struct Params {
  profile: u32,
  refl_bits: u32,
  target_bits: u32,
  count: u32,
  mode: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_pixels: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_pixels: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> output_flags: array<u32>;
@group(0) @binding(4) var<storage, read> profile_data: array<f32>;

const DEG: f32 = 57.29577951308232;
const AP0_TO_AP1: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
  vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
  vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014));
const ACESCG_TO_AP0: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
  vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
  vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723));
const XYZ_TO_P3: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(2.493496911941425, -0.829488969561575, 0.035845830243784),
  vec3<f32>(-0.931383617919124, 1.762664060318347, -0.076172389268042),
  vec3<f32>(-0.402710784450717, 0.023624685841944, 0.956884524007687));
const AP0_TO_LMS: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.4451810420, 0.1237341460, 0.0117007261),
  vec3<f32>(0.3496492800, 0.6136437060, 0.0280607939),
  vec3<f32>(-0.0011297321, 0.0563228019, 0.7539390330));
const AAB_FROM_RGB_A: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(20.25881, 15480.0, 1720.0),
  vec3<f32>(10.129405, -16887.2734, 1720.0),
  vec3<f32>(0.506470263, 1407.27271, -3440.0));
const AAB_TO_RGB_A: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.0323680267, 0.0323680267, 0.0323680267),
  vec3<f32>(0.0000207658, -0.0000410250, -0.0000101296),
  vec3<f32>(0.0000132606, -0.0000120174, -0.0002900761));
const RGB_A_TO_LMS: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(2.66705441, -0.535811961, -0.0214489009),
  vec3<f32>(-1.52505875, 1.94158089, -0.0485954471),
  vec3<f32>(0.117925502, -0.145848125, 1.32996535));
const CAT16: mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.401288, -0.250268, -0.002079),
  vec3<f32>(0.650173, 1.204414, 0.048952),
  vec3<f32>(-0.051461, 0.045854, 0.953127));

fn bad(x: f32) -> bool {
  // Ordered comparisons reject both NaN (all comparisons false) and +/-inf
  // without relying on optional floating-point classification builtins.
  return !(x >= -3.402823466e38 && x <= 3.402823466e38);
}
fn bad3(x: vec3<f32>) -> bool { return bad(x.x) || bad(x.y) || bad(x.z); }
fn signed_pow(x: f32, exponent: f32) -> f32 { return sign(x) * pow(abs(x), exponent); }
fn clamp3(x: vec3<f32>, low: f32, high: f32) -> vec3<f32> {
  return clamp(x, vec3<f32>(low), vec3<f32>(high));
}
fn mconst(m: mat3x3<f32>, x: vec3<f32>) -> vec3<f32> { return m * x; }
fn profile_slot(profile: u32) -> u32 {
  if (profile == 0u) { return 0u; }
  if (profile == 1u) { return 1u; }
  if (profile == 2u) { return 2u; }
  return 3u;
}
fn pvalue(base: u32, offset: u32) -> f32 { return profile_data[base + offset]; }
fn profile_base(profile: u32) -> u32 { return profile_slot(profile) * 56u; }
fn profile_matrix(base: u32, offset: u32, x: vec3<f32>) -> vec3<f32> {
  let i = base + offset;
  return vec3<f32>(
    profile_data[i] * x.x + profile_data[i + 1u] * x.y + profile_data[i + 2u] * x.z,
    profile_data[i + 3u] * x.x + profile_data[i + 4u] * x.y + profile_data[i + 5u] * x.z,
    profile_data[i + 6u] * x.x + profile_data[i + 7u] * x.y + profile_data[i + 8u] * x.z);
}
fn table_base(base: u32) -> u32 {
  return 224u + u32(pvalue(base, 55u)) * 1815u;
}
fn reach_sample(hue: f32, base: u32) -> f32 {
  let h = hue - floor(hue / 360.0) * 360.0;
  let index = min(u32(floor(h)) + 1u, 362u);
  let table = table_base(base);
  let lo = profile_data[table + index];
  let hi = profile_data[table + min(index + 1u, 362u)];
  return lo + (hi - lo) * (h - floor(h));
}
fn cusp_sample(hue: f32, base: u32) -> vec3<f32> {
  let h = hue - floor(hue / 360.0) * 360.0;
  let table = table_base(base);
  let hues = table + 1452u;
  var lower = 1u;
  loop {
    if (!(lower + 1u < 363u && h > profile_data[hues + lower + 1u])) { break; }
    lower = lower + 1u;
  }
  let upper = min(lower + 1u, 362u);
  let h0 = profile_data[hues + lower];
  let h1 = profile_data[hues + upper];
  let t = clamp((h - h0) / (h1 - h0), 0.0, 1.0);
  let cusp = table + 363u;
  let lo = cusp + lower * 3u;
  let hi = cusp + upper * 3u;
  return vec3<f32>(
    profile_data[lo] + (profile_data[hi] - profile_data[lo]) * t,
    profile_data[lo + 1u] + (profile_data[hi + 1u] - profile_data[lo + 1u]) * t,
    profile_data[lo + 2u] + (profile_data[hi + 2u] - profile_data[lo + 2u]) * t);
}

fn rgb_to_jmh_ap0(rgb: vec3<f32>) -> vec3<f32> {
  let lms = mconst(AP0_TO_LMS, rgb);
  let rgb_a = vec3<f32>(
    signed_pow(lms.x, 0.42) / (27.1299992 + pow(abs(lms.x), 0.42)),
    signed_pow(lms.y, 0.42) / (27.1299992 + pow(abs(lms.y), 0.42)),
    signed_pow(lms.z, 0.42) / (27.1299992 + pow(abs(lms.z), 0.42)));
  let aab = mconst(AAB_FROM_RGB_A, rgb_a);
  if (aab.x <= 0.0) { return vec3<f32>(0.0); }
  let j = 100.0 * pow(aab.x, 1.13705599);
  let m = length(aab.yz);
  var h = atan2(aab.z, aab.y) * DEG;
  if (h < 0.0) { h = h + 360.0; }
  return vec3<f32>(j, m, h);
}
fn solve_j_intersect(j: f32, m: f32, focus_j: f32, slope_gain: f32, j_max: f32) -> f32 {
  let m_scaled = m / slope_gain;
  let a = m_scaled / focus_j;
  if (j < focus_j) {
    let b = 1.0 - m_scaled;
    let c = -j;
    let root = sqrt(b * b - 4.0 * a * c);
    return -2.0 * c / (b + root);
  }
  let b = -(1.0 + m_scaled + j_max * a);
  let c = j_max * m_scaled + j;
  let root = sqrt(b * b - 4.0 * a * c);
  return -2.0 * c / (b - root);
}
fn gamut_boundary_intersection(cusp: vec3<f32>, gamma_top_inv: f32, gamma_bottom_inv: f32,
    j_source: f32, j_cusp: f32, slope: f32, j_max: f32) -> f32 {
  let lower = j_cusp * pow(j_source / j_cusp, gamma_bottom_inv) /
    (cusp.x / cusp.y - slope);
  let upper = cusp.y * (j_max - j_cusp) *
    pow((j_max - j_source) / (j_max - j_cusp), gamma_top_inv) /
    (slope * cusp.y + j_max - cusp.x);
  let s = 0.12 * cusp.y;
  let h = max(s - abs(lower - upper), 0.0) / s;
  return min(lower, upper) - h * h * h * s / 6.0;
}
fn get_focus_gain(j: f32, cusp_j: f32, j_max: f32) -> f32 {
  let threshold = cusp_j * 0.7 + j_max * 0.3;
  if (j > threshold) {
    let gain = (j_max - threshold) / max(0.0001, j_max - j);
    let lg = log(gain) / log(10.0);
    return lg * lg + 1.0;
  }
  return 1.0;
}
fn remap_m_forward(m: f32, gamut_boundary: f32, reach_boundary: f32) -> f32 {
  let boundary_ratio = gamut_boundary / reach_boundary;
  let proportion = max(boundary_ratio, 0.75);
  let threshold = proportion * gamut_boundary;
  if (proportion >= 1.0 || m <= threshold) { return m; }
  let gamut_offset = gamut_boundary - threshold;
  let reach_offset = reach_boundary - threshold;
  let scale = reach_offset / (reach_offset / gamut_offset - 1.0);
  let nd = (m - threshold) / scale;
  return threshold + scale * nd / (1.0 + nd);
}
fn gamut_compress_forward(jmh: vec3<f32>, jx: f32, reach_boundary: f32, base: u32) -> vec3<f32> {
  let j = jmh.x;
  let m = jmh.y;
  let h = jmh.z;
  let j_max = pvalue(base, 36u);
  if (m <= 0.0 || j > j_max) { return vec3<f32>(j, 0.0, h); }
  let cusp = cusp_sample(h, base);
  let focus_weight = min(1.0, 1.3 - cusp.x / j_max);
  let focus = cusp.x * (1.0 - focus_weight) + pvalue(base, 39u) * focus_weight;
  let slope_gain = pvalue(base, 40u) * get_focus_gain(jx, cusp.x, j_max);
  let j_source = solve_j_intersect(j, m, focus, slope_gain, j_max);
  let slope_base = select(j_max - j_source, j_source, j_source < focus);
  let gamut_slope = slope_base * (j_source - focus) / (focus * slope_gain);
  let j_cusp = solve_j_intersect(cusp.x, cusp.y, focus, slope_gain, j_max);
  let gamut_boundary = gamut_boundary_intersection(cusp, cusp.z, pvalue(base, 41u),
    j_source, j_cusp, gamut_slope, j_max);
  if (gamut_boundary <= 0.0) { return vec3<f32>(j, 0.0, h); }
  let reach = j_max * pow(j_source / j_max, 0.879464149) /
    (j_max / reach_boundary - gamut_slope);
  let remapped = remap_m_forward(m, gamut_boundary, reach);
  return vec3<f32>(j_source + remapped * gamut_slope, remapped, h);
}
fn tonescale_forward(j: f32, base: u32) -> f32 {
  let a = 0.0323680267 * pow(abs(j) * 0.00999999978, 0.879464149);
  let y = pow(27.1299992 * a / (1.0 - a), 2.38095238095);
  let f = pvalue(base, 44u) * pow(y / (y + pvalue(base, 43u)), 1.14999998);
  let y_ts = max(f * f / (f + 0.0399999991), 0.0);
  let f_l_y = pow(0.7937005721 * y_ts, 0.42);
  return sign(j) * 100.0 * pow(f_l_y / (27.1299992 + f_l_y) * 30.8946857, 1.13705599);
}
fn toe_forward(x: f32, limit: f32, k1_in: f32, k2_in: f32) -> f32 {
  let k2 = max(k2_in, 0.001);
  let k1 = sqrt(k1_in * k1_in + k2 * k2);
  let k3 = (limit + k1) / (limit + k2);
  if (x > limit) { return x; }
  let value = k3 * x - k1;
  return 0.5 * (value + sqrt(value * value + 4.0 * k2 * k3 * x));
}
fn chroma_forward(jmh: vec3<f32>, base: u32) -> vec3<f32> {
  let j = jmh.x;
  let m = jmh.y;
  let h = jmh.z;
  let j_ts = tonescale_forward(j, base);
  if (m == 0.0 || j == 0.0) { return vec3<f32>(j_ts, 0.0, h); }
  let radians = h / DEG;
  let cos_h = cos(radians);
  let sin_h = sin(radians);
  let cos_h2 = 2.0 * cos_h * cos_h - 1.0;
  let sin_h2 = 2.0 * cos_h * sin_h;
  let cos_h3 = 4.0 * cos_h * cos_h * cos_h - 3.0 * cos_h;
  let sin_h3 = 3.0 * sin_h - 4.0 * sin_h * sin_h * sin_h;
  let mnorm = cos_h * pvalue(base, 45u) + cos_h2 * pvalue(base, 46u) +
    cos_h3 * pvalue(base, 47u) + sin_h * pvalue(base, 48u) +
    sin_h2 * pvalue(base, 49u) + sin_h3 * pvalue(base, 50u) + pvalue(base, 51u);
  let nj = j_ts / pvalue(base, 36u);
  let snj = max(1.0 - nj, 0.0);
  let limit = pow(nj, 0.879464149) * reach_sample(h, base) / mnorm;
  var m_cp = m * pow(j_ts / j, 0.879464149) / mnorm;
  m_cp = limit - toe_forward(limit - m_cp, limit - 0.001,
    snj * pvalue(base, 53u), sqrt(nj * nj + pvalue(base, 54u)));
  m_cp = toe_forward(m_cp, limit, nj * pvalue(base, 52u), snj);
  return vec3<f32>(j_ts, m_cp * mnorm, h);
}
fn jmh_to_target_rgb(jmh: vec3<f32>, base: u32) -> vec3<f32> {
  let radians = jmh.z / DEG;
  let aab = vec3<f32>(pow(jmh.x * 0.00999999978, 0.879464149),
    jmh.y * cos(radians), jmh.y * sin(radians));
  let rgb_a = mconst(AAB_TO_RGB_A, aab);
  let rx = min(abs(rgb_a.x), 0.99000001);
  let ry = min(abs(rgb_a.y), 0.99000001);
  let rz = min(abs(rgb_a.z), 0.99000001);
  let lms = vec3<f32>(
    sign(rgb_a.x) * pow(27.1299992 * rx / (1.0 - rx), 2.38095236),
    sign(rgb_a.y) * pow(27.1299992 * ry / (1.0 - ry), 2.38095236),
    sign(rgb_a.z) * pow(27.1299992 * rz / (1.0 - rz), 2.38095236));
  return profile_matrix(base, 27u, lms);
}
fn aces_forward(profile: u32, acescg: vec3<f32>) -> vec3<f32> {
  let base = profile_base(profile);
  let ap0 = clamp3(mconst(ACESCG_TO_AP0, acescg), 0.0, pvalue(base, 38u));
  let jmh = rgb_to_jmh_ap0(ap0);
  let chroma = chroma_forward(jmh, base);
  let compressed = gamut_compress_forward(chroma, chroma.x, reach_sample(jmh.z, base), base);
  let target_rgb = clamp3(jmh_to_target_rgb(compressed, base), 0.0, pvalue(base, 37u));
  return profile_matrix(base, 18u, target_rgb);
}

fn response_hk(value: f32) -> f32 {
  let f_l = 0.4641590666;
  let lower = 0.26;
  let upper = 150.0;
  let power_lower = pow(f_l * lower / 100.0, 0.42);
  let power_upper = pow(f_l * upper / 100.0, 0.42);
  let at_lower = 400.0 * power_lower / (27.13 + power_lower);
  let at_upper = 400.0 * power_upper / (27.13 + power_upper);
  let slope = 1.68 * 27.13 * f_l * pow(f_l * upper / 100.0, -0.58) /
    pow(27.13 + power_upper, 2.0);
  if (value < lower) { return at_lower * value / lower + 0.1; }
  if (value > upper) { return at_upper + slope * (value - upper) + 0.1; }
  let power = pow(f_l * value / 100.0, 0.42);
  return 400.0 * power / (27.13 + power) + 0.1;
}
fn eccentricity(hue: f32) -> f32 {
  let h = hue / DEG;
  return -0.0582 * cos(h) - 0.0258 * cos(2.0 * h) - 0.1347 * cos(3.0 * h) +
    0.0289 * cos(4.0 * h) - 0.1475 * sin(h) - 0.0308 * sin(2.0 * h) +
    0.0385 * sin(3.0 * h) + 0.0096 * sin(4.0 * h) + 1.0;
}
fn jhk_from_xyz(xyz: vec3<f32>) -> f32 {
  let sharpened = mconst(CAT16, xyz * 100.0);
  let adapted = sharpened * vec3<f32>(1.0250779612, 0.9837843319, 0.9216705823);
  let compressed = vec3<f32>(response_hk(adapted.x), response_hk(adapted.y), response_hk(adapted.z));
  let opponent_a = compressed.x - 12.0 * compressed.y / 11.0 + compressed.z / 11.0;
  let opponent_b = (compressed.x + compressed.y - 2.0 * compressed.z) / 9.0;
  var hue = atan2(opponent_b, opponent_a) * DEG;
  if (hue < 0.0) { hue = hue + 360.0; }
  let achromatic = 2.0 * compressed.x + compressed.y + 0.05 * compressed.z - 0.305;
  let j = 100.0 * signed_pow(achromatic / 31.7296683127, 0.525 * 1.7962277660);
  let colorfulness = 43.0 * 0.8 * eccentricity(hue) * length(vec2<f32>(opponent_a, opponent_b));
  let chroma = 35.0 * colorfulness / 31.7296683127;
  return sqrt(max(j * j + 66.0 * chroma, 0.0));
}
fn jhk_for_ap0(ap0: vec3<f32>, profile: u32) -> f32 {
  return jhk_from_xyz(aces_forward(profile, mconst(AP0_TO_AP1, ap0)));
}

fn srgb_encode(value: f32) -> f32 {
  let v = clamp(value, 0.0, 1.0);
  if (v <= 0.0031308) { return 12.92 * v; }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

// The preview transform is fixed to ACES 2.0 SDR 100-nit P3-D65 (profile 4).
// aces_forward is the same OCIO-derived fixed function used by the solve path;
// only the final XYZ-to-P3 matrix and sRGB encoding are added here.
fn preview_pixel(ap0: vec3<f32>) -> vec3<f32> {
  let acescg = mconst(AP0_TO_AP1, ap0);
  let xyz = aces_forward(4u, acescg);
  let p3 = mconst(XYZ_TO_P3, xyz);
  return vec3<f32>(srgb_encode(p3.x), srgb_encode(p3.y), srgb_encode(p3.z));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  if (index >= params.count) { return; }
  let q0 = input_pixels[index].xyz;
  if (bad3(q0)) {
    output_pixels[index] = vec4<f32>(0.0);
    output_flags[index] = 4u;
    return;
  }
  let q = max(q0, vec3<f32>(0.0));
  var flags = 0u;
  if (q0.x < 0.0 || q0.y < 0.0 || q0.z < 0.0) { flags = flags | 1u; }
  let target_j = bitcast<f32>(params.target_bits);
  let refl = bitcast<f32>(params.refl_bits);
  if (q.x == 0.0 && q.y == 0.0 && q.z == 0.0) {
    output_pixels[index] = vec4<f32>(refl, refl, refl, 0.0);
    output_flags[index] = flags;
    return;
  }
  var low = -20.0;
  var high = 20.0;
  var low_j = jhk_for_ap0(q * pow(2.0, -low), params.profile);
  var high_j = jhk_for_ap0(q * pow(2.0, -high), params.profile);
  // Find the complete root before applying the serializable +/-10-stop norm
  // EV range. The fourth output component is the direct scalar s; JavaScript
  // derives the clamped norm EV channel from its log2 value.
  for (var expansion = 0u; expansion < 8u; expansion = expansion + 1u) {
    if (low_j < target_j) {
      low = low - 10.0;
      low_j = jhk_for_ap0(q * pow(2.0, -low), params.profile);
    }
    if (high_j > target_j) {
      high = high + 10.0;
      high_j = jhk_for_ap0(q * pow(2.0, -high), params.profile);
    }
    if (low_j >= target_j && high_j <= target_j) { break; }
  }
  if (low_j >= target_j && high_j <= target_j) {
    for (var iteration = 0u; iteration < 32u; iteration = iteration + 1u) {
      let middle = 0.5 * (low + high);
      let scale = pow(2.0, -middle);
      let j = jhk_for_ap0(q * scale, params.profile);
      if (j > target_j) { low = middle; } else { high = middle; }
    }
  } else {
    flags = flags | 2u;
    low = select(100.0, -100.0, low_j < target_j);
  }
  if (low < -10.0 || low > 10.0) { flags = flags | 2u; }
  let scalar = pow(2.0, low);
  let base = q * pow(2.0, -low);
  let normalized = clamp(low / 20.0 + 0.5, 0.0, 1.0);
  if (bad3(base) || bad(scalar) || bad(normalized)) {
    output_pixels[index] = vec4<f32>(0.0);
    output_flags[index] = flags | 4u;
    return;
  }
  output_pixels[index] = vec4<f32>(base, scalar);
  output_flags[index] = flags;
}

@compute @workgroup_size(64)
fn preview_main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  if (index >= params.count) { return; }
  let input = input_pixels[index];
  let refl = bitcast<f32>(params.refl_bits);
  var ap0 = input.xyz;
  if (params.mode == 2u) {
    ap0 = vec3<f32>(refl * input.w);
  }
  if (bad3(ap0)) {
    output_pixels[index] = vec4<f32>(0.0);
    output_flags[index] = 4u;
    return;
  }
  let rgb = preview_pixel(ap0);
  output_pixels[index] = vec4<f32>(rgb, 1.0);
  output_flags[index] = 0u;
}
