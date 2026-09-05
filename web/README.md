# modCAM16-HK web tool

Install Node.js 20+, Rust with the `wasm32-unknown-unknown` target, and
`wasm-pack` (`cargo install wasm-pack`), then run:

```sh
npm install
npm run build
npm run dev
```

Open the URL printed by Vite. The Rust module is run in up to sixteen Web Workers;
every canvas pixel is evaluated on demand for the current profile-side neutral
J_HK target derived from that profile's Refl curve, with no precomputed
saturation or color table. The backing raster is 512x512 and is
displayed in the existing 512px square viewport once settled; while Refl is
being dragged, a disposable 64x64 raster keeps the viewport responsive.
`npm run build:wasm` can be run separately when iterating on the Rust crate.
Refl accepts `0.0..1.2` so the brightest ColorChecker references and the
Rec.709 inverse-view bridge remain addressable. Direct sRGB is the default profile; it shows linear Rec.709 and
encoded Rec.709 values and bounds the output to the sRGB cube. ACES profiles
continue to show linear ACEScg and encoded AP1 values. Switching among the
four ACES profiles retains that ACEScg value and solves all three target
Refl, Hue, and Sat coordinates from it. Refl is therefore profile-local; the
same ACEScg color can have different Refl values in different profiles.
The profile menu keeps stable IDs behind the scenes and displays them in this
order: direct sRGB, Rec.709 SDR, P3-D65 SDR, P3-D65 HDR, and Rec.2020 HDR. The
ACES transform names follow the OCIO view names, while the source-gamut labels
before `/` remain unchanged.
When the target cannot represent the retained color, the conversion keeps a
finite boundary Refl (`0` or `1.2`), reports the state as invalid, and lets the
normal evaluator render its fallback state. The Linear Rec.709 and ACEScg RGB
readouts are always clamped to `[0, 1]`; a color with an out-of-range channel is
marked unavailable. The Background value remains linear, while its slider
position uses an sRGB piecewise curve for more usable low-level control, and
its snap marker is the selected profile's forward-view neutral.
The direct sRGB profile remains a separate workflow: it shows linear Rec.709,
and its `Refl` is the neutral linear-sRGB value whose `J_HK` defines the picked
color. Its encoded readout is labeled “sRGB Encoded Rec.709 (sRGB)”. Cross-workflow conversions use the SDR bridge explicitly: ACES-to-sRGB
runs the retained ACEScg RGB through the ACES 2.0 Rec.709 100-nit view and then
to clipped sRGB, while sRGB-to-ACES runs linear Rec.709 through the inverse of
that same view before rendering the selected ACES profile. The selected ACEScg
RGB value, rather than Refl, is the base color to export to Blender.
When switching profiles, Background preserves its `J_HK` offset from the
current foreground neutral. In particular, if it is on the source profile's
foreground snap marker, it moves to the target profile's marker rather than
being transformed as an independent ACEScg Refl value. The ColorChecker markers use the same runtime WASM path and the official
post-2014 Lab/D50 data with CAT02 adaptation used by the Python tools. Each dot
is an absolute linear ACEScg patch reference rendered through the selected
profile; its Hue, Sat, and Refl coordinates use the same target-profile solve
as ACEScg entry and profile switching. An unavailable source preimage does not
hide or move its dot. See [ACES_PROFILE_BEHAVIOR.md](./ACES_PROFILE_BEHAVIOR.md)
for the precise notation and conversion contract.
The Rec.2020 (P3-D65 limited), P3-D65 HDR, and P3-D65 SDR modes are encoded
for a tagged Display P3 canvas when the browser supports it; the Rec.709-D65
mode uses sRGB. Browsers without Display P3 support use the explicit sRGB
conversion for all modes. Both P3-D65 modes use their exact ACES 2.0 output
processor parameters and limiting-gamut tables from the bundled OCIO 2.5
configuration.

The display side also has Temp (2000..20000 K, default 6500 K) and Tint
(-100..100, default 0) controls. Negative Tint moves toward green and positive
Tint toward magenta along the normal to the local CCT locus. CAT02 adapts the
display-side XYZ to the selected white and applies a J_HK-preserving scale, so the slice, picked color,
ColorChecker dots, and background surround all respond without changing the
pre-adaptation Refl/Hue/Sat state. Hex entry is interpreted as the visible
adapted color and reverse-adapted before solving the sliders. See
[CHROMATIC_ADAPTATION_BEHAVIOR.md](./CHROMATIC_ADAPTATION_BEHAVIOR.md).
Temp uses a piecewise reciprocal-temperature (mired) slider curve: the
2000..6500 K and 6500..20000 K spans occupy equal halves of the track, putting
6500 K at the exact midpoint while keeping each side's response consistent in
mired space. Tint uses a signed square-root curve so small
corrections have more travel. Both sliders show a neutral snap marker and snap
to 6500 K/0 when edited within the normal tolerance (500 K / 0.5 tint units).
While dragging Temp, its readout is rounded to the nearest 50 K; Tint is shown
as an integer. The values sent to the color core remain numeric kelvins and tint
units. Reset restores both controls to 6500 K and tint 0.
While Refl, Temp, or Tint is dragged, the slice is rendered at 64×64 for
responsiveness; releasing or settling the control renders the full-resolution
slice.
