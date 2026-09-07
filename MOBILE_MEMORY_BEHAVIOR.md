# Mobile memory behavior for image decomposition

The web application preserves the uploaded image's full pixel dimensions and
precision. It does not resize the source to avoid memory pressure. Large jobs
are processed as bounded row-major tiles in the decomposition worker.

The worker keeps one decoder-owned source raster, one Rust-owned prepared raster,
one small validated WebGPU batch (or the equivalent CPU row batch), small
readback buffers, and bounded EXR encoder state. On mobile, CPU batches are
limited to 1,024 pixels (or one image row when the row is wider), and WebGPU
batches to 8,192 pixels (or one row when wider).
Full-resolution base/exposure arrays and EXR byte arrays are never accumulated
in JavaScript or WASM memory. Preview RGB rows are spooled to OPFS; one preview
plane is read back while its JPEG is encoded, then released before the second
preview is encoded.

The worker uses the Origin Private File System (OPFS) for per-job scratch and
output files. It first writes the prepared full-resolution float raster to a
scratch file, then writes the three full-resolution fp16 EXRs incrementally.
The main thread opens the completed OPFS files for previews and downloads
without receiving complete output buffers through `postMessage`.

When OPFS synchronous access handles are unavailable, the worker uses writable
OPFS streams. IndexedDB tile/file blobs remain the compatibility fallback to
add; currently a job fails before expensive decoding if OPFS is unavailable or
if the estimated quota cannot hold the source scratch file, outputs, and
preview staging files.

Source decoding retains the existing interpretation rules: an explicit gamut
and transfer override wins, a usable ICC profile is used directly when present,
supported HEIF nclx values are used automatically when ICC is absent, and
missing color information requires manual selection. HEIC primary and Apple
gain-map samples remain 10/12-bit capable without an 8-bit display conversion;
the decoder-owned raster is the unavoidable codec working-set floor until
region decode is available in the browser bridge.

Gaussian blur is fixed at zero, so tiles do not require a halo. Each row batch
is solved from the Rust-owned prepared raster with the exact CPU reference or
validated WebGPU path and immediately written to the output writers. CPU
batches do not cross JavaScript/WASM for solving; WebGPU receives only the
active batch. Statistics are accumulated as scalar counters only.

OpenEXR output is scanline-streamed as fp16 ACEScg/AP1 channels with the
existing metadata. The default Exposure EXR stores direct scalar exposure
replicated across RGB; the normalized EV Exposure EXR stores its single
channel. Both preview JPEGs remain full-resolution outputs. Their RGB8 staging
planes are spooled to OPFS during solving. Each plane is encoded in a fresh,
short-lived preview worker so the decomposition worker's large WASM
decoder/prepared raster allocation is not live alongside the JPEG encoder's
full-resolution input and output buffers.

GPU resources are reused for one batch at a time, explicitly destroyed after
readback, and completed before the next tile is submitted. Mobile devices use
smaller row batches to keep transient unified-memory allocations bounded.
Device loss or GPU
validation failure restarts the complete tiled job on the accurate Rust/WASM
CPU implementation without creating full-image result arrays.

Cancellation, quota errors, decoder failures, and page unload close handles,
release mapped buffers, revoke object URLs, and delete incomplete per-job
files. Successful HEIC precision and gain-map decoding remains silent unless a
failure changes the operation.

Implementation snapshot (2026-09-07): decomposition now writes scanline EXRs
and raw full-resolution preview planes directly to OPFS and returns file
descriptors to the page. The worker no longer allocates full base, exposure,
or EXR result buffers. Preparation writes the prepared float raster to an OPFS
scratch file in small batches, then its worker is terminated. The solve worker
reads one bounded source range at a time, so the decoder/preparation heap is
not resident during "Decompose pixels". Each full-resolution JPEG is encoded
in a separate worker and that worker is terminated after completion to reclaim
its WASM heap. CPU and GPU paths use only the active bounded source/result
buffers. HEIC decoder pixel and gain-map buffers are released immediately
after Rust preparation.
