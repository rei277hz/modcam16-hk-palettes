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
three ACES profiles retains that ACEScg value and solves all three target
Refl, Hue, and Sat coordinates from it. Refl is therefore profile-local; the
same ACEScg color can have different Refl values in different profiles.
When the target cannot represent the retained color, the conversion keeps a
finite boundary Refl (`0` or `1.2`), reports the state as invalid, and lets the
normal evaluator render its fallback state. The Linear Rec.709 and ACEScg RGB
readouts are always clamped to `[0, 1]`; a color with an out-of-range channel is
marked unavailable. The Background value remains linear, while its slider
position uses an sRGB piecewise curve for more usable low-level control, and
its snap marker is the selected profile's forward-view neutral.
The direct sRGB profile remains a separate workflow: it shows linear Rec.709,
and its `Refl` is the neutral linear-sRGB value whose `J_HK` defines the picked
color. Cross-workflow conversions use the SDR bridge explicitly: ACES-to-sRGB
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
The Rec.2020 (P3-D65 limited) and P3-D65 HDR modes are encoded for a tagged
Display P3 canvas when the browser supports it; the Rec.709-D65 mode uses sRGB.
Browsers without Display P3 support use the explicit sRGB conversion for all
modes.
