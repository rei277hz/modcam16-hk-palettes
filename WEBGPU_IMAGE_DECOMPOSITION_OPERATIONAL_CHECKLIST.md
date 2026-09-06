# WebGPU Image Decomposition Operational Checklist

Use this checklist to implement, validate, and release the Rust `wgpu` acceleration for the static image decomposition page. Keep command output, benchmark timings, browser logs, and representative reports with the change.

## Documentation and scope

- [x] Keep `WEBGPU_IMAGE_DECOMPOSITION_BEHAVIOR.md` synchronized with the worker protocol and report fields.
- [x] Preserve the existing image decomposition behavior and no-guessing color confirmation contract.
- [x] Confirm the first acceleration pass covers the J_HK solver; source codecs, optional CPU blur, and EXR encoding retain their existing behavior.

## Rust and WASM build

- [x] Add exact `wgpu` 30.0.1 target-specific dependency with `std`, `webgpu`, and `wgsl` features; avoid native backend features in the browser build.
- [x] Keep GPU code behind `wasm32` configuration so host Rust tests do not require a graphics adapter.
- [x] Add the Rust GPU context, async initialization, reusable pipeline, adapter-derived batch limit, and mapped readback buffer lifecycle. Device-loss handling remains part of worker integration.
- [x] Add async WASM exports for capability probing and GPU batch solving without removing `solve_chunk` or other CPU compatibility APIs; worker validation gates GPU use.
- [x] Build with the existing `wasm-pack` release command and verify the generated package loads in a module worker.
- [ ] Record the `wgpu` MIT/Apache-2.0 notice and any newly bundled dependency licenses.

## Shader and numerical contract

- [x] Implement WGSL f32 versions of the ACES profile transform, modCAM16-HK `J_HK`, projection, clipping, and 32-step bisection.
- [x] Port the accurate ACES 2.0 fixed-function processors, including profile-specific tone/gamut behavior and OCIO-derived reach/cusp tables; do not substitute an approximate tone curve or reduced color model.
- [x] Port the same default modCAM16-HK equations and constants used by the CPU reference; keep the CPU implementation as the f64 numerical authority.
- [x] Upload ACES profile parameters and lookup tables from shared Rust data so CPU and GPU constants cannot drift silently.
- [x] Use 64-invocation workgroups and packed input/output buffers with explicit alignment tests still pending.
- [x] Return base AP0 RGB, normalized exposure, and per-pixel diagnostic flags for every finite/non-finite input.
- [x] Compare every WebGPU validation sample directly against the accurate original f64 ACES 2.0/modCAM16-HK implementation, never against an approximation or another GPU result.
- [x] Validate deterministic edge and seeded-random samples against that f64 reference for every supported ACES profile.
- [x] Measure exposure error in stops and base-channel error against the f64 reference; enforce exposure error `<= 0.002` stops and base-channel absolute error `<= 0.0002`, disabling GPU processing when validation fails.

## Worker and UI integration

- [x] Initialize WebGPU once per worker and reuse the device, queue, pipeline, and parameter buffer across batches.
- [x] Select a batch size no larger than 1,048,576 pixels and clamp it to adapter storage-buffer limits.
- [x] Add progress stages for GPU initialization, validation, GPU batches, CPU fallback, and restart after device failure.
- [x] Keep progress monotonic and report processed, projected, clipped, non-finite, and encoded-byte counters.
- [x] Automatically use the CPU chunked solver when WebGPU is missing, rejected, unsupported, invalid, or lost.
- [x] Restart a failed GPU job from the beginning on CPU and discard partial GPU output.
- [ ] Preserve cancellation, worker replacement, Blob URL revocation, keyboard accessibility, and screen-reader status announcements.
- [x] Add compute backend, adapter, validation, batch, and fallback warning fields to the analytic report.

## Tests

- [x] Run all existing Rust color-core and decomposition tests.
- [ ] Add Rust tests for shared GPU parameter packing, table lengths/checksums, buffer alignment, and fallback error mapping. WGSL syntax validation is currently run with Naga 30.0.1 during implementation.
- [x] Run TypeScript checking, the Vite production build, and the wasm-pack release builds.
- [ ] Add Chromium WebGPU browser coverage for upload, explicit gamut/transfer confirmation, validation, progress, cancellation, report rendering, and both downloads.
- [ ] Test the no-WebGPU path and forced initialization/validation/device-loss failures; each must complete through CPU fallback with an actionable warning.
- [ ] Compare WebGPU and accurate f64 reference outputs for neutral, zero, negative/projected, clipped, high-range, non-finite, and random pixels across all ACES profiles; record maximum and percentile errors.
- [ ] Round-trip GPU-generated EXRs and verify dimensions, channels, ACEScg metadata, fp16 encoding, finite values, and diagnostic counts.
- [ ] Run the full `IMG_9607-rec2020d65-linear.exr` benchmark on the Chromium reference device and record total time, GPU batch size, and peak memory.
- [ ] Verify narrow viewport, keyboard-only, screen-reader, cancellation, reset, and download behavior after GPU fallback and after successful GPU processing.

## Release gate

- [ ] Confirm the reference 4032 x 3024 benchmark completes in under 30 seconds with zero blur on the designated Chromium WebGPU device.
- [ ] Confirm GPU outputs meet both tolerances against the accurate f64 reference and that CPU fallback outputs remain unchanged.
- [ ] Confirm no uploaded bytes or generated EXRs leave the browser and that the GitHub Pages build uses relative, cache-busted assets.
- [ ] Review the final diff for accidental changes to the existing picker, generated user files, or unrelated metadata.
- [ ] Test the published `decompose.html` route and both downloads from the GitHub Pages URL.
- [ ] Archive the benchmark record, validation report, browser version, adapter information, and representative EXR hashes before release.
