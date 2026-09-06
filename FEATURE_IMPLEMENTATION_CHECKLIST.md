# Multiformat image decomposition checklist

Branch: `feat/web-image-decomposition-p3-preview`

## Documentation and API

- [x] Document supported formats, metadata precedence, explicit fallback, HDR
      transfers, Apple gain maps, ACES2065-1 working space, and tolerance
      reporting in `IMAGE_DECOMPOSITION.md`.
- [x] Document the static web UI contract, PNG-to-JPEG retry, ICC-backed
      decoding without an exact gamut/gamma pair, five outputs, inline preview
      images, and the exact ACES 2.0 P3-D65 preview transform in
      `IMAGE_DECOMPOSITION.md`.
- [x] Create this implementation checklist before code changes.
- [x] Add an explicit source gamut/transfer representation while retaining the
      existing combined OpenEXR input-space API.
- [x] Record input format, source interpretation, metadata provenance, and
      overrides in decomposition results and output EXR metadata.

## Decoding and color management

- [x] Add JPEG and PNG decoding with ICC, cICP, sRGB, gAMA, chromaticity, and
      EXIF metadata handling.
- [x] Add HEIC/HEIF decoding with `pillow-heif`, including 10/12-bit samples,
      ICC/nclx metadata, and clear dependency errors.
- [x] Add Apple HDR gain-map decoding through `apple-hdr-heic` and document
      the `exiftool` runtime requirement.
- [x] Add `Linear P3-D65` to OpenEXR detection and explicit fallback choices.
- [x] Decode SDR, linear, PQ, and HLG transfers and convert all sources to
      ACES2065-1 before decomposition.
- [x] Ensure missing or unsupported metadata never silently selects sRGB.

## Decomposition behavior

- [ ] Preserve the existing ACES 2.0 and ACEScg output contract.
- [x] Continue after J_HK, inverse round-trip, and reconstruction tolerance
      exceedances, retaining maximum-error and pixel-count diagnostics.
- [ ] Keep invalid/non-finite data and fundamentally unavailable inverse/root
      cases as hard errors.

## Static web UI and output behavior

- [x] Publish `decompose.html` as a self-contained GitHub Pages entry point;
      keep all decoding, computation, and downloads local to the browser.
- [x] Provide load, metadata review, manual gamut/transfer confirmation, ACES
      profile, Refl (with blur fixed at zero), decompose/cancel, report, and
      five output controls.
- [x] Retry JPEG decoding when a `.png` upload has an invalid PNG signature or
      parser failure, and report the final decoder error only after both paths.
- [x] Use a parseable embedded ICC profile directly for decoding when no exact
      gamut/gamma pair is available; permit explicit gamut/transfer controls to
      override that ICC path and never guess missing values.
- [x] Keep source interpretation hidden until it is needed; expose an explicit
      ICC override action and require both override values without a redundant
      confirmation checkbox.
- [x] Return base ACEScg fp16 EXR, normalized exposure fp16 EXR, direct-scalar
      exposure RGB ACEScg fp16 EXR, base preview JPEG, and exposure preview
      JPEG from the worker.
- [x] Add a download control and analytic-report metadata for the direct-scalar
      exposure RGB EXR; its three channels must each contain `s` without log or
      normalization.
- [x] Show both preview JPEGs inline next to their download buttons.
- [x] Use a single no-card, no-page-scroll viewport layout with upload first,
      interpretation/options, progress, previews, and EXR controls.
- [x] Make previews clickable and open a full-screen overlay with the matching
      save action; use the mobile file share sheet when available and download
      as a fallback.
- [x] Keep preview thumbnails compact with explicit viewport-relative width and
      height bounds, and simplify the controls to detected dropdown defaults,
      a WebGPU availability indicator, and a `Decompose` action.
- [x] Keep Primaries and Transfer in a right-hand column beside the load and
      metadata area on narrow screens; allow long metadata values to wrap.
- [x] Keep Refl beside the ACES profile selector, use `0.1` increments, and
      display the value with three decimal places.
- [x] Make the WebGPU capability indicator interactive, with hover/focus help
      on desktop and tap-to-toggle implications on touch devices.
- [x] Keep preview JPEG output fixed to P3-D65 primaries with sRGB encoding.
- [x] Define the preview pipeline as the OCIO ACES 2.0 built-in transform
      `ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-100nit-P3-D65_2.0`.
- [x] Split progress labels and counters so preview forward processing is
      reported separately from EXR encoding.

## GPU ACES forward-transform implementation

- [x] Add a WebGPU compute pass that converts reconstructed ACES2065-1 base
      pixels and exposure-neutral pixels to display-reference P3-D65 values.
- [x] Port the exact OCIO/ACES 2.0 fixed-function transform, including all
      profile matrices, tone scale, gamut-compression/JMh operations, and
      bundled lookup tables. Do not substitute a one-dimensional tone curve or
      an approximation.
- [x] Reuse the existing WebGPU device, queue, parameter buffers, and shader
      validation infrastructure; keep JPEG compression on the worker CPU after
      GPU readback of sRGB-ready pixels.
- [x] Preserve a CPU implementation using
      `modcam16_color_core::aces_output::forward(4, ...)` as the exact reference
      and fallback for missing WebGPU, device loss, shader errors, or failed
      validation.
- [x] Record backend, adapter (when available), transform identifier/version,
      validation result, fallback reason, and preview timing in the analytic
      report.

## Tests and validation

- [x] Test P3-D65 EXR metadata and control-prefix normalization.
- [x] Test JPEG/PNG metadata and explicit fallback behavior.
- [x] Test PQ/HLG transfer decoding and ACES conversion.
- [x] Test HEIF nclx and Apple gain-map paths (including the real
      `IMG_9536.HEIC` sample with `exiftool`).
- [x] Test successful completion with tolerance exceedances and diagnostics.
- [x] Run focused decomposition tests, then the full test suite.
- [x] Review branch status and preserve unrelated user files.
- [x] Validate direct WGSL numerical output on a software Vulkan adapter and
      with CPU-generated vectors for black, neutral, peak, projected/clipped,
      and seeded-random AP0 values. Compare every channel against the exact
      CPU ACES 2.0 implementation and measure tolerance against those CPU
      values.
- [ ] Add browser smoke coverage proving that GPU-produced preview pixels and
      CPU JPEG encoding yield the same five downloadable artifacts and inline
      previews as the CPU fallback within the documented tolerance.

## Real-file validation

`IMG_9536.HEIC` was decoded successfully as an Apple HDR gain-map image:
Display P3 / P3-D65, linearized by `apple-hdr-heic`, with values normalized to
the project's 100-nit ACES reference scale. A complete one-worker
`p3-hdr1000` decomposition also completed and wrote both EXR outputs. It
reported 23,820 inverse round-trip tolerance exceedances and 7 J_HK tolerance
exceedances while continuing to completion, as required.

## Snapshot notes

- 2026-09-07: Updated this checklist and `IMAGE_DECOMPOSITION.md` before the
  ACES forward-transform GPU work. The exact OCIO ACES 2.0 P3-D65 transform is
  now the stated source of truth.
- 2026-09-07: Implemented the dedicated ACES 2.0 P3-D65 preview shader and
  separate worker stages. The shader uses the full-precision XYZ-D65→P3-D65
  matrix with WGSL column-major layout, shares the OCIO-derived parameter blob,
  and is checked against the f64 CPU forward implementation on Mesa lavapipe.
- 2026-09-07: Added the direct-scalar exposure RGB ACEScg fp16 EXR as a fifth
  output, with an explicit `exposure_rgb_exr` payload key and download control.
