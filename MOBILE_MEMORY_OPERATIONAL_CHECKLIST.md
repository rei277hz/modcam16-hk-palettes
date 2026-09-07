# Mobile memory implementation checklist

## Storage and job lifecycle

- [x] Feature-detect OPFS and create isolated per-job output files.
- [x] Prefer `FileSystemSyncAccessHandle` in the worker; use writable OPFS
      streams when synchronous handles are unavailable.
- [ ] Implement an IndexedDB fallback for browsers without usable OPFS.
- [x] Estimate available quota after preparation and before solving.
- [ ] Move quota checking before decoding; avoid counting existing source
      scratch bytes twice. Current estimates do not reserve disk space.
- [x] Include the full-resolution prepared source scratch file in the quota
      estimate and remove it after preview staging completes.
- [ ] Refuse a job cleanly when no local storage or sufficient quota exists.
- [ ] Delete incomplete files on cancellation, failure, replacement, and unload.
- [x] Return output file names and sizes instead of complete byte arrays.

## Bounded source and tile processing

- [x] Use row-aligned 524,288-pixel GPU/source-spooling targets and
      32,768-pixel CPU targets; enforce the adapter limit and use CPU if a
      full source row cannot fit on GPU.
- [ ] Keep source resolution, dimensions, and meaningful 10/12-bit precision.
- [x] Keep the prepared raster owned by Rust during preparation and expose
      only bounded ranges for the OPFS spool. The fresh solve worker reads
      those ranges into JS/WASM for both CPU and GPU.
- [x] Cache the immutable source `File` once and prefetch exactly one next
      source range while processing the current batch. Never queue a third
      source range or a second GPU solve.
- [x] Observe prefetch rejection immediately; drain/discard the pending read
      before restarting on CPU or propagating a processing failure.
- [x] Reduce preparation writes/progress messages and timer yields from
      one per row to bounded batches and periodic event-loop yields.
- [x] Spool prepared float pixels to OPFS and restart solving in a fresh
      worker, so decoder/preparation memory is absent during decomposition.
- [ ] Copy only the active source tile from decoder-owned HEIF buffers.
- [ ] Process Apple gain-map interpolation per tile and release native images
      when source traversal finishes.
- [ ] Stream PNG, JPEG, and EXR rows/chunks into the tile pipeline wherever
      decoder APIs permit; avoid duplicate full-resolution floating buffers.
- [ ] Keep blur disabled at zero so no tile halo is required.

## GPU and CPU execution

- [ ] Reuse GPU input/output/flags/readback allocations between batches.
- [x] Allocate bounded GPU resources and destroy them after successful readback.
- [ ] Handle `device.lost` and uncaptured errors.
- [x] Preserve WebGPU tolerance validation against the accurate implementation.
- [x] Restart the whole job on the tiled CPU path after a GPU solve failure,
      including CPU previews; restart traversal at row zero after draining
      the single prefetched source read.
- [x] Aggregate report statistics without retaining per-pixel history.

## Streaming outputs

- [x] Add stateful scanline OpenEXR writers for Base, Exposure RGB, and
      normalized EV Exposure outputs.
- [x] Preserve ACEScg/AP1 fp16 channels, chromaticities, and metadata.
- [x] Encode both full-resolution Display P3/sRGB previews in short-lived
      workers, separate from the decomposition worker's large WASM heap.
- [x] Stream EXR encoder output and raw preview planes directly to local files;
      JPEG encoding reads one spooled plane at a time.
- [x] Reuse fp16 bit-conversion scratch views, removing per-channel typed-array
      allocation; keep scanline format and color arithmetic unchanged.
- [x] Keep preview storage writes outside GPU-transform fallback handling so a
      write failure cannot append duplicate preview pixels.
- [ ] Verify output files can be previewed and downloaded through object URLs
      backed by OPFS/IndexedDB files.

## UI and protocol

- [x] Replace the result message's five byte arrays with output descriptors.
- [x] Show tile progress and aggregate pixel diagnostics; output byte counts are
      reported when files are finalized.
- [ ] Keep thumbnails and enlarged previews backed by stored JPEG files.
- [ ] Revoke object URLs and close old file references before a new job.
- [ ] Keep quota/storage errors actionable and concise.

## Validation

- [ ] Compare tiled and legacy results on small PNG, JPEG, EXR, ICC-only,
      nclx-only HEIC, and Apple gain-map fixtures.
- [ ] Validate `IMG_9487.HEIC` automatic Rec.2020/PQ interpretation.
- [ ] Validate `IMG_9809.HEIC` 10-bit primary and gain-map reconstruction.
- [ ] Read every generated EXR back and verify dimensions, fp16 channels,
      ACEScg metadata, and exposure encodings.
- [ ] Decode both JPEG previews and compare pixels to the accurate ACES 2.0
      P3-D65 CPU reference within the documented tolerance.
- [ ] Test cancellation, quota exhaustion, OPFS absence, IndexedDB fallback,
      malformed input, malformed ICC, and GPU device loss.
- [x] Test a synthetic 6000x4000 source traversal: 46 GPU-sized batches,
      complete sample order, row alignment, bounded reads, and at most one
      prefetched source range (`cd web && npm run test:batches`).
- [x] Test short final batches, read failure propagation, early return with
      a pending read, restart ordering, GPU adapter limits, and EXR row
      conversion consistency across batch boundaries.
- [x] Run Rust workspace tests (53 core and 6 decomposition tests), TypeScript
      checking, optimized release WASM generation, and the Vite production build.
- [ ] Measure end-to-end 6000x4000 solving/output runtime and peak memory on
      mobile Safari with the increased budgets; the synthetic test exercises
      source traversal, not real GPU execution or full output encoding.
- [ ] Inject device loss, cancellation, and storage-write failures into the
      complete worker pipeline and verify cleanup and CPU restart outputs.
- [ ] Exercise the deployed page on iOS Safari with remote Web Inspector and
      inspect for WebContent/GPU process termination.

## Snapshot

- 2026-09-07: Added OPFS-backed scanline EXR writers, quota checks, output-file
      descriptors, and bounded solve/readback batches. Full base, exposure, and
      EXR byte arrays are no longer retained. Rust now owns the prepared raster
      and exposes row batches only. Prepared pixels are spooled to OPFS and
      solving runs in a fresh worker; full-resolution preview planes are
      encoded in isolated workers. Codec APIs still decode a full source raster
      before the preparation spool begins.
- 2026-09-07 throughput update: increased batch targets, added one-batch
      prefetch over a cached source file, removed fp16 per-channel allocations,
      and reduced timers/synchronous-write microtasks. A 600,000-pixel Node
      conversion microbenchmark improved from 2425.6 ms to 33.0 ms with the
      same checksum; this is not a measurement of total job speed. All outputs
      remain full-resolution. Updated stale lifecycle and allocation claims
      above to distinguish implemented behavior from remaining work.
