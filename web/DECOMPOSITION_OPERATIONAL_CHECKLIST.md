# Decomposition operational checklist

Use this concise release gate for changes to `web/decompose.html`, its workers,
WASM, GPU path, storage backends, or output encoders. It records repeatable
acceptance checks; historical snapshots and obsolete implementation TODOs are
not kept here.

## Documentation and build

- [ ] Confirm `DECOMPOSITION_BEHAVIOR.md` describes the current HTML, worker
      messages, report fields, output descriptors, and mobile behavior.
- [ ] Run Rust workspace tests, including decomposition and exact ACES/GPU
      reference tests.
- [ ] Run `fnm exec --using v26.7.0 npx tsc --noEmit`.
- [ ] Run `fnm exec --using v26.7.0 npx vite build`.
- [ ] Run `fnm exec --using v26.7.0 npm test` and `git diff --check`.

## Input and interpretation

- [ ] Load representative EXR, JPEG, PNG, HEIC, and HEIF files, including a
      `.png`-named JPEG and malformed input.
- [ ] Verify ICC, CICP/nclx, EXR chromaticities, and no-metadata precedence;
      confirm the page never guesses an interpretation.
- [ ] Verify 10/12-bit HEIF precision and Apple gain-map behavior, including a
      missing or malformed auxiliary image.
- [ ] Verify embedded Primaries hides Transfer, manual Primaries reveals
      Transfer with `sRGB`, and Transfer never offers an embedded option.
- [ ] Verify no placeholder options, no override-ICC action, no warning banner,
      and the `Primaries (action needed)` suffix clears after selection.
- [ ] Replace the source by clicking the frame, including selecting the same
      file again; confirm format-only metadata and reset state.

## Source and result UI

- [ ] Confirm the empty frame prompt and format list hide after loading.
- [ ] Confirm source, Base, and Exposure previews contain the complete image
      with preserved aspect ratio and black borders when needed.
- [ ] At `360 x 645`, verify no source-area vertical scroller, no horizontal
      overflow, flexible frame heights, and no control overlap.
- [ ] Change Primaries and Transfer repeatedly; confirm the source preview
      updates within three seconds while the previous preview remains visible.
- [ ] Decompose, cancel, and decompose again without reloading; confirm the
      source image and interpretation controls remain available.
- [ ] Verify progress is monotonic, Decompose changes to same-width Cancel,
      and incomplete outputs remain disabled.

## Numerical and file correctness

- [ ] Validate norm EV encoding, black-pixel handling, projection/clipping
      counts, non-finite diagnostics, and reconstruction.
- [ ] Inspect all three EXRs for magic bytes, dimensions, channels, fp16
      endianness, ZIP16/raw blocks, ACEScg metadata, and report provenance.
- [ ] Confirm the three EXR buttons have equal widths, omit `ZIP16`, reset to
      `Waiting`, and show final file sizes.
- [ ] Verify display JPEG area resampling occurs in linear AP0 before the exact
      P3-D65 transform, uses a 2048-edge cap, and reports actual display
      dimensions.
- [ ] Open both overlays and verify two-line headings, dimmer metadata line,
      contain-fit images, outside-click close, and `Save full-size JPEG` only
      beside `Close`.
- [ ] Test desktop file save, Android/iOS share sheets, cancelled sharing,
      iPhone HTTP-LAN image-tab fallback, and full-size dimensions/ICC.

## Backend, storage, and failure recovery

- [ ] Run with WebGPU enabled and compare deterministic/random samples against
      the f64 CPU reference within exposure `0.002` stops and base `0.0002`.
- [ ] Run no-WebGPU, insecure-origin, validation-failure, buffer/readback,
      queue, mapping, and device-loss scenarios; confirm CPU completion or a
      clear unrecoverable error.
- [ ] Confirm a GPU failure restarts the complete job from row zero, removes
      partial outputs, reports `WASM CPU`, and preserves the original cause.
- [ ] Exercise OPFS creation/access failure and IndexedDB chunked fallback;
      verify source, EXRs, previews, downloads, cleanup, and stale-file
      precedence.
- [ ] Cancel during preparation, GPU work, CPU restart, preview encoding, and
      cleanup; verify workers, GPU resources, object URLs, and scratch files
      are released.
- [ ] Force JPEG encoder termination and confirm bounded fresh-worker retry,
      actual retry dimensions, full-size save preservation, and both errors in
      Debug info when recovery fails.

## Diagnostics, device matrix, and release

- [ ] Confirm Analytic Report and Debug info start folded, expand independently,
      scroll correctly, and restore the compact viewport when folded.
- [ ] Verify Debug info captures page/workers, stacks, promise rejections,
      WASM panic context, checkpoints, backend transitions, and storage events;
      confirm no image bytes or pixel arrays are logged.
- [ ] Save the complete log as `.txt`; test native mobile sharing and direct
      file-save fallback with the text area both scrolled and unscrolled.
- [ ] Test desktop Chromium, CPU-only browser, Android Chromium, iPhone Safari,
      secure GitHub Pages/localhost, and `http://10.42.0.144:5173`.
- [ ] Confirm the page route, privacy guarantee (no upload), output hashes,
      and final Markdown links before release.
