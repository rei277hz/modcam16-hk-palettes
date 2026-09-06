# Mobile memory implementation checklist

## Storage and job lifecycle

- [x] Feature-detect OPFS and create isolated per-job output files.
- [x] Prefer `FileSystemSyncAccessHandle` in the worker; use writable OPFS
      streams when synchronous handles are unavailable.
- [ ] Implement an IndexedDB fallback for browsers without usable OPFS.
- [x] Estimate quota before decoding and reserve space for all outputs.
- [ ] Refuse a job cleanly when no local storage or sufficient quota exists.
- [ ] Delete incomplete files on cancellation, failure, replacement, and unload.
- [x] Return output file names and sizes instead of complete byte arrays.

## Bounded source and tile processing

- [ ] Select a default 512×512 tile, bounded by device and GPU limits.
- [ ] Keep source resolution, dimensions, and meaningful 10/12-bit precision.
- [ ] Replace full `Float32Array` preparation with tile/row-band access.
- [ ] Copy only the active source tile from decoder-owned HEIF buffers.
- [ ] Process Apple gain-map interpolation per tile and release native images
      when source traversal finishes.
- [ ] Stream PNG, JPEG, and EXR rows/chunks into the tile pipeline wherever
      decoder APIs permit; avoid duplicate full-resolution floating buffers.
- [ ] Keep blur disabled at zero so no tile halo is required.

## GPU and CPU execution

- [x] Reuse one GPU input/output/flags/readback allocation sized to one batch.
- [ ] Destroy replaced GPU resources and await completion before reuse.
- [ ] Handle `device.lost` and uncaptured errors.
- [ ] Preserve WebGPU tolerance validation against the accurate implementation.
- [ ] Restart the whole job on the tiled CPU path after a GPU failure.
- [x] Aggregate report statistics without retaining per-pixel history.

## Streaming outputs

- [x] Add stateful scanline OpenEXR writers for Base, Exposure RGB, and
      normalized EV Exposure outputs.
- [x] Preserve ACEScg/AP1 fp16 channels, chromaticities, and metadata.
- [ ] Add row-fed JPEG encoders for both Display P3/sRGB previews.
- [x] Stream EXR encoder output and raw preview planes directly to local files;
      JPEG encoding reads one spooled plane at a time.
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
- [ ] Run a synthetic 6000×4000 job and assert no full result arrays are
      allocated and that working memory remains tile-bounded.
- [ ] Exercise the deployed page on iOS Safari with remote Web Inspector and
      inspect for WebContent/GPU process termination.

## Snapshot

- 2026-09-07: Added OPFS-backed scanline EXR writers, quota checks, output-file
  descriptors, and bounded solve/readback batches. Full base, exposure, and
  EXR byte arrays are no longer retained. Full source preparation and preview
  RGB staging remain follow-up memory reductions.
