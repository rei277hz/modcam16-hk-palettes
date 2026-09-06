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
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;
use ultrahdr_core::metadata::apple::{from_apple_headroom, parse_exif_for_apple_hdr};

mod gpu;

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
const XYZ_D65_TO_AP0: [[f32; 3]; 3] = [
    [1.049811, 0.0, -0.0000975],
    [-0.495903, 1.373314, 0.09824],
    [0.0, 0.0, 0.918224],
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
    pub warnings: Vec<String>,
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
fn icc_rgb_to_ap0(rgb: &[[f32; 3]], icc: &[u8]) -> Result<Vec<[f32; 3]>, String> {
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
    let flat = flat_pixels(rgb);
    let mut xyz = vec![0.0_f32; flat.len()];
    for (src, dst) in flat.chunks_exact(3).zip(xyz.chunks_exact_mut(3)) {
        transform
            .transform_f32(src, dst)
            .map_err(|e| e.to_string())?;
    }
    let mut ap0 = Vec::with_capacity(rgb.len());
    for chunk in xyz.chunks_exact(3) {
        let d50 = [chunk[0], chunk[1], chunk[2]];
        let d65 = mat(D50_TO_D65_CAT02, d50);
        ap0.push(mat(XYZ_D65_TO_AP0, d65));
    }
    Ok(ap0)
}
fn decode_icc_profile_to_ap0(rgb: Vec<[f32; 3]>, icc: &[u8]) -> Result<Vec<[f32; 3]>, String> {
    icc_rgb_to_ap0(&rgb, icc)
}
fn prepare_rgb(
    mut rgb: Vec<[f32; 3]>,
    width: usize,
    height: usize,
    req: &Request,
    icc_profile: Option<&[u8]>,
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
        rgb = decode_icc_profile_to_ap0(rgb, icc)?;
    } else {
        return Err(
            "This image does not provide a usable embedded ICC profile; select a gamut and transfer manually.".into(),
        );
    }
    blur(&mut rgb, width, height, req.blur_sigma);
    Ok(rgb)
}

fn srgb_eotf(value: f32) -> f32 {
    let a = value.abs();
    let linear = if a <= 0.04045 { a / 12.92 } else { ((a + 0.055) / 1.055).powf(2.4) };
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
    let info = parse_exif_for_apple_hdr(exif)
        .ok_or_else(|| "Apple HDR gain-map metadata does not contain a usable MakerNote headroom value.".to_string())?;
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
            let gain_linear = (g00 * (1.0 - fx) + g01 * fx) * (1.0 - fy)
                + (g10 * (1.0 - fx) + g11 * fx) * fy;
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
            warnings: if automatic_icc {
                Vec::new()
            } else if info.icc_profile.is_some() {
                vec!["Embedded ICC profile is malformed or unsupported; select gamut and transfer manually.".into()]
            } else if cicp.is_some() {
                vec!["PNG exposes cICP metadata but no usable ICC profile; select gamut and transfer manually.".into()]
            } else {
                vec!["PNG does not expose a usable embedded ICC profile; select gamut and transfer manually.".into()]
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
fn parse_jpeg_inner(data: &[u8]) -> Result<Pixels, String> {
    let mut d = JpegDecoder::new(Cursor::new(data));
    d.read_info().map_err(|e| e.to_string())?;
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
            "Embedded ICC profile is malformed or unsupported; select gamut and transfer manually."
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
            warnings,
        },
    })
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
            warnings: if detected_gamut.is_none() {
                vec!["EXR chromaticities are missing or unsupported; select gamut and transfer manually.".into()]
            } else {
                Vec::new()
            },
        },
    })
}
fn parse(data: &[u8], format: &str) -> Result<Pixels, String> {
    match format.to_ascii_lowercase().as_str() {
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
            AttributeValue::Text(Text::new_or_panic(if component == "exposure_rgb" {
                "RGB=(s,s,s); s=2^(normalized_exposure*20-10); linear scalar"
            } else {
                "normalized_exposure=clamp(log2(s),-10,10)/20+0.5"
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

fn parse_request(value: JsValue) -> Result<Request, String> {
    let req: Request = serde_wasm_bindgen::from_value(value).map_err(|e| e.to_string())?;
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
    exposure: Vec<u8>,
    exposure_rgb: Vec<u8>,
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
        &JsValue::from_str("exposure_exr"),
        &Uint8Array::from(exposure.as_slice()).into(),
    )
    .map_err(|e| format!("exposure: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("exposure_rgb_exr"),
        &Uint8Array::from(exposure_rgb.as_slice()).into(),
    )
    .map_err(|e| format!("exposure RGB: {e:?}"))?;
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

fn solve_exposure(q: [f32; 3], profile: u32, target: f64, refl: f32) -> (f32, [f32; 3], bool) {
    if q.iter().all(|v| *v == 0.0) {
        return (0.0, [refl; 3], false);
    }
    let mut low = -20.0_f64;
    let mut high = 20.0_f64;
    let scale_low = 2.0_f64.powf(-low) as f32;
    let low_j = jhk_for_ap0(
        [q[0] * scale_low, q[1] * scale_low, q[2] * scale_low],
        profile,
    );
    let scale_high = 2.0_f64.powf(-high);
    let high_j = jhk_for_ap0(
        [
            q[0] * scale_high as f32,
            q[1] * scale_high as f32,
            q[2] * scale_high as f32,
        ],
        profile,
    );
    // Increasing exposure lowers the base and therefore lowers J_HK. If the
    // finite root is outside the serializable range, retain the endpoint and
    // report that clipping occurred.
    let mut clipped = false;
    if low_j < target {
        clipped = true;
        low = -10.0;
    }
    if high_j > target {
        clipped = true;
        high = 10.0;
    }
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
        // The broad root search did not bracket the target. Keep a finite
        // exposure and make the lossy endpoint visible in the report.
        clipped = true;
        low = if low_j < target { -10.0 } else { 10.0 };
    }
    clipped |= low < EXPOSURE_MIN as f64 || low > EXPOSURE_MAX as f64;
    let e = low.clamp(EXPOSURE_MIN as f64, EXPOSURE_MAX as f64) as f32;
    let scale = 2.0_f64.powf(-e as f64) as f32;
    (e, [q[0] * scale, q[1] * scale, q[2] * scale], clipped)
}

fn solve_prepared(rgb: &[[f32; 3]], req: &Request) -> (Vec<[f32; 3]>, Vec<f32>, SolveStats) {
    let target_j_hk = jhk_for_ap0([req.refl; 3], req.profile);
    let mut base = Vec::with_capacity(rgb.len());
    let mut exposure = Vec::with_capacity(rgb.len());
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
            continue;
        }
        let mut qq = *q;
        if qq.iter().any(|v| *v < 0.0) {
            stats.projected_pixels += 1;
            for v in &mut qq {
                *v = v.max(0.0);
            }
        }
        let (e, b, clipped) = solve_exposure(qq, req.profile, target_j_hk, req.refl);
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
        exposure.push((e / 20.0 + 0.5).clamp(0.0, 1.0));
    }
    (base, exposure, stats)
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
        preview_encoding: "Display P3-D65 primaries / sRGB encoding / JPEG".into(),
        preview_backend: if stats.preview_backend.is_empty() { "wasm-cpu".into() } else { stats.preview_backend.clone() },
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

fn exposure_scalar(normalized: f32) -> f32 {
    2.0_f32.powf(normalized * 20.0 - 10.0)
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
    exposure: &[f32],
    width: usize,
    height: usize,
    refl: f32,
) -> Result<Vec<u8>, String> {
    let pixels = preview_bytes(
        exposure
            .iter()
            .map(|e| preview_rgb_for_ap0([refl * exposure_scalar(*e); 3])),
    );
    encode_preview_jpeg(width, height, &pixels)
}

fn encode_exrs(
    base: &[[f32; 3]],
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
    let re: Vec<f16> = exposure.iter().map(|v| f16::from_f32(*v)).collect();
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
    let exposure_exr = write_exr(
        width,
        height,
        vec![AnyChannel::new("exposure", FlatSamples::F16(re))],
        "exposure",
        &report,
    )?;
    let scalar: Vec<f16> = exposure.iter()
        .map(|e| f16::from_f32(exposure_scalar(*e)))
        .collect();
    let exposure_rgb_exr = write_exr(
        width, height,
        vec![
            AnyChannel::new("R", FlatSamples::F16(scalar.clone())),
            AnyChannel::new("G", FlatSamples::F16(scalar.clone())),
            AnyChannel::new("B", FlatSamples::F16(scalar)),
        ],
        "exposure_rgb", report,
    )?;
    Ok((base_exr, exposure_exr, exposure_rgb_exr))
}

fn encode_result(
    base: &[[f32; 3]],
    exposure: &[f32],
    width: usize,
    height: usize,
    report: Report,
) -> Result<JsValue, String> {
    let (base_exr, exposure_exr, exposure_rgb_exr) = encode_exrs(base, exposure, width, height, &report)?;
    let base_preview = encode_base_preview_jpeg(base, width, height)?;
    let exposure_preview = encode_exposure_preview_jpeg(exposure, width, height, report.refl)?;
    payload(
        report,
        base_exr,
        exposure_exr,
        exposure_rgb_exr,
        base_preview,
        exposure_preview,
    )
}

fn process(mut p: Pixels, req: Request) -> Result<JsValue, String> {
    p.rgb = prepare_rgb(
        std::mem::take(&mut p.rgb),
        p.width,
        p.height,
        &req,
        p.icc_profile.as_deref(),
    )?;
    let (base, exposure, stats) = solve_prepared(&p.rgb, &req);
    let report = report_from_stats(p.width, p.height, &req, &stats, p.summary.warnings.clone());
    encode_result(&base, &exposure, p.width, p.height, report)
}

fn prepared_payload(
    pixels: Vec<f32>,
    width: usize,
    height: usize,
    warnings: Vec<String>,
) -> Result<JsValue, String> {
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("width"),
        &JsValue::from_f64(width as f64),
    )
    .map_err(|e| format!("width: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("height"),
        &JsValue::from_f64(height as f64),
    )
    .map_err(|e| format!("height: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("pixels"),
        &Float32Array::from(pixels.as_slice()).into(),
    )
    .map_err(|e| format!("pixels: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("warnings"),
        &serde_wasm_bindgen::to_value(&warnings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("warnings: {e:?}"))?;
    Ok(object.into())
}

fn solve_chunk_payload(data: Vec<f32>, req: &Request) -> Result<JsValue, String> {
    if data.len() % 3 != 0 {
        return Err("Prepared pixel chunk must contain RGB triples.".into());
    }
    let rgb: Vec<[f32; 3]> = data.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let (base, exposure, stats) = solve_prepared(&rgb, req);
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
        &Float32Array::from(exposure.as_slice()).into(),
    )
    .map_err(|e| format!("exposure: {e:?}"))?;
    Reflect::set(
        &object,
        &JsValue::from_str("stats"),
        &serde_wasm_bindgen::to_value(&stats).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("stats: {e:?}"))?;
    Ok(object.into())
}

#[wasm_bindgen]
pub fn prepare(data: Vec<u8>, request: JsValue) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let p = parse(&data, &req.format).map_err(|e| JsValue::from_str(&e))?;
    let width = p.width;
    let height = p.height;
    let warnings = p.summary.warnings.clone();
    let rgb = prepare_rgb(p.rgb, width, height, &req, p.icc_profile.as_deref())
        .map_err(|e| JsValue::from_str(&e))?;
    prepared_payload(flat_pixels(&rgb), width, height, warnings).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn prepare_pixels(
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
    let rgb: Vec<[f32; 3]> = data.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let rgb = prepare_rgb(rgb, width as usize, height as usize, &req, None)
        .map_err(|e| JsValue::from_str(&e))?;
    prepared_payload(
        flat_pixels(&rgb),
        width as usize,
        height as usize,
        Vec::new(),
    )
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
) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    if width == 0 || height == 0 || data.len() != width as usize * height as usize * 3 {
        return Err(JsValue::from_str("HEIF pixel buffer dimensions do not match."));
    }
    let mut rgb: Vec<[f32; 3]> = data.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
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
        return prepared_payload(flat_pixels(&prepared), width as usize, height as usize, Vec::new())
            .map_err(|e| JsValue::from_str(&e));
    }
    let prepared = prepare_rgb(
        rgb,
        width as usize,
        height as usize,
        &req,
        (!icc_profile.is_empty()).then_some(icc_profile.as_slice()),
    )
    .map_err(|e| JsValue::from_str(&e))?;
    prepared_payload(flat_pixels(&prepared), width as usize, height as usize, Vec::new())
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
    encode_result(&base, &exposure, width as usize, height as usize, report)
        .map_err(|e| JsValue::from_str(&e))
}

// The worker uses these separate exports so progress measures ACES forward
// processing, EXR encoding, and each JPEG compression call independently.
#[wasm_bindgen]
pub fn encode_exr_outputs(
    base: Vec<f32>,
    exposure: Vec<f32>,
    width: u32,
    height: u32,
    request: JsValue,
    stats: JsValue,
    warnings: JsValue,
) -> Result<JsValue, JsValue> {
    let req = parse_request(request).map_err(|e| JsValue::from_str(&e))?;
    let pixel_count = width as usize * height as usize;
    if width == 0 || height == 0 || base.len() != pixel_count * 3 || exposure.len() != pixel_count {
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
    let (base_exr, exposure_exr, exposure_rgb_exr) =
        encode_exrs(&base, &exposure, width as usize, height as usize, &report)
            .map_err(|e| JsValue::from_str(&e))?;
    payload(report, base_exr, exposure_exr, exposure_rgb_exr, Vec::new(), Vec::new())
        .map_err(|e| JsValue::from_str(&e))
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
pub fn cpu_preview_pixels(
    base: Vec<f32>,
    exposure: Vec<f32>,
    refl: f32,
) -> Result<JsValue, JsValue> {
    if base.len() != exposure.len() * 3 || !refl.is_finite() || refl <= 0.0 {
        return Err(JsValue::from_str("Invalid preview input buffers or Refl."));
    }
    let base = preview_bytes(
        base.chunks_exact(3)
            .map(|p| preview_rgb_for_ap0([p[0], p[1], p[2]])),
    );
    let exposure = preview_bytes(
        exposure
            .iter()
            .map(|e| preview_rgb_for_ap0([refl * exposure_scalar(*e); 3])),
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
    fn exposure_solver_preserves_hk_target_for_positive_pixel() {
        let target = jhk_for_ap0([0.5; 3], 1);
        let (exposure, base, clipped) = solve_exposure([0.15, 0.25, 0.4], 1, target, 0.5);
        assert!(!clipped);
        assert!((-10.0..=10.0).contains(&exposure));
        let solved = jhk_for_ap0(base, 1);
        assert!((solved - target).abs() < 1.0e-3, "{solved} vs {target}");
    }

    #[test]
    fn zero_pixel_keeps_neutral_base_and_zero_exposure() {
        let (exposure, base, clipped) = solve_exposure([0.0; 3], 1, 0.0, 0.5);
        assert_eq!(exposure, 0.0);
        assert_eq!(base, [0.5; 3]);
        assert!(!clipped);
    }

    #[test]
    fn exposure_rgb_output_uses_direct_scalar_encoding() {
        assert!((exposure_scalar(0.5) - 1.0).abs() < 1.0e-6);
        assert!((exposure_scalar(0.75) - 32.0).abs() < 1.0e-5);
        assert!((exposure_scalar(0.0) - 0.0009765625).abs() < 1.0e-9);
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
