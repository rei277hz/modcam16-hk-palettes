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
