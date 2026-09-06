# Web image decomposition behavior

This document describes the user-visible behavior of the standalone image decomposition page. The page is served as a static GitHub Pages application. Image data and all expensive calculations stay in the browser; Rust/WASM workers perform decoding, color conversion, decomposition, diagnostics, and OpenEXR encoding. No uploaded image or generated result is sent to a server.

## Entry point and layout

- The feature is exposed at `decompose.html` and keeps the existing picker at its current entry point.
- The page has four areas: input, color interpretation, processing, and results.
- The page works on desktop and touch mobile layouts. Controls remain keyboard accessible and have visible focus states.
- The selected file name, format, dimensions, and file size are shown after selection.
- A reset action clears the file, options, progress, report, and download URLs.

## Input formats and metadata

The upload control accepts EXR, JPEG, PNG, HEIF, and HEIC files. The browser selects the decoder from the file type/extension and each decoder validates its own file signature. A `.png` upload is tried as PNG first; if PNG parsing or signature validation fails, the same bytes are retried as JPEG before the page gives up. Apple HDR gain-map markers are detected and reported. The current pinned high-level HEIF bridge processes the primary image and warns when an auxiliary gain-map image is present; it does not claim HDR gain-map composition until the required auxiliary image and headroom metadata are available through the bridge.

Metadata is inspected without silently filling in missing color information. The page displays any recognized ICC profile, transfer function, primaries/gamut, HDR gain-map marker, and EXIF color-space information exposed by the selected decoder. EXR channel and chromaticity metadata are also shown when present; HEIF nclx/ICC extraction remains gated by the bridge API and falls back to explicit manual confirmation.

## Gamut and transfer/gamma confirmation

Before processing, the source interpretation is established by precedence: explicit manual gamut/transfer override, then a parseable embedded ICC profile, then no guess. The page never guesses either value from weak or ambiguous metadata.

- If a supported ICC profile is present and can be parsed, it is used automatically for decoding even when the file does not expose an exact gamut/gamma pair.
- If the ICC profile can also be mapped to a supported exact gamut/transfer pair, the UI may show that pair as a reference or manual override.
- If an ICC profile is absent, unsupported, malformed, or ambiguous, the controls start unset and the page explains why manual selection is required.
- Manual gamut choices are the supported source primaries (sRGB/Rec.709, Display P3/D65, Rec.2020/D65, Adobe RGB, ACEScg, and ACES2065-1 where applicable to the input codec).
- Manual transfer choices include linear, sRGB, gamma 2.2, gamma 2.4, PQ, and HLG where the decoder exposes enough information to interpret them. Unsupported combinations are disabled rather than approximated.
- For an EXR whose channels are already linear ACES-family data, the UI shows the exact detected profile when metadata permits it; it does not infer a profile from channel names alone.

## Decomposition options

The options panel contains:

- **ACES profile**: a named profile from the existing Rust color core (Rec.2020 HDR, Rec.709 SDR, P3-D65 HDR, P3-D65 SDR, or direct sRGB). The selected profile controls the exact ACES 2.0 inverse view used by the solver and the preview JPEG transforms.
- **Refl**: a numeric reflectance/lightness parameter used by the modCAM16-HK decomposition. The control has a documented default, min/max, step, and an editable numeric value.
- **Gaussian blur**: an optional blur radius in pixels applied in the ACES2065-1/AP0 working space before solving. Zero disables blur. The radius and resulting kernel size are shown in the report.

Defaults are loaded from the documented pipeline defaults, including `Refl = 0.5` and blur sigma `0`, and are visible before processing. Invalid, non-finite, or out-of-range values are rejected inline.

## Processing and progress

Pressing **Calculate decomposition** starts a cancellable job in a dedicated worker. The worker owns the WASM module and never blocks the UI thread. A second click is replaced by a **Cancel** action while work is running.

The progress region always reports:

- current stage (decode, metadata/color interpretation, ACES conversion, blur, decomposition, diagnostics, encoding base EXR, encoding exposure EXR, encoding base preview JPEG, encoding exposure preview JPEG, or complete);
- percentage for the current job;
- live counters (pixels processed, projected pixels, clipped pixels, non-finite pixels, and bytes encoded where available);
- an accessible textual status for screen readers.

The J_HK solve is processed in 4,096-pixel worker chunks. The worker posts a zero-pixel decomposition event before the first solve and yields between chunks, so large EXRs show advancing counters and remain cancellable instead of appearing stalled at the preparation step. Progress is monotonic at the job level, even when a stage has to yield to keep the page responsive. Cancellation releases worker buffers and leaves no stale download URLs.

## Projection, clipping, and warnings

The solver automatically projects unreachable colors into the configured ACES gamut so that a report and outputs are produced for every finite input. Projection is recorded per pixel and never hidden.

The results area prominently displays warnings when any pixels were projected, clipped, non-finite, or affected by missing/ambiguous metadata. It includes counts and percentages, the source of each condition, and whether a fallback path (such as an Apple gain-map composition) was used. A job with warnings can still be downloaded; a job that cannot establish a confirmed source gamut and transfer cannot start.

## Analytic report

After successful calculation, the report includes:

- source file and metadata summary;
- confirmed source gamut and transfer;
- ACES profile, Refl, blur radius, and effective blur kernel;
- dimensions, pixel count, and processing duration;
- decomposition statistics (base/exposure ranges and means, projected/clipped/non-finite counts, and solver status);
- warnings and diagnostic notes;
- the exact output encoding and channel semantics, including the preview JPEG color pipeline.

The report is rendered as text and a compact table so it can be copied or read without the canvas preview. It remains available until reset or a new file is selected.

## Downloads and previews

Five buttons become enabled only after all output encodings finish:

- **Download base EXR** downloads a ZIP-compressed OpenEXR with linear ACEScg/AP1 RGB channels stored as fp16.
- **Download exposure EXR** downloads a ZIP-compressed OpenEXR with the exposure channel stored as fp16 using `clamp(log2(s), -10, 10) / 20 + 0.5` and the documented channel metadata.
- **Download exposure RGB EXR** downloads a ZIP-compressed OpenEXR with linear ACEScg/AP1 fp16 `R`, `G`, and `B` channels, each storing the direct scalar `s = 2^(exposure * 20 - 10)`.
- **Download base preview JPEG** downloads an sRGB JPEG produced from the ACES2065-1 linear base data through the exact `ACES 2.0 - SDR 100 nits (P3 D65)` forward transform, then through sRGB encoding.
- **Download exposure preview JPEG** downloads an sRGB JPEG produced by starting from a neutral `f(Refl, Refl, Refl)` canvas, multiplying each pixel by `s = 2^(exposure * 20 - 10)`, then applying the exact `ACES 2.0 - SDR 100 nits (P3 D65)` forward transform and sRGB encoding.

Each download is created from a browser `Blob` and uses a deterministic, descriptive filename derived from the input name and selected options. The UI reports output byte sizes and revokes old object URLs when a new job starts or is reset.

The downloads panel also renders the base and exposure preview JPEGs inline next to the download controls so the user can inspect the preview result before saving it.

## Implementation contract

The page uses a dedicated Rust crate, `modcam16-decomposition-wasm`, compiled with `wasm-pack` for a browser worker. The worker API is intentionally data-oriented:

- `inspect(bytes, format)` returns dimensions, recognized metadata, and warnings without selecting missing color values.
- `decompose(bytes, request)` handles PNG, JPEG, and EXR entirely in Rust/WASM.
- `decompose_pixels(rgb, width, height, request)` accepts decoded linear-in-container RGB from the browser HEIF bridge and runs the same processing and encoding path.

The versioned request fields are `format`, confirmed `gamut`, confirmed `transfer`, `profile`, `refl`, and `blur_sigma`. A successful response contains `report`, `base_exr`, `exposure_exr`, `exposure_rgb_exr`, `base_preview_jpeg`, and `exposure_preview_jpeg`; the output values are `Uint8Array` instances and are transferred from the worker to the UI as `ArrayBuffer`s where the browser permits it. Current OpenEXR output uses ZIP scanline compression and fp16 channels. Preview JPEG generation uses the exact ACES 2.0 implementation from `modcam16-color-core`; the browser does not substitute an approximation path for the preview transforms.

The browser HEIF bridge is pinned to `libheif-js` 1.23.2. It is responsible for decoding HEIF/HEIC and passing an explicit RGB buffer to `decompose_pixels`. The current high-level API exposes the primary image and auxiliary-image count; Apple HDR gain-map XMP/auxiliary markers are reported as warnings, and gain-map composition is not silently substituted for the primary image. Full gain-map composition remains a release-blocking codec task until the bridge can expose the auxiliary image and headroom metadata together.

The worker's decomposition path uses the shared Rust modCAM16-HK appearance model. For each finite working pixel it solves exposure with a 32-iteration J_HK bisection against the selected profile's neutral target, then stores the corresponding ACEScg base and normalized exposure. The report includes `target_j_hk`, solver status, exposure mean/range, and base mean/range in addition to projection, clipping, and non-finite counters. The preview JPEGs are derived from those outputs and are not separate approximate calculations.

## Failure handling and accessibility

Malformed files, unsupported codecs, missing required metadata, WASM failures, out-of-memory conditions, and cancellation produce an actionable error in the status region. The page does not fall back to guessed color values. A retry can be attempted after correcting the input or options. If a PNG signature check fails on a `.png` upload, the page reports the PNG error only after the same bytes have also been attempted as JPEG.

All form controls have labels, validation messages are associated with their controls, progress uses `role="progressbar"` plus a live status region, and download buttons expose disabled state until outputs are ready. The page remains usable without a pointer and at narrow viewport widths.
