# Image Decomposition CLI

`modcam16-decompose` separates an OpenEXR image into a perceptual base-color
image and a scalar exposure image for a selected ACES 2.0 view.

## Inputs

The command accepts a three-channel RGB OpenEXR input. Scanline files with
half-float (`fp16`) or single-precision (`fp32`) channels are supported. The
input is interpreted as scene-linear RGB and is converted to ACES2065-1 (AP0)
before any ACES or appearance-model operation.

Color-space detection uses metadata in this order:

1. `ocioColorSpace` when present;
2. standard EXR `chromaticities` for ACES2065-1, ACEScg, Linear Rec.2020, or
   Linear Rec.709 (sRGB).

If no supported metadata identifies the color space, an interactive terminal
prompt asks the user to choose one of those four spaces. Non-interactive runs
must provide `--input-color-space` explicitly when metadata is absent.
The command accepts only these exact input-space names and exact profile IDs;
there are no aliases.

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
necessarily loses exact scalar reconstruction. Non-finite or negative working
values, and pixels outside the selected view's invertible domain, are rejected
with diagnostics and no output files are published by default.

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
