# Mobile memory behavior for image decomposition

The web application preserves the uploaded image's full pixel dimensions and
precision. It does not resize the source to avoid memory pressure. Large jobs
are processed as bounded row-major tiles in the decomposition worker.

The worker keeps one prepared source raster, one validated WebGPU batch (or the
equivalent CPU row batch), small readback buffers, and bounded EXR encoder state.
Full-resolution base/exposure arrays and EXR byte arrays are never accumulated
in JavaScript or WASM memory. Preview RGB rows are spooled to OPFS; one preview
plane is read back while its JPEG is encoded, then released before the second
preview is encoded.

The worker uses the Origin Private File System (OPFS) for per-job output files.
It writes the three full-resolution fp16 EXRs incrementally. The main thread opens
the completed OPFS files for previews and downloads without receiving complete
output buffers through `postMessage`.

When OPFS synchronous access handles are unavailable, the worker uses writable
OPFS streams. IndexedDB tile/file blobs remain the compatibility fallback to
add; currently a job fails before expensive decoding if OPFS is unavailable or
if the estimated quota cannot hold the outputs.

Source decoding retains the existing interpretation rules: an explicit gamut
and transfer override wins, a usable ICC profile is used directly when present,
supported HEIF nclx values are used automatically when ICC is absent, and
missing color information requires manual selection. HEIC primary and Apple
gain-map samples remain 10/12-bit capable without an 8-bit display conversion;
the decoder-owned raster is the unavoidable codec working-set floor until
region decode is available in the browser bridge.

Gaussian blur is fixed at zero, so tiles do not require a halo. Each row batch
is copied from the prepared raster and solved with the exact CPU
reference or validated WebGPU path, and immediately written to the output
writers. Statistics are accumulated as scalar counters only.

OpenEXR output is scanline-streamed as fp16 ACEScg/AP1 channels with the
existing metadata. The default Exposure EXR stores direct scalar exposure
replicated across RGB; the normalized EV Exposure EXR stores its single
 channel. Preview JPEG encoding currently reads one OPFS RGB8 staging file at
a time after the exact ACES 2.0 SDR 100-nit Display P3 forward transform and
sRGB encoding; a row-fed JPEG encoder remains a follow-up task.

GPU resources are reused for one batch at a time, explicitly destroyed when
replaced, and completed before the next tile is submitted. Device loss or GPU
validation failure restarts the complete tiled job on the accurate Rust/WASM
CPU implementation without creating full-image result arrays.

Cancellation, quota errors, decoder failures, and page unload close handles,
release mapped buffers, revoke object URLs, and delete incomplete per-job
files. Successful HEIC precision and gain-map decoding remains silent unless a
failure changes the operation.

Implementation snapshot (2026-09-07): decomposition now writes scanline EXRs
and raw preview planes directly to OPFS and returns file descriptors to the
page. The worker no longer allocates full base, exposure, or EXR result
buffers. Source preparation still uses one decoder/prepared raster, and JPEG
encoding reads one spooled preview plane at a time.
