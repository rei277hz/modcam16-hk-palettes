# WebGPU Image Decomposition Operational Checklist

Use this checklist to implement, validate, and release the Rust `wgpu` acceleration for the static image decomposition page. Keep command output, benchmark timings, browser logs, and representative reports with the change.

## Documentation and scope

- [ ] Keep `WEBGPU_IMAGE_DECOMPOSITION_BEHAVIOR.md` synchronized with the worker protocol and report fields.
- [ ] Preserve the existing image decomposition behavior and no-guessing color confirmation contract.
- [ ] Confirm the first acceleration pass covers the J_HK solver; source codecs, optional CPU blur, and EXR encoding retain their existing behavior.

## Rust and WASM build

- [x] Add exact `wgpu` 30.0.1 target-specific dependency with `std`, `webgpu`, and `wgsl` features; avoid native backend features in the browser build.
- [ ] Keep GPU code behind `wasm32` configuration so host Rust tests do not require a graphics adapter.
- [x] Add the Rust GPU context, async initialization, reusable pipeline, adapter-derived batch limit, and mapped readback buffer lifecycle. Device-loss handling remains part of worker integration.
- [x] Add async WASM exports for capability probing and GPU batch solving without removing `solve_chunk` or other CPU compatibility APIs. GPU validation remains to be wired into the worker.
- [ ] Build with the existing `wasm-pack` release command and verify the generated package loads in a module worker.
- [ ] Record the `wgpu` MIT/Apache-2.0 notice and any newly bundled dependency licenses.

## Shader and numerical contract

- [ ] Implement WGSL f32 versions of the ACES profile transform, modCAM16-HK `J_HK`, projection, clipping, and 32-step bisection.
- [ ] Upload ACES profile parameters and lookup tables from shared Rust data so CPU and GPU constants cannot drift silently.
- [x] Use 64-invocation workgroups and packed input/output buffers with explicit alignment tests still pending.
- [ ] Return base AP0 RGB, normalized exposure, and per-pixel diagnostic flags for every finite/non-finite input.
- [ ] Validate deterministic edge and random samples against the f64 CPU reference for every supported ACES profile.
- [ ] Enforce exposure error `<= 0.002` stops and base-channel absolute error `<= 0.0002`; disable GPU processing when validation fails.

## Worker and UI integration

- [ ] Initialize WebGPU once per worker and reuse the device, queue, pipeline, parameter buffers, and batch allocations.
- [ ] Select a batch size no larger than 1,048,576 pixels and clamp it to adapter storage-buffer limits.
- [ ] Add progress stages for GPU initialization, validation, GPU batches, CPU fallback, and restart after device failure.
- [ ] Keep progress monotonic and report processed, projected, clipped, non-finite, and encoded-byte counters.
- [ ] Automatically use the CPU chunked solver when WebGPU is missing, rejected, unsupported, invalid, or lost.
- [ ] Restart a failed GPU job from the beginning on CPU and discard partial GPU output.
- [ ] Preserve cancellation, worker replacement, Blob URL revocation, keyboard accessibility, and screen-reader status announcements.
- [ ] Add compute backend, adapter, validation, batch, duration, and fallback warning fields to the analytic report.

## Tests

- [ ] Run all existing Rust color-core and decomposition tests.
- [ ] Add Rust tests for shared GPU parameter packing, table lengths/checksums, WGSL validation, buffer alignment, and fallback error mapping.
- [ ] Run TypeScript checking, the Vite production build, and the wasm-pack release builds.
- [ ] Add Chromium WebGPU browser coverage for upload, explicit gamut/transfer confirmation, validation, progress, cancellation, report rendering, and both downloads.
- [ ] Test the no-WebGPU path and forced initialization/validation/device-loss failures; each must complete through CPU fallback with an actionable warning.
- [ ] Compare CPU and GPU outputs for neutral, zero, negative/projected, clipped, high-range, non-finite, and random pixels across all ACES profiles.
- [ ] Round-trip GPU-generated EXRs and verify dimensions, channels, ACEScg metadata, fp16 encoding, finite values, and diagnostic counts.
- [ ] Run the full `IMG_9607-rec2020d65-linear.exr` benchmark on the Chromium reference device and record total time, GPU batch size, and peak memory.
- [ ] Verify narrow viewport, keyboard-only, screen-reader, cancellation, reset, and download behavior after GPU fallback and after successful GPU processing.

## Release gate

- [ ] Confirm the reference 4032 x 3024 benchmark completes in under 30 seconds with zero blur on the designated Chromium WebGPU device.
- [ ] Confirm GPU outputs meet both numerical tolerances and that CPU fallback outputs remain unchanged.
- [ ] Confirm no uploaded bytes or generated EXRs leave the browser and that the GitHub Pages build uses relative, cache-busted assets.
- [ ] Review the final diff for accidental changes to the existing picker, generated user files, or unrelated metadata.
- [ ] Test the published `decompose.html` route and both downloads from the GitHub Pages URL.
- [ ] Archive the benchmark record, validation report, browser version, adapter information, and representative EXR hashes before release.
