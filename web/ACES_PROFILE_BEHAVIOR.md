# ACES Profile Behavior

This document defines the color-state contract shared by the Rust/WASM core
and the web controls.

The implementation discrepancies addressed by this contract were a
profile-independent ACEScg Refl calculation, profile switches that retained
that Refl and rejected otherwise representable target coordinates, and a
sample path that exposed inverse-model XYZ without an explicit forward
`f_p(A)` pass. Unreachable neutral solves also previously surfaced as NaN
slider values.

## Notation

For one of the four ACES view profiles, let:

- `A` be the linear ACEScg/AP1 RGB value shown in the ACEScg readout.
- `f_p(X)` be the profile `p` forward ACES view transform, excluding the
  display encoding and display-gamut conversion.
- `C(r) = (r, r, r)` be the ACEScg neutral constructed from the profile's
  `Refl` slider value `r`.
- `J_HK(X)` be the modCAM16-HK lightness-like coordinate of an XYZ value.

The slider state is constructed so that

```text
J_HK(f_p(A)) = J_HK(f_p(C(r))).
```

The display transform used for the canvas and preview is applied only after
this constraint has been solved. It does not participate in the equation.

## Display-side white balance

The web UI applies CAT02 chromatic adaptation after the profile forward
transform and before inverse/readout conversion. Temperature (2000..20000 K)
and tint (-100..100 CIE 1960 Delta uv) select the destination white; 6500 K
and tint 0 are the exact D65 identity. Negative tint moves toward green and
positive tint toward magenta along the normal to the local CCT locus. The adapted display color is scaled so
its `J_HK` equals the pre-adaptation value. This affects the raster, picked
preview, ColorChecker dots, and surround background. Slider and profile state
remain pre-adaptation, and visible hex entry is reverse-adapted before solving
coordinates. See [CHROMATIC_ADAPTATION_BEHAVIOR.md](./CHROMATIC_ADAPTATION_BEHAVIOR.md)
for the complete control and failure contract.

The Temp and Tint controls use non-linear presentation coordinates (piecewise
mired normalization around 6500 K for Temp and a signed square-root curve for
Tint), with snap markers at 6500 K and 0 respectively (500 K and 0.5 tint-unit
tolerances). During a Temp drag its adjacent readout is rounded to a multiple
of 50 K, and Tint is shown as an integer; worker messages and all color
calculations use the restored numeric values, not the presentation coordinates.

## Evaluation

For a slider state `(r, hue, sat)`:

1. The core evaluates `D = f_p(C(r))` and takes `J_HK(D)` as the target.
2. It inverts the appearance model at that target, hue, and saturation.
3. The resulting ACEScg value is `A`; it is passed through `f_p` again before
   source-gamut checks and preview rendering. This makes the forward-rendered
   `f_p(A)` the value used by the rest of the pipeline.
4. The ACEScg readout and its encoded AP1 representation come from `A`. Their
   displayed channels are clamped to `[0, 1]`; if any underlying channel is
   outside that range, the sample is marked unavailable and uses the ordinary
   unavailable preview.

## ACES Profile Switching

The ACES view profiles are:

- ID `0`: Rec.2020 (P3-D65 limited) / ACES 2.0 - HDR 1000 nits (Rec.2020);
- ID `1`: Rec.709 / ACES 2.0 - SDR 100 nits (Rec.709);
- ID `2`: P3-D65 / ACES 2.0 - HDR 1000 nits (P3 D65);
- ID `4`: P3-D65 / ACES 2.0 - SDR 100 nits (P3 D65).

ID `3` remains reserved for the direct sRGB profile. Switching between ACES
profile IDs `0`, `1`, `2`, and `4` retains the ACEScg readout as the source
color. The target profile evaluates `f_target(A)` and independently solves:

- `Refl`: the target neutral `C(r)` whose forward `J_HK` matches
  `J_HK(f_target(A))`;
- `Hue` and `Sat`: the appearance coordinates of `f_target(A)`.

Consequently, `Refl` is profile-local. It is expected to change when the view
profile changes, while the ACEScg readout remains the same (subject only to
the readout's encoded precision).

If the target J_HK is outside the neutral curve's slider range, the solver
returns the nearest finite boundary (`Refl = 0` for a low target or
`Refl = 1.2` for a high target) and marks the conversion invalid. The web UI
keeps that target profile and all finite returned slider values, then lets the
normal evaluator render its fallback state. It does not roll the profile
selection back.

ACEScg hex entry and ColorChecker marker coordinates use this same target
profile solve. ColorChecker availability remains a diagnostic about source
gamut/preimage reachability; it never moves or hides the reference marker.

## Direct sRGB Profile

Profile ID `3` is intentionally separate. Its controls are native linear
Rec.709/sRGB controls. For a direct slider state, `Refl` means the neutral
linear-sRGB value `C(r) = (r, r, r)`; the picked color's target is the
`J_HK` of that neutral, without an ACES view transform.

The two cross-workflow conversions use the SDR ACES view as their bridge:

- **ACES to sRGB:** decode the retained ACEScg readout to `A`, evaluate the
  ACES 2.0 Rec.709 100-nit forward view `f_709(A)`, convert its linear Rec.709
  result to sRGB, and clip to the direct sRGB cube before solving direct
  `Refl`, `Hue`, and `Sat`.
- **sRGB to ACES:** decode the retained value as linear Rec.709, apply the
  inverse ACES 2.0 Rec.709 100-nit view to obtain `A`, then evaluate the target
  ACES profile `f_target(A)` and solve its profile-local coordinates.

The direct output value is the canonical state during these transitions. A
target coordinate that cannot be represented remains finite and is reported as
invalid; the UI can show the normal unavailable preview instead of fabricating
NaN slider values.

## Background Switching

The Background slider represents a neutral output value in the selected
profile's source encoding. The displayed numeric value and all conversions are
linear; only the slider position uses an sRGB piecewise curve. Its marker is
the forward-view source-neutral value for the foreground `Refl`:

```text
marker_p(r) = source_p(f_p(C(r))).
```

On a profile switch, the source background and source foreground neutral are
converted to `J_HK` values. The target background is solved from:

```text
J_HK(target background) = J_HK(target foreground)
  + J_HK(source background) - J_HK(source foreground neutral).
```

Therefore a background snapped to the source marker remains snapped to the
target marker, while an intentional offset from that marker is retained.

## Slider Position Curves

Slider positions are presentation coordinates only. Numeric inputs, snapping
distances, worker messages, and the color calculations continue to use linear
`Refl` values and saturation percentages.

- `Refl` applies the sRGB piecewise transfer function directly to the linear
  reflectance. The same power branch is extended above `1` through the
  control's maximum of `1.2`, then the encoded result is normalized to the
  slider width.
- `Sat` applies the sRGB piecewise transfer function to `Sat / 50`. Saturation
  `0..50` therefore maps to the transfer function's normal `0..1` domain, and
  saturation `(50, 100]` uses its mathematical extension through `(1, 2]`.
  The encoded result at saturation `100` is normalized to the slider width.
- Background retains its existing sRGB-style position curve over its complete
  linear `0..1.2` range.
- `Temp` maps reciprocal temperature (mireds) piecewise around 6500 K. The
  2000..6500 K warm span occupies the left half and the 6500..20000 K cool span
  occupies the right half, so the neutral marker is exactly centered.
- `Tint` maps a signed square-root presentation coordinate around zero; this
  deliberately gives small green/magenta corrections more slider travel.

The Temp snap window is ±500 K and the Tint snap window is ±0.5 units. These
are interaction conveniences only; the underlying white-point values remain
numeric Kelvin and tint units.
