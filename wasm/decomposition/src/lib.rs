//! Browser worker API for image decomposition.
//!
//! The API is intentionally coarse grained: a worker sends one byte buffer and
//! receives a self contained report and two OpenEXR buffers.  Codec metadata is
//! inspected before the caller supplies the explicit gamut and transfer values;
//! this keeps the no-guessing rule in the data model rather than in the UI.

use exr::{
    image::{AnyChannel, AnyChannels, FlatSamples, Image, Layer},
    meta::{
        attribute::{AttributeValue, Chromaticities, Text},
        header::{ImageAttributes, LayerAttributes},
    },
    prelude::{Encoding, ReadChannels, ReadLayers, Vec2, WritableImage},
};
use half::f16;
use image::{codecs::jpeg::JpegEncoder as ImageJpegEncoder, ExtendedColorType, ImageEncoder as _};
use jpeg_decoder::{Decoder as JpegDecoder, PixelFormat};
use js_sys::{Float32Array, Object, Reflect, Uint8Array};
use png::{Decoder as PngDecoder, Transformations};
use rawler::{
    cfa::{PlaneColor, CFA},
    imgop::{Dim2, Point, Rect},
};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::OnceLock;
use ultrahdr_core::metadata::apple::{from_apple_headroom, parse_exif_for_apple_hdr};
use wasm_bindgen::prelude::*;

mod gpu;
mod preview_display;

// Emit the panic reason/location before wasm32 turns it into an opaque
// `unreachable` trap. The worker console bridge preserves this and the JS stack.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn log_panic(message: &str, error: &js_sys::Error);
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(start)]
pub fn install_panic_diagnostics() {
    std::panic::set_hook(Box::new(|info| {
        log_panic(
            &format!("Rust/WASM panic: {info}"),
            &js_sys::Error::new("Rust/WASM panic stack"),
        );
    }));
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod gpu_host_tests;

const EXPOSURE_MIN: f32 = -10.0;
const EXPOSURE_MAX: f32 = 10.0;
const AP0_TO_AP1: [[f32; 3]; 3] = [
    [1.4514393, -0.23651075, -0.21492857],
    [-0.07655377, 1.1762297, -0.09967593],
    [0.008316148, -0.00603245, 0.9977163],
];
const AP1_TO_AP0: [[f32; 3]; 3] = [
    [0.69545224, 0.1406787, 0.16386907],
    [0.04479456, 0.8596711, 0.09553432],
    [-0.005525883, 0.00402521, 1.0015007],
];
const SRGB_TO_XYZ: [[f32; 3]; 3] = [
    [0.4123908, 0.35758433, 0.18048096],
    [0.212639, 0.7151687, 0.07219232],
    [0.01933082, 0.11919478, 0.95053214],
];
const P3_TO_XYZ: [[f32; 3]; 3] = [
    [0.48657095, 0.26566768, 0.19821729],
    [0.22897457, 0.69173855, 0.07928691],
    [0.0, 0.04511338, 1.0439444],
];
const REC2020_TO_XYZ: [[f32; 3]; 3] = [
    [0.63695806, 0.1446169, 0.16888098],
    [0.2627002, 0.67799807, 0.05930172],
    [0.0, 0.02807269, 1.060985],
];
const ADOBE_RGB_TO_XYZ: [[f32; 3]; 3] = [
    [0.576669, 0.185558, 0.188229],
    [0.297345, 0.627364, 0.075291],
    [0.027031, 0.070689, 0.991338],
];
const D50_TO_D65_CAT02: [[f32; 3]; 3] = [
    [0.9599086, -0.02931107, 0.06569604],
    [-0.02119125, 0.99885744, 0.02614608],
    [0.001371287, 0.0044387075, 1.3127874],
];
const D50_WHITE: [f32; 3] = [0.96422, 1.0, 0.82521];
#[cfg(test)]
const D65_WHITE: [f32; 3] = [0.9504559, 1.0, 1.0890578];
// Inverse of the ACES AP0 (D60) to CIE XYZ D65 BFD matrix from the bundled
// OCIO configuration.  Keeping the D65 adaptation in this matrix means DNG
// and ordinary D65 RGB sources share the same AP0 scene-reference contract.
const XYZ_D65_TO_AP0: [[f32; 3]; 3] = [
    [1.0634955, 0.00640891, -0.01580679],
    [-0.49207413, 1.3682234, 0.09133709],
    [-0.00281646, 0.00464417, 0.91641857],
];
const BRADFORD: [[f32; 3]; 3] = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INVERSE: [[f32; 3]; 3] = [
    [0.9869929, -0.1470543, 0.1599627],
    [0.4323053, 0.5183603, 0.0492912],
    [-0.0085287, 0.0400428, 0.9684867],
];
const XYZ_TO_P3: [[f32; 3]; 3] = [
    [2.493496911941425, -0.931383617919124, -0.402710784450717],
    [-0.829488969561575, 1.762664060318347, 0.023624685841944],
    [0.035845830243784, -0.076172389268042, 0.956884524007687],
];
static P3_D65_ICC: OnceLock<&'static [u8]> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
pub struct DecodeSummary {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub gamut: Option<String>,
    pub transfer: Option<String>,
    pub metadata_source: Option<String>,
    pub automatic_icc: bool,
    pub embedded_available: bool,
    #[serde(default)]
    pub orientation: Option<u16>,
    #[serde(default)]
    pub camera_model: Option<String>,
    #[serde(default)]
    pub photometry: Option<String>,
    #[serde(default)]
    pub bit_depth: Option<u16>,
    #[serde(default)]
    pub compression: Option<String>,
    #[serde(default)]
    pub dng_transform: Option<DngTransformDiagnostics>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DngTransformDiagnostics {
    pub color_matrix_first_weight: f32,
    pub forward_matrix_used: bool,
    pub as_shot_neutral: [f32; 3],
    pub white_balance_multipliers: [f32; 3],
    pub source_white_xyz: [f32; 3],
    pub raw_sample_range: [f32; 2],
    pub normalized_sample_range: [f32; 2],
    pub demosaiced_rgb_range: [[f32; 3]; 2],
    pub post_vignette_rgb_range: [[f32; 3]; 2],
    pub final_ap0_range: [[f32; 3]; 2],
    pub representative_camera_rgb: [[f32; 3]; 3],
    pub representative_ap0: [[f32; 3]; 3],
    pub camera_to_xyz_d50: [[f32; 3]; 3],
    pub cat02_d50_to_d65: [[f32; 3]; 3],
    pub camera_to_d65: [[f32; 3]; 3],
    pub camera_to_ap0: [[f32; 3]; 3],
    pub white_balance_integrated: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub format: String,
    pub gamut: Option<String>,
    pub transfer: Option<String>,
    pub profile: u32,
    pub refl: f32,
    pub blur_sigma: f32,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Report {
    pub width: u32,
    pub height: u32,
    pub pixel_count: u64,
    pub profile: u32,
    pub refl: f32,
    pub blur_sigma: f32,
    pub projected_pixels: u64,
    pub clipped_pixels: u64,
    pub non_finite_pixels: u64,
    pub exposure_min: f32,
    pub exposure_max: f32,
    pub exposure_mean: f32,
    pub base_min: f32,
    pub base_max: f32,
    pub base_mean: f32,
    pub target_j_hk: f32,
    pub solver_status: String,
    pub compute_backend: String,
    pub gpu_adapter: Option<String>,
    pub gpu_validation: Option<String>,
    pub batch_size: u32,
    pub preview_transform: String,
    pub preview_encoding: String,
    pub preview_backend: String,
    pub preview_transform_ms: f32,
    pub warnings: Vec<String>,
}

struct Pixels {
    width: usize,
    height: usize,
    rgb: Vec<[f32; 3]>,
    summary: DecodeSummary,
    icc_profile: Option<Vec<u8>>,
}

#[cfg(test)]
fn dng_demosaic(
    raw: &[f32],
    width: usize,
    height: usize,
    pattern: &[u8],
    _repeat: (usize, usize),
) -> Vec<[f32; 3]> {
    let cfa_string = pattern
        .iter()
        .map(|c| match c {
            0 => 'R',
            1 => 'G',
            2 => 'B',
            _ => 'U',
        })
        .collect::<String>();
    let cfa = CFA::new(&cfa_string);
    let colors = rawler::cfa::PlaneColor::new("RGB");
    demosaic_bayer(raw, width, height, &cfa, &colors, (0, 0)).expect("valid Bayer fixture")
}

#[inline]
fn ppg_hue_transit(l1: f32, l2: f32, l3: f32, v1: f32, v3: f32) -> f32 {
    if (l1 < l2 && l2 < l3) || (l1 > l2 && l2 > l3) {
        v1 + (v3 - v1) * (l2 - l1) / (l3 - l1)
    } else {
        (v1 + v3) / 2.0 + (l2 * 2.0 - l1 - l3) / 4.0
    }
}

/// WASM-safe PPG demosaicing. rawler's PPG implementation calls
/// `std::time::Instant::now()`, which traps on the `wasm32-unknown-unknown`
/// target used by the browser worker. Keep the same four interpolation stages
/// here while leaving timing to the worker checkpoint log.
fn demosaic_bayer(
    raw: &[f32],
    width: usize,
    height: usize,
    cfa: &CFA,
    colors: &PlaneColor,
    origin: (usize, usize),
) -> Result<Vec<[f32; 3]>, String> {
    if width == 0 || height == 0 || raw.len() != width.saturating_mul(height) {
        return Err("DNG Bayer sample dimensions do not match.".into());
    }
    if !cfa.is_rgb() || cfa.width != 2 || cfa.height != 2 {
        return Err("DNG Bayer CFA must be a 2x2 RGB pattern.".into());
    }
    let lookup = colors.plane_lookup_table();
    let mut pattern = [[0usize; 2]; 2];
    for y in 0..2 {
        for x in 0..2 {
            let plane = lookup[cfa.color_at(origin.1 + y, origin.0 + x)];
            if plane >= 3 {
                return Err("DNG Bayer CFA has an invalid RGB plane mapping.".into());
            }
            pattern[y][x] = plane;
        }
    }
    let channel_at = |y: usize, x: usize| pattern[y & 1][x & 1];
    let mut rgb = vec![[0.0_f32; 3]; width * height];
    for y in 0..height {
        for x in 0..width {
            rgb[y * width + x][channel_at(y, x)] = raw[y * width + x];
        }
    }

    // PPG's border pass uses a 3x3 average. Interior pixels are skipped here
    // and filled by the directional stages below, which keeps full-resolution
    // browser development bounded on CPU-only devices.
    let narrow = width < 7 || height < 7;
    for y in 0..height {
        let interior_row = !narrow && y >= 3 && y + 3 < height;
        let x_ranges: &[(usize, usize)] = if interior_row {
            &[(0, 3), (width - 3, width)]
        } else {
            &[(0, width)]
        };
        for &(start, end) in x_ranges {
            for x in start..end {
                let known = channel_at(y, x);
                let mut sums = [0.0_f32; 3];
                let mut counts = [0_u32; 3];
                let y0 = y.saturating_sub(1);
                let y1 = (y + 1).min(height - 1);
                let x0 = x.saturating_sub(1);
                let x1 = (x + 1).min(width - 1);
                for ny in y0..=y1 {
                    for nx in x0..=x1 {
                        let ch = channel_at(ny, nx);
                        sums[ch] += raw[ny * width + nx];
                        counts[ch] += 1;
                    }
                }
                for ch in 0..3 {
                    if ch != known && counts[ch] != 0 {
                        rgb[y * width + x][ch] = sums[ch] / counts[ch] as f32;
                    }
                }
            }
        }
    }

    if !narrow {
        // Interpolate missing green at red/blue photosites using the PPG
        // directional gradient choice.
        for y in 3..height - 3 {
            for x in 3..width - 3 {
                let ch = channel_at(y, x);
                if ch == 1 {
                    continue;
                }
                let pixel = rgb[y * width + x];
                let n1 = rgb[(y - 1) * width + x][1];
                let n2 = rgb[(y - 2) * width + x][ch];
                let e1 = rgb[y * width + x + 1][1];
                let e2 = rgb[y * width + x + 2][ch];
                let s1 = rgb[(y + 1) * width + x][1];
                let s2 = rgb[(y + 2) * width + x][ch];
                let w1 = rgb[y * width + x - 1][1];
                let w2 = rgb[y * width + x - 2][ch];
                let gradients = [
                    (pixel[ch] - n2).abs() * 2.0 + (n1 - s1).abs(),
                    (pixel[ch] - e2).abs() * 2.0 + (w1 - e1).abs(),
                    (pixel[ch] - w2).abs() * 2.0 + (w1 - e1).abs(),
                    (pixel[ch] - s2).abs() * 2.0 + (n1 - s1).abs(),
                ];
                let direction = gradients
                    .iter()
                    .enumerate()
                    .min_by(|a, b| a.1.total_cmp(b.1))
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                rgb[y * width + x][1] = match direction {
                    0 => (n1 * 3.0 + s1 + pixel[ch] - n2) / 4.0,
                    1 => (e1 * 3.0 + w1 + pixel[ch] - e2) / 4.0,
                    2 => (w1 * 3.0 + e1 + pixel[ch] - w2) / 4.0,
                    _ => (s1 * 3.0 + n1 + pixel[ch] - s2) / 4.0,
                };
            }
        }

        // Interpolate red/blue at green photosites from the horizontal and
        // vertical corresponding-color neighbours.
        for y in 3..height - 3 {
            for x in 3..width - 3 {
                if channel_at(y, x) != 1 {
                    continue;
                }
                let horizontal = channel_at(y, x + 1);
                let vertical = channel_at(y + 1, x);
                let green = rgb[y * width + x][1];
                let value_h = ppg_hue_transit(
                    rgb[y * width + x - 1][1],
                    green,
                    rgb[y * width + x + 1][1],
                    rgb[y * width + x - 1][horizontal],
                    rgb[y * width + x + 1][horizontal],
                );
                let value_v = ppg_hue_transit(
                    rgb[(y - 1) * width + x][1],
                    green,
                    rgb[(y + 1) * width + x][1],
                    rgb[(y - 1) * width + x][vertical],
                    rgb[(y + 1) * width + x][vertical],
                );
                rgb[y * width + x][horizontal] = value_h;
                rgb[y * width + x][vertical] = value_v;
            }
        }

        // Interpolate the opposite red/blue channel at red/blue photosites
        // along the lower-gradient diagonal.
        for y in 3..height - 3 {
            for x in 3..width - 3 {
                let x_ch = channel_at(y, x);
                if x_ch == 1 {
                    continue;
                }
                let y_ch = if x_ch == 0 { 2 } else { 0 };
                let ne = (rgb[(y - 1) * width + x + 1][y_ch] - rgb[(y + 1) * width + x - 1][y_ch])
                    .abs()
                    + (rgb[(y - 2) * width + x + 2][x_ch] - rgb[y * width + x][x_ch]).abs()
                    + (rgb[y * width + x][x_ch] - rgb[(y + 2) * width + x - 2][x_ch]).abs()
                    + (rgb[(y - 1) * width + x + 1][1] - rgb[y * width + x][1]).abs()
                    + (rgb[y * width + x][1] - rgb[(y + 1) * width + x - 1][1]).abs();
                let nw = (rgb[(y - 1) * width + x - 1][y_ch] - rgb[(y + 1) * width + x + 1][y_ch])
                    .abs()
                    + (rgb[(y - 2) * width + x - 2][x_ch] - rgb[y * width + x][x_ch]).abs()
                    + (rgb[y * width + x][x_ch] - rgb[(y + 2) * width + x + 2][x_ch]).abs()
                    + (rgb[(y - 1) * width + x - 1][1] - rgb[y * width + x][1]).abs()
                    + (rgb[y * width + x][1] - rgb[(y + 1) * width + x + 1][1]).abs();
                rgb[y * width + x][y_ch] = if ne < nw {
                    ppg_hue_transit(
                        rgb[(y - 1) * width + x + 1][1],
                        rgb[y * width + x][1],
                        rgb[(y + 1) * width + x - 1][1],
                        rgb[(y - 1) * width + x + 1][y_ch],
                        rgb[(y + 1) * width + x - 1][y_ch],
                    )
                } else {
                    ppg_hue_transit(
                        rgb[(y - 1) * width + x - 1][1],
                        rgb[y * width + x][1],
                        rgb[(y + 1) * width + x + 1][1],
                        rgb[(y - 1) * width + x - 1][y_ch],
                        rgb[(y + 1) * width + x + 1][y_ch],
                    )
                };
            }
        }
    }
    Ok(rgb)
}

/// DNG ColorMatrix values are XYZ-to-camera matrices; the small developer below
/// inverts those matrices without imposing an RGB gamut clamp. The existing
/// `XYZ_D65_TO_AP0` matrix includes the D65-to-ACES-D60 adaptation used by the
/// rest of this decomposition module.
fn invert3(m: [[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
    let a = m[0][0];
    let b = m[0][1];
    let c = m[0][2];
    let d = m[1][0];
    let e = m[1][1];
    let f = m[1][2];
    let g = m[2][0];
    let h = m[2][1];
    let i = m[2][2];
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if !det.is_finite() || det.abs() < 1.0e-8 {
        return None;
    }
    let inv = [
        [
            (e * i - f * h) / det,
            (c * h - b * i) / det,
            (b * f - c * e) / det,
        ],
        [
            (f * g - d * i) / det,
            (a * i - c * g) / det,
            (c * d - a * f) / det,
        ],
        [
            (d * h - e * g) / det,
            (b * g - a * h) / det,
            (a * e - b * d) / det,
        ],
    ];
    Some(inv)
}

fn dng_opcode_vignette(
    rgb: &mut [[f32; 3]],
    width: usize,
    height: usize,
    parameters: &[u8],
) -> Result<(), String> {
    if parameters.len() != 56 {
        return Err("DNG FixVignetteRadial has an invalid parameter payload.".into());
    }
    let mut v = [0.0_f64; 7];
    for (n, slot) in v.iter_mut().enumerate() {
        let start = n * 8;
        let bytes: [u8; 8] = parameters[start..start + 8].try_into().unwrap();
        *slot = f64::from_bits(u64::from_be_bytes(bytes));
        if !slot.is_finite() {
            return Err("DNG FixVignetteRadial contains a non-finite coefficient.".into());
        }
    }
    let center_h = v[5] as f32;
    let center_v = v[6] as f32;
    if !(0.0..=1.0).contains(&center_h) || !(0.0..=1.0).contains(&center_v) {
        return Err("DNG FixVignetteRadial center is outside the image.".into());
    }
    // The opcode defines an image-pixel radius m to the farthest corner and
    // evaluates the gain polynomial in r², where r is the pixel distance from
    // the optical center divided by m. Pixel coordinates refer to the image
    // bounds (0 through width/height - 1), rather than pixel-center offsets.
    if width == 0 || height == 0 {
        return Ok(());
    }
    let x1 = (width - 1) as f64;
    let y1 = (height - 1) as f64;
    let cx = center_h as f64 * x1;
    let cy = center_v as f64 * y1;
    let mx = cx.max((x1 - cx).abs());
    let my = cy.max((y1 - cy).abs());
    let radius = (mx * mx + my * my).sqrt();
    if radius <= 0.0 || !radius.is_finite() {
        return Ok(());
    }
    for y in 0..height {
        for x in 0..width {
            let dx = x as f64 - cx;
            let dy = y as f64 - cy;
            let r = (dx * dx + dy * dy).sqrt() / radius;
            let q = r * r;
            let mut q_power = q;
            let mut gain = 1.0_f64;
            for coefficient in v[..5].iter() {
                gain += coefficient * q_power;
                q_power *= q;
            }
            let gain = gain as f32;
            if !gain.is_finite() || gain <= 0.0 {
                return Err("DNG FixVignetteRadial produced an invalid gain.".into());
            }
            for c in 0..3 {
                rgb[y * width + x][c] *= gain;
            }
        }
    }
    Ok(())
}

fn dng_orientation(data: &[u8]) -> u16 {
    if data.len() < 10 {
        return 1;
    }
    let little = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return 1,
    };
    let u16_at = |p: usize| -> Option<u16> {
        let b = data.get(p..p + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |p: usize| -> Option<u32> {
        let b = data.get(p..p + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if u16_at(2) != Some(42) {
        return 1;
    }
    let ifd = u32_at(4).unwrap_or(0) as usize;
    let count = usize::from(u16_at(ifd).unwrap_or(0));
    for n in 0..count {
        let p = ifd.saturating_add(2 + n * 12);
        if u16_at(p) == Some(274) && u16_at(p + 2) == Some(3) && u32_at(p + 4) == Some(1) {
            return u16_at(p + 8).unwrap_or(1).clamp(1, 8);
        }
    }
    1
}

fn rotate_dng(
    rgb: Vec<[f32; 3]>,
    width: usize,
    height: usize,
    orientation: u16,
) -> (Vec<[f32; 3]>, usize, usize) {
    if orientation == 1 {
        return (rgb, width, height);
    }
    let (out_width, out_height) = if matches!(orientation, 5 | 6 | 7 | 8) {
        (height, width)
    } else {
        (width, height)
    };
    let mut out = vec![[0.0; 3]; out_width * out_height];
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = match orientation {
                2 => (width - 1 - x, y),
                3 => (width - 1 - x, height - 1 - y),
                4 => (x, height - 1 - y),
                5 => (y, x),
                6 => (height - 1 - y, x),
                7 => (height - 1 - y, width - 1 - x),
                8 => (y, width - 1 - x),
                _ => (x, y),
            };
            out[dy * out_width + dx] = rgb[y * width + x];
        }
    }
    (out, out_width, out_height)
}

fn tiff_tag_bytes(data: &[u8], target: u16) -> Option<Vec<u8>> {
    if data.len() < 8 {
        return None;
    }
    let little = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |p: usize| -> Option<u16> {
        let b = data.get(p..p + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |p: usize| -> Option<u32> {
        let b = data.get(p..p + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if u16_at(2) != Some(42) {
        return None;
    }
    let mut stack = vec![u32_at(4)? as usize];
    let mut visited = std::collections::HashSet::new();
    while let Some(ifd) = stack.pop() {
        if !visited.insert(ifd) {
            continue;
        }
        let count = usize::from(u16_at(ifd)?);
        for n in 0..count {
            let p = ifd.checked_add(2 + n * 12)?;
            let tag = u16_at(p)?;
            let typ = u16_at(p + 2)?;
            let count = u32_at(p + 4)? as usize;
            let unit = match typ {
                1 | 2 | 6 | 7 => 1,
                3 => 2,
                4 | 9 => 4,
                5 | 10 => 8,
                _ => 0,
            };
            let bytes_len = count.checked_mul(unit)?;
            let inline = bytes_len <= 4;
            let value_pos = if inline {
                p + 8
            } else {
                u32_at(p + 8)? as usize
            };
            if tag == target && typ == 7 {
                let end = value_pos.checked_add(bytes_len)?;
                let value = data.get(value_pos..end)?;
                return Some(value.to_vec());
            }
            if tag == 330 && (typ == 3 || typ == 4) {
                if typ == 3 && bytes_len <= 4 {
                    stack.push(usize::from(u16_at(p + 8)?));
                } else if typ == 4 {
                    for i in 0..count {
                        stack.push(u32_at(value_pos + i * 4)? as usize);
                    }
                }
            }
        }
        if let Some(next) = u32_at(ifd + 2 + count * 12) {
            if next != 0 {
                stack.push(next as usize);
            }
        }
    }
    None
}

fn tiff_tag_type(data: &[u8], target: u16) -> Option<u16> {
    if data.len() < 8 {
        return None;
    }
    let little = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |p: usize| -> Option<u16> {
        let b = data.get(p..p + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |p: usize| -> Option<u32> {
        let b = data.get(p..p + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if u16_at(2) != Some(42) {
        return None;
    }
    let mut stack = vec![u32_at(4)? as usize];
    let mut visited = std::collections::HashSet::new();
    while let Some(ifd) = stack.pop() {
        if !visited.insert(ifd) {
            continue;
        }
        let count = usize::from(u16_at(ifd)?);
        for n in 0..count {
            let p = ifd.checked_add(2 + n * 12)?;
            let tag = u16_at(p)?;
            let typ = u16_at(p + 2)?;
            let value_count = u32_at(p + 4)? as usize;
            let unit = match typ {
                1 | 2 | 6 | 7 => 1,
                3 => 2,
                4 | 9 => 4,
                5 | 10 => 8,
                _ => 0,
            };
            let bytes_len = value_count.checked_mul(unit)?;
            let value_pos = if bytes_len <= 4 {
                p + 8
            } else {
                u32_at(p + 8)? as usize
            };
            if tag == target {
                return Some(typ);
            }
            if tag == 330 && (typ == 3 || typ == 4) {
                if typ == 3 && bytes_len <= 4 {
                    stack.push(usize::from(u16_at(p + 8)?));
                } else if typ == 4 {
                    for i in 0..value_count {
                        stack.push(u32_at(value_pos + i * 4)? as usize);
                    }
                }
            }
        }
        if let Some(next) = u32_at(ifd + 2 + count * 12) {
            if next != 0 {
                stack.push(next as usize);
            }
        }
    }
    None
}

fn tiff_tag_f64(data: &[u8], target: u16) -> Option<f64> {
    if data.len() < 8 {
        return None;
    }
    let little = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |p: usize| -> Option<u16> {
        let b = data.get(p..p + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |p: usize| -> Option<u32> {
        let b = data.get(p..p + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if u16_at(2) != Some(42) {
        return None;
    }
    let mut stack = vec![u32_at(4)? as usize];
    let mut visited = std::collections::HashSet::new();
    while let Some(ifd) = stack.pop() {
        if !visited.insert(ifd) {
            continue;
        }
        let count = usize::from(u16_at(ifd)?);
        for n in 0..count {
            let p = ifd.checked_add(2 + n * 12)?;
            let tag = u16_at(p)?;
            let typ = u16_at(p + 2)?;
            let count = u32_at(p + 4)? as usize;
            let unit = match typ {
                3 => 2,
                4 | 9 => 4,
                5 | 10 => 8,
                _ => 0,
            };
            let bytes_len = count.checked_mul(unit)?;
            let value_pos = if bytes_len <= 4 {
                p + 8
            } else {
                u32_at(p + 8)? as usize
            };
            if tag == target && count > 0 {
                return match typ {
                    5 => {
                        let a = u32_at(value_pos)?;
                        let b = u32_at(value_pos + 4)?;
                        (b != 0).then_some(a as f64 / b as f64)
                    }
                    10 => {
                        let a = u32_at(value_pos)? as i32;
                        let b = u32_at(value_pos + 4)? as i32;
                        (b != 0).then_some(a as f64 / b as f64)
                    }
                    4 => Some(u32_at(value_pos)? as f64),
                    9 => Some(u32_at(value_pos)? as i32 as f64),
                    3 => Some(u16_at(value_pos)? as f64),
                    _ => None,
                };
            }
            if tag == 330 && (typ == 3 || typ == 4) {
                if typ == 3 && bytes_len <= 4 {
                    stack.push(usize::from(u16_at(p + 8)?));
                } else if typ == 4 {
                    for i in 0..count {
                        stack.push(u32_at(value_pos + i * 4)? as usize);
                    }
                }
            }
        }
        if let Some(next) = u32_at(ifd + 2 + count * 12) {
            if next != 0 {
                stack.push(next as usize);
            }
        }
    }
    None
}

/// Read a TIFF/DNG numeric tag as a vector of finite floating-point values.
/// DNG calibration matrices are SRATIONAL arrays, while white balance and
/// exposure tags are commonly RATIONAL or SRATIONAL scalars.  The traversal
/// mirrors the raw IFD search used by rawler and follows SubIFDs so embedded
/// profile tags are found as well.
fn tiff_tag_f64_values(data: &[u8], target: u16) -> Option<Vec<f64>> {
    if data.len() < 8 {
        return None;
    }
    let little = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |p: usize| -> Option<u16> {
        let b = data.get(p..p + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |p: usize| -> Option<u32> {
        let b = data.get(p..p + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if u16_at(2) != Some(42) {
        return None;
    }
    let mut stack = vec![u32_at(4)? as usize];
    let mut visited = std::collections::HashSet::new();
    while let Some(ifd) = stack.pop() {
        if !visited.insert(ifd) {
            continue;
        }
        let count = usize::from(u16_at(ifd)?);
        for n in 0..count {
            let p = ifd.checked_add(2 + n * 12)?;
            let tag = u16_at(p)?;
            let typ = u16_at(p + 2)?;
            let value_count = u32_at(p + 4)? as usize;
            let unit = match typ {
                1 | 2 | 6 | 7 => 1,
                3 => 2,
                4 | 9 | 11 => 4,
                5 | 10 | 12 => 8,
                _ => 0,
            };
            let bytes_len = value_count.checked_mul(unit)?;
            let value_pos = if bytes_len <= 4 {
                p + 8
            } else {
                u32_at(p + 8)? as usize
            };
            if tag == target {
                let mut values = Vec::with_capacity(value_count);
                for index in 0..value_count {
                    let pos = value_pos.checked_add(index.checked_mul(unit)?)?;
                    let value = match typ {
                        3 => u16_at(pos)? as f64,
                        4 => u32_at(pos)? as f64,
                        5 => {
                            let denominator = u32_at(pos + 4)?;
                            if denominator == 0 {
                                return None;
                            }
                            u32_at(pos)? as f64 / denominator as f64
                        }
                        9 => u32_at(pos)? as i32 as f64,
                        10 => {
                            let denominator = u32_at(pos + 4)? as i32;
                            if denominator == 0 {
                                return None;
                            }
                            u32_at(pos)? as i32 as f64 / denominator as f64
                        }
                        11 => f32::from_bits(u32_at(pos)?).into(),
                        12 => {
                            let bytes: [u8; 8] = data.get(pos..pos + 8)?.try_into().ok()?;
                            f64::from_bits(if little {
                                u64::from_le_bytes(bytes)
                            } else {
                                u64::from_be_bytes(bytes)
                            })
                        }
                        _ => return None,
                    };
                    if !value.is_finite() {
                        return None;
                    }
                    values.push(value);
                }
                return Some(values);
            }
            if tag == 330 && (typ == 3 || typ == 4) {
                if typ == 3 && bytes_len <= 4 {
                    stack.push(usize::from(u16_at(p + 8)?));
                } else if typ == 4 {
                    for index in 0..value_count {
                        stack.push(u32_at(value_pos + index * 4)? as usize);
                    }
                }
            }
        }
        if let Some(next) = u32_at(ifd + 2 + count * 12) {
            if next != 0 {
                stack.push(next as usize);
            }
        }
    }
    None
}

fn dng_compression_name(data: &[u8]) -> Option<String> {
    let code = dng_compression_code(data)?;
    Some(
        match code {
            1 => "uncompressed",
            7 => "lossless JPEG",
            8 | 0x80b2 => "Deflate",
            34892 => "lossy JPEG",
            52546 => "JPEG XL",
            _ => return Some(format!("compression {code}")),
        }
        .into(),
    )
}

fn dng_compression_code(data: &[u8]) -> Option<u16> {
    tiff_tag_f64(data, 259).map(|value| value as u16)
}

#[derive(Clone, Debug)]
struct DngOpcode {
    id: u32,
    flags: u32,
    parameters: Vec<u8>,
}

fn dng_opcode_list(data: &[u8], tag: u16, label: &str) -> Result<Option<Vec<DngOpcode>>, String> {
    if let Some(typ) = tiff_tag_type(data, tag) {
        if typ != 7 {
            return Err(format!(
                "DNG opcode list tag {tag} has unsupported TIFF type {typ}."
            ));
        }
    }
    let Some(bytes) = tiff_tag_bytes(data, tag) else {
        if tiff_tag_type(data, tag).is_some() {
            return Err(format!(
                "DNG {label} value is truncated or outside the file."
            ));
        }
        return Ok(None);
    };
    if bytes.len() < 4 {
        return Err(format!("DNG {label} is truncated before its opcode count."));
    }
    let count = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let mut opcodes = Vec::with_capacity(count.min(1024));
    let mut pos = 4usize;
    for index in 0..count {
        let header_end = pos
            .checked_add(16)
            .ok_or_else(|| format!("DNG {label} opcode {index} header overflows."))?;
        let header = bytes
            .get(pos..header_end)
            .ok_or_else(|| format!("DNG {label} opcode {index} header is truncated."))?;
        let id = u32::from_be_bytes(header[0..4].try_into().unwrap());
        let flags = u32::from_be_bytes(header[8..12].try_into().unwrap());
        let parameter_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
        pos = header_end;
        let end = pos
            .checked_add(parameter_len)
            .ok_or_else(|| format!("DNG {label} opcode {index} parameter length overflows."))?;
        let parameters = bytes
            .get(pos..end)
            .ok_or_else(|| format!("DNG {label} opcode {index} parameters are truncated."))?
            .to_vec();
        opcodes.push(DngOpcode {
            id,
            flags,
            parameters,
        });
        pos = end;
    }
    if pos != bytes.len() {
        return Err(format!(
            "DNG {label} contains trailing bytes after its opcode chain."
        ));
    }
    Ok(Some(opcodes))
}

fn dng_opcode_name(id: u32) -> &'static str {
    match id {
        1 => "WarpRectilinear",
        2 => "WarpFisheye",
        3 => "FixVignetteRadial",
        4 => "FixBadPixelsConstant",
        5 => "FixBadPixelsList",
        6 => "TrimBounds",
        7 => "MapTable",
        8 => "MapPolynomial",
        9 => "GainMap",
        10 => "DeltaPerRow",
        11 => "DeltaPerColumn",
        12 => "ScalePerRow",
        13 => "ScalePerColumn",
        14 => "WarpRectilinear2",
        _ => "unknown",
    }
}

fn validate_dng_opcode_stage(
    opcodes: Option<&[DngOpcode]>,
    label: &str,
    warnings: &mut Vec<String>,
    allow_vignette: bool,
) -> Result<Vec<Vec<u8>>, String> {
    let mut vignette = Vec::new();
    for opcode in opcodes.unwrap_or(&[]) {
        let optional = opcode.flags & 1 != 0;
        let supported = allow_vignette && opcode.id == 3;
        if supported {
            vignette.push(opcode.parameters.clone());
        } else if optional {
            warnings.push(format!(
                "Skipped optional DNG {label} {} opcode.",
                dng_opcode_name(opcode.id)
            ));
        } else {
            return Err(format!(
                "Unsupported mandatory DNG {label} {} opcode ({}).",
                dng_opcode_name(opcode.id),
                opcode.id
            ));
        }
    }
    Ok(vignette)
}

fn dng_illuminant_cct(code: u16) -> Option<f64> {
    Some(match code {
        17 => 2856.0, // Standard light A
        18 => 4874.0, // B
        19 => 6774.0, // C
        20 => 5503.0, // D55
        21 => 6504.0, // D65
        22 => 7500.0, // D75
        23 => 5003.0, // D50
        _ => return None,
    })
}

fn dng_white_cct(xyz: [f32; 3]) -> Option<f64> {
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !sum.is_finite() || sum <= 0.0 {
        return None;
    }
    let x = xyz[0] as f64 / sum as f64;
    let y = xyz[1] as f64 / sum as f64;
    let denominator = 0.1858 - y;
    if denominator.abs() < 1.0e-8 {
        return None;
    }
    let n = (x - 0.3320) / denominator;
    let cct = 449.0 * n.powi(3) + 3525.0 * n.powi(2) + 6823.3 * n + 5520.33;
    cct.is_finite().then_some(cct.clamp(1000.0, 50000.0))
}

fn matrix3(values: Option<Vec<f64>>) -> Option<[[f32; 3]; 3]> {
    let values = values?;
    if values.len() < 9 {
        return None;
    }
    let matrix = [
        [values[0] as f32, values[1] as f32, values[2] as f32],
        [values[3] as f32, values[4] as f32, values[5] as f32],
        [values[6] as f32, values[7] as f32, values[8] as f32],
    ];
    matrix
        .iter()
        .flatten()
        .all(|value| value.is_finite())
        .then_some(matrix)
}

fn identity3() -> [[f32; 3]; 3] {
    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
}

fn interpolate_matrix(
    first: [[f32; 3]; 3],
    second: Option<[[f32; 3]; 3]>,
    first_cct: Option<f64>,
    second_cct: Option<f64>,
    white_cct: Option<f64>,
) -> ([[f32; 3]; 3], f32) {
    let Some(second) = second else {
        return (first, 0.0);
    };
    let (Some(first_cct), Some(second_cct), Some(white_cct)) = (first_cct, second_cct, white_cct)
    else {
        return (first, 0.0);
    };
    let first_mired = 1.0e6 / first_cct;
    let second_mired = 1.0e6 / second_cct;
    let white_mired = 1.0e6 / white_cct;
    // DNG SDK's `g` is the weight of the first matrix: it is 1 at the first
    // calibration illuminant and 0 at the second, with linear interpolation
    // in reciprocal temperature (mired), regardless of tag ordering.
    let denominator = first_mired - second_mired;
    if !denominator.is_finite() || denominator.abs() < 1.0e-8 {
        return (first, 0.0);
    }
    let weight = ((white_mired - second_mired) / denominator).clamp(0.0, 1.0) as f32;
    let matrix = std::array::from_fn(|row| {
        std::array::from_fn(|column| {
            first[row][column] * weight + second[row][column] * (1.0 - weight)
        })
    });
    (matrix, weight)
}

/// Resolve the DNG as-shot neutral to the interpolated dual-illuminant
/// XYZ-to-camera matrix. DNG's reference implementation iterates this
/// operation: the matrix used to estimate the white point depends on the
/// white point itself. AnalogBalance and CameraCalibration are part of the
/// matrix used by that solve, so they are folded in before iterating.
fn resolve_dng_color_matrix(
    first: [[f32; 3]; 3],
    second: Option<[[f32; 3]; 3]>,
    first_cct: Option<f64>,
    second_cct: Option<f64>,
    camera_neutral: [f32; 3],
) -> Result<([[f32; 3]; 3], f32, [f32; 3], f64), String> {
    let first_inverse = invert3(first).ok_or("DNG ColorMatrix1 is singular.")?;
    let mut white_cct = dng_white_cct(mat(first_inverse, camera_neutral)).unwrap_or(5000.0);
    let mut resolved = first;
    let mut weight = 0.0;
    let mut source_white = mat(first_inverse, camera_neutral);
    for _ in 0..30 {
        let (matrix, matrix_weight) =
            interpolate_matrix(first, second, first_cct, second_cct, Some(white_cct));
        let inverse = invert3(matrix).ok_or("DNG interpolated ColorMatrix is singular.")?;
        let next_white = mat(inverse, camera_neutral);
        let next_cct = dng_white_cct(next_white).unwrap_or(white_cct);
        resolved = matrix;
        weight = matrix_weight;
        source_white = next_white;
        if (next_cct - white_cct).abs() < 1.0e-4 {
            white_cct = next_cct;
            break;
        }
        white_cct = next_cct;
    }
    Ok((resolved, weight, source_white, white_cct))
}

fn parse_dng(data: &[u8]) -> Result<Pixels, String> {
    let compression =
        dng_compression_code(data).ok_or("DNG is missing a readable Compression tag.")?;
    if !matches!(compression, 1 | 7 | 8 | 0x80b2) {
        return Err(format!(
            "DNG compression {} is unsupported; use uncompressed, lossless JPEG, or Deflate.",
            compression
        ));
    }
    let source = rawler::rawsource::RawSource::new_from_slice(data);
    let raw = rawler::global_loader()
        .decode(
            &source,
            &rawler::decoders::RawDecodeParams { image_index: 0 },
            false,
        )
        .map_err(|e| format!("DNG decode failed: {e}"))?;
    if raw.width == 0 || raw.height == 0 {
        return Err("DNG has invalid raw dimensions.".into());
    }
    let orientation = match raw.orientation {
        rawler::Orientation::Unknown => dng_orientation(data),
        value => value.to_u16(),
    }
    .clamp(1, 8);
    let width = raw.width;
    let height = raw.height;
    let active = raw
        .active_area
        .unwrap_or(Rect::new(Point::new(0, 0), Dim2::new(width, height)));
    let mut width_out = active.d.w;
    let mut height_out = active.d.h;
    if width_out == 0 || height_out == 0 {
        return Err("DNG active area is empty.".into());
    }
    if active.p.x > width
        || active.p.y > height
        || active
            .p
            .x
            .checked_add(width_out)
            .is_none_or(|end| end > width)
        || active
            .p
            .y
            .checked_add(height_out)
            .is_none_or(|end| end > height)
    {
        return Err("DNG active area lies outside the decoded image.".into());
    }
    let mut samples = raw.data.as_f32().into_owned();
    let expected_samples = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(raw.cpp))
        .ok_or("DNG sample dimensions overflow.")?;
    if samples.len() < expected_samples {
        return Err("DNG sample buffer is shorter than its declared dimensions.".into());
    }
    let raw_sample_range = scalar_range(&samples[..expected_samples]);
    let photometry = raw.photometric.clone();
    if matches!(
        photometry,
        rawler::rawimage::RawPhotometricInterpretation::Cfa(_)
    ) {
        if raw.cpp != 1 {
            return Err("DNG Bayer CFA must contain one stored sample per pixel.".into());
        }
        let black_levels = raw.blacklevel.as_vec();
        let black_w = raw.blacklevel.width.max(1);
        let black_h = raw.blacklevel.height.max(1);
        let white_levels = raw.whitelevel.as_vec();
        if black_levels.is_empty() || white_levels.is_empty() {
            return Err("DNG CFA is missing black/white levels.".into());
        }
        let mut normalized = vec![0.0_f32; width_out * height_out];
        for y in 0..height_out {
            for x in 0..width_out {
                let src = (active.p.y + y) * width + active.p.x + x;
                // DNG black-level repeat patterns and CFAPattern are anchored
                // at the active-area origin, which is also the origin passed
                // to the demosaicer below.
                let black_index = (y % black_h) * black_w + (x % black_w);
                let black_level = *black_levels.get(black_index).unwrap_or(&black_levels[0]);
                let white_level = *white_levels
                    .get(black_index.min(white_levels.len().saturating_sub(1)))
                    .unwrap_or(&white_levels[0]);
                let denominator = white_level - black_level;
                if !denominator.is_finite() || denominator <= 0.0 {
                    return Err("DNG CFA has an invalid white/black level range.".into());
                }
                normalized[y * width_out + x] = (samples[src] - black_level) / denominator;
            }
        }
        samples = normalized;
    } else if matches!(
        photometry,
        rawler::rawimage::RawPhotometricInterpretation::LinearRaw
    ) && raw.cpp == 3
    {
        let black = raw.blacklevel.as_vec();
        let white = raw.whitelevel.as_vec();
        if black.len() < 3 || white.len() < 3 {
            return Err("DNG LinearRaw is missing per-channel black/white levels.".into());
        }
        let mut normalized = vec![0.0_f32; width_out * height_out * 3];
        for y in 0..height_out {
            for x in 0..width_out {
                for p in 0..3 {
                    let src = ((active.p.y + y) * width + active.p.x + x) * 3 + p;
                    let denominator = white[p] - black[p];
                    if !denominator.is_finite() || denominator <= 0.0 {
                        return Err("DNG LinearRaw has an invalid white/black level range.".into());
                    }
                    normalized[(y * width_out + x) * 3 + p] =
                        (samples[src] - black[p]) / denominator;
                }
            }
        }
        samples = normalized;
    } else {
        return Err("DNG LinearRaw must contain exactly three RGB planes.".into());
    }
    let normalized_sample_range = scalar_range(&samples);
    let mut rgb = match photometry {
        rawler::rawimage::RawPhotometricInterpretation::Cfa(config) => {
            if !config.cfa.is_rgb() {
                return Err("DNG CFA pattern is not an RGB Bayer mosaic.".into());
            }
            demosaic_bayer(
                &samples,
                width_out,
                height_out,
                &config.cfa,
                &config.colors,
                // rawler shifts the decoded CFA to the active-area origin in
                // DngDecoder::get_cfa(). The cropped sample buffer therefore
                // starts at (0, 0) for this already-shifted pattern.
                (0, 0),
            )?
        }
        rawler::rawimage::RawPhotometricInterpretation::LinearRaw => samples
            .chunks_exact(3)
            .map(|p| [p[0], p[1], p[2]])
            .collect(),
        _ => return Err("DNG photometry is not supported by the browser developer.".into()),
    };
    let demosaiced_rgb_range = rgb_range(&rgb);
    let mut warnings = Vec::new();
    let list1 = dng_opcode_list(data, 51008, "OpcodeList1")?;
    let list2 = dng_opcode_list(data, 51009, "OpcodeList2")?;
    let list3 = dng_opcode_list(data, 51022, "OpcodeList3")?;
    // OpcodeList1/2 operate on stored or linearized camera samples.  The
    // browser developer currently has no implementation for those operations,
    // so mandatory entries must fail rather than being silently omitted.  The
    // supplied iPhone DNGs have only a post-demosaic vignette entry in list 3.
    let _ = validate_dng_opcode_stage(list1.as_deref(), "OpcodeList1", &mut warnings, false)?;
    let _ = validate_dng_opcode_stage(list2.as_deref(), "OpcodeList2", &mut warnings, false)?;
    for params in validate_dng_opcode_stage(list3.as_deref(), "OpcodeList3", &mut warnings, true)? {
        dng_opcode_vignette(&mut rgb, width_out, height_out, &params)?;
        warnings.push("Applied DNG FixVignetteRadial correction.".into());
    }
    let post_vignette_rgb_range = rgb_range(&rgb);
    let first_matrix = matrix3(tiff_tag_f64_values(data, 50721))
        .or_else(|| {
            raw.color_matrix
                .get(&rawler::imgop::xyz::Illuminant::D65)
                .or_else(|| raw.color_matrix.values().next())
                .and_then(|matrix| {
                    matrix3(Some(matrix.iter().map(|value| *value as f64).collect()))
                })
        })
        .ok_or("DNG has no usable ColorMatrix1.")?;
    let second_matrix = matrix3(tiff_tag_f64_values(data, 50722));
    // Rawler exposes AsShotNeutral as reciprocal white-balance coefficients.
    // DNG permits the tag to be absent; follow the decoder's documented
    // neutral fallback instead of allowing NaNs into the AP0 raster.
    let wb = if raw.wb_coeffs[..3]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
    {
        raw.wb_coeffs
    } else {
        [1.0, 1.0, 1.0, 1.0]
    };
    let camera_neutral = [1.0 / wb[0], 1.0 / wb[1], 1.0 / wb[2]];
    // Interpolate dual-illuminant calibration tags in inverse correlated
    // colour temperature, as required by the DNG processing model. The DNG
    // SDK resolves this as a fixed point because the matrix used to estimate
    // the as-shot white depends on that same white point. CameraCalibration
    // and AnalogBalance are folded into the ColorMatrix before this solve.
    let first_cct = tiff_tag_f64(data, 50778).and_then(|value| dng_illuminant_cct(value as u16));
    let second_cct = tiff_tag_f64(data, 50779).and_then(|value| dng_illuminant_cct(value as u16));
    let calibration_first = matrix3(tiff_tag_f64_values(data, 50723)).unwrap_or_else(identity3);
    let calibration_second = matrix3(tiff_tag_f64_values(data, 50724));
    let analog_balance = matrix3(tiff_tag_f64_values(data, 50727)).unwrap_or_else(identity3);
    let first_reference_to_camera = mat_mul(analog_balance, calibration_first);
    let second_reference_to_camera = second_matrix
        .map(|_| mat_mul(analog_balance, calibration_second.unwrap_or_else(identity3)));
    let first_xyz_to_camera = mat_mul(first_reference_to_camera, first_matrix);
    let second_xyz_to_camera = second_matrix
        .zip(second_reference_to_camera)
        .map(|(color, reference)| mat_mul(reference, color));
    let (xyz_to_camera, matrix_weight, source_white, white_cct_value) = resolve_dng_color_matrix(
        first_xyz_to_camera,
        second_xyz_to_camera,
        first_cct,
        second_cct,
        camera_neutral,
    )?;
    let white_cct = Some(white_cct_value);
    let reference_to_camera = interpolate_matrix(
        first_reference_to_camera,
        second_reference_to_camera,
        first_cct,
        second_cct,
        white_cct,
    )
    .0;
    // The Bradford ratios depend only on chromaticity. Normalize the solved
    // camera white to Y=1 before adapting; ColorMatrix inversion can otherwise
    // carry an arbitrary luminance scale into the CAT and tint the result.
    let source_white = normalize_white(source_white).ok_or("DNG as-shot white is invalid.")?;
    let no_forward_camera_to_xyz = invert3(xyz_to_camera).and_then(|camera_to_xyz| {
        // DNG's no-ForwardMatrix path adapts from the as-shot white to D50.
        bradford_adaptation(source_white, D50_WHITE)
            .map(|adaptation| mat_mul(adaptation, camera_to_xyz))
    });
    let forward_matrix = {
        let first = matrix3(tiff_tag_f64_values(data, 50964));
        let second = matrix3(tiff_tag_f64_values(data, 50965));
        match first {
            Some(first) => Some(
                interpolate_matrix(
                    first,
                    second,
                    tiff_tag_f64(data, 50778).and_then(|value| dng_illuminant_cct(value as u16)),
                    tiff_tag_f64(data, 50779).and_then(|value| dng_illuminant_cct(value as u16)),
                    white_cct,
                )
                .0,
            ),
            None => None,
        }
    };
    let forward_matrix_used = forward_matrix.is_some();
    let camera_to_xyz_d50 = if let Some(forward) = forward_matrix {
        // ForwardMatrix maps white-balanced reference-camera values to D50.
        // Undo the calibration/analog-balance transform after applying the
        // neutral diagonal, preserving the native camera sample coordinates.
        dng_forward_camera_to_xyz(forward, reference_to_camera, camera_neutral)
            .or(no_forward_camera_to_xyz)
    } else {
        no_forward_camera_to_xyz
    }
    .ok_or("DNG camera calibration is singular or invalid.")?;
    // The DNG camera-to-XYZ result is D50. A D50→D65 CAT02 step then feeds
    // the ACES AP0 (D60) conversion, whose BFD adaptation is included in
    // `XYZ_D65_TO_AP0`.
    let camera_to_d65 = mat_mul(D50_TO_D65_CAT02, camera_to_xyz_d50);
    let camera_to_ap0 = mat_mul(XYZ_D65_TO_AP0, camera_to_d65);
    let representative_indices = [0, rgb.len() / 2, rgb.len().saturating_sub(1)];
    let representative_camera_rgb = representative_indices.map(|index| rgb[index]);
    // BaselineExposure is an image-level offset; BaselineExposureOffset is
    // an optional profile-level addition. Both are signed EV values.
    let baseline_exposure =
        tiff_tag_f64(data, 50730).unwrap_or(0.0) + tiff_tag_f64(data, 51109).unwrap_or(0.0);
    let exposure = 2.0_f32.powf(baseline_exposure as f32);
    // The no-ForwardMatrix ColorMatrix path already incorporates the as-shot
    // neutral in its Bradford adaptation (`source_white` above). Applying the
    // reciprocal AsShotNeutral a second time here would white-balance the
    // camera samples twice and produces the characteristic magenta cast seen
    // in the iPhone DNG preview. Keep the camera samples in their native
    // coordinates for this integrated ColorMatrix transform.
    apply_dng_camera_transform(&mut rgb, camera_to_ap0, exposure);
    let final_ap0_range = rgb_range(&rgb);
    let representative_ap0 = representative_indices.map(|index| rgb[index]);
    let dng_transform = DngTransformDiagnostics {
        color_matrix_first_weight: matrix_weight,
        forward_matrix_used,
        as_shot_neutral: camera_neutral,
        white_balance_multipliers: [wb[0], wb[1], wb[2]],
        source_white_xyz: source_white,
        raw_sample_range,
        normalized_sample_range,
        demosaiced_rgb_range,
        post_vignette_rgb_range,
        final_ap0_range,
        representative_camera_rgb,
        representative_ap0,
        camera_to_xyz_d50,
        cat02_d50_to_d65: D50_TO_D65_CAT02,
        camera_to_d65,
        camera_to_ap0,
        white_balance_integrated: true,
    };
    if matches!(orientation, 5 | 6 | 7 | 8) {
        std::mem::swap(&mut width_out, &mut height_out);
    }
    let (rgb, _, _) = rotate_dng(rgb, active.d.w, active.d.h, orientation);
    let photometry_name = match &raw.photometric {
        rawler::rawimage::RawPhotometricInterpretation::Cfa(config) => {
            format!("Bayer CFA ({})", config.cfa)
        }
        rawler::rawimage::RawPhotometricInterpretation::LinearRaw => "LinearRaw RGB".into(),
        rawler::rawimage::RawPhotometricInterpretation::BlackIsZero => "BlackIsZero".into(),
    };
    let compression_name =
        dng_compression_name(data).unwrap_or_else(|| "supported raw storage".into());
    let metadata_source = format!(
        "DNG camera calibration ({}; {}; {}-bit; {})",
        raw.clean_model, photometry_name, raw.bps, compression_name
    );
    Ok(Pixels {
        width: width_out,
        height: height_out,
        rgb,
        icc_profile: None,
        summary: DecodeSummary {
            format: "dng".into(),
            width: width_out as u32,
            height: height_out as u32,
            gamut: Some("ACES2065-1/AP0".into()),
            transfer: Some("Linear".into()),
            metadata_source: Some(metadata_source),
            automatic_icc: false,
            embedded_available: true,
            orientation: Some(orientation),
            camera_model: Some(raw.clean_model.clone()),
            photometry: Some(photometry_name),
            bit_depth: Some(raw.bps as u16),
            compression: Some(compression_name),
            dng_transform: Some(dng_transform),
            warnings,
        },
    })
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct SolveStats {
    projected_pixels: u64,
    clipped_pixels: u64,
    non_finite_pixels: u64,
    exposure_min: f32,
    exposure_max: f32,
    exposure_sum: f64,
    base_min: f32,
    base_max: f32,
    base_sum: f64,
    finite_pixels: u64,
    #[serde(default)]
    compute_backend: String,
    #[serde(default)]
    gpu_adapter: Option<String>,
    #[serde(default)]
    gpu_validation: Option<String>,
    #[serde(default)]
    batch_size: u32,
    #[serde(default)]
    preview_backend: String,
    #[serde(default)]
    preview_transform_ms: f32,
}

fn flat_pixels(rgb: &[[f32; 3]]) -> Vec<f32> {
    rgb.iter().flat_map(|pixel| pixel.iter().copied()).collect()
}

fn mat(m: [[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn mat_mul(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    [
        [
            a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
            a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2],
        ],
        [
            a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
            a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2],
        ],
        [
            a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
            a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
            a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2],
        ],
    ]
}

fn normalize_white(white: [f32; 3]) -> Option<[f32; 3]> {
    if !white.iter().all(|value| value.is_finite() && *value > 0.0)
        || !white[1].is_finite()
        || white[1] <= 1.0e-8
    {
        return None;
    }
    Some([white[0] / white[1], 1.0, white[2] / white[1]])
}

fn scalar_range(values: &[f32]) -> [f32; 2] {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for &value in values {
        if value.is_finite() {
            min = min.min(value);
            max = max.max(value);
        }
    }
    if min.is_finite() && max.is_finite() {
        [min, max]
    } else {
        [0.0, 0.0]
    }
}

fn rgb_range(values: &[[f32; 3]]) -> [[f32; 3]; 2] {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for pixel in values {
        for channel in 0..3 {
            let value = pixel[channel];
            if value.is_finite() {
                min[channel] = min[channel].min(value);
                max[channel] = max[channel].max(value);
            }
        }
    }
    for channel in 0..3 {
        if !min[channel].is_finite() || !max[channel].is_finite() {
            min[channel] = 0.0;
            max[channel] = 0.0;
        }
    }
    [min, max]
}

fn bradford_adaptation(source_white: [f32; 3], target_white: [f32; 3]) -> Option<[[f32; 3]; 3]> {
    if !source_white
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
        || !target_white
            .iter()
            .all(|value| value.is_finite() && *value > 0.0)
    {
        return None;
    }
    let source_cone = mat(BRADFORD, source_white);
    let target_cone = mat(BRADFORD, target_white);
    if !source_cone
        .iter()
        .all(|value| value.is_finite() && value.abs() > 1.0e-8)
    {
        return None;
    }
    let scale = [
        target_cone[0] / source_cone[0],
        target_cone[1] / source_cone[1],
        target_cone[2] / source_cone[2],
    ];
    Some(mat_mul(
        BRADFORD_INVERSE,
        mat_mul(
            [
                [scale[0], 0.0, 0.0],
                [0.0, scale[1], 0.0],
                [0.0, 0.0, scale[2]],
            ],
            BRADFORD,
        ),
    ))
}

fn apply_dng_camera_transform(rgb: &mut [[f32; 3]], camera_to_ap0: [[f32; 3]; 3], exposure: f32) {
    for px in rgb {
        *px = mat(camera_to_ap0, *px).map(|value| value * exposure);
    }
}

/// Build the DNG ForwardMatrix camera-to-XYZ(D50) transform while retaining
/// the camera's native, un-white-balanced sample coordinates. ForwardMatrix
/// is defined for white-balanced reference-camera values, so the neutral
/// diagonal and inverse AnalogBalance/CameraCalibration transform must be
/// applied around it.
fn dng_forward_camera_to_xyz(
    forward: [[f32; 3]; 3],
    reference_to_camera: [[f32; 3]; 3],
    camera_neutral: [f32; 3],
) -> Option<[[f32; 3]; 3]> {
    let inverse_reference = invert3(reference_to_camera)?;
    let reference_neutral = mat(inverse_reference, camera_neutral);
    if !reference_neutral
        .iter()
        .all(|value| value.is_finite() && *value > 1.0e-8)
    {
        return None;
    }
    let diagonal = [
        [1.0 / reference_neutral[0], 0.0, 0.0],
        [0.0, 1.0 / reference_neutral[1], 0.0],
        [0.0, 0.0, 1.0 / reference_neutral[2]],
    ];
    Some(mat_mul(forward, mat_mul(diagonal, inverse_reference)))
}

fn finite(v: [f32; 3]) -> bool {
    v.iter().all(|x| x.is_finite())
}
fn is_usable_icc_profile(data: &[u8]) -> bool {
    let Ok(profile) = icc_profile::Profile::new(data) else {
        return false;
    };
    if profile.color_space() != icc_profile::ColorSpace::Rgb
        || profile.pcs() != icc_profile::Pcs::Xyz
    {
        return false;
    }
    profile
        .compile(
            icc_profile::TransformDirection::DeviceToPcs,
            icc_profile::RenderingIntent::RelativeColorimetric,
            icc_profile::TransformLimits::default(),
        )
        .is_ok()
}
fn icc_rgb_to_ap0(rgb: &mut [[f32; 3]], icc: &[u8]) -> Result<(), String> {
    let profile = icc_profile::Profile::new(icc).map_err(|e| e.to_string())?;
    if profile.color_space() != icc_profile::ColorSpace::Rgb {
        return Err("Embedded ICC profile must be RGB.".into());
    }
    if profile.pcs() != icc_profile::Pcs::Xyz {
        return Err("Embedded ICC profile must use XYZ PCS.".into());
    }
    let transform = profile
        .compile(
            icc_profile::TransformDirection::DeviceToPcs,
            icc_profile::RenderingIntent::RelativeColorimetric,
            icc_profile::TransformLimits::default(),
        )
        .map_err(|e| e.to_string())?;
    for px in rgb.iter_mut() {
        // ICC device transforms accept normalized device samples only. Native
        // decoders can produce tiny over/under-shoots at the numeric edge;
        // clamp those representational errors before entering the profile.
        let normalized = [
            px[0].clamp(0.0, 1.0),
            px[1].clamp(0.0, 1.0),
            px[2].clamp(0.0, 1.0),
        ];
        let mut xyz = [0.0_f32; 3];
        transform
            .transform_f32(&normalized, &mut xyz)
            .map_err(|e| e.to_string())?;
        let d65 = mat(D50_TO_D65_CAT02, xyz);
        *px = mat(XYZ_D65_TO_AP0, d65);
    }
    Ok(())
}
fn prepare_rgb(
    mut rgb: Vec<[f32; 3]>,
    width: usize,
    height: usize,
    req: &Request,
    icc_profile: Option<&[u8]>,
    embedded_pair: Option<(&str, &str)>,
) -> Result<Vec<[f32; 3]>, String> {
    let manual = match (&req.gamut, &req.transfer) {
        (Some(gamut), Some(transfer)) => Some((gamut.as_str(), transfer.as_str())),
        (None, None) => None,
        _ => {
            return Err(
                "Source gamut and transfer must either both be set or both be omitted.".into(),
            )
        }
    };
    if let Some((gamut, transfer)) = manual {
        for px in &mut rgb {
            for c in px.iter_mut() {
                *c = decode_transfer(*c, transfer);
            }
            *px = source_to_ap0(*px, gamut);
        }
    } else if let Some(icc) = icc_profile {
        icc_rgb_to_ap0(&mut rgb, icc)?;
    } else if let Some((gamut, transfer)) = embedded_pair {
        for px in &mut rgb {
            for c in px.iter_mut() {
                *c = decode_transfer(*c, transfer);
            }
            *px = source_to_ap0(*px, gamut);
        }
    } else {
        return Err(
            "Select gamut and transfer manually: this image has no usable embedded ICC profile."
                .into(),
        );
    }
    blur(&mut rgb, width, height, req.blur_sigma);
    Ok(rgb)
}

fn srgb_eotf(value: f32) -> f32 {
    let a = value.abs();
    let linear = if a <= 0.04045 {
        a / 12.92
    } else {
        ((a + 0.055) / 1.055).powf(2.4)
    };
    value.signum() * linear
}

/// Reconstruct an Apple auxiliary HDR gain map before source color conversion.
/// The Apple gain map is encoded as an sRGB-like grayscale image. The primary
/// image remains in its encoded source space until the normal source
/// interpretation path runs below.
fn apply_apple_gain_map(
    mut rgb: Vec<[f32; 3]>,
    width: usize,
    height: usize,
    gain: &[f32],
    gain_width: usize,
    gain_height: usize,
    exif: &[u8],
) -> Result<Vec<[f32; 3]>, String> {
    if gain.is_empty() || gain_width == 0 || gain_height == 0 {
        return Ok(rgb);
    }
    if gain.len() != gain_width.saturating_mul(gain_height) {
        return Err("Apple HDR gain-map dimensions do not match the supplied samples.".into());
    }
    let info = parse_exif_for_apple_hdr(exif).ok_or_else(|| {
        "Apple HDR gain-map metadata does not contain a usable MakerNote headroom value."
            .to_string()
    })?;
    let metadata = from_apple_headroom(&info)
        .ok_or_else(|| "Apple HDR gain-map headroom is missing.".to_string())?;
    let stops = metadata.alternate_hdr_headroom as f32;
    let headroom = 2.0_f32.powf(stops);
    let scale = headroom - 1.0;
    for y in 0..height {
        let gy = ((y as f32 + 0.5) * gain_height as f32 / height as f32 - 0.5)
            .clamp(0.0, (gain_height - 1) as f32);
        let y0 = gy.floor() as usize;
        let y1 = (y0 + 1).min(gain_height - 1);
        let fy = gy - y0 as f32;
        for x in 0..width {
            let gx = ((x as f32 + 0.5) * gain_width as f32 / width as f32 - 0.5)
                .clamp(0.0, (gain_width - 1) as f32);
            let x0 = gx.floor() as usize;
            let x1 = (x0 + 1).min(gain_width - 1);
            let fx = gx - x0 as f32;
            let g00 = srgb_eotf(gain[y0 * gain_width + x0].clamp(0.0, 1.0));
            let g01 = srgb_eotf(gain[y0 * gain_width + x1].clamp(0.0, 1.0));
            let g10 = srgb_eotf(gain[y1 * gain_width + x0].clamp(0.0, 1.0));
            let g11 = srgb_eotf(gain[y1 * gain_width + x1].clamp(0.0, 1.0));
            let gain_linear =
                (g00 * (1.0 - fx) + g01 * fx) * (1.0 - fy) + (g10 * (1.0 - fx) + g11 * fx) * fy;
            let factor = 1.0 + scale * gain_linear;
            let px = &mut rgb[y * width + x];
            for c in px.iter_mut() {
                *c *= factor;
            }
        }
    }
    Ok(rgb)
}
fn decode_transfer(x: f32, name: &str) -> f32 {
    let s = x.signum();
    let a = x.abs();
    let y = match name {
        "Linear" => a,
        "sRGB" => {
            if a <= 0.04045 {
                a / 12.92
            } else {
                ((a + 0.055) / 1.055).powf(2.4)
            }
        }
        "Gamma 1.8" => a.powf(1.8),
        "Gamma 2.2" => a.powf(2.2),
        "Gamma 2.4 / BT.1886" => a.powf(2.4),
        "BT.709 / BT.2020" => {
            if a < 0.081 {
                a / 4.5
            } else {
                ((a + 0.099) / 1.099).powf(1.0 / 0.45)
            }
        }
        "PQ / ST 2084" => {
            let m1 = 2610.0 / 16384.0;
            let m2 = 2523.0 / 32.0;
            let c1 = 3424.0 / 4096.0;
            let c2 = 2413.0 / 128.0;
            let c3 = 2392.0 / 128.0;
            let r = a.powf(1.0 / m2);
            (10000.0 * ((r - c1).max(0.0) / (c2 - c3 * r)).powf(1.0 / m1)) / 100.0
        }
        "HLG / BT.2100" => {
            if a <= 0.5 {
                a * a / 3.0
            } else {
                (((a - 0.55991073) / 0.17883277).exp() + 0.28466892) / 12.0
            }
        }
        _ => f32::NAN,
    };
    s * y
}
fn source_to_ap0(rgb: [f32; 3], gamut: &str) -> [f32; 3] {
    if gamut == "ACES2065-1" {
        return rgb;
    }
    let xyz = match gamut {
        "Rec.709 / sRGB" => mat(SRGB_TO_XYZ, rgb),
        "Display P3 / P3-D65" => mat(P3_TO_XYZ, rgb),
        "Rec.2020" => mat(REC2020_TO_XYZ, rgb),
        "Adobe RGB" => mat(ADOBE_RGB_TO_XYZ, rgb),
        "ACEScg" => mat(AP1_TO_AP0, rgb),
        _ => [f32::NAN; 3],
    };
    mat(XYZ_D65_TO_AP0, xyz)
}
fn blur(rgb: &mut [[f32; 3]], width: usize, height: usize, sigma: f32) {
    if sigma <= 0.0 {
        return;
    }
    let radius = (sigma * 3.0).ceil() as isize;
    let mut kernel = Vec::new();
    let mut sum = 0.0;
    for i in -radius..=radius {
        let w = (-0.5 * (i as f32 / sigma).powi(2)).exp();
        kernel.push(w);
        sum += w;
    }
    for w in &mut kernel {
        *w /= sum;
    }
    let src = rgb.to_vec();
    for y in 0..height {
        for x in 0..width {
            let mut out = [0.0; 3];
            for (k, w) in kernel.iter().enumerate() {
                let xx = (x as isize + k as isize - radius).clamp(0, (width - 1) as isize) as usize;
                for c in 0..3 {
                    out[c] += src[y * width + xx][c] * w;
                }
            }
            rgb[y * width + x] = out;
        }
    }
    let src = rgb.to_vec();
    for y in 0..height {
        for x in 0..width {
            let mut out = [0.0; 3];
            for (k, w) in kernel.iter().enumerate() {
                let yy =
                    (y as isize + k as isize - radius).clamp(0, (height - 1) as isize) as usize;
                for c in 0..3 {
                    out[c] += src[yy * width + x][c] * w;
                }
            }
            rgb[y * width + x] = out;
        }
    }
}

fn parse_png_inner(data: &[u8]) -> Result<Pixels, String> {
    let mut d = PngDecoder::new(Cursor::new(data));
    d.set_transformations(Transformations::EXPAND);
    let mut r = d.read_info().map_err(|e| e.to_string())?;
    let info = r.info().clone();
    let mut buf = vec![0; r.output_buffer_size().ok_or("PNG too large")?];
    let out = r.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let channels = out.color_type.samples();
    let depth = matches!(out.bit_depth, png::BitDepth::Sixteen);
    let mut rgb = Vec::with_capacity((out.width * out.height) as usize);
    for i in 0..(out.width * out.height) as usize {
        let mut v = [0.0; 3];
        for c in 0..3 {
            let source_channel = if channels < 3 { 0 } else { c };
            v[c] = if depth {
                u16::from_be_bytes([
                    buf[i * channels * 2 + source_channel * 2],
                    buf[i * channels * 2 + source_channel * 2 + 1],
                ]) as f32
                    / 65535.0
            } else {
                buf[i * channels + source_channel] as f32 / 255.0
            };
        }
        rgb.push(v);
    }
    let detected = info
        .coding_independent_code_points
        .map(|c| (c.color_primaries, c.transfer_function));
    let cicp = detected.and_then(|(p, t)| {
        let g = match p {
            1 => Some("Rec.709 / sRGB"),
            9 => Some("Rec.2020"),
            12 => Some("Display P3 / P3-D65"),
            _ => None,
        };
        let tr = match t {
            1 | 14 | 15 => Some("BT.709 / BT.2020"),
            13 => Some("sRGB"),
            16 => Some("PQ / ST 2084"),
            18 => Some("HLG / BT.2100"),
            _ => None,
        };
        g.zip(tr).map(|(a, b)| (a.to_string(), b.to_string()))
    });
    let icc_profile = info.icc_profile.as_ref().and_then(|v| {
        if is_usable_icc_profile(v.as_ref()) {
            Some(v.as_ref().to_vec())
        } else {
            None
        }
    });
    let automatic_icc = icc_profile.is_some();
    let embedded_available = automatic_icc || cicp.is_some();
    Ok(Pixels {
        width: out.width as usize,
        height: out.height as usize,
        rgb,
        icc_profile,
        summary: DecodeSummary {
            format: "png".into(),
            width: out.width,
            height: out.height,
            gamut: cicp.as_ref().map(|x| x.0.clone()),
            transfer: cicp.as_ref().map(|x| x.1.clone()),
            metadata_source: if automatic_icc {
                Some("PNG ICC profile".into())
            } else if cicp.is_some() {
                Some("PNG cICP".into())
            } else {
                None
            },
            automatic_icc,
            embedded_available,
            orientation: None,
            camera_model: None,
            photometry: None,
            bit_depth: None,
            compression: None,
            dng_transform: None,
            warnings: if automatic_icc {
                Vec::new()
            } else if info.icc_profile.is_some() {
                vec!["Select gamut and transfer manually: the embedded ICC profile is malformed or unsupported.".into()]
            } else if cicp.is_some() {
                vec!["Select gamut and transfer manually: the PNG has cICP metadata but no usable embedded ICC profile.".into()]
            } else {
                vec!["Select gamut and transfer manually: the PNG has no usable embedded ICC profile.".into()]
            },
        },
    })
}
fn parse_png(data: &[u8]) -> Result<Pixels, String> {
    match parse_png_inner(data) {
        Ok(pixels) => Ok(pixels),
        Err(png_error) => match parse_jpeg_inner(data) {
            Ok(mut pixels) => {
                pixels.summary.format = "jpeg".into();
                Ok(pixels)
            }
            Err(jpeg_error) => Err(format!(
                "PNG parsing failed ({png_error}); JPEG fallback also failed ({jpeg_error})"
            )),
        },
    }
}
fn parse_jpeg_inner_scaled(data: &[u8], max_edge: Option<u32>) -> Result<Pixels, String> {
    let mut d = JpegDecoder::new(Cursor::new(data));
    d.read_info().map_err(|e| e.to_string())?;
    let full = d.info().ok_or("JPEG metadata missing")?;
    let full_width = full.width;
    let full_height = full.height;
    if let Some(max_edge) = max_edge {
        if max_edge == 0 {
            return Err("JPEG preview edge cap must be positive.".into());
        }
        // JPEG's native decoder can perform a 1/2, 1/4, or 1/8 IDCT directly.
        // Requesting the preview bound here avoids allocating and converting
        // the full raster on every source interpretation change.
        let max_edge = max_edge.min(65_535);
        let longest = u32::from(full_width).max(u32::from(full_height));
        let requested_width = ((u32::from(full_width) * max_edge + longest - 1) / longest)
            .clamp(1, u32::from(full_width));
        let requested_height = ((u32::from(full_height) * max_edge + longest - 1) / longest)
            .clamp(1, u32::from(full_height));
        d.scale(requested_width as u16, requested_height as u16)
            .map_err(|e| e.to_string())?;
    }
    let icc = d.icc_profile();
    let px = d.decode().map_err(|e| e.to_string())?;
    let info = d.info().ok_or("JPEG metadata missing")?;
    if info.pixel_format != PixelFormat::RGB24 {
        return Err("JPEG must contain RGB pixels".into());
    }
    let rgb = px
        .chunks_exact(3)
        .map(|p| {
            [
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            ]
        })
        .collect();
    let icc_profile = icc.as_deref().and_then(|bytes| {
        if is_usable_icc_profile(bytes) {
            Some(bytes.to_vec())
        } else {
            None
        }
    });
    let automatic_icc = icc_profile.is_some();
    let metadata_source = if automatic_icc {
        Some("JPEG ICC profile".to_string())
    } else {
        None
    };
    let warnings = if automatic_icc {
        Vec::new()
    } else if icc.is_some() {
        vec![
            "Select gamut and transfer manually: the embedded ICC profile is malformed or unsupported."
                .into(),
        ]
    } else {
        vec!["Select gamut and transfer manually: the loaded JPEG image has no usable embedded ICC profile.".into()]
    };
    Ok(Pixels {
        width: info.width as usize,
        height: info.height as usize,
        rgb,
        icc_profile,
        summary: DecodeSummary {
            format: "jpeg".into(),
            width: info.width as u32,
            height: info.height as u32,
            gamut: None,
            transfer: None,
            metadata_source,
            automatic_icc,
            embedded_available: automatic_icc,
            orientation: None,
            camera_model: None,
            photometry: None,
            bit_depth: None,
            compression: None,
            dng_transform: None,
            warnings,
        },
    })
}
fn parse_jpeg_inner(data: &[u8]) -> Result<Pixels, String> {
    parse_jpeg_inner_scaled(data, None)
}
fn parse_jpeg(data: &[u8]) -> Result<Pixels, String> {
    parse_jpeg_inner(data)
}
fn parse_exr(data: &[u8]) -> Result<Pixels, String> {
    let reader = exr::prelude::read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .first_valid_layer()
        .all_attributes()
        .non_parallel();
    let image = reader
        .from_buffered(Cursor::new(data))
        .map_err(|e| e.to_string())?;
    let layer = &image.layer_data;
    let width = layer.size.0;
    let height = layer.size.1;
    let channel = |name: &[u8]| {
        layer
            .channel_data
            .list
            .iter()
            .find(|c| c.name.as_slice() == name)
    };
    let r = channel(b"R").ok_or("EXR must contain an R channel")?;
    let g = channel(b"G").ok_or("EXR must contain a G channel")?;
    let b = channel(b"B").ok_or("EXR must contain a B channel")?;
    let rv: Vec<f32> = r.sample_data.values_as_f32().collect();
    let gv: Vec<f32> = g.sample_data.values_as_f32().collect();
    let bv: Vec<f32> = b.sample_data.values_as_f32().collect();
    if rv.len() != width * height || gv.len() != rv.len() || bv.len() != rv.len() {
        return Err("EXR channel dimensions do not match".into());
    }
    let rgb = (0..rv.len()).map(|i| [rv[i], gv[i], bv[i]]).collect();
    let detected_gamut = image.attributes.chromaticities.and_then(|c| {
        let close = |a: f32, b: f32| (a - b).abs() < 0.001;
        let p3 = close(c.red.0, 0.680)
            && close(c.red.1, 0.320)
            && close(c.green.0, 0.265)
            && close(c.green.1, 0.690);
        let rec = close(c.red.0, 0.640)
            && close(c.red.1, 0.330)
            && close(c.green.0, 0.300)
            && close(c.green.1, 0.600);
        let ap1 = close(c.red.0, 0.713) && close(c.red.1, 0.293);
        if ap1 {
            Some("ACEScg".to_string())
        } else if p3 {
            Some("Display P3 / P3-D65".to_string())
        } else if rec {
            Some("Rec.709 / sRGB".to_string())
        } else {
            None
        }
    });
    let transfer = detected_gamut.as_ref().map(|_| "Linear".to_string());
    Ok(Pixels {
        width,
        height,
        rgb,
        icc_profile: None,
        summary: DecodeSummary {
            format: "exr".into(),
            width: width as u32,
            height: height as u32,
            gamut: detected_gamut.clone(),
            transfer,
            metadata_source: detected_gamut.as_ref().map(|_| "EXR chromaticities".into()),
            automatic_icc: false,
            embedded_available: detected_gamut.is_some(),
            orientation: None,
            camera_model: None,
            photometry: None,
            bit_depth: None,
            compression: None,
            dng_transform: None,
            warnings: if detected_gamut.is_none() {
                vec!["Select gamut and transfer manually: EXR chromaticities are missing or unsupported.".into()]
            } else {
                Vec::new()
            },
        },
    })
}
fn parse(data: &[u8], format: &str) -> Result<Pixels, String> {
    match format.to_ascii_lowercase().as_str() {
        "dng" => parse_dng(data),
        "png" => parse_png(data),
        "jpg" | "jpeg" => parse_jpeg(data),
        "exr" => parse_exr(data),
        "heic" | "heif" => {
            Err("HEIF/HEIC pixels must be supplied by libheif-js with explicit metadata.".into())
        }
        _ => Err("Unsupported image format".into()),
    }
}

fn write_exr(
    width: usize,
    height: usize,
    channels: Vec<AnyChannel<FlatSamples>>,
    component: &str,
    report: &Report,
) -> Result<Vec<u8>, String> {
    let mut attrs = ImageAttributes::with_size((width, height));
    attrs.chromaticities = Some(Chromaticities {
        red: Vec2(0.713, 0.293),
        green: Vec2(0.165, 0.830),
        blue: Vec2(0.128, 0.044),
        white: Vec2(0.32168, 0.33767),
    });
    attrs.other.insert(
        Text::new_or_panic("ocioColorSpace"),
        AttributeValue::Text(Text::new_or_panic("ACEScg")),
    );
    attrs.other.insert(
        Text::new_or_panic("decompositionComponent"),
        AttributeValue::Text(Text::new_or_panic(component)),
    );
    attrs.other.insert(
        Text::new_or_panic("decompositionProjectedPixels"),
        AttributeValue::I32(report.projected_pixels as i32),
    );
    if component.starts_with("exposure") {
        attrs.other.insert(
            Text::new_or_panic("decompositionExposureEncoding"),
            AttributeValue::Text(Text::new_or_panic(if component == "exposure" {
                "RGB=(s,s,s); direct solved s; linear scalar"
            } else {
                "normalized_exposure=clamp(log2(s),-10,10)/20+0.5; scalar s is not stored in this channel"
            })),
        );
    }
    let layer = Layer::new(
        (width, height),
        LayerAttributes::named("decomposition"),
        Encoding::SMALL_LOSSLESS,
        AnyChannels::sort(channels.into_iter().collect()),
    );
    let image = Image::new(attrs, layer);
    let mut out = Vec::new();
    image
        .write()
        .non_parallel()
        .to_buffered(Cursor::new(&mut out))
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[wasm_bindgen]
pub fn inspect(data: Vec<u8>, format: String) -> Result<JsValue, JsValue> {
    let p = parse(&data, &format).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&p.summary).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Prepare a bounded JPEG source preview without decoding the full-resolution
/// raster. The native JPEG IDCT scale is selected before pixel conversion.
#[wasm_bindgen]
pub fn prepare_jpeg_preview(
    data: Vec<u8>,
    request: JsValue,
    max_edge: u32,
) -> Result<PreparedImage, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let p = parse_jpeg_inner_scaled(&data, Some(max_edge)).map_err(|e| JsValue::from_str(&e))?;
    let width = p.width;
    let height = p.height;
    let embedded_pair = p
        .summary
        .gamut
        .as_deref()
        .zip(p.summary.transfer.as_deref());
    let rgb = prepare_rgb(
        p.rgb,
        width,
        height,
        &req,
        p.icc_profile.as_deref(),
        embedded_pair,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    prepared_payload_rgb(rgb, width, height, p.summary.warnings.clone(), None)
        .map_err(|e| JsValue::from_str(&e))
}

fn parse_request(value: JsValue) -> Result<Request, String> {
    let req: Request = serde_wasm_bindgen::from_value(value).map_err(|e| e.to_string())?;
    if req.format.eq_ignore_ascii_case("dng") && (req.gamut.is_some() || req.transfer.is_some()) {
        return Err(
            "DNG sources use their embedded camera calibration and linear ACES2065-1/AP0 output."
                .into(),
        );
    }
    match (&req.gamut, &req.transfer) {
        (None, None) => {}
        (Some(gamut), Some(transfer)) => {
            if !matches!(
                gamut.as_str(),
                "Rec.709 / sRGB"
                    | "Display P3 / P3-D65"
                    | "Rec.2020"
                    | "Adobe RGB"
                    | "ACEScg"
                    | "ACES2065-1"
            ) {
                return Err("Unsupported source gamut.".into());
            }
            if !matches!(
                transfer.as_str(),
                "Linear"
                    | "sRGB"
                    | "Gamma 1.8"
                    | "Gamma 2.2"
                    | "Gamma 2.4 / BT.1886"
                    | "BT.709 / BT.2020"
                    | "PQ / ST 2084"
                    | "HLG / BT.2100"
            ) {
                return Err("Unsupported source transfer function.".into());
            }
        }
        _ => {
            return Err(
                "Source gamut and transfer must either both be set or both be omitted.".into(),
            )
        }
    }
    if !req.refl.is_finite()
        || req.refl <= 0.0
        || !req.blur_sigma.is_finite()
        || req.blur_sigma < 0.0
    {
        return Err("Invalid Refl or Gaussian blur value.".into());
    }
    if !matches!(req.profile, 0 | 1 | 2 | 4) {
        return Err("Unsupported ACES profile.".into());
    }
    Ok(req)
}

fn payload(
    report: Report,
    base: Vec<u8>,
    exposure_norm_ev: Vec<u8>,
    exposure: Vec<u8>,
    base_preview: Vec<u8>,
    exposure_preview: Vec<u8>,
) -> Result<JsValue, String> {
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("report"),
        &serde_wasm_bindgen::to_value(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("report: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("base_exr"),
        &Uint8Array::from(base.as_slice()).into(),
    )
    .map_err(|e| format!("base: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure_norm_ev_exr"),
        &Uint8Array::from(exposure_norm_ev.as_slice()).into(),
    )
    .map_err(|e| format!("exposure norm EV: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure_exr"),
        &Uint8Array::from(exposure.as_slice()).into(),
    )
    .map_err(|e| format!("exposure: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("base_preview_jpeg"),
        &Uint8Array::from(base_preview.as_slice()).into(),
    )
    .map_err(|e| format!("base_preview: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure_preview_jpeg"),
        &Uint8Array::from(exposure_preview.as_slice()).into(),
    )
    .map_err(|e| format!("exposure_preview: {e:?}"))?;
    Ok(object.into())
}

fn jhk_for_ap0(ap0: [f32; 3], profile: u32) -> f64 {
    let ap1 = mat(AP0_TO_AP1, ap0);
    let xyz = modcam16_color_core::aces_output::forward(
        profile,
        [ap1[0] as f64, ap1[1] as f64, ap1[2] as f64],
    );
    modcam16_color_core::j_hk_from_xyz(xyz)
}

fn solve_exposure(q: [f32; 3], profile: u32, target: f64, refl: f32) -> (f32, f32, [f32; 3], bool) {
    if q.iter().all(|v| *v == 0.0) {
        return (0.0, 0.0, [refl; 3], false);
    }
    let mut low = -20.0_f64;
    let mut high = 20.0_f64;
    let mut low_j = jhk_for_ap0(
        [
            q[0] * 2.0_f64.powf(-low) as f32,
            q[1] * 2.0_f64.powf(-low) as f32,
            q[2] * 2.0_f64.powf(-low) as f32,
        ],
        profile,
    );
    let mut high_j = jhk_for_ap0(
        [
            q[0] * 2.0_f64.powf(-high) as f32,
            q[1] * 2.0_f64.powf(-high) as f32,
            q[2] * 2.0_f64.powf(-high) as f32,
        ],
        profile,
    );

    // Find the complete root before applying the representable norm-EV range.
    // The direct RGB exposure output must retain this scalar when its log2
    // value lies outside +/-10 stops.
    for _ in 0..8 {
        if low_j < target {
            low -= 10.0;
            low_j = jhk_for_ap0(
                [
                    q[0] * 2.0_f64.powf(-low) as f32,
                    q[1] * 2.0_f64.powf(-low) as f32,
                    q[2] * 2.0_f64.powf(-low) as f32,
                ],
                profile,
            );
        }
        if high_j > target {
            high += 10.0;
            high_j = jhk_for_ap0(
                [
                    q[0] * 2.0_f64.powf(-high) as f32,
                    q[1] * 2.0_f64.powf(-high) as f32,
                    q[2] * 2.0_f64.powf(-high) as f32,
                ],
                profile,
            );
        }
        if low_j >= target && high_j <= target {
            break;
        }
    }
    let mut clipped = false;
    if low_j >= target && high_j <= target {
        for _ in 0..32 {
            let middle = 0.5 * (low + high);
            let scale = 2.0_f64.powf(-middle) as f32;
            let j = jhk_for_ap0([q[0] * scale, q[1] * scale, q[2] * scale], profile);
            if j > target {
                low = middle;
            } else {
                high = middle;
            }
        }
    } else {
        // No finite bracket was found. Keep a finite endpoint and expose the
        // lossy condition in the diagnostics.
        clipped = true;
        low = if low_j < target { -100.0 } else { 100.0 };
    }
    let e = low as f32;
    clipped |= e < EXPOSURE_MIN || e > EXPOSURE_MAX;
    let scalar = 2.0_f64.powf(low) as f32;
    let scale = 2.0_f64.powf(-low) as f32;
    (
        e,
        scalar,
        [q[0] * scale, q[1] * scale, q[2] * scale],
        clipped,
    )
}

fn normalized_exposure(e: f32, scalar: f32) -> f32 {
    if scalar == 0.0 || e.is_nan() {
        0.0
    } else {
        (e / 20.0 + 0.5).clamp(0.0, 1.0)
    }
}

fn solve_prepared(
    rgb: &[[f32; 3]],
    req: &Request,
) -> (Vec<[f32; 3]>, Vec<f32>, Vec<f32>, SolveStats) {
    let target_j_hk = jhk_for_ap0([req.refl; 3], req.profile);
    let mut base = Vec::with_capacity(rgb.len());
    let mut exposure = Vec::with_capacity(rgb.len());
    let mut exposure_scalar = Vec::with_capacity(rgb.len());
    let mut stats = SolveStats {
        exposure_min: f32::INFINITY,
        exposure_max: f32::NEG_INFINITY,
        base_min: f32::INFINITY,
        base_max: f32::NEG_INFINITY,
        ..SolveStats::default()
    };
    for q in rgb {
        if !finite(*q) {
            stats.non_finite_pixels += 1;
            base.push([0.0; 3]);
            exposure.push(0.0);
            exposure_scalar.push(0.0);
            continue;
        }
        let mut qq = *q;
        if qq.iter().any(|v| *v < 0.0) {
            stats.projected_pixels += 1;
            for v in &mut qq {
                *v = v.max(0.0);
            }
        }
        let (e, scalar, b, clipped) = solve_exposure(qq, req.profile, target_j_hk, req.refl);
        if clipped {
            stats.clipped_pixels += 1;
        }
        stats.exposure_min = stats.exposure_min.min(e);
        stats.exposure_max = stats.exposure_max.max(e);
        stats.exposure_sum += e as f64;
        for value in b {
            stats.base_min = stats.base_min.min(value);
            stats.base_max = stats.base_max.max(value);
            stats.base_sum += value as f64;
        }
        stats.finite_pixels += 1;
        base.push(b);
        exposure.push(normalized_exposure(e, scalar));
        exposure_scalar.push(scalar);
    }
    (base, exposure, exposure_scalar, stats)
}

fn report_from_stats(
    width: usize,
    height: usize,
    req: &Request,
    stats: &SolveStats,
    warnings: Vec<String>,
) -> Report {
    let count = (width * height) as u64;
    Report {
        width: width as u32,
        height: height as u32,
        pixel_count: count,
        profile: req.profile,
        refl: req.refl,
        blur_sigma: req.blur_sigma,
        projected_pixels: stats.projected_pixels,
        clipped_pixels: stats.clipped_pixels,
        non_finite_pixels: stats.non_finite_pixels,
        exposure_min: if stats.exposure_min.is_finite() {
            stats.exposure_min
        } else {
            0.0
        },
        exposure_max: if stats.exposure_max.is_finite() {
            stats.exposure_max
        } else {
            0.0
        },
        exposure_mean: if stats.finite_pixels > 0 {
            (stats.exposure_sum / stats.finite_pixels as f64) as f32
        } else {
            0.0
        },
        base_min: if stats.base_min.is_finite() {
            stats.base_min
        } else {
            0.0
        },
        base_max: if stats.base_max.is_finite() {
            stats.base_max
        } else {
            0.0
        },
        base_mean: if stats.finite_pixels > 0 {
            (stats.base_sum / (stats.finite_pixels as f64 * 3.0)) as f32
        } else {
            0.0
        },
        target_j_hk: jhk_for_ap0([req.refl; 3], req.profile) as f32,
        solver_status: "J_HK bisection (32 iterations)".into(),
        compute_backend: if stats.compute_backend.is_empty() {
            "wasm-cpu".into()
        } else {
            stats.compute_backend.clone()
        },
        gpu_adapter: stats.gpu_adapter.clone(),
        gpu_validation: stats.gpu_validation.clone(),
        batch_size: stats.batch_size,
        preview_transform: "ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-100nit-P3-D65_2.0".into(),
        preview_encoding: "P3-D65 JPEG, sRGB encoding".into(),
        preview_backend: if stats.preview_backend.is_empty() {
            "wasm-cpu".into()
        } else {
            stats.preview_backend.clone()
        },
        preview_transform_ms: stats.preview_transform_ms,
        warnings,
    }
}

fn srgb_encode_component(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    if value <= 0.0031308 {
        12.92 * value
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    }
}

fn display_p3_icc_profile() -> &'static [u8] {
    P3_D65_ICC.get_or_init(|| {
        let bytes = cmx::profile::DisplayProfile::cmx_display_p3(
            cmx::tag::RenderingIntent::RelativeColorimetric,
        )
        .to_bytes()
        .expect("Display P3 ICC profile")
        .into_boxed_slice();
        Box::leak(bytes)
    })
}

fn encode_preview_jpeg(width: usize, height: usize, pixels: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut encoder = ImageJpegEncoder::new_with_quality(&mut output, 95);
    encoder
        .set_icc_profile(display_p3_icc_profile().to_vec())
        .map_err(|e| e.to_string())?;
    encoder
        .write_image(pixels, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(output)
}

// Accurate CPU reference for the production WGSL preview path. The core API
// accepts ACEScg, so preserve the same AP0 -> AP1 boundary on both backends.
fn preview_rgb_for_ap0(ap0: [f32; 3]) -> [f32; 3] {
    let acescg = mat(AP0_TO_AP1, ap0);
    let xyz = modcam16_color_core::aces_output::forward(
        4,
        [acescg[0] as f64, acescg[1] as f64, acescg[2] as f64],
    );
    mat(XYZ_TO_P3, [xyz[0] as f32, xyz[1] as f32, xyz[2] as f32]).map(srgb_encode_component)
}

fn preview_bytes(rgb: impl Iterator<Item = [f32; 3]>) -> Vec<u8> {
    rgb.flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8))
        .collect()
}

fn encode_base_preview_jpeg(
    base: &[[f32; 3]],
    width: usize,
    height: usize,
) -> Result<Vec<u8>, String> {
    let pixels = preview_bytes(base.iter().map(|p| preview_rgb_for_ap0(*p)));
    encode_preview_jpeg(width, height, &pixels)
}

fn encode_exposure_preview_jpeg(
    exposure_scalar: &[f32],
    width: usize,
    height: usize,
    refl: f32,
) -> Result<Vec<u8>, String> {
    let pixels = preview_bytes(
        exposure_scalar
            .iter()
            .map(|s| preview_rgb_for_ap0([refl * *s; 3])),
    );
    encode_preview_jpeg(width, height, &pixels)
}

fn encode_exrs(
    base: &[[f32; 3]],
    exposure_norm_ev: &[f32],
    exposure: &[f32],
    width: usize,
    height: usize,
    report: &Report,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    let rb: Vec<f16> = base
        .iter()
        .flat_map(|v| {
            let ap1 = mat(AP0_TO_AP1, *v);
            [
                f16::from_f32(ap1[0]),
                f16::from_f32(ap1[1]),
                f16::from_f32(ap1[2]),
            ]
        })
        .collect();
    let re: Vec<f16> = exposure_norm_ev
        .iter()
        .map(|v| f16::from_f32(if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }))
        .collect();
    let base_exr = write_exr(
        width,
        height,
        vec![
            AnyChannel::new(
                "R",
                FlatSamples::F16(rb.iter().step_by(3).copied().collect()),
            ),
            AnyChannel::new(
                "G",
                FlatSamples::F16(rb.iter().skip(1).step_by(3).copied().collect()),
            ),
            AnyChannel::new(
                "B",
                FlatSamples::F16(rb.iter().skip(2).step_by(3).copied().collect()),
            ),
        ],
        "base",
        &report,
    )?;
    let exposure_norm_ev_exr = write_exr(
        width,
        height,
        vec![AnyChannel::new("exposure", FlatSamples::F16(re))],
        "exposure_norm-ev",
        &report,
    )?;
    let scalar: Vec<f16> = exposure.iter().map(|s| f16::from_f32(*s)).collect();
    let exposure_exr = write_exr(
        width,
        height,
        vec![
            AnyChannel::new("R", FlatSamples::F16(scalar.clone())),
            AnyChannel::new("G", FlatSamples::F16(scalar.clone())),
            AnyChannel::new("B", FlatSamples::F16(scalar)),
        ],
        "exposure",
        report,
    )?;
    Ok((base_exr, exposure_norm_ev_exr, exposure_exr))
}

fn encode_result(
    base: &[[f32; 3]],
    exposure_norm_ev: &[f32],
    exposure: &[f32],
    width: usize,
    height: usize,
    report: Report,
) -> Result<JsValue, String> {
    let (base_exr, exposure_norm_ev_exr, exposure_exr) =
        encode_exrs(base, exposure_norm_ev, exposure, width, height, &report)?;
    let base_preview = encode_base_preview_jpeg(base, width, height)?;
    let exposure_preview = encode_exposure_preview_jpeg(exposure, width, height, report.refl)?;
    payload(
        report,
        base_exr,
        exposure_norm_ev_exr,
        exposure_exr,
        base_preview,
        exposure_preview,
    )
}

fn process(mut p: Pixels, req: Request) -> Result<JsValue, String> {
    if !req.format.eq_ignore_ascii_case("dng") {
        let embedded_pair = p
            .summary
            .gamut
            .as_deref()
            .zip(p.summary.transfer.as_deref());
        p.rgb = prepare_rgb(
            std::mem::take(&mut p.rgb),
            p.width,
            p.height,
            &req,
            p.icc_profile.as_deref(),
            embedded_pair,
        )?;
    }
    let (base, exposure_norm_ev, exposure, stats) = solve_prepared(&p.rgb, &req);
    let report = report_from_stats(p.width, p.height, &req, &stats, p.summary.warnings.clone());
    encode_result(
        &base,
        &exposure_norm_ev,
        &exposure,
        p.width,
        p.height,
        report,
    )
}

/// Own the prepared raster in Rust. JavaScript reads only the active batch;
/// no full-size typed-array copy or borrowed WASM-memory view escapes.
#[wasm_bindgen]
pub struct PreparedImage {
    rgb: Vec<[f32; 3]>,
    width: u32,
    height: u32,
    warnings: Vec<String>,
    summary: Option<DecodeSummary>,
}

#[wasm_bindgen]
impl PreparedImage {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn warnings(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.warnings).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(getter)]
    pub fn summary(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.summary).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn read_pixels(&self, start: u32, count: u32) -> Result<Vec<f32>, JsValue> {
        let start = start as usize;
        let end = start
            .checked_add(count as usize)
            .filter(|end| *end <= self.rgb.len())
            .ok_or_else(|| JsValue::from_str("Prepared pixel batch is outside the image."))?;
        Ok(flat_pixels(&self.rgb[start..end]))
    }

    /// Solve directly from the Rust-owned prepared raster. This avoids copying
    /// every batch through JavaScript and back into WASM memory.
    pub fn solve_pixels(
        &self,
        start: u32,
        count: u32,
        request: JsValue,
    ) -> Result<JsValue, JsValue> {
        let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
        let start = start as usize;
        let end = start
            .checked_add(count as usize)
            .filter(|end| *end <= self.rgb.len())
            .ok_or_else(|| JsValue::from_str("Prepared pixel batch is outside the image."))?;
        solve_result_payload(&self.rgb[start..end], &req).map_err(|e| JsValue::from_str(&e))
    }
}

fn prepared_payload_rgb(
    rgb: Vec<[f32; 3]>,
    width: usize,
    height: usize,
    warnings: Vec<String>,
    summary: Option<DecodeSummary>,
) -> Result<PreparedImage, String> {
    if rgb.len() != width.saturating_mul(height) {
        return Err("Prepared RGB dimensions do not match.".into());
    }
    Ok(PreparedImage {
        rgb,
        width: width as u32,
        height: height as u32,
        warnings,
        summary,
    })
}

fn flat_to_rgb(data: Vec<f32>) -> Result<Vec<[f32; 3]>, String> {
    if data.len() % 3 != 0 {
        return Err("Prepared pixel buffer is not an RGB triple array.".into());
    }
    if data.capacity() % 3 != 0 {
        return Ok(data.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect());
    }
    let len = data.len() / 3;
    let capacity = data.capacity() / 3;
    let pointer = data.as_ptr() as *mut [f32; 3];
    std::mem::forget(data);
    // `[f32; 3]` has the same alignment and contiguous representation as
    // three f32 values. Ownership is transferred without another full raster.
    Ok(unsafe { Vec::from_raw_parts(pointer, len, capacity) })
}

fn solve_result_payload(rgb: &[[f32; 3]], req: &Request) -> Result<JsValue, String> {
    let (base, exposure_norm_ev, exposure, stats) = solve_prepared(rgb, req);
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("base"),
        &Float32Array::from(flat_pixels(&base).as_slice()).into(),
    )
    .map_err(|e| format!("base: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure"),
        &Float32Array::from(exposure_norm_ev.as_slice()).into(),
    )
    .map_err(|e| format!("exposure: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure_scalar"),
        &Float32Array::from(exposure.as_slice()).into(),
    )
    .map_err(|e| format!("exposure scalar: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("stats"),
        &serde_wasm_bindgen::to_value(&stats).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("stats: {e:?}"))?;
    Ok(object.into())
}

fn solve_chunk_payload(data: Vec<f32>, req: &Request) -> Result<JsValue, String> {
    if data.len() % 3 != 0 {
        return Err("Prepared pixel chunk must contain RGB triples.".into());
    }
    let rgb = flat_to_rgb(data)?;
    solve_result_payload(&rgb, req)
}

#[wasm_bindgen]
pub fn prepare(data: Vec<u8>, request: JsValue) -> Result<PreparedImage, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let p = parse(&data, &req.format).map_err(|e| JsValue::from_str(&e))?;
    let width = p.width;
    let height = p.height;
    let warnings = p.summary.warnings.clone();
    let rgb = if req.format.eq_ignore_ascii_case("dng") {
        p.rgb
    } else {
        let embedded_pair = p
            .summary
            .gamut
            .as_deref()
            .zip(p.summary.transfer.as_deref());
        prepare_rgb(
            p.rgb,
            width,
            height,
            &req,
            p.icc_profile.as_deref(),
            embedded_pair,
        )
        .map_err(|e| JsValue::from_str(&e))?
    };
    prepared_payload_rgb(rgb, width, height, warnings, Some(p.summary))
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn prepare_pixels(
    data: Vec<f32>,
    width: u32,
    height: u32,
    request: JsValue,
) -> Result<PreparedImage, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    if width == 0 || height == 0 || data.len() != width as usize * height as usize * 3 {
        return Err(JsValue::from_str(
            "HEIF pixel buffer dimensions do not match.",
        ));
    }
    let rgb = flat_to_rgb(data).map_err(|e| JsValue::from_str(&e))?;
    let rgb = prepare_rgb(rgb, width as usize, height as usize, &req, None, None)
        .map_err(|e| JsValue::from_str(&e))?;
    prepared_payload_rgb(rgb, width as usize, height as usize, Vec::new(), None)
        .map_err(|e| JsValue::from_str(&e))
}

/// Prepare native HEIC/HEIF samples supplied by the browser libheif bridge.
/// Empty ICC, gain-map, and Exif buffers mean that the corresponding metadata
/// was not present in the container.
#[wasm_bindgen]
pub fn prepare_heic_pixels(
    data: Vec<f32>,
    width: u32,
    height: u32,
    request: JsValue,
    icc_profile: Vec<u8>,
    gain_map: Vec<f32>,
    gain_width: u32,
    gain_height: u32,
    exif: Vec<u8>,
) -> Result<PreparedImage, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    if width == 0 || height == 0 || data.len() != width as usize * height as usize * 3 {
        return Err(JsValue::from_str(
            "HEIF pixel buffer dimensions do not match.",
        ));
    }
    let mut rgb = flat_to_rgb(data).map_err(|e| JsValue::from_str(&e))?;
    if !gain_map.is_empty() {
        // Apple gain-map primaries are Display P3 with an sRGB-like transfer
        // unless the user explicitly overrides the source interpretation.
        // Reconstruct in linear source RGB; passing the boosted encoded values
        // through an ICC device transform would violate its [0,1] domain.
        let gain_transfer = req.transfer.as_deref().unwrap_or("sRGB");
        for px in &mut rgb {
            for c in px.iter_mut() {
                *c = decode_transfer(*c, gain_transfer);
            }
        }
        rgb = apply_apple_gain_map(
            rgb,
            width as usize,
            height as usize,
            &gain_map,
            gain_width as usize,
            gain_height as usize,
            &exif,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        let gain_gamut = req.gamut.as_deref().unwrap_or("Display P3 / P3-D65");
        let prepared: Vec<[f32; 3]> = rgb
            .into_iter()
            .map(|px| source_to_ap0(px, gain_gamut))
            .collect();
        let prepared = {
            let mut value = prepared;
            blur(&mut value, width as usize, height as usize, req.blur_sigma);
            value
        };
        return prepared_payload_rgb(prepared, width as usize, height as usize, Vec::new(), None)
            .map_err(|e| JsValue::from_str(&e));
    }
    let prepared = prepare_rgb(
        rgb,
        width as usize,
        height as usize,
        &req,
        (!icc_profile.is_empty()).then_some(icc_profile.as_slice()),
        None,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    prepared_payload_rgb(prepared, width as usize, height as usize, Vec::new(), None)
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn solve_chunk(data: Vec<f32>, request: JsValue) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    solve_chunk_payload(data, &req).map_err(|e| JsValue::from_str(&e))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn gpu_probe() -> Result<JsValue, JsValue> {
    gpu::probe().await
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn gpu_solve_chunk(data: Vec<f32>, request: JsValue) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let result = gpu::solve(data, &req)
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("base"),
        &Float32Array::from(result.base.as_slice()).into(),
    )
    .map_err(|e| JsValue::from_str(&format!("base: {e:?}")))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure"),
        &Float32Array::from(result.exposure.as_slice()).into(),
    )
    .map_err(|e| JsValue::from_str(&format!("exposure: {e:?}")))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure_scalar"),
        &Float32Array::from(result.exposure_scalar.as_slice()).into(),
    )
    .map_err(|e| JsValue::from_str(&format!("exposure scalar: {e:?}")))?;
    Reflect::set(
        &object,
        &JsValue::from_str("stats"),
        &serde_wasm_bindgen::to_value(&result.stats)
            .map_err(|e| JsValue::from_str(&e.to_string()))?,
    )
    .map_err(|e| JsValue::from_str(&format!("stats: {e:?}")))?;
    Ok(object.into())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn gpu_preview_pixels(
    base: Vec<f32>,
    exposure: Vec<f32>,
    refl: f32,
) -> Result<JsValue, JsValue> {
    let (base_pixels, exposure_pixels) = gpu::preview(base, exposure, refl)
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("base"),
        &Uint8Array::from(base_pixels.as_slice()).into(),
    )
    .map_err(|e| JsValue::from_str(&format!("base preview: {e:?}")))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure"),
        &Uint8Array::from(exposure_pixels.as_slice()).into(),
    )
    .map_err(|e| JsValue::from_str(&format!("exposure preview: {e:?}")))?;
    Ok(object.into())
}

#[wasm_bindgen]
pub fn encode_outputs(
    base: Vec<f32>,
    exposure: Vec<f32>,
    exposure_scalar: Vec<f32>,
    width: u32,
    height: u32,
    request: JsValue,
    stats: JsValue,
    warnings: JsValue,
) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    if width == 0
        || height == 0
        || base.len() != width as usize * height as usize * 3
        || exposure.len() != width as usize * height as usize
        || exposure_scalar.len() != width as usize * height as usize
    {
        return Err(JsValue::from_str(
            "Output buffers do not match the image dimensions.",
        ));
    }
    let stats: SolveStats =
        serde_wasm_bindgen::from_value(stats).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let warnings: Vec<String> =
        serde_wasm_bindgen::from_value(warnings).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let base: Vec<[f32; 3]> = base.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let report = report_from_stats(width as usize, height as usize, &req, &stats, warnings);
    encode_result(
        &base,
        &exposure,
        &exposure_scalar,
        width as usize,
        height as usize,
        report,
    )
    .map_err(|e| JsValue::from_str(&e))
}

// The worker uses these separate exports so progress measures ACES forward
// processing, EXR encoding, and each JPEG compression call independently.
#[wasm_bindgen]
pub fn encode_exr_outputs(
    base: Vec<f32>,
    exposure: Vec<f32>,
    exposure_scalar: Vec<f32>,
    width: u32,
    height: u32,
    request: JsValue,
    stats: JsValue,
    warnings: JsValue,
) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let pixel_count = width as usize * height as usize;
    if width == 0
        || height == 0
        || base.len() != pixel_count * 3
        || exposure.len() != pixel_count
        || exposure_scalar.len() != pixel_count
    {
        return Err(JsValue::from_str(
            "Output buffers do not match the image dimensions.",
        ));
    }
    let stats: SolveStats =
        serde_wasm_bindgen::from_value(stats).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let warnings: Vec<String> =
        serde_wasm_bindgen::from_value(warnings).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let base: Vec<[f32; 3]> = base.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let report = report_from_stats(width as usize, height as usize, &req, &stats, warnings);
    let (base_exr, exposure_norm_ev_exr, exposure_exr) = encode_exrs(
        &base,
        &exposure,
        &exposure_scalar,
        width as usize,
        height as usize,
        &report,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    payload(
        report,
        base_exr,
        exposure_norm_ev_exr,
        exposure_exr,
        Vec::new(),
        Vec::new(),
    )
    .map_err(|e| JsValue::from_str(&e))
}

/// Build analytic report metadata without allocating or encoding full image
/// outputs. The browser worker uses this after streaming EXR rows to OPFS.
#[wasm_bindgen]
pub fn build_report(
    width: u32,
    height: u32,
    request: JsValue,
    stats: JsValue,
    warnings: JsValue,
) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let stats: SolveStats =
        serde_wasm_bindgen::from_value(stats).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let warnings: Vec<String> =
        serde_wasm_bindgen::from_value(warnings).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&report_from_stats(
        width as usize,
        height as usize,
        &req,
        &stats,
        warnings,
    ))
    .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn encode_preview_pixels(pixels: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, JsValue> {
    if width == 0 || height == 0 || pixels.len() != width as usize * height as usize * 3 {
        return Err(JsValue::from_str(
            "Preview pixels do not match the image dimensions.",
        ));
    }
    encode_preview_jpeg(width as usize, height as usize, &pixels).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn cpu_preview_ap0(pixels: &[f32]) -> Result<Vec<u8>, JsValue> {
    if pixels.len() % 3 != 0 {
        return Err(JsValue::from_str("Invalid AP0 preview buffer."));
    }
    Ok(preview_bytes(
        pixels
            .chunks_exact(3)
            .map(|p| preview_rgb_for_ap0([p[0], p[1], p[2]])),
    ))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn gpu_preview_ap0(pixels: Vec<f32>) -> Result<Vec<u8>, JsValue> {
    gpu::preview_ap0(pixels)
        .await
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn cpu_preview_pixels(
    base: Vec<f32>,
    exposure_scalar: Vec<f32>,
    refl: f32,
) -> Result<JsValue, JsValue> {
    if base.len() != exposure_scalar.len() * 3 || !refl.is_finite() || refl <= 0.0 {
        return Err(JsValue::from_str("Invalid preview input buffers or Refl."));
    }
    let base = preview_bytes(
        base.chunks_exact(3)
            .map(|p| preview_rgb_for_ap0([p[0], p[1], p[2]])),
    );
    let exposure = preview_bytes(
        exposure_scalar
            .iter()
            .map(|s| preview_rgb_for_ap0([refl * *s; 3])),
    );
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("base"),
        &Uint8Array::from(base.as_slice()).into(),
    )?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure"),
        &Uint8Array::from(exposure.as_slice()).into(),
    )?;
    Ok(object.into())
}

#[wasm_bindgen]
pub fn decompose(data: Vec<u8>, request: JsValue) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let p = parse(&data, &req.format).map_err(|e| JsValue::from_str(&e))?;
    process(p, req).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn decompose_pixels(
    data: Vec<f32>,
    width: u32,
    height: u32,
    request: JsValue,
) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    if width == 0 || height == 0 || data.len() != width as usize * height as usize * 3 {
        return Err(JsValue::from_str(
            "HEIF pixel buffer dimensions do not match.",
        ));
    }
    let rgb = data.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let p = Pixels {
        width: width as usize,
        height: height as usize,
        rgb,
        summary: DecodeSummary {
            format: req.format.clone(),
            width,
            height,
            gamut: req.gamut.clone(),
            transfer: req.transfer.clone(),
            metadata_source: Some("libheif-js".into()),
            automatic_icc: false,
            embedded_available: false,
            orientation: None,
            camera_model: None,
            photometry: None,
            bit_depth: None,
            compression: None,
            dng_transform: None,
            warnings: Vec::new(),
        },
        icc_profile: None,
    };
    process(p, req).map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dng_demosaic_preserves_signed_and_hdr_samples() {
        let mosaic = (0..256)
            .map(|i| {
                if i == 0 {
                    -1.0
                } else if i == 255 {
                    8.0
                } else {
                    4.0
                }
            })
            .collect::<Vec<_>>();
        let rgb = dng_demosaic(&mosaic, 16, 16, &[0, 1, 1, 2], (2, 2));
        assert!(rgb.iter().flatten().any(|v| *v > 1.0));
        assert!(rgb.iter().flatten().any(|v| *v < 0.0));
    }

    #[test]
    fn dng_orientation_rotates_quarter_turn() {
        let input = vec![
            [1.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [5.0, 0.0, 0.0],
            [6.0, 0.0, 0.0],
        ];
        let (rotated, width, height) = rotate_dng(input, 3, 2, 6);
        assert_eq!((width, height), (2, 3));
        assert_eq!(
            rotated.iter().map(|p| p[0]).collect::<Vec<_>>(),
            vec![4.0, 1.0, 5.0, 2.0, 6.0, 3.0]
        );
    }

    #[test]
    fn dng_vignette_uses_normalized_coordinates() {
        let mut rgb = vec![[1.0; 3]; 2 * 2];
        let mut parameters = Vec::new();
        // gain = 1 + q, with the center at the image midpoint.  For a 2x2
        // raster every corner is the farthest pixel, so q = 1.
        parameters.extend_from_slice(&1.0_f64.to_be_bytes());
        parameters.extend_from_slice(&[0; 32]);
        parameters.extend_from_slice(&0.5_f64.to_be_bytes());
        parameters.extend_from_slice(&0.5_f64.to_be_bytes());
        dng_opcode_vignette(&mut rgb, 2, 2, &parameters).expect("valid vignette parameters");
        assert!((rgb[0][0] - 2.0).abs() < 1.0e-6);
    }

    #[test]
    fn dng_dual_illuminant_interpolates_in_inverse_cct() {
        let first = identity3();
        let second = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
        let (matrix, weight) = interpolate_matrix(
            first,
            Some(second),
            Some(2856.0),
            Some(6504.0),
            Some((2856.0_f64 * 6504.0).sqrt()),
        );
        assert!(weight > 0.0 && weight < 1.0);
        assert!((matrix[0][0] - (2.0 - weight)).abs() < 1.0e-6);
        assert_eq!(matrix[1][2], 0.0);
        let (at_first, first_weight) = interpolate_matrix(
            first,
            Some(second),
            Some(2856.0),
            Some(6504.0),
            Some(2856.0),
        );
        let (at_second, second_weight) = interpolate_matrix(
            first,
            Some(second),
            Some(2856.0),
            Some(6504.0),
            Some(6504.0),
        );
        assert_eq!(first_weight, 1.0);
        assert_eq!(second_weight, 0.0);
        assert_eq!(at_first, first);
        assert_eq!(at_second, second);
    }

    #[test]
    fn dng_cat02_and_color_matrix_white_balance_once() {
        let adapted_d65_white = mat(D50_TO_D65_CAT02, D50_WHITE);
        assert!(adapted_d65_white
            .iter()
            .zip(D65_WHITE)
            .all(|(actual, expected)| (actual - expected).abs() < 2.0e-4));

        // This is the same no-ForwardMatrix construction used for an iPhone
        // DNG: ColorMatrix is XYZ-to-camera, while AsShotNeutral is a camera
        // neutral sample.  The integrated transform must send that sample to
        // the D65/AP0 neutral without a second per-pixel WB multiplication.
        let color_matrix = [
            [1.208984971, -0.5616751313, -0.2423728853],
            [-0.4658203721, 1.533753872, -0.05347846821],
            [-0.05024547502, 0.1744534373, 0.5932850242],
        ];
        let camera_neutral = [0.4369066656, 1.0, 0.53194803];
        let camera_to_xyz = invert3(color_matrix).expect("camera matrix is invertible");
        let source_white = mat(camera_to_xyz, camera_neutral);
        let adaptation = bradford_adaptation(source_white, D50_WHITE).expect("valid white");
        let camera_to_xyz_d50 = mat_mul(adaptation, camera_to_xyz);
        let d50_neutral = mat(camera_to_xyz_d50, camera_neutral);
        assert!(d50_neutral
            .iter()
            .zip(D50_WHITE)
            .all(|(actual, expected)| (actual - expected).abs() < 2.0e-5));

        let camera_to_ap0 = mat_mul(XYZ_D65_TO_AP0, mat_mul(D50_TO_D65_CAT02, camera_to_xyz_d50));
        let mut pixel = vec![camera_neutral];
        apply_dng_camera_transform(&mut pixel, camera_to_ap0, 1.0);
        assert!(pixel[0].iter().all(|value| (*value - 1.0).abs() < 5.0e-4));

        // A second WB would turn the neutral into a strongly chromatic sample;
        // retain this assertion as a guard against reintroducing that cast.
        let double_wb = mat(camera_to_ap0, [1.0, 1.0, 1.0]);
        assert!((double_wb[0] - double_wb[2]).abs() > 0.2);
    }

    #[test]
    fn d65_rgb_white_maps_to_the_aces_ap0_white() {
        let ap0 = source_to_ap0([1.0; 3], "Rec.709 / sRGB");
        // RGB white is represented as unit AP0 values. The corresponding
        // ACES D60 white tristimulus is an XYZ-space quantity, not the AP0
        // RGB result asserted here.
        let expected = [1.0, 1.0, 1.0];
        assert!(ap0
            .iter()
            .zip(expected)
            .all(|(actual, expected)| (actual - expected).abs() < 2.0e-4));
    }

    #[test]
    fn unsupported_mandatory_opcode_is_rejected_and_optional_is_reported() {
        let mut warnings = Vec::new();
        let mandatory = [DngOpcode {
            id: 9,
            flags: 0,
            parameters: Vec::new(),
        }];
        let error =
            validate_dng_opcode_stage(Some(&mandatory), "OpcodeList2", &mut warnings, false)
                .unwrap_err();
        assert!(error.contains("mandatory"));
        let optional = [DngOpcode {
            id: 9,
            flags: 1,
            parameters: Vec::new(),
        }];
        validate_dng_opcode_stage(Some(&optional), "OpcodeList3", &mut warnings, true)
            .expect("optional opcode may be skipped");
        assert!(warnings.iter().any(|warning| warning.contains("optional")));
    }

    #[test]
    #[ignore = "full-resolution fixture development is a release-performance check"]
    fn supplied_dngs_develop_when_fixtures_are_available() {
        let expected = [
            ("IMG_9983.DNG", 1, (4032, 3024)),
            ("IMG_9984.DNG", 1, (4032, 3024)),
            ("IMG_9985.DNG", 6, (3024, 4032)),
            ("IMG_9986.DNG", 6, (3024, 4032)),
        ];
        let mut saw_negative = false;
        let mut saw_above_one = false;
        for (name, orientation, dimensions) in expected {
            let Ok(data) = std::fs::read(format!("../../{name}")) else {
                return;
            };
            let started = std::time::Instant::now();
            let developed = parse_dng(&data).expect("supplied DNG should develop");
            let values = developed.rgb.iter().flatten();
            let mut negative = 0usize;
            let mut above_one = 0usize;
            for value in values {
                assert!(value.is_finite());
                negative += usize::from(*value < 0.0);
                above_one += usize::from(*value > 1.0);
            }
            eprintln!(
                "{name}: {}x{} orientation={} negative={} above_one={} elapsed={:?}",
                developed.width,
                developed.height,
                developed.summary.orientation.unwrap_or(0),
                negative,
                above_one,
                started.elapsed()
            );
            assert_eq!((developed.width, developed.height), dimensions);
            assert!(developed.summary.embedded_available);
            assert_eq!(developed.summary.orientation, Some(orientation));
            assert_eq!(
                developed.summary.camera_model.as_deref(),
                Some("iPhone 13 mini")
            );
            assert!(developed
                .summary
                .photometry
                .as_deref()
                .is_some_and(|value| value.contains("Bayer CFA")));
            assert_eq!(developed.summary.bit_depth, Some(16));
            assert_eq!(
                developed.summary.compression.as_deref(),
                Some("lossless JPEG")
            );
            saw_negative |= negative > 0;
            saw_above_one |= above_one > 0;
        }
        assert!(
            saw_negative && saw_above_one,
            "DNG development must retain signed/HDR AP0 values"
        );
    }

    #[test]
    fn exposure_solver_preserves_hk_target_for_positive_pixel() {
        let target = jhk_for_ap0([0.5; 3], 1);
        let (exposure, _scalar, base, clipped) = solve_exposure([0.15, 0.25, 0.4], 1, target, 0.5);
        assert!(!clipped);
        assert!((-10.0..=10.0).contains(&exposure));
        let solved = jhk_for_ap0(base, 1);
        assert!((solved - target).abs() < 1.0e-3, "{solved} vs {target}");
    }

    #[test]
    fn zero_pixel_keeps_neutral_base_and_zero_exposure() {
        let (exposure, _scalar, base, clipped) = solve_exposure([0.0; 3], 1, 0.0, 0.5);
        assert_eq!(exposure, 0.0);
        assert_eq!(base, [0.5; 3]);
        assert!(!clipped);
    }

    #[test]
    fn grayscale_png_samples_are_replicated() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), 1, 1);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("PNG header");
            writer.write_image_data(&[128]).expect("PNG pixel");
        }
        let pixels = parse_png(&bytes).expect("valid PNG");
        assert_eq!(pixels.rgb.len(), 1);
        assert!((pixels.rgb[0][0] - pixels.rgb[0][1]).abs() < 1.0e-6);
        assert!((pixels.rgb[0][1] - pixels.rgb[0][2]).abs() < 1.0e-6);
    }
}
