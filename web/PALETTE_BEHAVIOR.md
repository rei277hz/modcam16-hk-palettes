# Palette behavior (`index.html`)

This is the authoritative behavior contract for the browser palette at
[`index.html`](./index.html). Palette calculation, rendering, and color
picking remain local to the browser. The page does not send color data to a
server.

## Workspace and controls

The page is a single dark workspace with three functional regions:

- a gamut-slice viewport with a raster canvas and a transparent indicator
  canvas;
- display-side white-balance controls (`Temp`, `Tint`, `Reset`, `Store`, and
  `Recall`);
- a picked-color preview, numeric readouts, encoded hex entry, background
  control, and profile-side controls (`Mode`, `Refl`, `Hue`, and `Sat`).

The viewport is the selection surface. Hue is represented by angle, saturation
by distance from the center, and the outer edge by the available gamut boundary
for that hue. The selected point, neutral reference, selection line, and
ColorChecker markers are drawn on the indicator layer so replacing the raster
does not clear them.

The picked-color panel shows a profile-side linear readout, an encoded
readout, and six hexadecimal digits. The encoded value can be copied or
replaced through `Set`. The Background slider controls the neutral surround.
A ColorChecker marker name appears when a marker is selected.

## Profiles and stable identifiers

Profile IDs are implementation identifiers, not dropdown positions. They must
not be renumbered:

| ID | Profile |
| --- | --- |
| `0` | Rec.2020 (P3-D65 limited) / ACES 2.0 - HDR 1000 nits (Rec.2020) |
| `1` | Rec.709 / ACES 2.0 - SDR 100 nits (Rec.709) |
| `2` | P3-D65 / ACES 2.0 - HDR 1000 nits (P3 D65) |
| `3` | Rec.709 / No view transform (direct linear Rec.709/sRGB) |
| `4` | P3-D65 / ACES 2.0 - SDR 100 nits (P3 D65) |

The menu order is direct sRGB, Rec.709 SDR, P3-D65 SDR, P3-D65 HDR, and
Rec.2020 HDR (`3`, `1`, `4`, `2`, `0`). The source-gamut wording before `/`
and the OCIO view wording after it are part of the visible contract.

The direct sRGB profile is a separate workflow. Its controls and readout use
linear Rec.709 values, its neutral is a direct linear-sRGB neutral, and its
encoded readout is labelled `sRGB Encoded Rec.709 (sRGB)`. ACES profiles use
linear ACEScg/AP1 for the visible readout and encoded AP1 values.

## Color-state contract

For an ACES profile `p`, let `A` be the linear ACEScg/AP1 value, `f_p` be the
profile forward ACES view transform before display encoding, and
`C(r) = (r, r, r)` be the neutral represented by `Refl = r`. The selected
coordinates satisfy:

```text
J_HK(f_p(A)) = J_HK(f_p(C(r)))
```

The core evaluates the neutral through the complete forward view transform,
solves the appearance model at that target, and forward-renders the result
again before gamut checks and previews. The ACEScg readout comes from `A`.
Displayed channels are clamped to `[0, 1]`, while an underlying out-of-range
channel marks the sample unavailable instead of fabricating a valid clipped
color.

For direct sRGB, the same relationship is evaluated in the direct linear
Rec.709 workflow without an ACES view transform. Cross-workflow conversion
uses the ACES 2.0 Rec.709 100-nit view as the explicit bridge:

- ACES to sRGB evaluates the retained ACEScg value through that view, converts
  to linear Rec.709, and then solves the direct sRGB state.
- sRGB to ACES decodes the linear Rec.709 value, applies the inverse bridge,
  and solves the selected ACES profile.

Profile switching preserves the pre-adaptation source color. Refl is
profile-local and is solved again in the target profile; it can change even
when the ACEScg readout remains the same. A target that cannot represent the
retained color keeps finite boundary coordinates and renders the ordinary
unavailable state rather than introducing NaN values.

## Display-side white balance

`Temp` ranges from 2000 K to 20000 K and defaults to 6500 K. `Tint` ranges
from -100 to 100 and defaults to 0. Negative tint moves toward green and
positive tint toward magenta along the local CIE 1960 Delta uv normal. The
source white for CAT02 is D65, so 6500 K and tint 0 are the exact identity.

The display side is adapted after the profile forward transform. CAT02 maps
D65 to the selected white and a positive scale is solved so the adapted value
preserves its `J_HK`:

```text
D_adapted = k * CAT02(D)
J_HK(D_adapted) = J_HK(D)
```

This adaptation affects the slice, picked-color preview, ColorChecker dots,
and background surround. Refl, Hue, Sat, and profile state remain
pre-adaptation values. Adaptation is never accumulated across profile
switches, and hex entry is reverse-adapted before coordinates are solved.

Slider positions are presentation coordinates. Temperature uses piecewise
reciprocal-temperature (mired) spans with 6500 K at the exact midpoint.
Tint uses a signed square-root curve so small corrections have more travel.
Neutral snap markers are 6500 K (within 500 K) and tint 0 (within 0.5 units).
During a temperature drag the adjacent value is rounded to 50 K, but worker
messages and calculations retain the underlying numeric Kelvin value. Tint is
displayed as an integer. Numeric inputs accept the full documented ranges.

`Reset` restores 6500 K and tint 0 and settles a full-resolution slice.
`Store` remembers one numeric pair in page memory. `Recall` restores that pair.
The stored pair survives profile switches and is cleared by a page reload.

## Background, markers, and entry

The Background value is a linear neutral in the selected profile's source
encoding. Its slider position uses an sRGB-style presentation curve. The
neutral marker is the forward-view neutral for the current Refl. On a profile
switch, the background preserves its `J_HK` offset from the foreground neutral;
if it was on the old foreground marker, it moves to the new marker. CAT02 is
applied to the surround, so non-D65 settings can make it chromatic while D65
remains the existing grayscale behavior.

ColorChecker points retain their source/pre-adaptation Hue, Sat, and Refl
coordinates for snapping. Their displayed colors and positions use the
adapted result. An unavailable source preimage never hides or moves a marker.

Hex entry represents the visible adapted encoded color. The core reverses the
current display adaptation and scale, recovers the pre-adaptation color, and
solves the selected profile. Values outside the profile remain finite and use
the ordinary unavailable preview.

## Rendering, scheduling, and caching

The settled gamut slice is rendered at 512 x 512. While Refl, Temp, or Tint is
being dragged, a disposable 64 x 64 raster keeps interaction responsive;
settling the control requests the full-resolution raster. Hue, Sat, and
Background edits repaint indicators and the picked preview when the slice
geometry is unchanged.

The evaluator is coalesced to one request per animation frame. Every response
is checked against the complete profile, slider, white-balance, and background
state that produced it. Late evaluator, profile-conversion, hex-entry,
ColorChecker, or raster responses are discarded. ColorChecker work is
coalesced to the newest white-balance state.

Two settled cache slots are retained for the D65 identity and the stored
white-balance pair. Cache keys include profile, Refl, white-balance values,
and canvas gamut. A completed full-resolution slice is retained briefly for
same-key Hue, Sat, and Background edits. A drag raster is never promoted as a
settled cache entry.

The raster and indicator layer are published atomically from the newest
accepted state. A pending request keeps the last accepted line, dots, and
picked preview visible. A failed raster or ColorChecker request preserves the
last valid picked preview; malformed evaluation or profile conversion leaves
the prior controls intact.

## Display encoding and compatibility

Display P3-capable browsers use a tagged Display P3 canvas for the P3 and
Rec.2020-limited profiles. Rec.709 uses sRGB. Browsers without Display P3
canvas support receive the explicit sRGB conversion for every profile. The
P3 SDR, P3 HDR, and Rec.2020-limited modes use the exact ACES 2.0 processors,
profile matrices, tone scale, gamut compression, and OCIO-derived reach/cusp
tables from the bundled configuration. GPU arithmetic may use `f32`, but the
accurate CPU path remains the numerical reference and rejects an implementation
whose validation exceeds the documented tolerance.

## Responsive and accessible behavior

The page uses a single viewport workspace without card containers or a visible
title block. The slice and display controls remain adjacent on desktop and
shrink together on narrow screens. The preview and background controls move
below them as needed, with no horizontal overflow.

All sliders have numeric inputs, labels, and visible focus indicators. The
slice exposes an accessible name, and the indicator canvas is decorative. The
empty, loading, unavailable, and invalid states are conveyed with text or
semantics in addition to color and opacity. Keyboard edits follow the same
coalescing and settlement behavior as pointer edits.

## Invariants for future changes

- Keep profile IDs stable and keep the profile menu order and OCIO labels
  synchronized with the implementation.
- Keep the accurate f64 CPU color core as the reference for ACES processors,
  modCAM16-HK, profile conversion, and GPU validation.
- Keep slider presentation mappings separate from numeric color state.
- Never replace an unrepresentable color with a guessed or silently clipped
  valid color, and never publish NaN coordinates.
- Keep adaptation display-side and non-accumulating across profile changes.
- Reject stale asynchronous responses before they can paint a newer state.
