# Display-Side Chromatic Adaptation Behavior

This document defines the white-balance behavior shared by the Rust/WASM
color core and the web controls. It supplements
[`ACES_PROFILE_BEHAVIOR.md`](./ACES_PROFILE_BEHAVIOR.md).

## Controls

The web UI exposes two display-side white-balance controls:

- `Temp`: 2000..20000 K, default 6500 K.
- `Tint`: -100..100, default 0.

Both controls show a fixed neutral snap marker and snap to that marker when
the pointer or keyboard edit comes sufficiently close: 6500 K for `Temp`
(within 500 K) and 0 for `Tint` (within 0.5 units). The marker is a presentation
aid; CAT02 receives the restored numeric Kelvin/tint values represented by the
slider, not its normalized presentation coordinate.

The `Reset` button restores both controls together to the D65 identity values,
6500 K and tint 0, and requests a settled full-resolution render. It is disabled
while both controls are already at those defaults.

Temp and Tint remain immediately to the right of the gamut-slice viewport on
mobile and desktop layouts. On narrow screens the viewport and control column
shrink together, while the preview and background controls move below them.

Temperature uses the standard Hernandez-Andres approximation to the Planckian
(black-body) CCT-to-xy locus, translated in CIE 1960 uv so that 6500 K is
exactly the D65 white used by the profiles. Tint is a signed CIE 1960 Delta uv
offset; +/-100 corresponds to +/-0.05 uv. Negative tint is toward green and
positive tint is toward magenta along the normal to the local CCT locus, so it
does not accidentally behave like a blue/yellow shift. The CAT02 source white
is D65 for every profile.

The slider positions are deliberately non-linear while the numeric values
remain in kelvins and tint units. Temperature is laid out in reciprocal
temperature (mireds), with the warm span (2000..6500 K) and cool span
(6500..20000 K) normalized independently to the two halves of the track. Thus
6500 K is exactly at the midpoint, and each side has a consistent linear mired
response over its own span. Tint uses a signed square-root curve around zero,
so small green/magenta corrections occupy more slider travel than the extreme
values. This presentation mapping is inverted before every worker request and
is not part of the colorimetry.

During a Temp slider drag the adjacent readout is rounded to the nearest 50 K
for a calm, useful display; the underlying slider coordinate remains continuous
and worker requests retain the corresponding numeric Kelvin value. Tint's
adjacent readout is shown as an integer. Numeric entry fields remain available
for direct values within their stated ranges.

At 6500 K and tint 0, the adaptation matrix is exactly identity. The existing
D65 output, ACEScg readout, background, and viewport behavior therefore remain
unchanged.

## Color flow

For a selected profile `p`, let `f_p` be its forward ACES view transform (or
the identity display/scene path for direct sRGB). Refl, Hue, and Sat first
construct the ordinary profile-side color:

```text
D = f_p(A0)
J = J_HK(D_neutral(Refl))
```

The CAT02 matrix maps D65 to the white point selected by Temp/Tint. The adapted
display-side color is scaled by one positive linear factor `k`:

```text
D_adapted = k * CAT02(D)
J_HK(D_adapted) = J_HK(D)
```

The scale is solved numerically against the existing modCAM16-HK model; it is
not a simple luminance ratio. For ACES profiles, the visible ACEScg readout is

```text
A1 = f_p^-1(D_adapted)
```

For direct sRGB, the visible readout is the linear Rec.709 value obtained from
`D_adapted`. Display P3 and sRGB previews are encoded from `D_adapted`.

The adapted result is checked for finite values, source-gamut validity, and
ACEScg unit-cube validity where applicable. Invalid adapted samples retain
finite, clamped readouts and use the existing unavailable preview. Finite
pre-adaptation coordinates remain available for profile switches and hex-entry
round trips even when the adapted display sample itself is unavailable.

## Viewport geometry

While Refl, Temp, or Tint is being dragged, the viewport uses the responsive
64×64 preview raster. Pointer/keyboard settlement requests the full-resolution
slice, preserving the existing interaction behavior while keeping adaptation
responsive.

The raster is generated in adapted appearance coordinates. For each output
pixel, the requested polar hue/saturation is converted to adapted XYZ at the
current Refl target `J_HK`; CAT02 and the J_HK-preserving scale are then inverted
to recover the pre-adaptation color and validate the selected profile.

The geometric canvas center represents adapted hue 0/saturation 0. The
adapted neutral for the current Refl can therefore be displaced from the
center. The selection line starts at that adapted neutral point and ends at the
adapted foreground point.

The Hue/Refl/Sat controls retain their pre-adaptation values. Changing
temperature or tint changes the displayed colors and adapted coordinates, but
does not rewrite those controls.

## ColorChecker markers

ColorChecker references continue to use their original scene/pre-adaptation
Hue, Sat, and Refl values for snapping and slider state. Their rendered dot
colors and viewport positions use the adapted display-side color. A selected
marker therefore keeps the original Hue slider value while its dot and
selection line follow the adapted appearance.

## Background

The Background slider remains a linear source/output neutral value with its
existing sRGB-style slider-position curve. Its numeric value and profile-switch
J_HK offset semantics are pre-adaptation values. The background surround is
rendered by applying CAT02 and the same J_HK-preserving scale to that neutral's
display-side XYZ, so it becomes chromatic for non-D65 white points. At
6500 K/tint 0 it remains the existing grayscale surround.

## Profile switches and entry

Profile switches keep Temp and Tint unchanged and preserve the pre-adaptation
source color:

- ACES profiles retain `A0 = f_p^-1(D)`.
- Direct sRGB retains its pre-adaptation linear Rec.709 value.

The target profile then solves new Refl, Hue, and Sat controls from that retained
pre-adaptation color. The post-adaptation readout may change with the target
profile, but CAT02 is never accumulated across switches.

Hex entry represents the visible post-adaptation readout. The core reverses
the current adaptation and scale, recovers `D`, and solves the pre-adaptation
controls. At 6500 K/tint 0 this is the existing entry path. If the recovered
color is outside the selected profile, finite boundary slider coordinates are
still applied so the normal unavailable preview communicates the failure.

## Failure handling

Temperature, tint, white-point conversion, CAT02 matrices, and scale factors
are clamped/validated at the core boundary. Non-finite or unrepresentable
adapted results return finite boundary coordinates where possible and otherwise
use the existing unavailable preview without introducing NaN slider values.
