# Mobile memory behavior for image decomposition

The web application preserves the uploaded image's full pixel dimensions and
precision. It does not resize the source to avoid memory pressure. Large jobs
are processed as bounded row-major tiles in the decomposition worker.

JPEG viewing contract (2026-09-07): each of the two JPEG outputs has a
full-resolution download and a separate display version capped at 2048 pixels
on its longest edge, preserving aspect ratio and never upscaling. Both the
inline thumbnail and enlarged overlay use only the display version. A
"Download full-size JPEG" button beside each preview downloads the original
dimensions without assigning it to an image element. This change applies only
to JPEG viewing; all three EXRs and both full-resolution JPEGs remain intact.

Generate display pixels from the solved, linear ACES2065-1/AP0 batches before
the nonlinear output transform. The Rust streaming area resampler accumulates
base AP0 RGB and the exposure preview's linear neutral canvas (`Refl * s`,
where `s = 2^(20 * normalizedEV - 10)`). It retains only two row accumulators
per image and emits completed reduced AP0 rows; it never averages normalized
EV, tone-mapped P3 pixels, or JPEG pixels. HDR and negative AP0 values remain
unclipped during resampling. Apply the same exact ACES 2.0 SDR 100-nit P3-D65
transform and sRGB encoding as the full-size previews to those accumulated
rows, using the validated GPU path or accurate CPU fallback, then spool the
capped RGB8 planes to OPFS. Completed AP0 rows are returned in a temporary
buffer bounded by the current solve batch; no full-size AP0 preview raster is
retained. The existing source read-ahead bound is unchanged.

Encode with the same Rust JPEG encoder and embedded Display P3 ICC profile.
No full-resolution canvas, ImageBitmap, or browser JPEG decode is used to
build the display version. Finish display encoding workers before starting
the full-resolution encoding workers, and release/revoke display and download
resources on replacement or cancellation. Quota estimates include the extra
capped RGB staging files and JPEGs.

Preparation may retain decoder-owned and Rust-owned full source rasters. It
spools prepared AP0 RGB f32 pixels to OPFS, then the preparation worker is
terminated. A fresh solve worker keeps one working batch and exactly one
loading/ready next source batch, bounded GPU readback buffers, and scanline EXR
encoder state. No decoder/preparation heap remains live in the solve worker.

GPU and source-spooling batches target 524,288 pixels. CPU solve batches target
32,768 pixels because CPU calls block the worker. Both budgets round down to
whole rows, with at least one complete row; GPU batches also respect the
adapter's pixel limit. If even one row exceeds that limit, use CPU. These
budgets apply on desktop and mobile without relying on user-agent detection.
For 6000x4000, GPU batches contain 522,000 pixels (87 rows), giving 46 batches
instead of the earlier 4,000 single-row batches. Each source buffer is about
6 MiB, so current plus prefetched source use about 12 MiB, in addition to the
current batch's WASM/GPU/result allocations.

The solve worker opens one immutable source `File` and reads only its required
ranges. It starts the next range read before processing the current batch,
without queuing a third source batch or submitting a second GPU solve. A
prefetched read failure is observed immediately and reported when consumed.
On restart or error, the outstanding read is drained and discarded before a
new traversal begins. Cancellation terminates the worker from the UI.
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
add. Storage/quota checks currently occur after preparation and before solving,
not before decoding; moving that check earlier remains outstanding. Quota
estimation is conservative and does not reserve disk space.

Source decoding retains the existing interpretation rules: an explicit gamut
and transfer override wins, a usable ICC profile is used directly when present,
supported HEIF nclx values are used automatically when ICC is absent, and
missing color information requires manual selection. HEIC primary and Apple
gain-map samples remain 10/12-bit capable without an 8-bit display conversion;
the decoder-owned raster is the unavoidable codec working-set floor until
region decode is available in the browser bridge.

Gaussian blur is fixed at zero, so tiles do not require a halo. Each source
range crosses into WASM for the exact CPU reference or validated WebGPU solve,
and results are immediately written to the output writers. Statistics are
accumulated as scalar counters only. Both paths retain their accurate ACES 2.0
transforms and existing validation tolerances. Larger batches and read overlap
do not alter the color math or output dimensions.

OpenEXR output is scanline-streamed as fp16 ACEScg/AP1 channels with the
existing metadata. The default Exposure EXR stores direct scalar exposure
replicated across RGB; the normalized EV Exposure EXR stores its single
channel. Both preview JPEGs remain full-resolution outputs. Their RGB8 staging
planes are spooled to OPFS during solving. Each plane is encoded in a fresh,
short-lived preview worker so the decomposition worker's large WASM
decoder/prepared raster allocation is not live alongside the JPEG encoder's
full-resolution input and output buffers.

GPU resources are allocated per batch, explicitly destroyed after successful
readback, and completed before the next GPU operation is submitted. Persistent
GPU buffer reuse remains an optimization to implement. GPU validation failure
selects the accurate Rust/WASM CPU implementation; a GPU solve failure restarts
the complete job at row zero with CPU solving and CPU previews. A preview GPU
failure switches subsequent preview transforms to exact CPU. Storage write
errors are reported as storage failures, without retrying an already partially
written batch as though it were a GPU failure.

The fp16 scanline conversion reuses its four-byte bit-conversion scratch views
instead of allocating two typed arrays per output channel. Synchronous OPFS
writes no longer await a synchronous return value. Source spooling and solving
yield to the worker event loop periodically (50 ms threshold), without forcing
a timer for every batch. EXR scanline layout and JPEG encoding are unchanged.

Cancellation, quota errors, decoder failures, and page unload should release
resources and remove incomplete files. Current termination and OPFS cleanup
are best effort; comprehensive lifecycle testing remains outstanding.
Successful HEIC precision and gain-map decoding remains silent unless a
failure changes the operation.

Implementation snapshot (2026-09-07): decomposition now writes scanline EXRs
and raw full-resolution preview planes directly to OPFS and returns file
descriptors to the page. The worker no longer allocates full base, exposure,
or EXR result buffers. Preparation writes the prepared float raster to an OPFS
scratch file in small batches, then its worker is terminated. The solve worker
reads bounded source ranges with one read ahead, so the decoder/preparation heap is
not resident during "Decompose pixels". Each full-resolution JPEG is encoded
in a separate worker and that worker is terminated after completion to reclaim
its WASM heap. CPU and GPU paths use only the active bounded source/result
buffers plus one prefetched source batch. HEIC decoder pixel and gain-map buffers are released immediately
after Rust preparation.

Throughput verification (2026-09-07): automated tests cover single-read
prefetch, ordering, tail batches, read failures, draining before CPU restart,
adapter limits, and a full 6000x4000 synthetic traversal. A Node v26.7.0
microbenchmark converting 600,000 EXR pixels measured 2425.6 ms before versus
33.0 ms after scratch-view reuse (same checksum). This measures conversion
only; it is not an end-to-end or iOS speed claim. Real-device runtime and peak
memory with these larger batches still need measurement. Use optimized release
WASM for performance checks.
