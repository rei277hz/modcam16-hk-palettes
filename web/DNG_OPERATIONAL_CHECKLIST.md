# DNG operational checklist

Use this checklist before merging the DNG input-format feature.

## Documentation and build

- [ ] Keep `DNG_BEHAVIOR.md` synchronized with the HTML, worker messages, Rust
      exports, diagnostics, and supported codec behavior.
- [ ] Run the Rust workspace tests and the DNG decoder/development tests.
- [ ] Run TypeScript checking, WASM builds, Vite production build, npm tests,
      and `git diff --check`.
- [ ] Update `THIRD_PARTY_NOTICES.md` for every newly bundled crate or module.

## Input and numerical correctness

- [ ] Load all four root `IMG_9983.DNG` through `IMG_9986.DNG` files.
- [ ] Verify dimensions, orientation, RGGB CFA metadata, 16-bit samples,
      lossless-JPEG tiles, black level 528, and white level 4095.
- [ ] Verify linearization, black-level patterns/deltas, active area, crop, and
      as-shot neutral handling with synthetic fixtures.
- [ ] Verify Bayer demosaicing at all four image edges and across worker-band
      boundaries against the CPU reference.
- [ ] Verify `FixVignetteRadial` execution and rejection of unsupported required
      opcodes; report optional skipped opcodes.
- [ ] Verify dual-illuminant interpolation, analog balance, ForwardMatrix and
      ColorMatrix fallback, CAT02 D50→D65 adaptation followed by the ACES AP0
      D60 BFD matrix path, and baseline exposure.
- [ ] Assert that negative and above-1.0 AP0 values survive preparation and
      scratch-file round trips without clamping or NaN introduction.

## Browser flow

- [ ] `.dng` appears in the picker and empty-state format list.
- [ ] Inspection selects embedded DNG calibration and hides manual transfer
      controls.
- [ ] A failed decode shows an actionable error and leaves no stale preview.
- [ ] The prepared AP0 source is reused for source preview and decomposition;
      changing Refl/profile never decodes the file again.
- [ ] Replacement, cancellation, stale responses, worker replacement, OPFS
      fallback, quota failure, and page unload remove incomplete resources.
- [ ] The source preview preserves aspect ratio and orientation and remains
      available after a completed or cancelled decomposition.

## Backend and performance

- [ ] Validate the WebGPU decomposition and preview paths against the WASM CPU
      reference before use; DNG preparation remains on the WASM CPU path.
- [ ] Exercise no-WebGPU, insecure-origin, shader/device failure, and mid-job
      fallback paths; confirm complete CPU restart with no partial output.
- [ ] Confirm worker count, batch sizes, GPU allocations, and scratch writes are
      bounded on mobile Safari.
- [ ] Benchmark each supplied DNG on a physical iPhone 13 mini Safari and record
      file-read, decode, development, scratch-write, preview, and total times.
- [ ] Require preparation plus usable preview for each supplied file within 20
      seconds after application load, including forced CPU fallback.

## Regression and release

- [ ] Run existing EXR/JPEG/PNG/HEIC/HEIF browser flows and confirm their
      interpretation and output behavior is unchanged.
- [ ] Inspect resulting EXRs for ACEScg metadata, fp16 encoding, dimensions,
      channels, and preserved signed/HDR source values at the solver boundary.
- [ ] Confirm analytic report and debug log include DNG provenance, backend,
      timings, range counters, warnings, and failure context without pixel dumps.
- [ ] Verify the route works on localhost, secure GitHub Pages, desktop Chromium,
      iPhone Safari, Android Chromium, and CPU-only browsers.
