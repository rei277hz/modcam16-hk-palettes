# Decomposition behavior (`decompose.html`)

This is the authoritative behavior contract for the browser decomposition page
at [`decompose.html`](./decompose.html). It is a static, browser-local tool:
uploaded bytes, decoder data, Rust/WASM workers, WebGPU resources, reports,
scratch files, previews, and downloads remain on the device. No server
endpoint is required for decoding, processing, or saving results.

## Source loading and format reporting

The visible source-image frame is the file picker. It occupies roughly half of
the input row beside the interpretation controls on desktop and adapts to the
compact mobile layout. Before loading, it is empty and asks the user to load
an image while listing EXR, JPEG, PNG, HEIC, and HEIF. The hidden file input
remains the browser selection mechanism.

Clicking the frame opens the picker. Clicking it again after a file is loaded
replaces the source, including when the same file is selected. Replacement
resets interpretation, source preview, report, progress, and outputs before
inspecting the new file. Once loading starts, the load prompt and accepted
format list disappear and the preview occupies the frame.

The source preview preserves the source aspect ratio with `object-fit:
contain`; black borders are allowed and cropping or stretching is forbidden.
The frame height is flexible and may compress on a short viewport, but it
remains at least tall enough for the stacked interpretation controls and format
indicator. The source area has no local vertical scroller and no horizontal
overflow.

After successful inspection, the only text below the interpretation menus is
the decoder's actual source format, such as `JPEG`, `PNG`, `EXR`, `HEIC`, or
`HEIF`. It contains no filename, dimensions, metadata explanation, or warning.
The format is reset on replacement and reflects parser detection, including a
JPEG whose filename ends in `.png`.

Malformed files, unsupported codecs, and failed format fallbacks produce an
actionable error. A `.png` file is attempted as PNG first; if the signature or
parser rejects it, its bytes are attempted as JPEG before the error is shown.

## Source interpretation

The decoder establishes source interpretation in this order:

1. A recognized embedded ICC profile.
2. Format metadata such as EXR color space/chromaticities, PNG cICP/sRGB/gAMA
   and chromaticities, HEIF nclx, or JPEG color-space tags.
3. A complete explicit Primaries and Transfer selection.

An ICC profile can be used directly even when it cannot be reduced to one of
the manual gamut/transfer pairs. The page never guesses from a filename,
extension, weak metadata, or an ambiguous profile.

The Primaries and Transfer controls are hidden before inspection and while a
replacement is being inspected. Neither menu contains a `Select Primaries` or
`Select Transfer` placeholder. The Primaries menu contains the only embedded
option, at the top, with provenance such as `Use embedded ICC`, `Use embedded
CICP`, `Use embedded chromaticities`, or `Use embedded metadata`.

When authoritative embedded information is usable, Primaries is preselected to
that option and Transfer is hidden. Transfer never contains an embedded option
and is disabled while embedded Primaries is active. Selecting a concrete
Primaries value switches to manual mode, reveals Transfer, and preselects
`sRGB` so the preview cannot pass through an untagged raw decoder view. A later
Primaries change preserves an already explicit Transfer value.

When no usable embedded information exists, only Primaries is shown and its
label is `Primaries (action needed)`. Only the suffix uses the warning color.
After a concrete Primaries selection, the suffix disappears, Transfer appears
with `sRGB` selected, and the source preview updates. A manual interpretation
is valid only when both controls contain concrete values. An empty or partial
pair remains unresolved and cannot start decomposition.

The interpretation state is exactly one of `embedded`, `manual`, or
`unresolved`. The old `Override embedded ICC` action and the warning banner
asking the user to select gamut and transfer are absent.

## Source preview

Inspection and preview preparation run in a dedicated worker. Embedded mode
uses the decoder's ICC, CICP, EXR chromaticities, or other authoritative
metadata through the same conversion path used by decomposition. Manual mode
uses the selected Primaries and Transfer. A preview request is sent
immediately after either concrete selection changes.

While a manual pair is incomplete, the last valid preview remains visible but
muted. If no embedded interpretation exists, a decoder/raw preview may be
shown as a visibly muted reference; it is never used as decomposition input.
Once a complete pair is selected, the muted state is removed and the preview
is replaced with the exact interpreted result.

Source previews are bounded to a display-safe size and resampled in linear
light before the exact ACES 2.0 SDR 100-nit P3-D65 transform and existing
Display P3/sRGB JPEG encoder. Interpretation changes should refresh in under
three seconds on representative images and browsers. The previous image stays
visible while an update is pending.

Preview requests carry a file identity and generation. Responses for an older
file or interpretation are discarded, so a slow worker cannot overwrite a
newer selection. A failed request shows an actionable error while retaining the
last valid image where possible.

The source file and its preview remain available after decomposition,
cancellation, and worker replacement. Retention keeps the browser `File` and
bounded preview resources; it does not require retaining a full decoded raster
in JavaScript or in the replacement worker.

## Options and decomposition

The options panel is enabled after a source is inspected. It exposes the ACES
profile, `Refl`, and Gaussian blur sigma. Supported web profiles are:

- ACES 2.0 - SDR 100 nits (Rec.709);
- ACES 2.0 - SDR 100 nits (P3 D65);
- ACES 2.0 - HDR 1000 nits (P3 D65);
- ACES 2.0 - HDR 1000 nits (Rec.2020).

P3-D65 HDR 1000 nits is the default. Numeric ranges are visible and invalid
values are rejected inline. Gaussian blur is optional and defaults to zero;
when enabled it is a separable reflected-boundary kernel applied equally to
the three AP0 channels before solving.

After source conversion to linear ACES2065-1/AP0, let `Q` be the selected
view's inverse of the un-tone-mapped display-reference value. For every pixel,
the solver finds AP0 base `B` and scalar `s` such that:

```text
Q = B * s
e = log2(s),   s = 2^e
J_HK(f(B)) = J_HK(f(Refl, Refl, Refl))
```

The stored base is `AP1(B)` in linear ACEScg. The norm EV channel is:

```text
norm_EV = clamp(log2(s), -10, 10) / 20 + 0.5
```

The direct scalar `s` is retained for the replicated RGB exposure output and
is never reconstructed from the clamped norm EV channel. The norm EV channel
is always bounded to `[0, 1]`; `e` and `s` may lie outside the representable
range when exposure is clipped and counted.

For an unclipped solution, this is equivalent to
`s = 2^(norm_EV * 20 - 10)`. Once `e` falls outside +/-10 stops, only the
norm EV representation is clipped; the direct RGB output keeps the solved
scalar.

Black (`Q = 0`) receives the neutral base, norm EV `0.0`, and scalar `s = 0.0`
through an explicit zero rule. Exposure outside +/-10 stops is clipped and
counted.
Projection into the selected view's limiting RGB volume and clamping negative
AP0 components are opt-in lossy operations; all projections, clamps,
non-finite values, solve residuals, and tolerance exceedances are reported.

## Worker pipeline and progress

The page uses a preparation worker for decode, metadata, source conversion,
and source spooling, then a fresh solve worker for bounded source traversal,
decomposition, preview rows, and EXR writers. Short-lived preview encoder
workers encode display JPEGs after the solve worker has finished its large
working allocations.

Progress is monotonic within an attempt and labels decode/inspection,
interpretation, source preparation, WebGPU initialization and validation,
decomposition, preview transforms, EXR encoding, JPEG encoding, completion,
cancellation, and errors. Pixel counters include processed, projected,
clipped, and non-finite values where available. The Decompose action becomes
Cancel without changing width or font weight while a job is running.

Cancellation terminates a worker when an in-flight WASM or GPU operation cannot
be interrupted directly. It removes incomplete outputs and releases worker
resources while retaining the selected source and source preview.

## WebGPU selection and fallback

WebGPU is initialized inside the solve worker and is selected automatically
only after adapter/device setup, shader validation, shared parameter upload,
and numerical comparison against the accurate f64 CPU implementation. It uses
the exact ACES 2.0 fixed-function processors, modCAM16-HK equations, profile
tables, projection, clipping, and 32-step exposure bisection. GPU arithmetic
uses portable `f32`; the CPU implementation remains authoritative.

The browser target is a conservative 131,072 pixels per batch, bounded by the
adapter storage limits and never exceeding the implementation maximum. GPU
validation requires exposure error of at most `0.002` stops and base-channel
absolute error of at most `0.0002` for deterministic and seeded samples across
all profiles. A missing GPU, insecure origin, adapter/device failure, shader
failure, validation mismatch, or unsupported limit selects the chunked WASM
CPU path before processing.

If a GPU buffer creation, upload, queue submission, mapping, readback, preview,
or device operation fails after processing starts, the worker stops using that
context for the job. It closes sinks, removes partial files, resets
statistics/preview accumulators, and restarts from row zero through the CPU
path. The report identifies `WASM CPU` and retains the GPU cause. CPU failure
retains both backend errors, stacks, stage, dimensions, and batch context.
There is no GPU/CPU retry loop and no partial output is enabled.

Temporary GPU resources are explicitly released on success and every failure
path. A device that repeatedly fails can be quarantined for later jobs in the
same worker session. Secure GitHub Pages and localhost can expose WebGPU;
HTTP LAN pages may not, and that condition is reported as an expected CPU
fallback rather than a color error.

## Storage and memory behavior

OPFS is the preferred scratch and output store. Prepared AP0 source pixels,
scanline EXRs, and capped preview RGB planes are written incrementally. The
solve worker reads one immutable source file by bounded ranges with one read
ahead; it never accumulates full base, exposure, EXR, or preview arrays in
JavaScript or WASM memory.

If OPFS file creation or synchronous access is unavailable, the same storage
abstraction uses a chunked IndexedDB backend for source, EXR, and preview
files. Cleanup and download reads use that abstraction, and IndexedDB copies
take precedence over stale OPFS entries. Unique per-job source names avoid
stale mobile Safari locks.

GPU and CPU batch buffers, preview row accumulators, JPEG encoder input, and
output blobs are bounded. On cancellation, replacement, worker failure, quota
failure, or page unload, incomplete files and object URLs are removed on a
best-effort basis. Storage errors are reported as storage failures and are not
misclassified as GPU failures.

## Outputs and downloads

Successful decomposition enables exactly three EXR downloads:

1. `Base EXR`: linear ACEScg/AP1 RGB, fp16, three channels.
2. `Exposure EXR`: direct scalar `s` replicated into linear ACEScg RGB,
   fp16, three channels.
3. `Exposure EXR (norm EV)`: bounded scalar norm EV, fp16, one `exposure`
   channel.

All are scanline OpenEXR files with the required magic bytes, little-endian
fp16 samples, ZIP16 compression when effective, and a raw-block fallback when
compression is larger. Headers carry source interpretation, selected profile,
Refl, blur, exposure encoding, ACEScg metadata, dimensions, and diagnostic
statistics. The buttons are equal width, ordered Base then the two exposure
outputs, and do not include a `ZIP16` description. They reset to disabled
`Waiting` on a new file or job and show actual file sizes after completion.

Two display JPEGs are generated separately from solved linear AP0 values. The
base preview uses the linear base; the exposure preview uses the neutral
`Refl * s` canvas. Area resampling happens before the exact ACES 2.0 SDR
100-nit P3-D65 transform and sRGB encoding, preserving HDR and negative AP0
values during averaging. Norm EV or already-rendered P3 pixels are never
averaged.

Display JPEGs are capped at 2048 pixels on the longest edge without upscaling
and preserve aspect ratio. Inline thumbnails and enlarged overlay images use
only these display versions and fit entirely inside flexible frames with black
borders. The overlay heading is two lines: `Base preview` or `Exposure
preview`, followed by the dimmer `Display P3 · [actual display dimensions]`.

`Save full-size JPEG` appears only in the open preview overlay, immediately to
the left of `Close`. It saves the original-dimension JPEG. When native file
sharing is supported, the page prepares a named `image/jpeg` File and opens
the Android/iOS share sheet, allowing Save Image or Save to Photos. A cancelled
share does nothing. On iPhone/iPad without file sharing, including an HTTP LAN
page, the action opens the full-size JPEG in a separate image tab for
touch-and-hold saving. Other browsers use a direct file save. Full-size JPEGs
are never decoded inline during display-preview recovery.

## Analytic Report and Debug info

The report is a folded disclosure on mobile and a bounded internal region on
desktop. Its definition lists wrap labels, values, long filenames, summaries,
and warnings. Expanding it on mobile enables page scrolling; folding it returns
to the single-viewport layout and scrolls to the top. A new file or job folds
it again. Preview overlays lock background scrolling.

The Debug info disclosure sits below the report and starts folded. It has a
read-only selectable text area and `Save debug info as .txt`. The saved file
contains the complete bounded session log, including page and worker console
output, uncaught errors, rejected promises, resource errors, stacks, WASM
panic details, backend transitions, storage operations, JPEG encoder retries,
checkpoints, and cancellation. Logs remain available across retries and file
replacement within the session, with a maximum of 1,500 entries and roughly
one million characters. Older or oversized entries are explicitly truncated.

The page preserves ordinary console output. Browser-internal DevTools output,
operating-system logs, and fatal browser-process crashes cannot be captured.
Logs identify time, severity, and page/worker instance, but never include image
bytes, pixel arrays, or embedded profile payloads. On Android/iOS the save
action shares `decomposition-debug.txt` through the native sheet when
available; other browsers save it directly. Expanding Debug info enables its
own page scrolling independently of the report.

## Responsive, accessible, and privacy requirements

The source area, options, progress, results, report, and Debug info must fit
without nested source-area scrolling, horizontal overflow, or overlapping
controls at desktop sizes and at the representative mobile viewport
`360 x 645`. Source, base, and exposure frames use contain-fit behavior.
Labels, buttons, selectors, status text, disclosure controls, and focus
indicators remain usable with keyboard and assistive technology. Loading,
muted, error, fallback, cancellation, and completion states are communicated
by text or semantics in addition to color.

The page never uploads source data automatically. Replacing a file revokes
obsolete object URLs and removes obsolete outputs. A stale worker response,
partial file, or failed backend attempt must not overwrite a newer source or
enable an incomplete download.

## Stable interface invariants

- A decomposition request contains either no explicit source gamut/transfer
  for embedded decoding or both concrete manual values; a single value is
  never sent.
- Inspection responses identify the detected format, dimensions, metadata
  provenance, embedded availability, and warnings needed by the selectors.
- Preview requests and responses carry file identity and generation, plus mode,
  dimensions, and bounded JPEG bytes.
- Solve progress remains monotonic and report fields identify source
  interpretation, options, backend, adapter/validation state, output sizes,
  preview transform, and all diagnostics.
- Output descriptors identify storage-backed files and their MIME types;
  consumers read them through the shared storage abstraction.
- CPU output semantics remain the reference regardless of WebGPU selection,
  storage backend, preview retry, or mobile layout.
