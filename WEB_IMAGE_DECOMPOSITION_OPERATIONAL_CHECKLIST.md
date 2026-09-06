# Web image decomposition operational checklist

This checklist is the implementation and release contract for the static web image decomposition tool. Check items in order; keep evidence (command output, screenshots, or report samples) with the release change.

## Repository and documentation

- [x] Work is on a dedicated feature branch and unrelated generated/user files are untouched.
- [x] `WEB_IMAGE_DECOMPOSITION_BEHAVIOR.md` describes the user-visible contract.
- [x] This checklist is updated when a design or library decision changes.
- [ ] `IMAGE_DECOMPOSITION.md` remains the source of truth for ACES, modCAM16-HK, exposure, diagnostics, and metadata semantics.

## Toolchain and dependency lock

- [x] Use the machine's `fnm` Node installation; build verification used Node `v26.7.0` and npm `11.19.0`.
- [x] Pin npm dependencies and commit the lockfile. `libheif-js` is pinned to 1.23.2; the lockfile records the exact Vite/TypeScript resolution used by the existing web app.
- [x] Pin Rust crate versions in the WASM workspace lockfile. The decomposition crate currently pins `exr` 1.74.2, `png` 0.18.1, `jpeg-decoder` 0.3.2, `icc-profile` 0.0.6, `half` 2.6, and the existing color-core path dependency.
- [x] Keep the existing `wasm/color_core` crate API and tests working (53 tests pass).
- [x] Record licenses/notices for newly bundled code in `THIRD_PARTY_NOTICES.md` (`libheif-js` 1.23.2, LGPL-3.0).

## Codec and metadata path

- [x] Decode EXR in Rust with the `exr` crate, preserving dimensions, channels, chromaticities, and finite-value diagnostics.
- [x] Decode PNG with `png`, including embedded ICC data and transfer metadata.
- [x] Decode JPEG with `jpeg-decoder`, extracting ICC APP2 markers when available; EXIF ColorSpace parsing remains a codec-test item.
- [ ] Decode HEIF/HEIC in the browser with pinned `libheif-js` 1.23.2; expose ICC/nclx metadata, auxiliary images, and Apple HDR gain-map metadata.
- [ ] Compose an Apple HDR gain map using its headroom metadata and the documented sRGB EOTF path; report that composition in diagnostics. The current bridge detects and warns about Apple gain-map markers but does not claim composition.
- [ ] Recognize an ICC profile only when it maps unambiguously to a supported gamut/transfer pair; otherwise require manual selection.
- [ ] Never silently default a missing or ambiguous gamut/transfer.
- [ ] Add malformed, truncated, unsupported-profile, and missing-metadata fixtures to codec tests.

## Rust/WASM worker contract

- [x] Add a dedicated decomposition WASM crate without changing the existing color-core crate's public behavior.
- [x] Define a versioned worker-facing request containing bytes, format hint, confirmed source gamut/transfer, ACES profile, Refl, and blur radius. The UI envelope adds the cancellation/job id and progress protocol.
- [x] Define structured progress events with stage, monotonic overall percentage, pixel counters, projection/clipping/non-finite counters, and encoded byte counters. The worker emits an initial decomposition event and solves 4,096-pixel chunks so large EXRs report progress promptly.
- [x] Return a structured analytic report plus base and exposure OpenEXR byte buffers. The current response keys are `report`, `base_exr`, and `exposure_exr`.
- [x] Keep heavy loops and allocations in the worker; send output `ArrayBuffer`s as transferables.
- [x] Check cancellation between solve chunks/stages and release buffers on cancellation or failure; the UI replaces the worker if cancellation arrives during a synchronous WASM call.
- [ ] Apply automatic gamut projection and preserve per-pixel diagnostic counters.
- [x] Match the core numerical contract: ACES2065-1/AP0 source conversion, optional AP0 Gaussian blur, shared modCAM16-HK J_HK bisection solve, normalized exposure encoding, and linear ACEScg fp16 outputs. Exact ACES `Un-tone-mapped`/inverse-view parity and projection residual diagnostics remain validation work.

## OpenEXR output contract

- [x] Base output is linear ACEScg/AP1 RGB, fp16, with documented channel names and chromaticity metadata.
- [x] Exposure output is fp16, uses the documented normalized exposure formula, and has the `exposure` channel metadata.
- [x] Use ZIP compression and deterministic headers where the encoder permits it. The Rust encoder currently uses ZIP scanline compression and writes ACEScg chromaticity/component metadata.
- [ ] Round-trip representative outputs through an EXR decoder and compare dimensions, channels, finite values, and metadata.
- [ ] Verify large images do not get silently downsampled or capped.

## Web UI and worker integration

- [x] Add standalone `web/decompose.html` and TypeScript controller/worker entry points; leave the existing picker route intact. Vite is configured with explicit multi-page Rollup inputs for `index.html` and `decompose.html`.
- [x] Provide upload, metadata display, gamut/transfer confirmation, ACES profile, Refl, blur, calculate/cancel, report, and two download controls.
- [x] Disable calculation until gamut and transfer are explicitly confirmed and options validate.
- [x] Show stage, percentage, and live counters throughout processing.
- [x] Surface projection, clipping, non-finite, fallback, and metadata warnings prominently.
- [x] Revoke stale Blob URLs on reset, new input, and replacement jobs; cancellation terminates the worker and releases its buffers.
- [x] Keep the UI responsive on desktop and mobile and expose keyboard/screen-reader status.
- [x] Handle worker/WASM/codec errors with actionable messages and no guessed color interpretation.

## Verification

- [ ] Run Python decomposition regression tests that cover the shared numerical contract.
- [ ] Run Rust unit/integration tests for metadata parsing, projection, counters, exposure encoding, and EXR round trips.
- [x] Build the WASM crates in release mode with `wasm-pack` using the pinned toolchain.
- [x] Run TypeScript type checking and the Vite production build.
- [ ] Preview the built static site and smoke-test upload, manual metadata confirmation, processing, cancellation, report, and both downloads.
- [ ] Test representative EXR, JPEG, PNG, Display P3 HEIC, Apple gain-map HEIC, malformed, and ambiguous-profile files.
- [ ] Test narrow mobile viewport, keyboard-only operation, screen-reader announcements, and browsers with WebAssembly workers enabled.
- [x] Confirm generated assets are self-contained for GitHub Pages under a subpath and that no network/API endpoint is required at runtime; Vite emits relative asset paths for both HTML entries.

## Release and publication

- [ ] Review the final diff for accidental changes to existing picker behavior and unrelated files.
- [ ] Run the deployment script against a local preview before publishing.
- [ ] Confirm the GitHub Pages URL, `decompose.html` route, cache-busted assets, and download behavior after publication.
- [ ] Archive the analytic report and validation evidence for a representative sample before tagging the release.
