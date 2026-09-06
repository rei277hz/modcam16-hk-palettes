# WebGPU Image Decomposition Behavior

This document defines the behavior of the accelerated image decomposition path. It supplements the existing image decomposition behavior contract and applies to the same static GitHub Pages application. Uploaded images and generated files remain local to the browser.

## Compute selection

- The decomposition page initializes WebGPU inside the dedicated Rust/WASM worker when the browser exposes a usable WebGPU adapter.
- The worker requests a high-performance adapter and keeps one `wgpu` device, queue, pipeline, and lookup-table buffer alive for the duration of the job.
- The user does not select a backend. The application chooses WebGPU automatically after capability and numerical validation.
- If WebGPU is unavailable, initialization fails, the device is lost, or validation exceeds the permitted error, the worker runs the existing chunked WASM CPU solver instead.
- The report and status region identify the backend as **WebGPU** or **WASM CPU**. A CPU fallback includes the reason as a warning.

### Current implementation decisions

- The browser dependency is Rust `wgpu` `30.0.1`, built for `wasm32-unknown-unknown` with only the `std`, `webgpu`, and `wgsl` features enabled.
- The GPU context is owned by the existing module worker rather than the page thread. It keeps the adapter, device, queue, compute pipeline, bind-group layout, and adapter-derived batch limit alive across solve calls; per-batch transfer buffers are released after readback.
- Prepared AP0 input is uploaded as padded `vec4<f32>` values. The shader returns packed base RGB plus normalized exposure in a `vec4<f32>` output buffer and a `u32` diagnostic flag buffer. Rust unpacks these buffers into the existing `base`, `exposure`, and `SolveStats` response shape.
- GPU readback is asynchronous through mapped staging buffers. The CPU remains responsible for report reduction and the existing OpenEXR encoder so output metadata and fp16 semantics stay shared with the CPU path.
- The WGSL module is validated with the pinned Naga 30.0.1 parser before packaging; browser adapter validation still remains the runtime gate.

## Color-science accuracy

The GPU implementation uses accurate, GPU-suitable ports of the same ACES 2.0 fixed-function output processors used by the color core. It includes the profile-specific matrices, tone scale, gamut compression, JMh conversions, and bundled OCIO-derived reach/cusp lookup tables for Rec.2020 HDR, Rec.709 SDR, P3-D65 HDR, and P3-D65 SDR. The shader also ports the default modCAM16-HK appearance equations used by the CPU reference.

The GPU path must not replace these transforms with a one-dimensional tone curve, a simple exposure-only approximation, a reduced gamut model, or any other shortcut that changes the ACES view. Shader arithmetic uses `f32` because that is the portable WebGPU baseline; the validation tolerance and CPU fallback make that precision difference explicit.

For modCAM16-HK, the original CPU implementation is the reference implementation: GPU `J_HK`, projection, exposure, and base values are compared directly with the CPU model and solver. ACES output values are separately compared with the exact CPU ACES 2.0 implementation. No GPU-to-GPU comparison is sufficient for enabling the accelerated backend.

## GPU initialization and validation

Before processing image pixels, the worker:

1. Creates a browser WebGPU instance using the Rust `wgpu` WebGPU backend.
2. Requests an adapter and device with no optional device features.
3. Compiles the WGSL compute pipeline and uploads the shared ACES/modCAM16 parameter tables.
4. Runs deterministic neutral, projected, clipped, high-range, zero, non-finite, and seeded-random validation samples for all four supported profiles through both the GPU and existing CPU solver.

The GPU path is enabled only when every validation sample meets both limits:

- exposure difference: at most `0.002` stops;
- base-channel absolute difference: at most `0.0002`.

The f64 WASM solver remains the numerical reference. Validation failures never guess a result or silently accept a less accurate GPU output.

## Processing behavior

Source decoding, metadata interpretation, explicit transfer/gamut conversion, optional CPU Gaussian blur, and color-confirmation rules remain unchanged. The accelerated stage receives prepared AP0 RGB pixels and solves the exposure independently for every pixel.

The WGSL kernel:

- projects negative working channels using the same projection rule;
- evaluates the selected ACES profile and modCAM16-HK `J_HK` function;
- performs the existing 32-step exposure bisection;
- writes ACES2065-1/AP0 base RGB, normalized exposure, and diagnostic flags.

Pixels are dispatched in batches of up to 1,048,576 pixels, reduced when the adapter reports a smaller storage-buffer limit. Workgroups contain 64 invocations. Rust reuses the GPU pipeline and parameter buffer across batches and reads each batch back before encoding the final EXRs.

The worker reports these stages:

- initializing WebGPU;
- validating GPU results;
- preparing pixels;
- GPU decomposition or CPU decomposition;
- encoding base and exposure EXR;
- complete, cancelled, or error.

Progress is monotonic. GPU batches report processed pixels, projected pixels, clipped pixels, non-finite pixels, and encoded bytes where available. CPU fallback continues to use 4,096-pixel cooperative chunks so cancellation and progress remain responsive.

## Failure and fallback behavior

- A missing `navigator.gpu`, unavailable adapter, device request failure, shader compilation error, validation mismatch, or unsupported storage limit selects the CPU path before image processing.
- If the device is lost or a GPU batch fails after processing starts, partial GPU buffers are discarded and the complete job restarts through the CPU path. The UI reports that restart and retains no partial downloads.
- Cancellation terminates the active worker when an in-flight WASM or GPU operation cannot be interrupted directly. Blob URLs and GPU/WASM buffers are released with the worker.
- A CPU fallback remains a successful calculation when the CPU solver completes; it is not presented as a color interpretation error.

## Analytic report and downloads

The report retains the existing dimensions, source interpretation, options, projection, clipping, non-finite, exposure, base, and solver fields. It additionally records:

- compute backend;
- GPU adapter information when WebGPU ran;
- GPU validation status;
- fallback or device-loss warnings;
- validated batch size.

OpenEXR encoding remains Rust/WASM and produces the same ZIP-compressed ACEScg/AP1 fp16 base file and normalized fp16 exposure file as the CPU path. GPU selection must not change channel names, metadata, filenames, or download enablement.

## Performance contract

The reference benchmark is `IMG_9607-rec2020d65-linear.exr` at 4032 x 3024 pixels with `Refl = 0.5` and zero blur. On the designated Chromium desktop WebGPU reference device, the complete calculation, report, and output encoding should finish in under 30 seconds. Other devices may take longer; the UI must always expose advancing progress and the selected backend.
