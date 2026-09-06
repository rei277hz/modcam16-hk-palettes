# HEIC/HEIF decoding implementation checklist

## Package and build decisions

- [x] Keep the pinned `libheif-js` WASM bundle and retain its LGPL notice.
- [x] Add `ultrahdr-core` to the Rust/WASM decomposition crate for Apple
      MakerNote parsing and gain-map reconstruction.
- [ ] Keep `libheif-rs` as a host-side native oracle for differential tests;
      do not make its native C build a browser prerequisite.
- [ ] Do not select the AGPL/commercial `heic` crate for the shipped page.
- [ ] Do not select `heif-oxide` as the production decoder until it gains
      equivalent Apple gain-map behavior and verified 12-bit support.

## Low-level browser decoder

- [x] Replace `HeifDecoder.decode()` plus `image.display()` in the worker with
      low-level context and image-handle calls.
- [x] Decode primary RGB/RGBA through `heif_js_decode_image2` using a 16-bit
      interleaved layout and normalize samples from the reported bit depth.
- [x] Extract ICC profile data from the image handle.
- [x] Read supported ISO-BMFF `nclx` CICP primaries and transfer identifiers
      when no ICC profile is present, and use them for automatic interpretation.
- [x] Enumerate auxiliary image IDs and decode the Apple gain-map auxiliary.
- [x] Read and validate each auxiliary image's exact URN before selecting the
      Apple gain-map auxiliary.
- [x] Extract Exif metadata blocks and release every native handle,
      metadata allocation, and WASM heap allocation on all paths.
- [ ] Add resource limits for dimensions, pixel count, and temporary buffers.

## Rust/WASM integration

- [x] Extend the worker payload to carry native-decoded RGB samples, source
      bit depth, optional ICC/nclx data, gain-map samples/dimensions, and Exif
      or XMP bytes.
- [x] Apply manual override, ICC, nclx, then required manual-selection
      precedence without guessing.
- [x] Parse Apple Exif with `parse_exif_for_apple_hdr` and construct metadata
      with `from_apple_headroom`.
- [x] Reconstruct linear RGB with the Apple headroom/gain-map math before
      converting to ACES2065-1.
- [ ] Keep ordinary HEIF, no-gain-map, cancellation, and malformed-input paths
      explicit and actionable.

## Validation

- [ ] Add low-level adapter tests for `IMG_9536.HEIC`: dimensions, primary
      precision, Display P3 ICC, gain-map URN, gain-map dimensions, and XMP.
- [ ] Add a 10-bit HEIC fixture test proving values are not reduced to 8-bit.
- [x] Add a 12-bit HEIC fixture test using the libheif-rs `test_nclx.heif`
      fixture; the shipped bundle reports 12-bit native RGB successfully.
- [ ] Differentially compare host decoding with `libheif-rs` and Apple
      gain-map reconstruction with the established reference implementation.
- [ ] Validate nclx-only HEIC samples (including `IMG_9487.HEIC`) complete
      without requiring a manual source pair.
- [ ] Test ICC-only input, explicit override, absent/malformed gain-map
      metadata, lower-resolution gain maps, cancellation, and resource limits.
- [ ] Run Rust host tests, WASM builds, TypeScript checks, and a browser worker
      smoke test before updating the deployment preview.

## Snapshot notes

- 2026-09-07: Confirmed that the bundled `libheif-js` high-level API is only
  8-bit, while its low-level exports decode the supplied primary and Apple
  gain-map auxiliary into 16-bit storage and expose the actual 10-bit depth.
- 2026-09-07: Selected low-level `libheif-js` plus `ultrahdr-core` as the
  browser implementation route; retained `libheif-rs` for host validation.
- 2026-09-07: Implemented native 16-bit primary/auxiliary decoding, ICC and
  Exif extraction, Apple gain-map reconstruction, and the Rust/WASM bridge.
  `cargo test -p modcam16-decomposition-wasm`, `npx tsc --noEmit`, and
  `npx vite build` pass.
- 2026-09-07: Verified the bundled decoder against a real 12-bit HEIF fixture;
  native RGB decoding reports 12 bits and preserves the 16-bit sample path.
- 2026-09-07: Corrected Apple gain-map ordering for `IMG_9809.HEIC`: decode
  the primary transfer to linear source RGB before applying headroom, then
  convert to AP0 so boosted samples never violate an ICC device domain.
