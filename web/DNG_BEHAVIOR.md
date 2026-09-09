# DNG source behavior

This document defines how `web/decompose.html` handles Digital Negative (`.dng`)
files. The page remains a static, browser-local application: the selected file,
decoder, workers, prepared source, previews, reports, and downloads stay on the
device.

## Loading and interpretation

- The file picker accepts `.dng` and `.DNG` in addition to the existing formats.
- DNG inspection runs in the preparation worker and reports the actual raw
  dimensions, orientation, camera model, photometry, bit depth, and compression.
- A supported DNG is interpreted from its embedded calibration. The source
  format indicator displays only `DNG`; manual gamut/transfer selectors stay
  hidden while calibration details remain available in diagnostics.
- The implementation does not request an external DCP and does not apply DCP
  tone curves, look tables, or display rendering. It uses DNG calibration and
  as-shot white balance for a scene-linear result.
- Missing calibration, unsupported photometry/compression, malformed metadata,
  or unsupported mandatory opcodes produce an actionable error. The page never
  guesses an interpretation from the filename.

## Development result

The decoder develops the raw image in this order:

1. Decode the selected raw IFD, including lossless JPEG, uncompressed, or
   Deflate storage where supported.
2. Apply the decoder's DNG linearization-table lookup, black-level pattern, and
   white-level normalization without clamping values outside the nominal range.
3. Validate all three DNG opcode lists in their defined stages. The supported
   post-demosaic operation is `FixVignetteRadial`, which is present in the
   supplied iPhone files. Unsupported mandatory opcodes fail rather than
   silently disappearing; optional operations are reported as skipped.
4. Demosaic Bayer images to RGB; already-demosaiced LinearRaw images bypass
   this step.
5. Apply as-shot white balance, AnalogBalance and CameraCalibration matrices,
   and interpolate dual-illuminant ColorMatrix/ForwardMatrix data in inverse
   correlated colour temperature when the tags provide both calibrations (the
   first-matrix weight is 1 at CalibrationIlluminant1 and 0 at
   CalibrationIlluminant2). A
   ForwardMatrix path is used when available; otherwise the ColorMatrix path
   uses Bradford adaptation from the as-shot white to D50. Unsupported profile
   look/tone rendering is not applied.
6. Convert the calibrated camera values from XYZ D50 through CAT02 to XYZ D65,
   then use the ACES AP0 (D60) BFD matrix path to linear ACES2065-1/AP0.
7. Apply embedded BaselineExposure and BaselineExposureOffset EV values when
   present. No automatic maximum-to-one normalization, tone curve, or clipping
   is performed.

The prepared raster is interleaved AP0 `f32`. Finite negative and above-1.0
values are retained. Any skipped optional metadata is carried into the
decomposition warnings. The source format indicator is intentionally concise
and displays only `DNG`; detailed calibration, dimensions, orientation, and raw
storage remain available in diagnostics.

## Reuse, preview, and decomposition

- DNG development happens once per selected file. The AP0 raster is streamed to
  the existing OPFS/IndexedDB scratch abstraction and reused for previews and
  decomposition.
- The source preview is generated from the prepared AP0 values, averaged in
  linear light, then passed through the existing ACES display preview encoder.
- Changing decomposition profile or Refl does not decode the DNG again.
- Replacing the source removes the old prepared raster and cancels stale worker
  requests. Cancellation releases workers and incomplete scratch files while
  retaining the selected source until it is replaced.
- DNG decoding, opcode application, demosaicing, and camera development run in
  the WASM preparation worker. The validated WebGPU path accelerates the
  following decomposition and preview stages; it is selected only after its
  output is checked against the CPU reference and falls back automatically
  when unavailable or when validation fails.

## Supported first-release inputs

The first release targets common DNG images represented by the supplied
iPhone 13 mini files: rectangular Bayer CFA and three-channel LinearRaw,
unsigned samples up to 16 bits, and uncompressed, lossless-JPEG, or Deflate
storage. JPEG XL, non-rectangular CFA, unsupported floating-point layouts, and
unsupported mandatory corrections are rejected with a clear message.

The four supplied files must load with their recorded orientation, decode to
their full raw dimensions, and complete preparation plus preview within 20
seconds on an iPhone 13 mini running Safari after the app has loaded. The
benchmark records device, browser, backend, and stage timings.
