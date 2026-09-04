//! Small browser-facing modCAM16-HK renderer.
//!
//! The public functions deliberately use flat arrays so they are cheap to
//! call from JavaScript workers.  The scene/display conversions here cover
//! the fixed HDR Rec.2020-limited, HDR P3-D65, SDR Rec.709, and direct sRGB
//! profiles used by the Python tool.
//! The ACES output forward and inverse paths are the ACES 2.0 fixed functions
//! exported by the bundled OpenColorIO processor.  The appearance equations are the
//! modCAM16-HK equations used by ``modcam16_palette.cam16_hk`` with its
//! default ``AppearanceConfig``.

mod aces_output;

use wasm_bindgen::prelude::*;

const WIDTH: usize = 512;
const HEIGHT: usize = 512;
const HK_COEFFICIENT: f64 = 66.0;
const SURROUND_C: f64 = 0.525;
const SURROUND_N_C: f64 = 0.8;
// Refl is an ACEScg-neutral control. The extension above unity keeps the
// brightest absolute ColorChecker references addressable and accommodates
// the Rec.709 100-nit inverse-view bridge (neutral sRGB 0.5 maps to about
// 1.169 ACEScg).
const REFLECTANCE_MAX: f64 = 1.2;
const BACKGROUND_MAX: f64 = 1.2;

const CAT16: [[f64; 3]; 3] = [
    [0.401288, 0.650173, -0.051461],
    [-0.250268, 1.204414, 0.045854],
    [-0.002079, 0.048952, 0.953127],
];

const CAT16_INVERSE: [[f64; 3]; 3] = [
    [1.862067855087233, -1.011254630531684, 0.149186775444452],
    [0.387526543236137, 0.621447441931475, -0.008973985167613],
    [-0.015841498849334, -0.034122938028516, 1.04996443687785],
];

const OPPONENT_TO_COMPRESSED: [[f64; 3]; 3] = [
    [460.0, 451.0, 288.0],
    [460.0, -891.0, -261.0],
    [460.0, -220.0, -6300.0],
];

const P3_TO_XYZ: [[f64; 3]; 3] = [
    [0.4865709486482161, 0.2656676931690931, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365063, 0.0792869140937450],
    [-0.00000000000000004, 0.0451133818589026, 1.043944368900976],
];

const REC709_TO_XYZ: [[f64; 3]; 3] = [
    [0.4123907992659595, 0.3575843393838780, 0.1804807884018343],
    [0.2126390058715104, 0.7151686787677560, 0.0721923153607337],
    [0.0193308187155919, 0.1191947797946259, 0.9505321522496607],
];

const XYZ_TO_P3: [[f64; 3]; 3] = [
    [2.493496911941425, -0.931383617919124, -0.402710784450717],
    [-0.829488969561575, 1.762664060318347, 0.023624685841944],
    [0.035845830243784, -0.076172389268042, 0.956884524007687],
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

// Linear ACEScg/AP1 (D60) from the adapted D65 XYZ reference.  ColorChecker
// dots are anchored to this absolute scene-linear value before the selected
// ACES 2.0 output transform is evaluated.
const XYZ_D65_TO_ACESCG: [[f64; 3]; 3] = [
    [1.660585326491183, -0.315295560825870, -0.241509327608377],
    [-0.659926063224154, 1.608391469566054, 0.017298594705446],
    [0.009002569137834, -0.003566876390337, 0.913643312763104],
];

// Linear ACEScg/AP1 (D60) to adapted D65 XYZ. This is the inverse of
// `XYZ_D65_TO_ACESCG` and is used by the direct sRGB profile, where the
// ACES 2.0 output transform is intentionally bypassed.
const ACESCG_TO_XYZ_D65: [[f64; 3]; 3] = [
    [0.6522375418862886, 0.1282361359997123, 0.1699822491656707],
    [0.2676721801253367, 0.6743399888015509, 0.0579878310731121],
    [-0.0053818157663876, 0.0013690602090956, 1.0930705063171706],
];

// Official post-2014 ColorChecker 18-patch Lab/D50 reference values used by
// modcam16_palette.colorchecker. Derived patch attributes are calculated at
// runtime; these are source measurements, not a precomputed color table.
const COLORCHECKER_LAB_D50: [[f64; 3]; 18] = [
    [37.54, 14.37, 14.92],
    [64.66, 19.27, 17.50],
    [49.32, -3.82, -22.54],
    [43.46, -12.74, 22.72],
    [54.94, 9.61, -24.79],
    [70.48, -32.26, -0.37],
    [62.73, 35.83, 56.50],
    [39.43, 10.75, -45.17],
    [50.57, 48.64, 16.67],
    [30.10, 22.54, -20.87],
    [71.77, -24.13, 58.19],
    [71.51, 18.24, 67.37],
    [28.37, 15.42, -49.80],
    [54.38, -39.72, 32.27],
    [42.43, 51.05, 28.62],
    [81.80, 2.67, 80.41],
    [50.63, 51.28, -14.12],
    [49.57, -29.71, -28.32],
];

// CAT02 chromatic adaptation from the ColorChecker's D50 reference white to
// the D65 reference used by the appearance model.
const D50_TO_D65_CAT02: [[f64; 3]; 3] = [
    [
        0.9599086057258068,
        -0.02931106901521631,
        0.06569604282439087,
    ],
    [-0.02119125332801955, 0.9988574221592446, 0.0261460794841881],
    [0.0013712869836183, 0.00443870751911378, 1.3127874597917268],
];

#[derive(Clone, Copy)]
struct Model {
    adaptation: [f64; 3],
    cam_a_w: f64,
    cam_f_l: f64,
    cam_z: f64,
}

#[derive(Clone, Copy)]
struct Sample {
    xyz: [f64; 3],
    source_rgb: [f64; 3],
    acescg: [f64; 3],
    valid: bool,
}

fn source_to_xyz(profile: u32, rgb: [f64; 3]) -> [f64; 3] {
    mat(
        if profile == 1 || profile == 3 {
            &REC709_TO_XYZ
        } else {
            &P3_TO_XYZ
        },
        rgb,
    )
}

fn xyz_to_source(profile: u32, xyz: [f64; 3]) -> [f64; 3] {
    mat(
        if profile == 1 || profile == 3 {
            &XYZ_TO_REC709
        } else {
            &XYZ_TO_P3
        },
        xyz,
    )
}

fn source_cone_valid(profile: u32, source_rgb: [f64; 3], xyz: [f64; 3]) -> bool {
    if min3(source_rgb) < -1.0e-6 {
        return false;
    }
    if profile == 3 {
        return max3(source_rgb) <= 1.0 + 1.0e-6;
    }
    // The Rec.2020-limited profile uses a P3 source constrained by the
    // selected ACES 2.0 Rec.2100 output path's narrower red boundary.
    profile != 0 || min3(mat(&XYZ_TO_REC2020, xyz)) >= -1.0e-6
}

fn mat(matrix: &[[f64; 3]; 3], value: [f64; 3]) -> [f64; 3] {
    [
        matrix[0][0] * value[0] + matrix[0][1] * value[1] + matrix[0][2] * value[2],
        matrix[1][0] * value[0] + matrix[1][1] * value[1] + matrix[1][2] * value[2],
        matrix[2][0] * value[0] + matrix[2][1] * value[1] + matrix[2][2] * value[2],
    ]
}

fn finite3(value: [f64; 3]) -> bool {
    value.iter().all(|component| component.is_finite())
}

fn min3(value: [f64; 3]) -> f64 {
    value[0].min(value[1]).min(value[2])
}

fn max3(value: [f64; 3]) -> f64 {
    value[0].max(value[1]).max(value[2])
}

fn unit_cube_valid(value: [f64; 3]) -> bool {
    finite3(value) && min3(value) >= -1.0e-6 && max3(value) <= 1.0 + 1.0e-6
}

fn clamp_unit(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn signed_power(value: f64, exponent: f64) -> f64 {
    value.signum() * value.abs().powf(exponent)
}

fn response(value: f64, f_l: f64) -> f64 {
    let lower = 0.26;
    let upper = 150.0;
    let response_at_lower = hyperbolic_response(lower, f_l);
    let response_at_upper = hyperbolic_response(upper, f_l);
    let upper_slope = hyperbolic_derivative(upper, f_l);
    if value < lower {
        response_at_lower * value / lower + 0.1
    } else if value > upper {
        response_at_upper + upper_slope * (value - upper) + 0.1
    } else {
        hyperbolic_response(value, f_l) + 0.1
    }
}

fn inverse_response(value: f64, f_l: f64) -> f64 {
    let response_value = value - 0.1;
    let lower = 0.26;
    let upper = 150.0;
    let response_at_lower = hyperbolic_response(lower, f_l);
    let response_at_upper = hyperbolic_response(upper, f_l);
    let upper_slope = hyperbolic_derivative(upper, f_l);
    if response_value < response_at_lower {
        lower * response_value / response_at_lower
    } else if response_value > response_at_upper {
        upper + (response_value - response_at_upper) / upper_slope
    } else {
        let base = 27.13 * response_value / (400.0 - response_value);
        100.0 / f_l * base.powf(1.0 / 0.42)
    }
}

fn hyperbolic_response(value: f64, f_l: f64) -> f64 {
    let power = (f_l * value / 100.0).powf(0.42);
    400.0 * power / (27.13 + power)
}

fn hyperbolic_derivative(value: f64, f_l: f64) -> f64 {
    let normalized = f_l * value / 100.0;
    let power = normalized.powf(0.42);
    1.68 * 27.13 * f_l * normalized.powf(-0.58) / (27.13 + power).powi(2)
}

fn model() -> Model {
    let white = [
        0.3127 / 0.3290 * 100.0,
        100.0,
        (1.0 - 0.3127 - 0.3290) / 0.3290 * 100.0,
    ];
    let cam_white = mat(&CAT16, white);
    let adaptation = [
        100.0 / cam_white[0],
        100.0 / cam_white[1],
        100.0 / cam_white[2],
    ];
    let adapting_luminance: f64 = 20.0;
    let k = 1.0 / (5.0 * adapting_luminance + 1.0);
    let k4 = k.powi(4);
    let f_l = 0.2 * k4 * 5.0 * adapting_luminance
        + 0.1 * (1.0 - k4).powi(2) * (5.0 * adapting_luminance).cbrt();
    let compressed_white = [
        response(cam_white[0] * adaptation[0], f_l),
        response(cam_white[1] * adaptation[1], f_l),
        response(cam_white[2] * adaptation[2], f_l),
    ];
    let cam_a_w =
        2.0 * compressed_white[0] + compressed_white[1] + 0.05 * compressed_white[2] - 0.305;
    Model {
        adaptation,
        cam_a_w,
        cam_f_l: f_l,
        // AppearanceConfig.reference_background_ratio = 20 / 200 = 0.1.
        cam_z: 1.48 + (0.1_f64).sqrt(),
    }
}

fn eccentricity(hue: f64) -> f64 {
    let h = hue.to_radians();
    -0.0582 * h.cos() - 0.0258 * (2.0 * h).cos() - 0.1347 * (3.0 * h).cos()
        + 0.0289 * (4.0 * h).cos()
        - 0.1475 * h.sin()
        - 0.0308 * (2.0 * h).sin()
        + 0.0385 * (3.0 * h).sin()
        + 0.0096 * (4.0 * h).sin()
        + 1.0
}

fn attributes(model: Model, xyz: [f64; 3]) -> (f64, f64, f64, f64) {
    let sharpened = mat(&CAT16, [xyz[0] * 100.0, xyz[1] * 100.0, xyz[2] * 100.0]);
    let adapted = [
        sharpened[0] * model.adaptation[0],
        sharpened[1] * model.adaptation[1],
        sharpened[2] * model.adaptation[2],
    ];
    let compressed = [
        response(adapted[0], model.cam_f_l),
        response(adapted[1], model.cam_f_l),
        response(adapted[2], model.cam_f_l),
    ];
    let opponent_a = compressed[0] - 12.0 * compressed[1] / 11.0 + compressed[2] / 11.0;
    let opponent_b = (compressed[0] + compressed[1] - 2.0 * compressed[2]) / 9.0;
    let hue = (opponent_b.atan2(opponent_a).to_degrees() + 360.0) % 360.0;
    let achromatic = 2.0 * compressed[0] + compressed[1] + 0.05 * compressed[2] - 0.305;
    let j = 100.0 * signed_power(achromatic / model.cam_a_w, SURROUND_C * model.cam_z);
    let colorfulness = 43.0 * SURROUND_N_C * eccentricity(hue) * opponent_a.hypot(opponent_b);
    let chroma = 35.0 * colorfulness / model.cam_a_w;
    let j_hk = (j * j + HK_COEFFICIENT * chroma).max(0.0).sqrt();
    (j, chroma, hue, j_hk)
}

// This is the profile-side neutral curve used to construct D = F_p(C) for a
// slider state. Refl is solved against this curve for every ACES view profile.
fn neutral_j_hk(model: Model, profile: u32, reflectance: f64) -> f64 {
    let xyz = if profile == 3 {
        source_to_xyz(profile, [reflectance; 3])
    } else {
        transform_from_acescg(profile, [reflectance; 3])
    };
    attributes(model, xyz).3
}

fn output_neutral_j_hk(model: Model, profile: u32, value: f64) -> f64 {
    attributes(model, source_to_xyz(profile, [value; 3])).3
}

fn solve_output_neutral_for_j_hk(model: Model, profile: u32, target: f64) -> (f64, bool) {
    let mut lower = 0.0;
    let mut upper = BACKGROUND_MAX;
    let lower_j = output_neutral_j_hk(model, profile, lower);
    let upper_j = output_neutral_j_hk(model, profile, upper);
    if !target.is_finite() || !lower_j.is_finite() || !upper_j.is_finite() {
        return (
            if target.is_sign_negative() {
                lower
            } else {
                upper
            },
            false,
        );
    }
    if target < lower_j {
        return (lower, false);
    }
    if target > upper_j {
        return (upper, false);
    }
    if target == lower_j {
        return (lower, true);
    }
    if target == upper_j {
        return (upper, true);
    }
    for _ in 0..60 {
        let middle = 0.5 * (lower + upper);
        if output_neutral_j_hk(model, profile, middle) < target {
            lower = middle;
        } else {
            upper = middle;
        }
    }
    (0.5 * (lower + upper), true)
}

fn lab_d50_to_xyz(lab: [f64; 3]) -> [f64; 3] {
    let delta = 6.0 / 29.0;
    let f = [(lab[0] + 16.0) / 116.0, lab[1] / 500.0, -lab[2] / 200.0];
    let f = [f[0], f[0] + f[1], f[0] + f[2]];
    let inverse = |value: f64| {
        if value > delta {
            value.powi(3)
        } else {
            3.0 * delta * delta * (value - 4.0 / 29.0)
        }
    };
    let white = [0.34567 / 0.35850, 1.0, (1.0 - 0.34567 - 0.35850) / 0.35850];
    [
        white[0] * inverse(f[1]),
        white[1] * inverse(f[0]),
        white[2] * inverse(f[2]),
    ]
}

/// Solve a profile-local neutral coordinate for a target J_HK.
///
/// The second tuple member distinguishes an exact in-range solve from a
/// finite boundary fallback. Keeping the fallback finite lets the UI display
/// and edit an unrepresentable conversion without manufacturing NaN slider
/// values.
fn solve_neutral_reflectance_for_j_hk(model: Model, profile: u32, target: f64) -> (f64, bool) {
    let mut lower = 0.0;
    let mut upper = REFLECTANCE_MAX;
    let lower_j = neutral_j_hk(model, profile, lower);
    let upper_j = neutral_j_hk(model, profile, upper);
    if !target.is_finite() || !lower_j.is_finite() || !upper_j.is_finite() {
        // A non-finite target has no meaningful direction. The upper bound is
        // the least surprising visible fallback for an over-range result.
        return (
            if target.is_sign_negative() {
                lower
            } else {
                upper
            },
            false,
        );
    }
    if target < lower_j {
        return (lower, false);
    }
    if target == lower_j {
        return (lower, true);
    }
    if target > upper_j {
        return (upper, false);
    }
    if target == upper_j {
        return (upper, true);
    }
    for _ in 0..60 {
        let middle = 0.5 * (lower + upper);
        if neutral_j_hk(model, profile, middle) < target {
            lower = middle;
        } else {
            upper = middle;
        }
    }
    (0.5 * (lower + upper), true)
}

// Keep the scalar helper available to callers inside this crate. Unlike the
// old implementation, it deliberately returns a finite boundary for an
// unreachable target; callers that need to distinguish a fallback use the
// tuple-returning solver above.
#[allow(dead_code)]
fn neutral_reflectance_for_j_hk(model: Model, profile: u32, target: f64) -> f64 {
    solve_neutral_reflectance_for_j_hk(model, profile, target).0
}

fn neutral_scalar(rgb: [f64; 3]) -> Option<f64> {
    if !finite3(rgb) {
        return None;
    }
    let value = (rgb[0] + rgb[1] + rgb[2]) / 3.0;
    let spread = max3([
        (rgb[0] - value).abs(),
        (rgb[1] - value).abs(),
        (rgb[2] - value).abs(),
    ]);
    if spread <= 2.0e-5 {
        Some(value)
    } else {
        None
    }
}

fn forward_acescg_neutral(profile: u32, value: f64) -> Option<f64> {
    if !value.is_finite() || !(0.0..=REFLECTANCE_MAX).contains(&value) {
        return None;
    }
    let xyz = if profile == 3 {
        source_to_xyz(profile, [value; 3])
    } else {
        transform_from_acescg(profile, [value; 3])
    };
    neutral_scalar(xyz_to_source(profile, xyz))
}

fn modcam_to_xyz(model: Model, j_hk: f64, chroma: f64, hue: f64) -> [f64; 3] {
    let radicand = j_hk * j_hk - HK_COEFFICIENT * chroma;
    let tolerance = 1.0e-12 * (1.0_f64).max(j_hk * j_hk);
    if !radicand.is_finite() || radicand < -tolerance || chroma < 0.0 {
        return [f64::NAN; 3];
    }
    let j = radicand.max(0.0).sqrt();
    let colorfulness = chroma * model.cam_a_w / 35.0;
    let opponent_radius = colorfulness / (43.0 * SURROUND_N_C * eccentricity(hue));
    let radians = hue.to_radians();
    let opponent = [
        model.cam_a_w * signed_power(j / 100.0, 1.0 / (SURROUND_C * model.cam_z)) + 0.305,
        opponent_radius * radians.cos(),
        opponent_radius * radians.sin(),
    ];
    let compressed = mat(&OPPONENT_TO_COMPRESSED, opponent);
    let compressed = [
        compressed[0] / 1403.0,
        compressed[1] / 1403.0,
        compressed[2] / 1403.0,
    ];
    let adapted = [
        inverse_response(compressed[0], model.cam_f_l),
        inverse_response(compressed[1], model.cam_f_l),
        inverse_response(compressed[2], model.cam_f_l),
    ];
    let sharpened = [
        adapted[0] / model.adaptation[0],
        adapted[1] / model.adaptation[1],
        adapted[2] / model.adaptation[2],
    ];
    let xyz = mat(&CAT16_INVERSE, sharpened);
    [xyz[0] / 100.0, xyz[1] / 100.0, xyz[2] / 100.0]
}

fn transform_to_acescg(profile: u32, xyz: [f64; 3]) -> [f64; 3] {
    if profile == 3 {
        mat(&XYZ_D65_TO_ACESCG, xyz)
    } else {
        aces_output::inverse(profile, xyz)
    }
}

fn transform_from_acescg(profile: u32, acescg: [f64; 3]) -> [f64; 3] {
    if profile == 3 {
        mat(&ACESCG_TO_XYZ_D65, acescg)
    } else {
        aces_output::forward(profile, acescg)
    }
}

// Cross-workflow conversions use the SDR Rec.709 ACES view as their bridge.
// Profile 3 itself is a direct linear Rec.709 workflow, so its ordinary
// ACEScg conversion is only used for same-workflow helpers. When crossing
// between direct sRGB and an ACES view, these helpers make the mandated view
// transform explicit.
fn acescg_to_rec709_view_xyz(acescg: [f64; 3]) -> [f64; 3] {
    transform_from_acescg(1, acescg)
}

fn acescg_to_srgb_xyz(acescg: [f64; 3]) -> [f64; 3] {
    let view_xyz = acescg_to_rec709_view_xyz(acescg);
    let output = xyz_to_source(3, view_xyz);
    let clipped = [
        output[0].clamp(0.0, 1.0),
        output[1].clamp(0.0, 1.0),
        output[2].clamp(0.0, 1.0),
    ];
    source_to_xyz(3, clipped)
}

fn srgb_to_acescg(linear: [f64; 3]) -> [f64; 3] {
    aces_output::inverse(1, source_to_xyz(3, linear))
}

fn decode_srgb(value: f64) -> f64 {
    if !value.is_finite() {
        return f64::NAN;
    }
    let sign = value.signum();
    let magnitude = value.abs();
    let linear = if magnitude <= 0.04045 {
        magnitude / 12.92
    } else {
        ((magnitude + 0.055) / 1.055).powf(2.4)
    };
    sign * linear
}

fn sample(model: Model, profile: u32, j_hk: f64, hue: f64, saturation: f64) -> Sample {
    let chroma = saturation / 100.0 * j_hk * j_hk / HK_COEFFICIENT;
    // Invert the appearance model to obtain A, then run A through the
    // selected forward view transform again. The latter is the color exposed
    // to the rest of the pipeline and makes the f(A) side of the J_HK
    // constraint explicit instead of relying on the intermediate inverse XYZ.
    let inverse_xyz = modcam_to_xyz(model, j_hk, chroma, hue);
    let acescg = transform_to_acescg(profile, inverse_xyz);
    let xyz = transform_from_acescg(profile, acescg);
    let source_rgb = xyz_to_source(profile, xyz);
    let source_valid = finite3(source_rgb) && source_cone_valid(profile, source_rgb, xyz);
    let rendered_j_hk = attributes(model, xyz).3;
    let appearance_match =
        rendered_j_hk.is_finite() && j_hk.is_finite() && (rendered_j_hk - j_hk).abs() <= 2.0e-5;
    let valid = if profile == 3 {
        source_valid && appearance_match
    } else {
        source_valid && appearance_match && unit_cube_valid(acescg)
    };
    Sample {
        xyz,
        source_rgb,
        acescg,
        valid,
    }
}

fn maximum_saturation_inner(model: Model, profile: u32, j_hk: f64, hue: f64) -> f64 {
    let mut lower = 0.0;
    let mut upper = 100.0;
    if !sample(model, profile, j_hk, hue, lower).valid {
        return 0.0;
    }
    if sample(model, profile, j_hk, hue, upper).valid {
        return upper;
    }
    for _ in 0..40 {
        let middle = (lower + upper) * 0.5;
        if sample(model, profile, j_hk, hue, middle).valid {
            lower = middle;
        } else {
            upper = middle;
        }
    }
    lower
}

fn encode_display_rgb(linear: [f64; 3]) -> [f64; 3] {
    let encode = |value: f64| {
        let value = value.clamp(0.0, 1.0);
        let encoded = if value <= 0.0031308 {
            12.92 * value
        } else {
            1.055 * value.powf(1.0 / 2.4) - 0.055
        };
        encoded.clamp(0.0, 1.0)
    };
    [encode(linear[0]), encode(linear[1]), encode(linear[2])]
}

fn display_rgb(linear_rgb: [f64; 3], matrix: &[[f64; 3]; 3]) -> [u8; 3] {
    let encoded = encode_display_rgb(mat(matrix, linear_rgb));
    [
        (encoded[0] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
        (encoded[1] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
        (encoded[2] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
    ]
}

fn display_rgb_f64(linear_rgb: [f64; 3], matrix: &[[f64; 3]; 3]) -> [f64; 3] {
    encode_display_rgb(mat(matrix, linear_rgb))
}

fn display_xyz_f64(xyz: [f64; 3], matrix: &[[f64; 3]; 3]) -> [f64; 3] {
    display_rgb_f64(xyz, matrix)
}

/// Evaluate one color.
///
/// Returns `[valid, maximum_saturation, linear output (sRGB for profile 3,
/// ACEScg for ACES profiles),
/// source_r, source_g, source_b, source-preview display_p3_r, display_p3_g,
/// display_p3_b, neutral_display_p3_r, neutral_display_p3_g,
/// neutral_display_p3_b, source-preview display_srgb_r, display_srgb_g, display_srgb_b,
/// neutral_display_srgb_r, neutral_display_srgb_g, neutral_display_srgb_b,
/// encoded ACEScg/AP1_r, encoded ACEScg/AP1_g, encoded ACEScg/AP1_b,
/// forward-view neutral background]`.
#[wasm_bindgen]
pub fn evaluate(profile: u32, reflectance: f64, hue: f64, saturation: f64) -> Vec<f64> {
    let model = model();
    let hue = hue.rem_euclid(360.0);
    let reflectance = reflectance.clamp(0.0, REFLECTANCE_MAX);
    let saturation = saturation.clamp(0.0, 100.0);
    let j_hk = neutral_j_hk(model, profile, reflectance);
    if !j_hk.is_finite() {
        return vec![0.0; 24];
    }
    let result = sample(model, profile, j_hk, hue, saturation);
    let neutral = sample(model, profile, j_hk, hue, 0.0);
    let maximum = maximum_saturation_inner(model, profile, j_hk, hue);
    // Readouts are always bounded to the unit interval. The validity bit
    // remains false when the underlying color had an out-of-range channel, so
    // the UI can show its unavailable state instead of presenting a valid
    // color for a clipped value.
    let acescg = result.acescg;
    let linear_output = if profile == 3 {
        [
            clamp_unit(result.source_rgb[0]),
            clamp_unit(result.source_rgb[1]),
            clamp_unit(result.source_rgb[2]),
        ]
    } else {
        [
            clamp_unit(acescg[0]),
            clamp_unit(acescg[1]),
            clamp_unit(acescg[2]),
        ]
    };
    let neutral_display_p3 = if neutral.valid {
        display_xyz_f64(neutral.xyz, &XYZ_TO_P3)
    } else {
        [0.0; 3]
    };
    let display_p3 = if result.valid {
        display_xyz_f64(result.xyz, &XYZ_TO_P3)
    } else {
        [0.0; 3]
    };
    let display_srgb = if result.valid {
        display_xyz_f64(result.xyz, &XYZ_TO_REC709)
    } else {
        [0.0; 3]
    };
    let neutral_display_srgb = if neutral.valid {
        display_xyz_f64(neutral.xyz, &XYZ_TO_REC709)
    } else {
        [0.0; 3]
    };
    let acescg_srgb = encode_display_rgb(acescg);
    let background_neutral = forward_acescg_neutral(profile, reflectance).unwrap_or(f64::NAN);
    vec![
        if result.valid { 1.0 } else { 0.0 },
        maximum,
        linear_output[0],
        linear_output[1],
        linear_output[2],
        if result.valid {
            result.source_rgb[0]
        } else {
            0.0
        },
        if result.valid {
            result.source_rgb[1]
        } else {
            0.0
        },
        if result.valid {
            result.source_rgb[2]
        } else {
            0.0
        },
        display_p3[0],
        display_p3[1],
        display_p3[2],
        neutral_display_p3[0],
        neutral_display_p3[1],
        neutral_display_p3[2],
        display_srgb[0],
        display_srgb[1],
        display_srgb[2],
        neutral_display_srgb[0],
        neutral_display_srgb[1],
        neutral_display_srgb[2],
        acescg_srgb[0],
        acescg_srgb[1],
        acescg_srgb[2],
        background_neutral,
    ]
}

/// Adapt a linear neutral through exact inverse and forward profile transforms.
/// The returned values are `[valid, bounded_target_neutral]`.
#[wasm_bindgen]
pub fn convert_neutral_profile(
    source_profile: u32,
    target_profile: u32,
    source_neutral: f64,
) -> Vec<f64> {
    if !source_neutral.is_finite() || !(0.0..=BACKGROUND_MAX).contains(&source_neutral) {
        return vec![0.0, f64::NAN];
    }
    let source_rgb = [source_neutral; 3];
    let acescg = if source_profile == 3 && target_profile != 3 {
        srgb_to_acescg(source_rgb)
    } else {
        transform_to_acescg(source_profile, source_to_xyz(source_profile, source_rgb))
    };
    let target_xyz = if target_profile == 3 && source_profile != 3 {
        acescg_to_srgb_xyz(acescg)
    } else {
        transform_from_acescg(target_profile, acescg)
    };
    let target_rgb = xyz_to_source(target_profile, target_xyz);
    let Some(target_neutral) = neutral_scalar(target_rgb) else {
        return vec![0.0, f64::NAN];
    };
    let valid = finite3(acescg) && target_neutral.is_finite() && target_neutral >= 0.0;
    vec![
        if valid { 1.0 } else { 0.0 },
        target_neutral.clamp(0.0, BACKGROUND_MAX),
    ]
}

/// Convert sRGB-encoded ACEScg/AP1 values back to the source appearance
/// coordinates used by the sliders. The returned values are
/// `[valid, profile_refl, hue, saturation]`. For ACES profiles, Refl is solved
/// against the selected profile's forward neutral curve.
#[wasm_bindgen]
pub fn set_from_acescg_srgb(profile: u32, red: f64, green: f64, blue: f64) -> Vec<f64> {
    let model = model();
    let acescg = [decode_srgb(red), decode_srgb(green), decode_srgb(blue)];
    let xyz = if profile == 3 {
        acescg_to_srgb_xyz(acescg)
    } else {
        transform_from_acescg(profile, acescg)
    };
    coordinates_from_rendered_xyz(model, profile, None, xyz)
}

/// Derive all three slider coordinates for an existing ACEScg color.
///
/// The returned values are `[valid, reflectance, hue, saturation]`.
#[wasm_bindgen]
pub fn set_profile_from_acescg_srgb(
    profile: u32,
    _reflectance: f64,
    red: f64,
    green: f64,
    blue: f64,
) -> Vec<f64> {
    let model = model();
    let acescg = [decode_srgb(red), decode_srgb(green), decode_srgb(blue)];
    let xyz = if profile == 3 {
        acescg_to_srgb_xyz(acescg)
    } else {
        transform_from_acescg(profile, acescg)
    };
    coordinates_from_rendered_xyz(model, profile, None, xyz)
}

fn output_srgb_to_xyz(red: f64, green: f64, blue: f64) -> ([f64; 3], [f64; 3]) {
    let linear = [decode_srgb(red), decode_srgb(green), decode_srgb(blue)];
    (linear, source_to_xyz(3, linear))
}

fn target_xyz_from_output_srgb(profile: u32, linear: [f64; 3], clamp_srgb: bool) -> [f64; 3] {
    let linear = if clamp_srgb {
        [
            linear[0].clamp(0.0, 1.0),
            linear[1].clamp(0.0, 1.0),
            linear[2].clamp(0.0, 1.0),
        ]
    } else {
        linear
    };
    if profile == 3 {
        source_to_xyz(3, linear)
    } else {
        // Direct sRGB is interpreted through the inverse ACES 2.0 Rec.709
        // 100-nit view before it is rendered by the selected ACES profile.
        let acescg = srgb_to_acescg(linear);
        transform_from_acescg(profile, acescg)
    }
}

fn target_xyz_from_retained_color(
    source_profile: u32,
    target_profile: u32,
    red: f64,
    green: f64,
    blue: f64,
) -> [f64; 3] {
    let encoded = [red, green, blue];
    if source_profile == 3 {
        let linear = [
            decode_srgb(encoded[0]),
            decode_srgb(encoded[1]),
            decode_srgb(encoded[2]),
        ];
        target_xyz_from_output_srgb(target_profile, linear, false)
    } else {
        let acescg = [
            decode_srgb(encoded[0]),
            decode_srgb(encoded[1]),
            decode_srgb(encoded[2]),
        ];
        if target_profile == 3 {
            acescg_to_srgb_xyz(acescg)
        } else {
            transform_from_acescg(target_profile, acescg)
        }
    }
}

/// Convert a profile's background slider around the retained foreground.
///
/// The slider is a neutral value, but its snap point is defined by the
/// foreground's J_HK. Preserve the source background's J_HK offset from that
/// foreground neutral and solve the equivalent target neutral coordinate.
#[wasm_bindgen]
pub fn convert_background_profile(
    source_profile: u32,
    target_profile: u32,
    source_background: f64,
    source_reflectance: f64,
    red: f64,
    green: f64,
    blue: f64,
) -> Vec<f64> {
    let model = model();
    if !source_background.is_finite()
        || !(0.0..=BACKGROUND_MAX).contains(&source_background)
        || !source_reflectance.is_finite()
        || !(0.0..=REFLECTANCE_MAX).contains(&source_reflectance)
    {
        return vec![0.0, f64::NAN];
    }
    let target_xyz =
        target_xyz_from_retained_color(source_profile, target_profile, red, green, blue);
    let target_foreground_j = attributes(model, target_xyz).3;
    let source_foreground_j = neutral_j_hk(model, source_profile, source_reflectance);
    let source_background_j = output_neutral_j_hk(model, source_profile, source_background);
    let target_j = target_foreground_j + source_background_j - source_foreground_j;
    let (target_background, _exact) =
        solve_output_neutral_for_j_hk(model, target_profile, target_j);
    let valid = target_foreground_j.is_finite()
        && source_foreground_j.is_finite()
        && source_background_j.is_finite()
        && target_background.is_finite();
    vec![
        if valid { 1.0 } else { 0.0 },
        target_background.clamp(0.0, BACKGROUND_MAX),
    ]
}

fn coordinates_from_rendered_xyz(
    model: Model,
    profile: u32,
    requested_reflectance: Option<f64>,
    xyz: [f64; 3],
) -> Vec<f64> {
    coordinates_from_rendered_xyz_mode(model, profile, requested_reflectance, xyz, true)
}

fn coordinates_from_rendered_xyz_mode(
    model: Model,
    profile: u32,
    requested_reflectance: Option<f64>,
    xyz: [f64; 3],
    solve_profile_refl: bool,
) -> Vec<f64> {
    let (_, chroma, hue, j_hk) = attributes(model, xyz);
    // Solve Refl from the target rendered J_HK. A requested value is only
    // accepted by the legacy direct-target branch used by callers that need
    // to explicitly preserve a neutral; profile switches and color entry
    // always pass `None` so the target coordinates describe the retained
    // rendered color.
    let (reflectance, neutral_match) =
        if solve_profile_refl && (profile != 3 || requested_reflectance.is_none()) {
            solve_neutral_reflectance_for_j_hk(model, profile, j_hk)
        } else {
            let requested = requested_reflectance.expect("checked above");
            let reflectance = if requested.is_finite() {
                requested.clamp(0.0, REFLECTANCE_MAX)
            } else if j_hk.is_sign_negative() {
                0.0
            } else {
                REFLECTANCE_MAX
            };
            let target_j_hk = neutral_j_hk(model, profile, reflectance);
            (
                reflectance,
                requested.is_finite()
                    && target_j_hk.is_finite()
                    && (j_hk - target_j_hk).abs() <= 2.0e-5,
            )
        };
    let saturation = if j_hk > 0.0 {
        100.0 * HK_COEFFICIENT * chroma / (j_hk * j_hk)
    } else if chroma.abs() <= 1.0e-12 {
        0.0
    } else {
        f64::NAN
    };
    let target_j_hk = neutral_j_hk(model, profile, reflectance);
    let reconstructed = if target_j_hk.is_finite() && hue.is_finite() && saturation.is_finite() {
        sample(model, profile, target_j_hk, hue, saturation)
    } else {
        Sample {
            xyz: [f64::NAN; 3],
            source_rgb: [f64::NAN; 3],
            acescg: [f64::NAN; 3],
            valid: false,
        }
    };
    let reconstruction_error = max3([
        (reconstructed.xyz[0] - xyz[0]).abs(),
        (reconstructed.xyz[1] - xyz[1]).abs(),
        (reconstructed.xyz[2] - xyz[2]).abs(),
    ]);
    let model_match = neutral_match && reconstruction_error <= 2.0e-5;
    let source_rgb = xyz_to_source(profile, xyz);
    let valid = finite3(xyz)
        && finite3(source_rgb)
        && source_cone_valid(profile, source_rgb, xyz)
        && reflectance.is_finite()
        && (0.0..=REFLECTANCE_MAX).contains(&reflectance)
        && hue.is_finite()
        && saturation.is_finite()
        && (0.0..=100.0).contains(&saturation);
    let valid = valid && reconstructed.valid && model_match;
    let output_hue = if hue.is_finite() {
        hue.rem_euclid(360.0)
    } else {
        0.0
    };
    let output_saturation = if saturation.is_finite() {
        saturation.clamp(0.0, 100.0)
    } else {
        0.0
    };
    vec![
        if valid { 1.0 } else { 0.0 },
        reflectance.clamp(0.0, REFLECTANCE_MAX),
        output_hue,
        output_saturation,
    ]
}

/// Convert an sRGB-encoded Rec.709 value into the selected profile's slider
/// coordinates. This input is always the output sRGB color shown by the UI.
#[wasm_bindgen]
pub fn set_from_output_srgb(profile: u32, red: f64, green: f64, blue: f64) -> Vec<f64> {
    let model = model();
    let (linear, _) = output_srgb_to_xyz(red, green, blue);
    let xyz = target_xyz_from_output_srgb(profile, linear, profile == 3);
    coordinates_from_rendered_xyz(model, profile, None, xyz)
}

/// Convert an encoded ACEScg/AP1 value during a profile switch. ACES targets
/// solve all three coordinates from the retained ACEScg color; a direct sRGB
/// target remains on the separate clipped/output workflow.
#[wasm_bindgen]
pub fn set_profile_from_acescg_srgb_converted(
    profile: u32,
    _reflectance: f64,
    red: f64,
    green: f64,
    blue: f64,
) -> Vec<f64> {
    let model = model();
    let acescg = [decode_srgb(red), decode_srgb(green), decode_srgb(blue)];
    let xyz = if profile == 3 {
        acescg_to_srgb_xyz(acescg)
    } else {
        transform_from_acescg(profile, acescg)
    };
    // A direct sRGB target owns the output color, so derive its Refl/Hue/Sat
    // from the clipped target XYZ just like an output-color entry. Carrying
    // the ACES source Refl here can make an otherwise valid conversion look
    // invalid when the two neutral curves differ.
    coordinates_from_rendered_xyz(model, profile, None, xyz)
}

/// Convert an encoded output-sRGB value into slider coordinates for direct
/// editing. Refl is solved from the selected profile's native neutral curve.
#[wasm_bindgen]
pub fn set_profile_from_output_srgb(profile: u32, red: f64, green: f64, blue: f64) -> Vec<f64> {
    let model = model();
    let (linear, _) = output_srgb_to_xyz(red, green, blue);
    let xyz = target_xyz_from_output_srgb(profile, linear, profile == 3);
    coordinates_from_rendered_xyz(model, profile, None, xyz)
}

/// Convert a retained output-sRGB value during a profile switch. The retained
/// output color is first interpreted through the inverse Rec.709 100-nit view
/// whenever the target is an ACES profile, then all target coordinates are
/// solved from the resulting rendered color.
#[wasm_bindgen]
pub fn set_profile_from_output_srgb_converted(
    profile: u32,
    _reflectance: f64,
    red: f64,
    green: f64,
    blue: f64,
) -> Vec<f64> {
    let model = model();
    let (linear, _) = output_srgb_to_xyz(red, green, blue);
    let xyz = target_xyz_from_output_srgb(profile, linear, profile == 3);
    // The retained output-sRGB value is the canonical color for transitions
    // sourced from the direct profile. Re-solve all target coordinates from
    // that color; preserving the old direct Refl would reject colors whose
    // target neutral curve has a different J_HK.
    coordinates_from_rendered_xyz(model, profile, None, xyz)
}

/// Build one absolute-ACEScg ColorChecker reference record.
///
/// The source measurement is first converted to an absolute ACEScg value and
/// rendered through the selected profile. Hue, saturation, and the profile's
/// Refl coordinate are then derived from that rendered XYZ. `available`
/// reports whether the rendered reference has a usable nonnegative source
/// preimage; it never changes the coordinates or dot color.
fn colorchecker_record_from_acescg(
    model: Model,
    profile: u32,
    acescg_target: [f64; 3],
) -> [f64; 10] {
    let profile_xyz = transform_from_acescg(profile, acescg_target);
    let (j, chroma, raw_hue, j_hk) = attributes(model, profile_xyz);
    let hue = if raw_hue.is_finite() {
        raw_hue.rem_euclid(360.0)
    } else {
        0.0
    };
    let saturation = if j_hk.is_finite() && j_hk > 0.0 && chroma.is_finite() {
        100.0 * HK_COEFFICIENT * chroma / (j_hk * j_hk)
    } else {
        0.0
    };
    // Match the same target-profile neutral solve used by ACEScg entry and
    // profile switching. An out-of-range J_HK remains visible at a finite
    // slider boundary while `neutral_available` records that it is only a
    // fallback coordinate.
    let (profile_reflectance, neutral_available) =
        solve_neutral_reflectance_for_j_hk(model, profile, j_hk);
    let source_rgb = xyz_to_source(profile, profile_xyz);
    let target_j_hk = neutral_j_hk(model, profile, profile_reflectance);
    let neutral_representable = target_j_hk.is_finite() && (target_j_hk - j_hk).abs() <= 2.0e-5;
    let target_in_output_range = if profile == 3 {
        finite3(source_rgb) && min3(source_rgb) >= -1.0e-6 && max3(source_rgb) <= 1.0 + 1.0e-6
    } else {
        finite3(acescg_target)
            && min3(acescg_target) >= -1.0e-6
            && max3(acescg_target) <= 1.0 + 1.0e-6
    };
    let available = finite3(profile_xyz)
        && finite3(source_rgb)
        && finite3(acescg_target)
        && target_in_output_range
        && j.is_finite()
        && chroma.is_finite()
        && hue.is_finite()
        && saturation.is_finite()
        && neutral_available
        && neutral_representable
        && source_cone_valid(profile, source_rgb, profile_xyz);
    let display_p3 = display_xyz_f64(profile_xyz, &XYZ_TO_P3);
    let display_srgb = display_xyz_f64(profile_xyz, &XYZ_TO_REC709);
    [
        hue,
        saturation,
        profile_reflectance,
        display_p3[0],
        display_p3[1],
        display_p3[2],
        display_srgb[0],
        display_srgb[1],
        display_srgb[2],
        if available { 1.0 } else { 0.0 },
    ]
}

/// Calculate the absolute-ACEScg ColorChecker markers at runtime for one
/// profile.
///
/// Each ten-value record is `[hue, saturation, profile_refl, display_p3_r,
/// display_p3_g, display_p3_b, display_srgb_r, display_srgb_g,
/// display_srgb_b, available]`.  The frontend supplies the corresponding
/// patch names in the same official dataset order.
#[wasm_bindgen]
pub fn colorchecker_points(profile: u32) -> Vec<f64> {
    let model = model();
    let mut output = Vec::with_capacity(COLORCHECKER_LAB_D50.len() * 10);
    for lab in COLORCHECKER_LAB_D50 {
        let xyz_d50 = lab_d50_to_xyz(lab);
        let xyz_d65 = mat(&D50_TO_D65_CAT02, xyz_d50);
        let acescg_target = mat(&XYZ_D65_TO_ACESCG, xyz_d65);
        output.extend_from_slice(&colorchecker_record_from_acescg(
            model,
            profile,
            acescg_target,
        ));
    }
    output
}

/// Return the maximum usable saturation for one reflectance/hue direction.
#[wasm_bindgen]
pub fn maximum_saturation(profile: u32, reflectance: f64, hue: f64) -> f64 {
    let model = model();
    let reflectance = reflectance.clamp(0.0, REFLECTANCE_MAX);
    maximum_saturation_inner(
        model,
        profile,
        neutral_j_hk(model, profile, reflectance),
        hue.rem_euclid(360.0),
    )
}

fn render_rows_inner(
    profile: u32,
    reflectance: f64,
    width: u32,
    height: u32,
    y_start: u32,
    y_end: u32,
    source_display_matrix: &[[f64; 3]; 3],
) -> Vec<u8> {
    let model = model();
    let width = width.max(1) as usize;
    let height = height.max(1) as usize;
    let center_x = (width as f64 - 1.0) / 2.0;
    let center_y = (height as f64 - 1.0) / 2.0;
    let max_radius = (width.min(height) as f64) / 2.0;
    let start = (y_start as usize).min(height);
    let end = (y_end as usize).min(height).max(start);
    let mut output = vec![0_u8; (end - start) * width * 4];
    let reflectance = reflectance.clamp(0.0, REFLECTANCE_MAX);
    let solved_j_hk = {
        let value = neutral_j_hk(model, profile, reflectance);
        value.is_finite().then_some(value)
    };
    for y in start..end {
        for x in 0..width {
            let dx = x as f64 - center_x;
            let dy = y as f64 - center_y;
            let radius = dx.hypot(dy);
            let index = ((y - start) * width + x) * 4;
            if radius > max_radius {
                continue;
            }
            // 0 degrees points up; positive angles travel counter-clockwise.
            let hue = (-dx).atan2(-dy).to_degrees().rem_euclid(360.0);
            let saturation = radius / max_radius * 100.0;
            let result = solved_j_hk.map(|j_hk| sample(model, profile, j_hk, hue, saturation));
            if result.is_some_and(|value| value.valid) {
                let rgb = display_rgb(result.unwrap().xyz, source_display_matrix);
                output[index..index + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            } else {
                output[index..index + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
    output
}

/// Render rows `[y_start, y_end)` of the 512x512 radial slice as Display P3
/// RGBA bytes.
#[wasm_bindgen]
pub fn render_rows(profile: u32, reflectance: f64, y_start: u32, y_end: u32) -> Vec<u8> {
    render_rows_inner(
        profile,
        reflectance,
        WIDTH as u32,
        HEIGHT as u32,
        y_start,
        y_end,
        &XYZ_TO_P3,
    )
}

/// Render rows as sRGB RGBA bytes for browsers without Display P3 canvas
/// support.
#[wasm_bindgen]
pub fn render_rows_srgb(profile: u32, reflectance: f64, y_start: u32, y_end: u32) -> Vec<u8> {
    render_rows_inner(
        profile,
        reflectance,
        WIDTH as u32,
        HEIGHT as u32,
        y_start,
        y_end,
        &XYZ_TO_REC709,
    )
}

/// Render rows of a square radial slice at the requested backing resolution.
/// The frontend uses this for responsive slider previews and the fixed-size
/// `render_rows` wrapper for settled 512x512 slices.
#[wasm_bindgen]
pub fn render_rows_scaled(
    profile: u32,
    reflectance: f64,
    width: u32,
    height: u32,
    y_start: u32,
    y_end: u32,
) -> Vec<u8> {
    render_rows_inner(
        profile,
        reflectance,
        width,
        height,
        y_start,
        y_end,
        &XYZ_TO_P3,
    )
}

/// Render rows of a square radial slice at the requested backing resolution
/// as sRGB RGBA bytes.
#[wasm_bindgen]
pub fn render_rows_scaled_srgb(
    profile: u32,
    reflectance: f64,
    width: u32,
    height: u32,
    y_start: u32,
    y_end: u32,
) -> Vec<u8> {
    render_rows_inner(
        profile,
        reflectance,
        width,
        height,
        y_start,
        y_end,
        &XYZ_TO_REC709,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_j_hk_is_monotonic() {
        let m = model();
        let values = [0.0, 0.01, 0.1, 0.5, 1.0];
        let mut previous = 0.0;
        for value in values {
            let current = neutral_j_hk(m, 0, value);
            assert!(current >= previous);
            previous = current;
        }
    }

    #[test]
    fn neutral_j_hk_uses_the_forward_rendered_acescg_neutral() {
        let m = model();
        for profile in 0..3 {
            for reflectance in [0.0, 0.5, 1.0, REFLECTANCE_MAX] {
                let expected = attributes(m, transform_from_acescg(profile, [reflectance; 3])).3;
                assert!((neutral_j_hk(m, profile, reflectance) - expected).abs() < 1.0e-12);
            }
        }
    }

    #[test]
    fn profile_refl_solves_unit_acescg_white() {
        let m = model();
        for profile in 0..3 {
            let rendered = transform_from_acescg(profile, [1.0; 3]);
            let j_hk = attributes(m, rendered).3;
            let (reflectance, exact) = solve_neutral_reflectance_for_j_hk(m, profile, j_hk);
            assert!(exact, "profile={profile}");
            assert!((neutral_j_hk(m, profile, reflectance) - j_hk).abs() < 1.0e-10);
        }
    }

    #[test]
    fn neutral_refl_round_trips_through_the_profile() {
        let values = evaluate(0, 0.858, 0.0, 0.0);
        assert!(values[0] > 0.5);
        assert!((values[2] - 0.858).abs() < 2.0e-5);
        assert!((values[3] - 0.858).abs() < 2.0e-5);
        assert!((values[4] - 0.858).abs() < 2.0e-5);
        assert!((values[5] - 0.90996).abs() < 2.0e-4);
        assert!((values[6] - 0.90996).abs() < 2.0e-4);
        assert!((values[7] - 0.90996).abs() < 2.0e-4);
    }

    #[test]
    fn evaluated_forward_color_matches_the_neutral_j_hk_target() {
        let m = model();
        for profile in 0..3 {
            for (reflectance, hue, saturation) in [(0.2, 15.0, 5.0), (0.5, 120.0, 30.0)] {
                let values = evaluate(profile, reflectance, hue, saturation);
                assert!(values[0] > 0.5, "profile={profile}");
                let acescg = [values[2], values[3], values[4]];
                let rendered = transform_from_acescg(profile, acescg);
                let actual = attributes(m, rendered).3;
                let expected = neutral_j_hk(m, profile, reflectance);
                assert!((actual - expected).abs() < 2.0e-5, "profile={profile}");
            }
        }
    }

    #[test]
    fn readouts_are_unit_bounded_when_refl_exceeds_unity() {
        let yellow = &colorchecker_points(1)[15 * 10..16 * 10];
        assert!((0.0..=REFLECTANCE_MAX).contains(&yellow[2]));
        let values = evaluate(1, yellow[2], yellow[0], yellow[1]);
        assert!(values[0] > 0.5);
        assert!(values[2..5]
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value)));

        let values = evaluate(1, REFLECTANCE_MAX, 0.0, 0.0);
        assert!(values[0] <= 0.5);
        assert!(values[2..5]
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value)));
    }

    #[test]
    fn colorchecker_points_are_absolute_acescg_references_for_each_profile() {
        let m = model();
        for profile in 0..3 {
            let points = colorchecker_points(profile);
            assert_eq!(points.len(), 18 * 10);
            for (index, record) in points.chunks_exact(10).enumerate() {
                assert!(record[..9].iter().all(|value| value.is_finite()));
                assert!((0.0..360.0).contains(&record[0]));
                assert!(record[1] >= 0.0);
                assert!(
                    (0.0..=REFLECTANCE_MAX).contains(&record[2]),
                    "profile={profile} patch={index} refl={}",
                    record[2]
                );
                assert!(record[3..9].iter().all(|value| (0.0..=1.0).contains(value)));
                assert!(record[9] == 0.0 || record[9] == 1.0);

                let xyz_d50 = lab_d50_to_xyz(COLORCHECKER_LAB_D50[index]);
                let xyz_d65 = mat(&D50_TO_D65_CAT02, xyz_d50);
                let target = mat(&XYZ_D65_TO_ACESCG, xyz_d65);
                let rendered = transform_from_acescg(profile, target);
                let (_, chroma, hue, j_hk) = attributes(m, rendered);
                let expected_saturation = 100.0 * HK_COEFFICIENT * chroma / (j_hk * j_hk);
                assert!((record[0] - hue.rem_euclid(360.0)).abs() < 2.0e-8);
                assert!((record[1] - expected_saturation).abs() < 2.0e-8);
                let expected_refl = solve_neutral_reflectance_for_j_hk(m, profile, j_hk).0;
                assert!((record[2] - expected_refl).abs() < 2.0e-8);
                let expected_p3 = display_xyz_f64(rendered, &XYZ_TO_P3);
                let expected_srgb = display_xyz_f64(rendered, &XYZ_TO_REC709);
                for channel in 0..3 {
                    assert!((record[3 + channel] - expected_p3[channel]).abs() < 2.0e-12);
                    assert!((record[6 + channel] - expected_srgb[channel]).abs() < 2.0e-12);
                }
            }
        }
    }

    #[test]
    fn absolute_reference_coordinates_reconstruct_a_reachable_target() {
        let m = model();
        let target = [0.3, 0.4, 0.5];
        for profile in 0..3 {
            let record = colorchecker_record_from_acescg(m, profile, target);
            assert!(record[..9].iter().all(|value| value.is_finite()));
            let rendered = transform_from_acescg(profile, target);
            let source_rgb = xyz_to_source(profile, rendered);
            if !source_cone_valid(profile, source_rgb, rendered) {
                assert_eq!(record[9], 0.0);
                continue;
            }
            let expected_refl =
                solve_neutral_reflectance_for_j_hk(m, profile, attributes(m, rendered).3).0;
            assert!((record[2] - expected_refl).abs() < 2.0e-8);
        }
    }

    #[test]
    fn unavailable_colorchecker_reference_keeps_its_visible_forward_color() {
        let points = colorchecker_points(0);
        let cyan = &points[17 * 10..18 * 10];
        assert_eq!(cyan[9], 0.0);
        assert!(cyan[..9].iter().all(|value| value.is_finite()));
        assert!(cyan[3..9].iter().any(|value| *value > 0.0));
    }

    #[test]
    fn center_pixel_is_valid_black_or_neutral() {
        let center_row = HEIGHT / 2;
        let bytes = render_rows(0, 0.5, (center_row - 1) as u32, (center_row + 1) as u32);
        let center = (WIDTH + WIDTH / 2) * 4;
        assert_eq!(bytes.len(), 2 * WIDTH * 4);
        assert!(bytes[center..center + 3].iter().any(|value| *value > 0));
    }

    #[test]
    fn rendered_rows_change_with_reflectance() {
        let center_row = HEIGHT / 2;
        let dark = render_rows(0, 0.2, (center_row - 1) as u32, (center_row + 1) as u32);
        let light = render_rows(0, 0.8, (center_row - 1) as u32, (center_row + 1) as u32);
        assert_ne!(dark, light);
    }

    #[test]
    fn scaled_render_rows_use_requested_dimensions() {
        let full = render_rows_scaled(0, 0.5, 64, 64, 0, 64);
        let partial = render_rows_scaled_srgb(1, 0.5, 64, 64, 31, 33);
        assert_eq!(full.len(), 64 * 64 * 4);
        assert_eq!(partial.len(), 2 * 64 * 4);
    }

    #[test]
    fn evaluate_reports_display_p3_and_srgb_encodings() {
        let values = evaluate(0, 0.5, 120.0, 30.0);
        assert_eq!(values.len(), 24);
        assert!(values[8..11]
            .iter()
            .zip(values[14..17].iter())
            .any(|(p3, srgb)| (p3 - srgb).abs() > 1.0e-4));
    }

    #[test]
    fn preview_uses_source_color_across_profiles() {
        // The same Refl/Hue/Sat controls describe different source colors when
        // the source gamut and inverse view profile change.
        let hdr = evaluate(0, 0.25, 120.0, 30.0);
        let sdr = evaluate(1, 0.25, 120.0, 30.0);
        assert!(hdr[0] > 0.5 && sdr[0] > 0.5);
        assert!(hdr[2..5]
            .iter()
            .zip(sdr[2..5].iter())
            .any(|(left, right)| (left - right).abs() > 1.0e-3));
        assert!(hdr[8..11]
            .iter()
            .zip(sdr[8..11].iter())
            .any(|(left, right)| (left - right).abs() > 1.0e-3));
        assert!(hdr[14..17]
            .iter()
            .zip(sdr[14..17].iter())
            .any(|(left, right)| (left - right).abs() > 1.0e-3));
    }

    #[test]
    fn unavailable_render_pixels_are_black() {
        // A non-finite requested ACEScg neutral is unavailable.
        let center_row = HEIGHT / 2;
        let bytes = render_rows_srgb(
            1,
            f64::NAN,
            (center_row - 1) as u32,
            (center_row + 1) as u32,
        );
        let center = (WIDTH + WIDTH / 2) * 4;
        assert_eq!(&bytes[center..center + 4], &[0, 0, 0, 255]);
    }

    #[test]
    fn acescg_srgb_set_round_trips_to_slider_coordinates() {
        let values = evaluate(0, 0.5, 120.0, 30.0);
        let set = set_from_acescg_srgb(0, values[20], values[21], values[22]);
        assert_eq!(set.len(), 4);
        assert!(set[0] > 0.5);
        let m = model();
        let target = [
            decode_srgb(values[20]),
            decode_srgb(values[21]),
            decode_srgb(values[22]),
        ];
        let rendered = transform_from_acescg(0, target);
        let expected_refl = solve_neutral_reflectance_for_j_hk(m, 0, attributes(m, rendered).3).0;
        assert!((set[1] - expected_refl).abs() < 1.0e-4);
        assert!((set[2] - 120.0).abs() < 1.0e-4);
        assert!((set[3] - 30.0).abs() < 1.0e-4);
    }

    #[test]
    fn profile_conversion_coordinates_solve_target_refl() {
        let source = evaluate(2, 0.5, 120.0, 30.0);
        assert!(source[0] > 0.5);
        let m = model();
        let acescg = [
            decode_srgb(source[20]),
            decode_srgb(source[21]),
            decode_srgb(source[22]),
        ];

        for profile in 0..3 {
            let coordinates =
                set_profile_from_acescg_srgb(profile, 0.5, source[20], source[21], source[22]);
            let rendered = transform_from_acescg(profile, acescg);
            let expected =
                solve_neutral_reflectance_for_j_hk(m, profile, attributes(m, rendered).3).0;
            assert!(
                (coordinates[1] - expected).abs() < 1.0e-6,
                "profile={profile}"
            );
            assert!(coordinates[2].is_finite() && coordinates[3].is_finite());
        }
    }

    #[test]
    fn profile_conversion_uses_finite_boundary_for_unreachable_j_hk() {
        let mut found = false;
        'states: for source_profile in 0..3 {
            for reflectance in [0.2, 0.5, 0.8, 1.0] {
                for hue in (0..360).step_by(15) {
                    for saturation in [15.0, 30.0, 50.0, 75.0, 100.0] {
                        let source = evaluate(source_profile, reflectance, hue as f64, saturation);
                        if source[0] <= 0.5 {
                            continue;
                        }
                        for target_profile in 0..3 {
                            let coordinates = set_profile_from_acescg_srgb(
                                target_profile,
                                reflectance,
                                source[20],
                                source[21],
                                source[22],
                            );
                            assert!(coordinates[1].is_finite());
                            assert!((0.0..=REFLECTANCE_MAX).contains(&coordinates[1]));
                            assert!(coordinates[2].is_finite() && coordinates[3].is_finite());
                            if coordinates[0] <= 0.5 {
                                assert!(coordinates[1] == 0.0 || coordinates[1] == REFLECTANCE_MAX);
                                found = true;
                                break 'states;
                            }
                        }
                    }
                }
            }
        }
        assert!(found, "test state should exercise an unreachable target");
    }

    #[test]
    fn profile_conversion_matches_absolute_reference_hue_and_saturation() {
        let m = model();
        for profile in 0..3 {
            for lab in COLORCHECKER_LAB_D50 {
                let xyz_d50 = lab_d50_to_xyz(lab);
                let xyz_d65 = mat(&D50_TO_D65_CAT02, xyz_d50);
                let target = mat(&XYZ_D65_TO_ACESCG, xyz_d65);
                let encoded = encode_display_rgb(target);
                let coordinates =
                    set_profile_from_acescg_srgb(profile, 0.5, encoded[0], encoded[1], encoded[2]);
                let reference = colorchecker_record_from_acescg(m, profile, target);
                assert!((coordinates[1] - reference[2]).abs() < 2.0e-8);
                assert!((coordinates[2] - reference[0]).abs() < 2.0e-8);
                assert!((coordinates[3] - reference[1]).abs() < 2.0e-8);
            }
        }
    }

    #[test]
    fn background_snap_is_the_forward_view_neutral() {
        for profile in 0..3 {
            let values = evaluate(profile, 0.5, 120.0, 30.0);
            let expected = forward_acescg_neutral(profile, 0.5).expect("neutral view output");
            assert!((values[23] - expected).abs() < 1.0e-12);
        }
    }

    #[test]
    fn background_profile_conversion_uses_exact_transforms() {
        for source_neutral in [0.0, 0.5, 1.0] {
            for source_profile in [0, 1, 2, 3] {
                for target_profile in [0, 1, 2, 3] {
                    let converted =
                        convert_neutral_profile(source_profile, target_profile, source_neutral);
                    assert!(converted[0] > 0.5);
                    let source_xyz = source_to_xyz(source_profile, [source_neutral; 3]);
                    let acescg = if source_profile == 3 && target_profile != 3 {
                        srgb_to_acescg([source_neutral; 3])
                    } else {
                        transform_to_acescg(source_profile, source_xyz)
                    };
                    let target_xyz = if target_profile == 3 && source_profile != 3 {
                        acescg_to_srgb_xyz(acescg)
                    } else {
                        transform_from_acescg(target_profile, acescg)
                    };
                    let expected = neutral_scalar(xyz_to_source(target_profile, target_xyz))
                        .expect("neutral target");
                    assert!((converted[1] - expected.clamp(0.0, BACKGROUND_MAX)).abs() < 1.0e-12);
                }
            }
        }
    }

    #[test]
    fn background_conversion_tracks_target_foreground_snap_point() {
        let light_skin = &colorchecker_points(3)[10..13];
        let source = evaluate(3, light_skin[2], light_skin[0], light_skin[1]);
        let target_coordinates = set_profile_from_output_srgb_converted(
            2,
            light_skin[2],
            source[14],
            source[15],
            source[16],
        );
        let target = evaluate(
            2,
            target_coordinates[1],
            target_coordinates[2],
            target_coordinates[3],
        );
        let converted = convert_background_profile(
            3,
            2,
            source[23],
            light_skin[2],
            source[14],
            source[15],
            source[16],
        );
        assert!(converted[0] > 0.5);
        assert!((converted[1] - target[23]).abs() < 2.0e-5);
    }

    #[test]
    fn background_conversion_accepts_zero_boundary() {
        let source = evaluate(
            3,
            0.14775534710139587,
            39.25784549124876,
            26.203829648600536,
        );
        for profile in 0..4 {
            let converted = convert_background_profile(
                3,
                profile,
                0.0,
                0.14775534710139587,
                source[14],
                source[15],
                source[16],
            );
            assert!(converted[0] > 0.5, "profile={profile}");
            assert!(converted[1].is_finite(), "profile={profile}");
            assert!(
                (0.0..=BACKGROUND_MAX).contains(&converted[1]),
                "profile={profile}"
            );
        }
    }

    #[test]
    fn maximum_saturation_is_bounded() {
        let value = maximum_saturation(0, 0.5, 120.0);
        assert!(value.is_finite());
        assert!((0.0..=100.0).contains(&value));
    }

    #[test]
    fn rec709_profile_uses_its_source_matrix_and_transform() {
        let p3 = evaluate(0, 0.2, 120.0, 10.0);
        let rec709 = evaluate(1, 0.2, 120.0, 10.0);
        assert_eq!(rec709.len(), 24);
        assert!(p3[2..5]
            .iter()
            .zip(rec709[2..5].iter())
            .any(|(left, right)| (left - right).abs() > 1.0e-4));
        assert!(rec709[5..8].iter().all(|value| value.is_finite()));
    }

    #[test]
    fn rec709_neutral_uses_exact_aces2_forward_inverse() {
        let values = evaluate(1, 0.456, 0.0, 0.0);
        assert!(values[0] > 0.5);
        for value in &values[2..5] {
            assert!((*value - 0.456).abs() < 2.0e-5, "ACEScg channel={value}");
        }
        let set = set_from_acescg_srgb(1, values[20], values[21], values[22]);
        assert!(set[0] > 0.5);
        assert!((set[1] - 0.456).abs() < 1.0e-4);
        assert!(set[3].abs() < 1.0e-4);
    }

    #[test]
    fn rec2020_limited_profile_enforces_source_cone() {
        let xyz = mat(&P3_TO_XYZ, [1.0, 0.0, 0.0]);
        let p3_rgb = mat(&XYZ_TO_P3, xyz);
        let rec2020_rgb = mat(&XYZ_TO_REC2020, xyz);
        assert!(min3(p3_rgb) >= -1.0e-6);
        assert!(min3(rec2020_rgb) < -1.0e-6);
        assert!(!source_cone_valid(0, p3_rgb, xyz));
        assert!(source_cone_valid(2, p3_rgb, xyz));
    }

    #[test]
    fn hdr_profiles_have_stable_source_limits_at_neutral_hue() {
        let p3_max = maximum_saturation(2, 0.5, 0.0);
        let rec2020_max = maximum_saturation(0, 0.5, 0.0);
        assert!(p3_max.is_finite() && rec2020_max.is_finite());
        assert!((p3_max - rec2020_max).abs() < 5.0e-4);
    }

    #[test]
    fn direct_srgb_profile_is_one_to_one_for_neutral_output() {
        let values = evaluate(3, 0.5, 0.0, 0.0);
        assert!(values[0] > 0.5);
        assert!(values[5..8]
            .iter()
            .all(|value| (*value - 0.5).abs() < 2.0e-6));
        assert!(values[2..5]
            .iter()
            .all(|value| (*value - 0.5).abs() < 2.0e-6));
        let encoded = encode_display_rgb([0.5; 3]);
        for (actual, expected) in values[14..17].iter().zip(encoded) {
            assert!((*actual - expected).abs() < 2.0e-6);
        }
        let set = set_from_output_srgb(3, encoded[0], encoded[1], encoded[2]);
        assert!(set[0] > 0.5);
        assert!((set[1] - 0.5).abs() < 2.0e-5);
        assert!(set[3].abs() < 2.0e-5);
    }

    #[test]
    fn direct_srgb_profile_clamps_out_of_cube_samples() {
        let values = evaluate(3, 0.5, 0.0, 100.0);
        assert!(values[14..17]
            .iter()
            .all(|value| (0.0..=1.0).contains(value)));
        let set = set_profile_from_output_srgb(3, values[14], values[15], values[16]);
        assert!(set[0] > 0.5);
        assert!((0.0..=100.0).contains(&set[3]));
    }

    #[test]
    fn aces_profile_conversion_solves_coordinates_for_same_acescg_value() {
        let source = evaluate(2, 0.5, 120.0, 10.0);
        let coordinates =
            set_profile_from_acescg_srgb_converted(1, 0.5, source[20], source[21], source[22]);
        assert!(coordinates[0] > 0.5);
        assert!((coordinates[1] - 0.5269).abs() < 0.01);
        let target = evaluate(1, coordinates[1], coordinates[2], coordinates[3]);
        for channel in 0..3 {
            assert!((target[2 + channel] - source[2 + channel]).abs() < 4.0e-4);
        }
    }

    #[test]
    fn profile_conversion_accepts_a_representable_neutral_state() {
        let source = evaluate(2, 0.5, 0.0, 0.0);
        let coordinates =
            set_profile_from_acescg_srgb_converted(1, 0.5, source[20], source[21], source[22]);
        assert!(coordinates[0] > 0.5);
        assert!((coordinates[1] - 0.5).abs() < 1.0e-3);
        assert!(coordinates[3].abs() < 1.0e-5);
    }

    #[test]
    fn direct_srgb_refl_is_the_linear_srgb_neutral_j_hk_target() {
        let m = model();
        for reflectance in [0.05, 0.5, 1.0] {
            let expected = attributes(m, source_to_xyz(3, [reflectance; 3])).3;
            assert!((neutral_j_hk(m, 3, reflectance) - expected).abs() < 1.0e-12);
            let values = evaluate(3, reflectance, 127.0, 0.0);
            assert!(values[0] > 0.5);
            for channel in &values[2..5] {
                assert!((*channel - reflectance).abs() < 2.0e-5);
            }
        }
    }

    #[test]
    fn aces_to_srgb_switch_uses_the_rec709_100nit_view() {
        // Use an in-gamut ACEScg value whose SDR-view result is visibly
        // different from a direct ACEScg-to-XYZ conversion.
        let source = [0.3, 0.4, 0.2];
        let encoded = encode_display_rgb(source);
        let coordinates =
            set_profile_from_acescg_srgb_converted(3, 0.5, encoded[0], encoded[1], encoded[2]);
        assert!(coordinates[0] > 0.5);
        let values = evaluate(3, coordinates[1], coordinates[2], coordinates[3]);
        let retained = [
            decode_srgb(encoded[0]),
            decode_srgb(encoded[1]),
            decode_srgb(encoded[2]),
        ];
        let expected_xyz = acescg_to_srgb_xyz(retained);
        let expected_rgb = xyz_to_source(3, expected_xyz);
        for channel in 0..3 {
            assert!((values[5 + channel] - expected_rgb[channel]).abs() < 2.0e-5);
        }
        let direct_xyz = mat(&ACESCG_TO_XYZ_D65, retained);
        let direct_rgb = xyz_to_source(3, direct_xyz);
        assert!(
            max3([
                (expected_rgb[0] - direct_rgb[0]).abs(),
                (expected_rgb[1] - direct_rgb[1]).abs(),
                (expected_rgb[2] - direct_rgb[2]).abs(),
            ]) > 1.0e-3
        );
    }

    #[test]
    fn srgb_to_aces_switch_uses_the_inverse_rec709_100nit_view() {
        let linear = [0.1, 0.2, 0.3];
        let encoded = encode_display_rgb(linear);
        let acescg = srgb_to_acescg(linear);
        for profile in 0..3 {
            let coordinates = set_profile_from_output_srgb_converted(
                profile, 0.5, encoded[0], encoded[1], encoded[2],
            );
            assert!(coordinates[0] > 0.5, "profile={profile}");
            let values = evaluate(profile, coordinates[1], coordinates[2], coordinates[3]);
            let expected_xyz = transform_from_acescg(profile, acescg);
            let expected_rgb = xyz_to_source(profile, expected_xyz);
            for channel in 0..3 {
                assert!(
                    (values[5 + channel] - expected_rgb[channel]).abs() < 2.0e-5,
                    "profile={profile} channel={channel}"
                );
            }
        }
    }

    #[test]
    fn srgb_to_aces_switch_reports_out_of_range_readout_as_unavailable() {
        // Neutral 0.5 linear sRGB maps above the ACEScg unit cube through the
        // inverse Rec.709 view. The profile switch still returns finite
        // boundary slider values, while evaluation exposes its unavailable
        // state and clamps the readout to the unit interval.
        let encoded = encode_display_rgb([0.5; 3]);
        for profile in 0..3 {
            let coordinates = set_profile_from_output_srgb_converted(
                profile, 0.5, encoded[0], encoded[1], encoded[2],
            );
            assert!(coordinates[1..4].iter().all(|value| value.is_finite()));
            assert!((0.0..=REFLECTANCE_MAX).contains(&coordinates[1]));
            assert!((0.0..=360.0).contains(&coordinates[2]));
            assert!((0.0..=100.0).contains(&coordinates[3]));
            assert!(coordinates[0] <= 0.5, "profile={profile}");
            let values = evaluate(profile, coordinates[1], coordinates[2], coordinates[3]);
            assert!(values[0] <= 0.5, "profile={profile}");
            assert!(values[2..5]
                .iter()
                .all(|value| value.is_finite() && (0.0..=1.0).contains(value)));
        }
    }

    #[test]
    fn linear_readouts_are_unit_bounded_when_colors_are_unavailable() {
        let direct = evaluate(3, REFLECTANCE_MAX, 0.0, 0.0);
        assert!(direct[0] <= 0.5);
        assert!(direct[2..5]
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value)));
        for profile in 0..3 {
            let values = evaluate(profile, REFLECTANCE_MAX, 0.0, 0.0);
            assert!(values[0] <= 0.5, "profile={profile}");
            assert!(values[2..5]
                .iter()
                .all(|value| value.is_finite() && (0.0..=1.0).contains(value)));
        }
    }

    #[test]
    fn p3_hdr_inverse_matches_ocio_reference_sample() {
        let acescg = transform_to_acescg(2, [0.1, 0.1, 0.1]);
        let expected = [0.14822204, 0.13269136, 0.12742696];
        for (actual, reference) in acescg.iter().zip(expected.iter()) {
            assert!(
                (actual - reference).abs() < 2.0e-6,
                "actual={actual}, reference={reference}"
            );
        }
    }
}
