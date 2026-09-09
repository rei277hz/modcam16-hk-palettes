use wasm_bindgen::prelude::*;

const MAX_EDGE: usize = 2048;

struct AreaPreview {
    source_width: usize,
    source_height: usize,
    width: usize,
    height: usize,
    source_row: usize,
    output_row: usize,
    horizontal: Vec<[f64; 3]>,
    accumulated: Vec<[f64; 3]>,
}

impl AreaPreview {
    fn new(width: usize, height: usize) -> Result<Self, String> {
        Self::new_with_max_edge(width, height, MAX_EDGE)
    }

    fn new_with_max_edge(width: usize, height: usize, max_edge: usize) -> Result<Self, String> {
        if width == 0 || height == 0 || width > 65535 || height > 65535 {
            return Err("Invalid JPEG preview dimensions.".into());
        }
        let longest = width.max(height);
        let scaled = |value: usize| {
            if longest <= max_edge {
                value
            } else {
                ((value as u64 * max_edge as u64 + longest as u64 / 2) / longest as u64).max(1)
                    as usize
            }
        };
        let (output_width, output_height) = (scaled(width), scaled(height));
        Ok(Self {
            source_width: width,
            source_height: height,
            width: output_width,
            height: output_height,
            source_row: 0,
            output_row: 0,
            horizontal: vec![[0.0; 3]; output_width],
            accumulated: vec![[0.0; 3]; output_width],
        })
    }

    fn append(
        &mut self,
        count: usize,
        sample: impl Fn(usize) -> [f32; 3],
    ) -> Result<Vec<f32>, String> {
        if count % self.source_width != 0
            || count / self.source_width > self.source_height - self.source_row
        {
            return Err("Display preview batch must contain complete source rows.".into());
        }
        let mut output = Vec::new();
        for row in 0..count / self.source_width {
            // Integer overlap coordinates avoid gaps at fractional pixel or
            // batch boundaries. Keep scene-linear AP0, including HDR and
            // negative values, until the area average is fully accumulated.
            for (x, rgb) in self.horizontal.iter_mut().enumerate() {
                *rgb = [0.0; 3];
                let mut left = x as u64 * self.source_width as u64;
                let right = left + self.source_width as u64;
                while left < right {
                    let source_x = (left / self.width as u64) as usize;
                    let stop = right.min((source_x as u64 + 1) * self.width as u64);
                    let weight = (stop - left) as f64 / self.source_width as f64;
                    let value = sample(row * self.source_width + source_x);
                    for c in 0..3 {
                        rgb[c] += value[c] as f64 * weight;
                    }
                    left = stop;
                }
            }
            let mut top = self.source_row as u64 * self.height as u64;
            let bottom = top + self.height as u64;
            while top < bottom {
                let boundary = (self.output_row as u64 + 1) * self.source_height as u64;
                let stop = bottom.min(boundary);
                let weight = (stop - top) as f64 / self.source_height as f64;
                for (sum, rgb) in self.accumulated.iter_mut().zip(&self.horizontal) {
                    for c in 0..3 {
                        sum[c] += rgb[c] * weight;
                    }
                }
                if stop == boundary {
                    for rgb in &mut self.accumulated {
                        output.extend(rgb.map(|v| v as f32));
                        *rgb = [0.0; 3];
                    }
                    self.output_row += 1;
                }
                top = stop;
            }
            self.source_row += 1;
        }
        Ok(output)
    }

    fn append_rgb(&mut self, pixels: &[f32]) -> Result<Vec<f32>, String> {
        if pixels.len() % 3 != 0 {
            return Err("Invalid AP0 RGB buffer.".into());
        }
        self.append(pixels.len() / 3, |i| {
            [pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]
        })
    }

    fn append_exposure(&mut self, exposure_scalar: &[f32], refl: f32) -> Result<Vec<f32>, String> {
        if !refl.is_finite() || refl <= 0.0 {
            return Err("Invalid preview Refl.".into());
        }
        // Match the full-size preview's scene-linear neutral AP0 canvas.
        // Average Refl * s, never norm EV or tone-mapped RGB.
        self.append(exposure_scalar.len(), |i| [refl * exposure_scalar[i]; 3])
    }

    fn finish(&self) -> Result<(), String> {
        if self.source_row != self.source_height || self.output_row != self.height {
            return Err("Display preview is missing source rows.".into());
        }
        Ok(())
    }
}

#[wasm_bindgen]
pub struct DisplayPreview {
    inner: AreaPreview,
}

#[wasm_bindgen]
impl DisplayPreview {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<DisplayPreview, JsValue> {
        AreaPreview::new(width as usize, height as usize)
            .map(|inner| Self { inner })
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width as u32
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height as u32
    }
    pub fn append_rgb(&mut self, pixels: &[f32]) -> Result<Vec<f32>, JsValue> {
        self.inner
            .append_rgb(pixels)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn append_exposure(&mut self, pixels: &[f32], refl: f32) -> Result<Vec<f32>, JsValue> {
        self.inner
            .append_exposure(pixels, refl)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn finish(&self) -> Result<(), JsValue> {
        self.inner.finish().map_err(|e| JsValue::from_str(&e))
    }
}

/// Construct a preview with a caller-selected longest-edge cap. Source
/// previews use a smaller cap than decomposition output previews.
#[wasm_bindgen]
pub fn new_bounded_display_preview(
    width: u32,
    height: u32,
    max_edge: u32,
) -> Result<DisplayPreview, JsValue> {
    let max_edge = max_edge as usize;
    if max_edge == 0 {
        return Err(JsValue::from_str("Preview edge cap must be positive."));
    }
    AreaPreview::new_with_max_edge(width as usize, height as usize, max_edge)
        .map(|inner| DisplayPreview { inner })
        .map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_dimensions_without_upscaling() {
        for (w, h, expected) in [
            (6000, 4000, (2048, 1365)),
            (4000, 6000, (1365, 2048)),
            (6000, 6000, (2048, 2048)),
            (6000, 1, (2048, 1)),
            (1, 6000, (1, 2048)),
            (37, 23, (37, 23)),
        ] {
            let preview = AreaPreview::new(w, h).unwrap();
            assert_eq!((preview.width, preview.height), expected);
            assert!(preview.accumulated.len() <= MAX_EDGE);
        }
    }

    #[test]
    fn preserves_small_images_hdr_and_negative_ap0_values() {
        let pixels: Vec<f32> = (0..768).map(|v| v as f32 / 32.0 - 5.0).collect();
        let mut preview = AreaPreview::new(16, 16).unwrap();
        assert_eq!(preview.append_rgb(&pixels).unwrap(), pixels);
        preview.finish().unwrap();
    }

    #[test]
    fn averages_ap0_before_the_nonlinear_aces_transform() {
        let width = 4096;
        let pixels: Vec<f32> = (0..width * 2)
            .flat_map(|i| if i % 2 == 0 { [0.0; 3] } else { [16.0; 3] })
            .collect();
        let mut whole = AreaPreview::new(width, 2).unwrap();
        let reduced = whole.append_rgb(&pixels).unwrap();
        assert!(reduced.iter().all(|&v| v == 8.0));
        let mut split = AreaPreview::new(width, 2).unwrap();
        assert!(split.append_rgb(&pixels[..width * 3]).unwrap().is_empty());
        assert_eq!(split.append_rgb(&pixels[width * 3..]).unwrap(), reduced);
        let expected = super::super::preview_rgb_for_ap0([8.0; 3]);
        let low = super::super::preview_rgb_for_ap0([0.0; 3]);
        let high = super::super::preview_rgb_for_ap0([16.0; 3]);
        assert!((expected[0] - (low[0] + high[0]) / 2.0).abs() > 0.1);
        let jpeg =
            super::super::encode_base_preview_jpeg(&vec![[8.0; 3]; whole.width], whole.width, 1)
                .unwrap();
        let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(jpeg));
        let decoded = decoder.decode().unwrap();
        assert_eq!(
            decoder.icc_profile().unwrap(),
            super::super::display_p3_icc_profile()
        );
        for (i, &value) in decoded.iter().enumerate() {
            assert!((value as f32 - (expected[i % 3] * 255.0).round()).abs() <= 2.0);
        }
    }

    #[test]
    fn exposure_averages_linear_canvas_not_normalized_ev() {
        let exposure: Vec<f32> = (0..4096)
            .map(|i| if i % 2 == 0 { 1.0 } else { 1.5 })
            .collect();
        let mut preview = AreaPreview::new(4096, 1).unwrap();
        let output = preview.append_exposure(&exposure, 0.5).unwrap();
        assert!(output.iter().all(|&v| (v - 0.625).abs() < 1e-6));
        preview.finish().unwrap();
    }

    #[test]
    fn fractional_resize_matches_area_reference_across_batches() {
        let (width, height) = (3001, 11);
        let pixels: Vec<f32> = (0..width * height * 3)
            .map(|i| ((i * 137) % 256) as f32 / 8.0 - 5.0)
            .collect();
        let mut preview = AreaPreview::new(width, height).unwrap();
        let mut reduced = Vec::new();
        for rows in pixels.chunks(width * 3 * 2) {
            reduced.extend(preview.append_rgb(rows).unwrap());
        }
        preview.finish().unwrap();
        for y in 0..preview.height {
            for x in 0..preview.width {
                let (left, right) = (
                    x as f64 * width as f64 / preview.width as f64,
                    (x + 1) as f64 * width as f64 / preview.width as f64,
                );
                let (top, bottom) = (
                    y as f64 * height as f64 / preview.height as f64,
                    (y + 1) as f64 * height as f64 / preview.height as f64,
                );
                for c in 0..3 {
                    let mut sum = 0.0;
                    for sy in top.floor() as usize..(bottom.ceil() as usize).min(height) {
                        for sx in left.floor() as usize..(right.ceil() as usize).min(width) {
                            let area = (right.min((sx + 1) as f64) - left.max(sx as f64))
                                * (bottom.min((sy + 1) as f64) - top.max(sy as f64));
                            sum += pixels[(sy * width + sx) * 3 + c] as f64 * area;
                        }
                    }
                    let expected = (sum / ((right - left) * (bottom - top))) as f32;
                    assert!((reduced[(y * preview.width + x) * 3 + c] - expected).abs() < 1e-6);
                }
            }
        }
    }

    #[test]
    fn rejects_partial_excess_or_missing_rows() {
        let mut preview = AreaPreview::new(8, 4).unwrap();
        assert!(preview.append_rgb(&[0.0; 25]).is_err());
        assert!(preview.finish().is_err());
        preview.append_rgb(&[0.0; 96]).unwrap();
        assert!(preview.append_rgb(&[0.0; 24]).is_err());
        preview.finish().unwrap();
    }
}
