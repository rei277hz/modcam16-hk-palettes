# Image Decomposition CLI

`modcam16-decompose` separates an OpenEXR, JPEG, PNG, HEIC, or HEIF image into
a perceptual base-color image and a scalar exposure image for a selected ACES
2.0 view. Every accepted input is decoded and interpreted as color-managed
source data, converted to scene-linear ACES2065-1 (AP0), and then processed by
the decomposition described below. Outputs remain linear ACEScg/AP1 base and
scalar exposure OpenEXR files.

## Inputs

The command accepts a three-channel RGB OpenEXR, JPEG, PNG, HEIC, or HEIF
input. OpenEXR scanline files with half-float (`fp16`) or single-precision
(`fp32`) channels are supported. JPEG/PNG integer samples and HEIF 10/12-bit
samples are normalized before transfer decoding. Alpha is ignored; the input
must provide RGB samples.

Color interpretation uses metadata in this order:

1. A recognized embedded ICC profile;
2. format metadata (`ocioColorSpace`/`colorInteropID` and EXR
   `chromaticities`; PNG `cICP`, `sRGB`, `gAMA`, and chromaticities; HEIF
   `nclx`; JPEG EXIF color-space tags);
3. explicit command-line choices.

The source gamut and transfer function are separate choices. Supported gamut
choices include Rec.709/sRGB, Display P3/P3-D65, Rec.2020, Adobe RGB, ACEScg,
and ACES2065-1. Supported transfer choices include Linear, sRGB, Gamma 1.8,
Gamma 2.2, Gamma 2.4/BT.1886, BT.709/BT.2020, PQ/ST 2084, and HLG/BT.2100.
These are exact fixed names; aliases and shorthand spellings are not accepted.
OpenEXR scene-linear names remain supported through `--input-color-space`, and
`Linear P3-D65` is included in that list. Explicit `--input-gamut` and
`--input-transfer-function` values override the corresponding metadata.

When either required component is unresolved, an interactive terminal asks the
user to choose it. A non-interactive run must provide both components. The
command never assumes sRGB merely because metadata is absent or unrecognized.
An ICC profile that cannot be mapped to a supported standard combination is
reported as unresolved and follows the same explicit-selection path.

HEIC/HEIF primary images use `pillow-heif` and preserve HDR sample precision.
Apple HDR gain-map HEIC files use the `apple-hdr-heic` decoder (and its
`exiftool` runtime dependency) to combine the primary Display P3 image and
gain map into linear Display P3 before conversion to ACES2065-1. A gain map
that is present but cannot be decoded is an error; the SDR base is never
silently substituted for an HDR source. The decoder's 203-nit reference-white
values are normalized to this project's 100-nit ACES scene-reference scale.

## Transform and decomposition

Let `S` be an input pixel after conversion to ACES2065-1. The image is first
sent through the ACES 2.0 `Un-tone-mapped` transform, producing the
display-reference value `P`. The selected ACES 2.0 view transform, with
display encoding omitted, is `f`; it maps AP0 scene RGB to display-reference
CIE XYZ-D65. `f'` is its inverse.

For every pixel, the working value is:

```text
Q = f'(P) = f'(Un-tone-mapped(S))
```

The command solves a scalar `s` and AP0 base color `B` such that:

```text
Q = B * s
s = 2^(exposure * 20 - 10)
J_HK(f(B)) = J_HK(f(Refl, Refl, Refl))
```

The equation above is in the internal AP0 working space. The stored base
pixels are `AP1(B)` in linear ACEScg; convert them back to ACES2065-1 before
using the reconstruction equation.

Before solving the base/exposure decomposition, the AP0 working image `Q` can
be blurred with a separable, reflected-boundary Gaussian. The same kernel is
applied to all three RGB channels. `--gaussian-blur` specifies the Gaussian
sigma in pixels and is opt-in (default `0`, disabled). The blurred `Q` is the
value decomposed into `B` and `s`, so the base and exposure outputs remain
paired.

`J_HK` is evaluated with the package's existing modCAM16-HK viewing
conditions. `Refl` is a positive scene-linear scalar supplied by
`--refl` and defaults to `0.5`.

The decomposition is calculated in three-channel fp32 ACES2065-1 (AP0). The
base image is converted from AP0 to linear ACEScg (AP1) for storage and written
as three-channel fp16 RGB. The exposure image stores one fp16 channel named
`exposure`. Its value is the normalized, clipped representation of `log2(s)`:

```text
exposure_channel = clamp(log2(s), -10, 10) / 20 + 0.5
```

Reconstruction of the un-tone-mapped display-reference pixel is therefore:

```text
Q = AP0(base_ACEScg) * 2^(exposure_channel * 20 - 10)
```

Values requiring an exposure outside the supported range are clipped to the
nearest endpoint and counted in the command diagnostics; endpoint clipping
necessarily loses exact scalar reconstruction. J_HK solve residuals, inverse
round-trip residuals, and reconstruction residuals that exceed their requested
tolerances do not stop the command. Both output files are written, and the
counts and maximum errors are reported in the CLI and output metadata.
Non-finite data, unavailable exposure roots, and unprojected negative AP0
values remain errors. Pixels outside the selected view's invertible domain can
be handled with `--project-unreachable`, which records the projection and
clamping diagnostics.

For images containing out-of-gamut or over-peak pixels, pass
`--project-unreachable` to explicitly
project the display-reference XYZ into the selected view's limiting RGB volume
before inversion. Any negative AP0 components that remain after that projection
are clamped to zero. These are intentional, lossy changes: projected/clamped
pixels are reported in metadata and diagnostics and are exempt from the strict
inverse residual check. Pixels that are not projected or clamped must still meet
`--round-trip-tolerance`; without this opt-in the command fails instead.

An exact black working pixel (`Q = (0, 0, 0)`) receives the neutral base
`(Refl, Refl, Refl)` and scalar `s = 0`. Its exposure channel is `0.0`; this
is the only value that does not decode through `log2` and reconstructs black
by the explicit zero rule.

## Views and command

The supported profile names are:

- `rec709-sdr100`: Rec.709-D65 SDR 100 nit;
- `p3-hdr1000`: P3-D65 HDR 1000 nit;
- `rec2020-hdr1000`: Rec.2020-D65 HDR 1000 nit.

Example:

```sh
modcam16-decompose input.exr --profile rec2020-hdr1000 --refl 0.5 \
  --base-output input-base.exr --exposure-output input-exposure.exr
```

To continue when the source contains values outside the selected view's
invertible domain:

```sh
modcam16-decompose input.exr --profile rec2020-hdr1000 --refl 0.5 \
  --project-unreachable
```

If output paths are omitted, `<input stem>-base-<Refl>.exr` and
`<input stem>-exposure-<Refl>.exr` are used, for example
`scene-base-0.5.exr` and `scene-exposure-0.5.exr`. `--ocio-config` selects
an alternate OCIO configuration; it must expose ACES2065-1 and the requested
ACES 2.0 view transform.

Both output files include provenance metadata, including the detected input
space, selected profile, OCIO configuration, `Refl`, and the exposure encoding
rule. The base RGB output advertises `ocioColorSpace=ACEScg`, AP1
chromaticities, and fp16 channels; the exposure output is a single fp16 channel.
The headers also record the Gaussian sigma, maximum inverse residual, its
exceedance count, and the number of negative AP0 pixels clamped by
`--project-unreachable`, plus `decompositionBaseAboveOnePixels` and
`decompositionBaseAboveOnePercent`.
Pixels are processed in chunks on all available CPU threads by default; use
`--workers` to override the worker count.

The CLI report includes the number and percentage of base pixels whose stored
linear ACEScg/AP1 RGB has at least one channel strictly greater than `1.0`.
The percentage is based on all image pixels, and each pixel is counted once.

## Static web UI behavior

The repository also publishes a browser-only decomposition page at
`decompose.html`. It is a static GitHub Pages application: uploaded bytes,
WASM workers, WebGPU buffers, reports, and generated files remain local to the
browser. The page must not require a server endpoint for decoding, processing,
or downloading results.

The upload control accepts OpenEXR, JPEG, PNG, HEIF, and HEIC. A file whose
name ends in `.png` is attempted as PNG first. If the PNG signature or parser
rejects it, the same bytes are attempted as JPEG before the error is shown.
The decoder reports the selected format, dimensions, and metadata. A malformed
file, unsupported codec, or failed fallback is an actionable error.

Color interpretation is explicit. The page applies a manual gamut/transfer
override first, then a parseable embedded ICC profile, then stops for user
confirmation. An ICC profile may be used directly to decode an image even when
the profile cannot be reduced to an exact gamut/gamma pair. The UI may display
an exact pair when it can be proven, but it never guesses one from a filename,
extension, weak metadata, or an ambiguous ICC. Manual gamut and transfer
controls remain available and supersede ICC-backed decoding. Processing is
disabled until the source interpretation is resolved. The source interpretation
controls are hidden on initial load and remain collapsed when a usable ICC is
available; an “Override embedded ICC” action reveals them. If no usable ICC is
available, the controls are shown automatically and both values are required.
There is no separate confirmation checkbox: selecting both override values is
the confirmation.

The options panel exposes the ACES profile used by the decomposition, `Refl`,
and Gaussian blur sigma. The ACES profile menu is ordered as `ACES 2.0 - SDR
100 nits (Rec.709)`, `ACES 2.0 - SDR 100 nits (P3 D65)`, `ACES 2.0 - HDR 1000
nits (P3 D65)`, and `ACES 2.0 - HDR 1000 nits (Rec.2020)`; P3-D65 HDR 1000 nits
is selected by default. Defaults and numeric ranges are visible, invalid
values are rejected inline, and a running job can be cancelled. A dedicated
worker reports decode, interpretation, ACES conversion, blur, decomposition,
diagnostics, output encoding, and completion as monotonic progress stages with
pixel and diagnostic counters. The worker yields between solve chunks so a
large image never remains indefinitely at “preparing pixels”.

The result contains an analytic report and three EXR downloads. The base OpenEXR is
linear ACEScg/AP1 RGB stored as fp16; the normalized exposure OpenEXR is the
single fp16 `exposure` channel defined above. An additional exposure RGB
OpenEXR stores the direct, non-log scalar in all three linear ACEScg channels:
`E = (s, s, s)` where `s = 2^(exposure * 20 - 10)`. It is fp16 and carries the
same ACEScg/AP1 metadata as the base file. The two inline preview images are
JPEGs with sRGB encoded P3-D65 primaries:

* The base preview converts the reconstructed linear ACES2065-1 base pixels
  through the exact ACES 2.0 `SDR-100nit-P3-D65_2.0` forward transform and
  then applies the sRGB encoding function.
* The exposure preview uses a scene-linear ACES2065-1 neutral canvas containing
  `(Refl * s, Refl * s, Refl * s)`, where `s = 2^(exposure * 20 - 10)`, then
  applies that same ACES 2.0 P3-D65 forward transform and sRGB encoding. The
  selected decomposition profile determines the solved exposure; both JPEG
  versions use the fixed P3-D65 preview transform on the resulting AP0 canvas.

The preview forward transform is the OCIO built-in transform named
`ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-100nit-P3-D65_2.0` from
`cg-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio`. Its GPU implementation must be a
faithful fixed-function port of the OCIO/ACES implementation, including the
profile matrices, tone scale, gamut-compression/JMh operations, and lookup
tables. A simple tone curve or other approximation is not acceptable. GPU
arithmetic uses portable `f32`; the exact CPU ACES implementation remains the
reference and a failed numerical validation selects the CPU preview path.

Both JPEG outputs retain their full source dimensions for explicit download.
Separate display JPEGs, capped at 2048 pixels on the longest edge without
upscaling, are used for every in-app image element, including the enlarged
overlay. The three EXR outputs are unchanged. A full-size JPEG download button
beside each preview shows the original dimensions and file size.

Display JPEGs are area-resampled in linear ACES2065-1/AP0, before the output
transform: average the solved base RGB and the exposure preview's linear
neutral canvas (`Refl * 2^(20 * normalizedEV - 10)`). Preserve HDR and negative
AP0 values during averaging. Do not average normalized EV or already rendered
P3 pixels. Completed reduced rows go through the same exact ACES 2.0 SDR
100-nit P3-D65 transform, sRGB encoding, and ICC-tagged JPEG encoder as the
full-size outputs. Resampling retains bounded row state across solve batches
and spools rendered display rows to OPFS.

The page shows both display JPEGs inline as compact viewport-bounded thumbnails.
Each thumbnail fills its frame while preserving aspect ratio, with centered
cropping permitted so there are no letterbox borders. The enlarged overlay
shows the complete image without cropping. Clicking a thumbnail opens a
full-screen image-only overlay titled “Base preview
(Display P3)” or “Exposure preview (Display P3)”. Clicking outside the image
closes the overlay; the image can be long-pressed or context-clicked to save.
The report records the source interpretation, selected decomposition options,
compute backend, preview transform name/version, output sizes, warnings, and
all projection, clipping, non-finite, and tolerance diagnostics. Object URLs
are revoked when a new job starts or a file is replaced.

The web layout is a single viewport workspace without visible title treatment,
vertical page scrolling, or card containers. Upload is the first control at the
top, followed by source interpretation and decomposition options, progress,
then the two preview images and EXR download controls. Preview images are
buttons: selecting one opens a full-screen overlay with its larger image.
The default Exposure EXR stores direct scalar exposure replicated across ACEScg
RGB. The first output footnote explains reconstruction: multiply Base EXR and
Exposure EXR in linear AP1 (ACEScg), then pass the result through the exact
selected ACES profile transform. The profile name is updated to match the
ACES profile control. The second footnote explains normalized exposure as
`v = (EV + 10) / 20` in `[0,1]`, covering -10 to +10 stops relative to Base EXR
colors, and reconstruction as `Base EXR * 2^(20 * v - 10)`. It retains the
Substance 3D Painter use case because its material picker is limited to
`[0,1]`. The page has no WebGPU availability footnote.

The EXR download buttons share one row on desktop and mobile. Base EXR is
on the left with 1.5 times the width of each exposure button to its right;
the two exposure buttons have equal widths. Their encoding labels are
`ACEScg fp16` for RGB outputs and `fp16 scalar` for normalized EV.
All three buttons reset to disabled with `Waiting` on a new input or job,
then show their respective file sizes when the outputs are ready.

The preview implementation now has a dedicated WebGPU compute pass. It reuses
the validated ACES parameter buffer and fixed-function shader from the solve
backend, dispatches base and exposure previews in adapter-sized batches, and
reads back sRGB-ready P3 bytes. JPEG compression remains in Rust/WASM on the
worker. A device that is unavailable, lost, or outside the validation limits
uses the exact CPU forward function and records the fallback warning.
