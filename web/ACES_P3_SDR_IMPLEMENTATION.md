# ACES 2.0 P3-D65 SDR Implementation Notes

This document records the implementation-critical facts for the
`P3-D65 / ACES 2.0 - SDR 100 nits (P3 D65)` profile. It is deliberately separate
from the user-facing behavior contract so future changes do not have to infer
numeric or profile-ID details from the UI.

## Stable Profile IDs

- `0`: Rec.2020 (P3-D65 limited) / ACES 2.0 - HDR 1000 nits (Rec.2020)
- `1`: Rec.709 / ACES 2.0 - SDR 100 nits (Rec.709)
- `2`: P3-D65 / ACES 2.0 - HDR 1000 nits (P3 D65)
- `3`: direct linear Rec.709/sRGB, with no ACES view transform
- `4`: P3-D65 / ACES 2.0 - SDR 100 nits (P3 D65)

ID `3` must remain the direct-sRGB workflow. Existing code branches on that
ID, so inserting the new profile before it would silently change conversion,
readout, and worker behavior.

## Source of Truth

The exact processor is the bundled OCIO 2.5 built-in transform:

```text
ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-100nit-P3-D65_2.0
```

The implementation was extracted from its GPU/CPU processor rather than
approximated from another profile. P3 SDR uses:

- P3-D65 XYZ matrices for source conversion;
- the P3 appearance-space RGB-to-LMS matrix;
- the P3 JMh-to-RGB matrix;
- SDR tone-scale and chroma-compression scalars (`Jmax = 100`, `input max = 1`,
  `output max = 1024`);
- the P3 SDR 363-entry reach/cusp payload and matching 363-entry hue grid.

The P3 HDR profile uses the same P3 appearance matrices but retains its HDR
scalars and HDR cusp payload. Its hue grid is P3-specific and must not use the
Rec.2020 grid. The generated payloads live in
`wasm/color_core/src/aces_output_p3_tables.rs`.

## Core Invariants

For every ACES profile, including ID `4`:

1. `transform_from_acescg(profile, A)` is the forward ACES output transform.
2. `transform_to_acescg(profile, D)` is its inverse output transform.
3. `neutral_j_hk` evaluates the forward-rendered neutral, not an intermediate
   inverse-model XYZ value.
4. Source-gamut checks use P3 for ID `4`; only ID `0` additionally applies the
   Rec.2020 limiting-cone check. ID `3` alone is bounded to the direct sRGB
   cube.
5. The ACEScg readout is finite and clamped to `[0, 1]`; an underlying
   out-of-range channel makes the sample unavailable rather than changing the
   color to a fabricated clipped valid sample.

## Display Adaptation

CAT02 adaptation remains display-side for ID `4`, exactly as for the other
ACES profiles: forward transform, CAT02, positive scale solving
`J_HK(adapted) = J_HK(original)`, then inverse transform for the ACEScg
readout. The adaptation affects the raster, picked preview, ColorChecker dots,
and surround background. Temp/tint state is not accumulated when switching
profiles.

## Required Validation

The Rust tests should cover the following before release:

- OCIO reference forward and inverse samples for ID `4`;
- neutral `J_HK` round trips and profile-local Refl solving;
- P3 source-gamut validation and ColorChecker records;
- profile switching to and from ID `4`, including direct-sRGB bridges;
- adapted rendering and background behavior at non-D65 controls;
- matching hue/cusp interpolation between the raster mask and the picker
  overlay.

Use the fnm-managed Node runtime for web checks and serving. Generated
`web/node_modules/` and `wasm/target/` are ignored by Git.
