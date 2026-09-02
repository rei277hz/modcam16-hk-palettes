//! Self-contained ACES 2.0 output-transform fixed functions.
//!
//! The equations and table payloads in this module are exported by the
//! bundled OpenColorIO 2.5 processors as GPU shader code.  Keeping the
//! fixed-function implementation here avoids approximating the inverse view
//! with a small one-dimensional curve.

mod tables {
    include!("aces_output_tables.rs");
    include!("aces_output_p3_tables.rs");
}

use super::{P3_TO_XYZ, XYZ_TO_P3};

#[derive(Clone, Copy)]
struct Parameters {
    xyz_to_rgb: [[f64; 3]; 3],
    rgb_to_lms: [[f64; 3]; 3],
    target_to_xyz: [[f64; 3]; 3],
    jmh_to_target_rgb: [[f64; 3]; 3],
    j_max: f64,
    input_max: f64,
    output_max: f64,
    focus_j: f64,
    slope_gain: f64,
    gamma_bottom_inv: f64,
    tonescale_y_max: f64,
    tonescale_y_scale: f64,
    tonescale_y_ref: f64,
    mnorm_cosine: [f64; 3],
    mnorm_sine: [f64; 3],
    mnorm_offset: f64,
    toe_first_gain: f64,
    toe_second_gain: f64,
    toe_second_k2: f64,
    reach_m: &'static [f64],
    gamut_cusp: &'static [f64],
    gamut_hues: &'static [f64],
}

const AP0_TO_ACESCG: [[f64; 3]; 3] = [
    [
        1.4514393161456653,
        -0.23651074689374019,
        -0.21492856925192524,
    ],
    [
        -0.07655377339602043,
        1.1762296998335731,
        -0.0996759264375522,
    ],
    [
        0.008316148425697719,
        -0.006032449791021028,
        0.9977163013653233,
    ],
];

const ACESCG_TO_AP0: [[f64; 3]; 3] = [
    [0.6954522413574518, 0.14067869647029416, 0.16386906217225403],
    [0.04479456337203763, 0.8596711184564216, 0.09553431817154036],
    [
        -0.005525882558113544,
        0.004025210305978659,
        1.001500672252135,
    ],
];

const RGB_TO_LMS_SDR: [[f64; 3]; 3] = [
    [0.223405808, 0.451332718, 0.118962049],
    [0.108193472, 0.547473967, 0.138033181],
    [0.020469198, 0.108180940, 0.665050387],
];

const RGB_TO_LMS_HDR: [[f64; 3]; 3] = [
    [0.312590361, 0.368067265, 0.113042921],
    [0.108960696, 0.542771041, 0.141968831],
    [0.0084437551, 0.0436396375, 0.741617143],
];

const RGB_TO_LMS_HDR_P3: [[f64; 3]; 3] = [
    [0.252340943, 0.410706788, 0.13065286],
    [0.106794775, 0.535307527, 0.15159817],
    [0.00746381795, 0.0558294654, 0.730407238],
];

// ACES 2.0's JMh fixed function operates in AP0 for every output profile.
const AP0_TO_LMS: [[f64; 3]; 3] = [
    [0.445181042, 0.34964928, -0.00112973212],
    [0.123734146, 0.613643706, 0.0563228019],
    [0.0117007261, 0.0280607939, 0.753939033],
];

const JMH_TO_RGB_SDR: [[f64; 3]; 3] = [
    [7.45048571, -6.1301837, -0.0603808537],
    [-1.4750675, 3.11835742, -0.383369029],
    [0.0106288502, -0.31857267, 1.56786489],
];

const JMH_TO_RGB_HDR: [[f64; 3]; 3] = [
    [4.18920946, -2.83307695, -0.0962111205],
    [-0.841454685, 2.4402566, -0.338880867],
    [0.00181781093, -0.111337908, 1.36944115],
];

const JMH_TO_RGB_HDR_P3: [[f64; 3]; 3] = [
    [5.86586046, -4.48821688, -0.117723338],
    [-1.17879069, 2.81135988, -0.372647762],
    [0.0301606283, -0.16902554, 1.39878595],
];

const REC709_TO_XYZ: [[f64; 3]; 3] = [
    [
        0.41239079926595951,
        0.35758433938387801,
        0.18048078840183432,
    ],
    [
        0.21263900587151038,
        0.71516867876775603,
        0.07219231536073373,
    ],
    [
        0.019330818715591825,
        0.11919477979462592,
        0.95053215224966037,
    ],
];

const REC2020_TO_XYZ: [[f64; 3]; 3] = [
    [
        0.63695804830129099,
        0.14461690358620841,
        0.16888097516417205,
    ],
    [
        0.26270021201126692,
        0.67799807151887115,
        0.059301716469861938,
    ],
    [
        4.9941065744660705e-17,
        0.028072693049087431,
        1.0609850577107902,
    ],
];

const XYZ_TO_REC709: [[f64; 3]; 3] = [
    [3.2409699419045226, -1.5373831775700935, -0.4986107602930034],
    [-0.9692436362808798, 1.8759675015077202, 0.0415550574071756],
    [0.0556300796969937, -0.2039769588889765, 1.0569715142428786],
];

const XYZ_TO_REC2020: [[f64; 3]; 3] = [
    [1.7166511879712680, -0.3556707837763925, -0.2533662813736599],
    [-0.6666843518324890, 1.6164812366349388, 0.0157685458139111],
    [0.0176398574453108, -0.0427706132578085, 0.9421031212354739],
];

const AAB_FROM_RGB_A: [[f64; 3]; 3] = [
    [20.25881, 10.129405, 0.506470263],
    [15480.0, -16887.2734, 1407.27271],
    [1720.0, 1720.0, -3440.0],
];

const AAB_TO_RGB_A: [[f64; 3]; 3] = [
    [0.0323680267, 2.07657631e-5, 1.32606210e-5],
    [0.0323680267, -4.10250432e-5, -1.20174373e-5],
    [0.0323680267, -1.01296409e-5, -2.90076074e-4],
];

const RGB_A_TO_LMS: [[f64; 3]; 3] = [
    [2.66705441, -1.52505875, 0.117925502],
    [-0.535811961, 1.94158089, -0.145848125],
    [-0.0214489009, -0.0485954471, 1.32996535],
];

fn parameters(profile: u32) -> Parameters {
    if profile == 1 {
        Parameters {
            xyz_to_rgb: XYZ_TO_REC709,
            rgb_to_lms: RGB_TO_LMS_SDR,
            target_to_xyz: REC709_TO_XYZ,
            jmh_to_target_rgb: JMH_TO_RGB_SDR,
            j_max: 100.0,
            input_max: 1.0,
            output_max: 1024.0,
            focus_j: 34.096539,
            slope_gain: 135.0,
            gamma_bottom_inv: 0.877192974,
            tonescale_y_max: 1.00826871,
            tonescale_y_scale: 0.73009213709383403,
            tonescale_y_ref: 1.04710376,
            mnorm_cosine: [11.341321604032515, 16.469863649185896, 7.8842182208776475],
            mnorm_sine: [14.665187919584513, -6.3725780354404442, 9.1941277054452897],
            mnorm_offset: 77.133051547393805,
            toe_first_gain: 2.4000001,
            toe_second_gain: 1.29999995,
            toe_second_k2: 0.00499999989,
            reach_m: tables::SDR_REACH_M,
            gamut_cusp: tables::SDR_GAMUT_CUSP,
            gamut_hues: tables::SDR_GAMUT_HUES,
        }
    } else if profile == 2 {
        Parameters {
            xyz_to_rgb: XYZ_TO_P3,
            rgb_to_lms: RGB_TO_LMS_HDR_P3,
            target_to_xyz: P3_TO_XYZ,
            jmh_to_target_rgb: JMH_TO_RGB_HDR_P3,
            j_max: 283.249878,
            input_max: 10.0,
            output_max: 4096.0,
            focus_j: 40.816883,
            slope_gain: 1051.56519,
            gamma_bottom_inv: 0.826446235,
            tonescale_y_max: 10.1325417,
            tonescale_y_scale: 4.6796021847256952,
            tonescale_y_ref: 10.1729107,
            mnorm_cosine: [28.177105004310604, 40.918782982468606, 19.588056175708772],
            mnorm_sine: [36.435131137728689, -15.832440585136412, 22.842479106426239],
            mnorm_offset: 191.63428819274904,
            toe_first_gain: 10.3199997,
            toe_second_gain: 0.402999997,
            toe_second_k2: 0.000500000024,
            reach_m: tables::HDR_REACH_M,
            gamut_cusp: tables::HDR_P3_GAMUT_CUSP,
            gamut_hues: tables::HDR_GAMUT_HUES,
        }
    } else {
        Parameters {
            xyz_to_rgb: XYZ_TO_REC2020,
            rgb_to_lms: RGB_TO_LMS_HDR,
            target_to_xyz: REC2020_TO_XYZ,
            jmh_to_target_rgb: JMH_TO_RGB_HDR,
            j_max: 283.249878,
            input_max: 10.0,
            output_max: 4096.0,
            focus_j: 40.816883,
            slope_gain: 1051.56519,
            gamma_bottom_inv: 0.826446235,
            tonescale_y_max: 10.1325417,
            tonescale_y_scale: 4.6796021847256952,
            tonescale_y_ref: 10.1729107,
            mnorm_cosine: [28.177105004310604, 40.918782982468606, 19.588056175708772],
            mnorm_sine: [36.435131137728689, -15.832440585136412, 22.842479106426239],
            mnorm_offset: 191.63428819274904,
            toe_first_gain: 10.3199997,
            toe_second_gain: 0.402999997,
            toe_second_k2: 0.000500000024,
            reach_m: tables::HDR_REACH_M,
            gamut_cusp: tables::HDR_GAMUT_CUSP,
            gamut_hues: tables::HDR_GAMUT_HUES,
        }
    }
}

fn mat(matrix: &[[f64; 3]; 3], value: [f64; 3]) -> [f64; 3] {
    [
        matrix[0][0] * value[0] + matrix[0][1] * value[1] + matrix[0][2] * value[2],
        matrix[1][0] * value[0] + matrix[1][1] * value[1] + matrix[1][2] * value[2],
        matrix[2][0] * value[0] + matrix[2][1] * value[1] + matrix[2][2] * value[2],
    ]
}

fn clamp3(value: [f64; 3], low: f64, high: f64) -> [f64; 3] {
    [
        value[0].clamp(low, high),
        value[1].clamp(low, high),
        value[2].clamp(low, high),
    ]
}

fn sign_power(value: f64, exponent: f64) -> f64 {
    value.signum() * value.abs().powf(exponent)
}

fn rgb_to_jmh_with_matrix(rgb: [f64; 3], matrix: &[[f64; 3]; 3]) -> [f64; 3] {
    let lms = mat(matrix, rgb);
    let rgb_a = [
        sign_power(lms[0], 0.42) / (27.1299992 + lms[0].abs().powf(0.42)),
        sign_power(lms[1], 0.42) / (27.1299992 + lms[1].abs().powf(0.42)),
        sign_power(lms[2], 0.42) / (27.1299992 + lms[2].abs().powf(0.42)),
    ];
    let aab = mat(&AAB_FROM_RGB_A, rgb_a);
    if aab[0] <= 0.0 {
        return [0.0, 0.0, 0.0];
    }
    let j = 100.0 * aab[0].powf(1.13705599);
    let m = aab[1].hypot(aab[2]);
    let h = aab[2].atan2(aab[1]).to_degrees().rem_euclid(360.0);
    [j, m, h]
}

fn rgb_to_jmh(rgb: [f64; 3], p: Parameters) -> [f64; 3] {
    rgb_to_jmh_with_matrix(rgb, &p.rgb_to_lms)
}

fn reach_sample(hue: f64, p: Parameters) -> f64 {
    let h = hue.rem_euclid(360.0);
    let base = h.floor() as usize + 1;
    let lo = p.reach_m[base.min(p.reach_m.len() - 1)];
    let hi = p.reach_m[(base + 1).min(p.reach_m.len() - 1)];
    lo + (hi - lo) * (h - h.floor())
}

fn cusp_sample(hue: f64, p: Parameters) -> [f64; 3] {
    let h = hue.rem_euclid(360.0);
    let mut lower = 1_usize;
    while lower + 1 < p.gamut_hues.len() && h > p.gamut_hues[lower + 1] {
        lower += 1;
    }
    let upper = (lower + 1).min(p.gamut_hues.len() - 1);
    let t =
        ((h - p.gamut_hues[lower]) / (p.gamut_hues[upper] - p.gamut_hues[lower])).clamp(0.0, 1.0);
    [
        p.gamut_cusp[lower * 3] + (p.gamut_cusp[upper * 3] - p.gamut_cusp[lower * 3]) * t,
        p.gamut_cusp[lower * 3 + 1]
            + (p.gamut_cusp[upper * 3 + 1] - p.gamut_cusp[lower * 3 + 1]) * t,
        p.gamut_cusp[lower * 3 + 2]
            + (p.gamut_cusp[upper * 3 + 2] - p.gamut_cusp[lower * 3 + 2]) * t,
    ]
}

fn solve_j_intersect(j: f64, m: f64, focus_j: f64, slope_gain: f64, j_max: f64) -> f64 {
    let m_scaled = m / slope_gain;
    let a = m_scaled / focus_j;
    if j < focus_j {
        let b = 1.0 - m_scaled;
        let c = -j;
        let root = (b * b - 4.0 * a * c).sqrt();
        -2.0 * c / (b + root)
    } else {
        let b = -(1.0 + m_scaled + j_max * a);
        let c = j_max * m_scaled + j;
        let root = (b * b - 4.0 * a * c).sqrt();
        -2.0 * c / (b - root)
    }
}

fn gamut_boundary_intersection(
    cusp: [f64; 3],
    gamma_top_inv: f64,
    gamma_bottom_inv: f64,
    j_source: f64,
    j_cusp: f64,
    slope: f64,
    j_max: f64,
) -> f64 {
    let lower = j_cusp * (j_source / j_cusp).powf(gamma_bottom_inv) / (cusp[0] / cusp[1] - slope);
    let upper =
        cusp[1] * (j_max - j_cusp) * ((j_max - j_source) / (j_max - j_cusp)).powf(gamma_top_inv)
            / (slope * cusp[1] + j_max - cusp[0]);
    let s = 0.12 * cusp[1];
    let h = (s - (lower - upper).abs()).max(0.0) / s;
    lower.min(upper) - h * h * h * s / 6.0
}

fn remap_m_inverse(m: f64, gamut_boundary: f64, reach_boundary: f64) -> f64 {
    let boundary_ratio = gamut_boundary / reach_boundary;
    let proportion = boundary_ratio.max(0.75);
    let threshold = proportion * gamut_boundary;
    if proportion >= 1.0 || m <= threshold {
        return m;
    }
    let m_offset = m - threshold;
    let gamut_offset = gamut_boundary - threshold;
    let reach_offset = reach_boundary - threshold;
    let scale = reach_offset / (reach_offset / gamut_offset - 1.0);
    let nd = m_offset / scale;
    if nd >= 1.0 {
        threshold + scale
    } else {
        threshold + scale * -(nd / (nd - 1.0))
    }
}

fn gamut_compress_inverse(jmh: [f64; 3], jx: f64, p: Parameters) -> [f64; 3] {
    let j = jmh[0];
    let m = jmh[1];
    let h = jmh[2];
    if m <= 0.0 || j > p.j_max {
        return [j, 0.0, h];
    }
    let cusp = cusp_sample(h, p);
    // Equivalent to mix(cuspJ, focusJ, min(1, 1.3-cuspJ/jmax)).
    let focus_weight = (1.3 - cusp[0] / p.j_max).min(1.0);
    let focus = cusp[0] * (1.0 - focus_weight) + p.focus_j * focus_weight;
    let slope_gain = p.slope_gain * get_focus_gain(jx, cusp[0], p.j_max);
    let j_source = solve_j_intersect(j, m, focus, slope_gain, p.j_max);
    let slope_base = if j_source < focus {
        j_source
    } else {
        p.j_max - j_source
    };
    let gamut_slope = slope_base * (j_source - focus) / (focus * slope_gain);
    let j_cusp = solve_j_intersect(cusp[0], cusp[1], focus, slope_gain, p.j_max);
    let gamut_boundary = gamut_boundary_intersection(
        cusp,
        cusp[2],
        p.gamma_bottom_inv,
        j_source,
        j_cusp,
        gamut_slope,
        p.j_max,
    );
    if gamut_boundary <= 0.0 {
        return [j, 0.0, h];
    }
    let reach = p.j_max * (j_source / p.j_max).powf(0.879464149)
        / (p.j_max / reach_sample(h, p) - gamut_slope);
    let remapped_m = remap_m_inverse(m, gamut_boundary, reach);
    [j_source + remapped_m * gamut_slope, remapped_m, h]
}

// OCIO evaluates inverse gamut compression twice for source J values above
// the cusp-to-white transition.  The second pass uses the J returned by the
// first pass as its focus-gain coordinate.
fn gamut_compress_inverse_ocio(jmh: [f64; 3], p: Parameters) -> [f64; 3] {
    let cusp = cusp_sample(jmh[2], p);
    let threshold = cusp[0] * 0.7 + p.j_max * 0.3;
    if jmh[0] <= threshold {
        gamut_compress_inverse(jmh, jmh[0], p)
    } else {
        let first = gamut_compress_inverse(jmh, jmh[0], p);
        gamut_compress_inverse(jmh, first[0], p)
    }
}

fn remap_m_forward(m: f64, gamut_boundary: f64, reach_boundary: f64) -> f64 {
    let boundary_ratio = gamut_boundary / reach_boundary;
    let proportion = boundary_ratio.max(0.75);
    let threshold = proportion * gamut_boundary;
    if proportion >= 1.0 || m <= threshold {
        return m;
    }
    let gamut_offset = gamut_boundary - threshold;
    let reach_offset = reach_boundary - threshold;
    let scale = reach_offset / ((reach_offset / gamut_offset) - 1.0);
    let nd = (m - threshold) / scale;
    threshold + scale * nd / (1.0 + nd)
}

fn gamut_compress_forward(jmh: [f64; 3], jx: f64, reach_boundary: f64, p: Parameters) -> [f64; 3] {
    let j = jmh[0];
    let m = jmh[1];
    let h = jmh[2];
    if m <= 0.0 || j > p.j_max {
        return [j, 0.0, h];
    }
    let cusp = cusp_sample(h, p);
    let focus_weight = (1.3 - cusp[0] / p.j_max).min(1.0);
    let focus = cusp[0] * (1.0 - focus_weight) + p.focus_j * focus_weight;
    let slope_gain = p.slope_gain * get_focus_gain(jx, cusp[0], p.j_max);
    let j_source = solve_j_intersect(j, m, focus, slope_gain, p.j_max);
    let slope_base = if j_source < focus {
        j_source
    } else {
        p.j_max - j_source
    };
    let gamut_slope = slope_base * (j_source - focus) / (focus * slope_gain);
    let j_cusp = solve_j_intersect(cusp[0], cusp[1], focus, slope_gain, p.j_max);
    let gamut_boundary = gamut_boundary_intersection(
        cusp,
        cusp[2],
        p.gamma_bottom_inv,
        j_source,
        j_cusp,
        gamut_slope,
        p.j_max,
    );
    if gamut_boundary <= 0.0 {
        return [j, 0.0, h];
    }
    let reach =
        p.j_max * (j_source / p.j_max).powf(0.879464149) / (p.j_max / reach_boundary - gamut_slope);
    let remapped_m = remap_m_forward(m, gamut_boundary, reach);
    [j_source + remapped_m * gamut_slope, remapped_m, h]
}

fn get_focus_gain(j: f64, cusp_j: f64, j_max: f64) -> f64 {
    let threshold = cusp_j * 0.7 + j_max * 0.3;
    if j > threshold {
        let gain = (j_max - threshold) / (0.0001_f64).max(j_max - j);
        let gain = gain.ln() / 10.0_f64.ln();
        gain * gain + 1.0
    } else {
        1.0
    }
}

fn tonescale_inverse(j: f64, p: Parameters) -> f64 {
    let a = 0.0323680267 * (j.abs() * 0.00999999978).powf(0.879464149);
    let y = (27.1299992 * a / (1.0 - a)).powf(2.3809523809523809);
    let yi = y / 0.79370057210326195;
    let z = yi.clamp(0.0, p.tonescale_y_max);
    let ht = 0.5 * (z + (z * (0.15999999642372131 + z)).sqrt());
    let yo = p.tonescale_y_scale / ((p.tonescale_y_ref / ht).powf(0.86956523541917463) - 1.0);
    let f_l_y = yo.abs().powf(0.42);
    let j_ts = 100.0 * (f_l_y / (27.1299992 + f_l_y) * 30.8946857).powf(1.13705599);
    j.signum() * j_ts
}

fn toe_inverse(x: f64, limit: f64, k1_in: f64, k2_in: f64) -> f64 {
    let k2 = k2_in.max(0.001);
    let k1 = (k1_in * k1_in + k2 * k2).sqrt();
    let k3 = (limit + k1) / (limit + k2);
    if x > limit {
        x
    } else {
        (x * x + k1 * x) / (k3 * (x + k2))
    }
}

fn chroma_inverse(jmh: [f64; 3], p: Parameters) -> [f64; 3] {
    let j_ts = jmh[0];
    let m_cp = jmh[1];
    let h = jmh[2];
    let j = tonescale_inverse(j_ts, p);
    if m_cp == 0.0 {
        return [j, 0.0, h];
    }
    let radians = h.to_radians();
    let cos_h = radians.cos();
    let sin_h = radians.sin();
    let cos_h2 = 2.0 * cos_h * cos_h - 1.0;
    let sin_h2 = 2.0 * cos_h * sin_h;
    let cos_h3 = 4.0 * cos_h * cos_h * cos_h - 3.0 * cos_h;
    let sin_h3 = 3.0 * sin_h - 4.0 * sin_h * sin_h * sin_h;
    let mnorm = cos_h * p.mnorm_cosine[0]
        + cos_h2 * p.mnorm_cosine[1]
        + cos_h3 * p.mnorm_cosine[2]
        + sin_h * p.mnorm_sine[0]
        + sin_h2 * p.mnorm_sine[1]
        + sin_h3 * p.mnorm_sine[2]
        + p.mnorm_offset;
    let nj = j_ts / p.j_max;
    let snj = (1.0 - nj).max(0.0);
    let limit = nj.powf(0.879464149) * reach_sample(h, p) / mnorm;
    let mut m = m_cp / mnorm;
    m = toe_inverse(m, limit, nj * p.toe_first_gain, snj);
    m = limit
        - toe_inverse(
            limit - m,
            limit - 0.001,
            snj * p.toe_second_gain,
            (nj * nj + p.toe_second_k2).sqrt(),
        );
    m *= mnorm;
    m *= (j_ts / j).powf(-0.879464149);
    [j, m, h]
}

fn tonescale_forward(j: f64, p: Parameters) -> f64 {
    let a = 0.0323680267 * (j.abs() * 0.00999999978).powf(0.879464149);
    let y = (27.1299992 * a / (1.0 - a)).powf(2.3809523809523809);
    let f = p.tonescale_y_ref * (y / (y + p.tonescale_y_scale)).powf(1.14999998);
    let y_ts = (f * f / (f + 0.0399999991)).max(0.0);
    let f_l_y = (0.79370057210326195 * y_ts).powf(0.42);
    let j_ts = 100.0 * (f_l_y / (27.1299992 + f_l_y) * 30.8946857).powf(1.13705599);
    j.signum() * j_ts
}

fn toe_forward(x: f64, limit: f64, k1_in: f64, k2_in: f64) -> f64 {
    let k2 = k2_in.max(0.001);
    let k1 = (k1_in * k1_in + k2 * k2).sqrt();
    let k3 = (limit + k1) / (limit + k2);
    if x > limit {
        x
    } else {
        let value = k3 * x - k1;
        0.5 * (value + (value * value + 4.0 * k2 * k3 * x).sqrt())
    }
}

fn chroma_forward(jmh: [f64; 3], p: Parameters) -> [f64; 3] {
    let j = jmh[0];
    let m = jmh[1];
    let h = jmh[2];
    let j_ts = tonescale_forward(j, p);
    if m == 0.0 || j == 0.0 {
        return [j_ts, 0.0, h];
    }
    let radians = h.to_radians();
    let cos_h = radians.cos();
    let sin_h = radians.sin();
    let cos_h2 = 2.0 * cos_h * cos_h - 1.0;
    let sin_h2 = 2.0 * cos_h * sin_h;
    let cos_h3 = 4.0 * cos_h * cos_h * cos_h - 3.0 * cos_h;
    let sin_h3 = 3.0 * sin_h - 4.0 * sin_h * sin_h * sin_h;
    let mnorm = cos_h * p.mnorm_cosine[0]
        + cos_h2 * p.mnorm_cosine[1]
        + cos_h3 * p.mnorm_cosine[2]
        + sin_h * p.mnorm_sine[0]
        + sin_h2 * p.mnorm_sine[1]
        + sin_h3 * p.mnorm_sine[2]
        + p.mnorm_offset;
    let nj = j_ts / p.j_max;
    let snj = (1.0 - nj).max(0.0);
    let limit = nj.powf(0.879464149) * reach_sample(h, p) / mnorm;
    let mut m_cp = m * (j_ts / j).powf(0.879464149) / mnorm;
    m_cp = limit
        - toe_forward(
            limit - m_cp,
            limit - 0.001,
            snj * p.toe_second_gain,
            (nj * nj + p.toe_second_k2).sqrt(),
        );
    m_cp = toe_forward(m_cp, limit, nj * p.toe_first_gain, snj);
    [j_ts, m_cp * mnorm, h]
}

fn jmh_to_ap0(jmh: [f64; 3]) -> [f64; 3] {
    let radians = jmh[2].to_radians();
    let aab = [
        (jmh[0] * 0.00999999978).powf(0.879464149),
        jmh[1] * radians.cos(),
        jmh[1] * radians.sin(),
    ];
    let rgb_a = mat(&AAB_TO_RGB_A, aab);
    let rgb_a_lim = [
        rgb_a[0].abs().min(0.99000001),
        rgb_a[1].abs().min(0.99000001),
        rgb_a[2].abs().min(0.99000001),
    ];
    let lms = [
        rgb_a[0].signum() * (27.1299992 * rgb_a_lim[0] / (1.0 - rgb_a_lim[0])).powf(2.38095236),
        rgb_a[1].signum() * (27.1299992 * rgb_a_lim[1] / (1.0 - rgb_a_lim[1])).powf(2.38095236),
        rgb_a[2].signum() * (27.1299992 * rgb_a_lim[2] / (1.0 - rgb_a_lim[2])).powf(2.38095236),
    ];
    mat(&RGB_A_TO_LMS, lms)
}

fn jmh_to_target_rgb(jmh: [f64; 3], p: Parameters) -> [f64; 3] {
    let radians = jmh[2].to_radians();
    let aab = [
        (jmh[0] * 0.00999999978).powf(0.879464149),
        jmh[1] * radians.cos(),
        jmh[1] * radians.sin(),
    ];
    let rgb_a = mat(&AAB_TO_RGB_A, aab);
    let lms = [
        rgb_a[0].signum()
            * (27.1299992 * rgb_a[0].abs().min(0.99000001)
                / (1.0 - rgb_a[0].abs().min(0.99000001)))
            .powf(2.38095236),
        rgb_a[1].signum()
            * (27.1299992 * rgb_a[1].abs().min(0.99000001)
                / (1.0 - rgb_a[1].abs().min(0.99000001)))
            .powf(2.38095236),
        rgb_a[2].signum()
            * (27.1299992 * rgb_a[2].abs().min(0.99000001)
                / (1.0 - rgb_a[2].abs().min(0.99000001)))
            .powf(2.38095236),
    ];
    mat(&p.jmh_to_target_rgb, lms)
}

/// Apply the exact ACES 2.0 inverse output fixed function and return ACEScg.
pub fn inverse(profile: u32, xyz: [f64; 3]) -> [f64; 3] {
    let p = parameters(profile);
    let rgb = clamp3(mat(&p.xyz_to_rgb, xyz), 0.0, p.input_max);
    let jmh = rgb_to_jmh(rgb, p);
    let jmh = gamut_compress_inverse_ocio(jmh, p);
    let jmh = chroma_inverse(jmh, p);
    let ap0 = jmh_to_ap0(jmh);
    clamp3(mat(&AP0_TO_ACESCG, ap0), 0.0, p.output_max)
}

/// Apply the exact ACES 2.0 forward output fixed function from ACEScg to XYZ.
pub fn forward(profile: u32, acescg: [f64; 3]) -> [f64; 3] {
    let p = parameters(profile);
    let ap0 = clamp3(mat(&ACESCG_TO_AP0, acescg), 0.0, p.output_max);
    let jmh = rgb_to_jmh_with_matrix(ap0, &AP0_TO_LMS);
    let chroma = chroma_forward(jmh, p);
    let compressed = gamut_compress_forward(chroma, chroma[0], reach_sample(jmh[2], p), p);
    let target_rgb = clamp3(jmh_to_target_rgb(compressed, p), 0.0, p.input_max);
    mat(&p.target_to_xyz, target_rgb)
}
