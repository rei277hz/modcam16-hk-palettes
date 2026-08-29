# modCAM16-HK palettes

The generator is split into an importable `modcam16_palette` package. The
original `make_modcam16-hk_palettes4.0.py` filename remains an executable
compatibility launcher.

Install the runtime dependencies with `python3 -m pip install -e .` and run
the default all-gamut generation with:

```sh
python3 make_modcam16-hk_palettes4.0.py
```

Configuration is loaded from TOML, then explicit command-line flags override
it. See `config.example.toml` for the complete schema. For example:

```sh
python3 make_modcam16-hk_palettes4.0.py \
  --config config.example.toml \
  --gamut ap1 --output-dir ./out \
  --image-size 1024 --chroma-level-count 8
```

The numerical pipeline remains scene-linear ACEScg/AP1 fp32 ZIP OpenEXR with
the same gamut-cone, equal-J_HK, cap, and marker constraints as the original
script.

With the default all-gamut selection, the generator writes the original three
palettes and two additional compensated variants. The sRGB variant uses a
solved profile-specific source neutral and the inverse of the ACES 2.0 SDR 100-nit
Rec.709 view transform (with Rec.1886/BT.1886 display diagnostics). The P3
variant uses the ACES 2.0 HDR 1000-nit Rec.2020 view transform (with
Rec.2100-PQ diagnostics). In both cases the inverse is evaluated in the OCIO
view reference path `ACEScg -> ACES2065-1 -> CIE XYZ-D65`; display encoding is
not baked into the scene-linear EXR. Foreground palette pixels are normalized
after inversion so the published center remains `(1, 1, 1)`; background and
marker pixels are left untouched.

CC18 dots on ordinary palettes retain the source-palette matching rule
(nearest Hellwig saturation/hue). On compensated palettes, dots are assigned
after the inverse-view colors have been finalized: each logical ring/cap
candidate is exposed over the configured grid, passed through the selected
ACES 2.0 forward view, and compared with the fixed D65 CC18 XYZ targets in
normalized Cartesian ACES JMh space. The dot is drawn at the winning palette
location; its winning EV is recorded as metadata and does not alter the stored
pixel. Matching is independent for each CC18 patch: candidate locations are
not consumed, so one ring or cap may receive multiple dots. The default
compensated-marker grid is inclusive `-5..+5` EV in
quarter-stop increments (41 samples). Configure it with
`colorchecker.compensated_marker_exposure_min_stops`,
`colorchecker.compensated_marker_exposure_max_stops`, and
`colorchecker.compensated_marker_exposure_step_stops`, or the corresponding
CLI options. `scripts/analyze_compensated_cc18_grid.py` compares the configured
grid with a finer reference grid when tuning these defaults.

P3-D65 is not a strict subset of Rec.2020: there is a very small sliver near
the P3 red primary that produces a negative Rec.2020 blue channel. The source
P3 cap remains at its configured safety inset from the P3 boundary, but such a
display target has no exact inverse through a Rec.2020-limited output
transform. The selected output view also has a finite peak: display-reference
RGB is relative to 100 nits, so the SDR 100-nit view is bounded by `[0, 1]` and
the HDR 1000-nit view by `[0, 10]`. A high fitted anchor can place a source
target above that upper face even though it remains valid in the source P3
gamut cone. The compensation path clamps each limiting-RGB channel of an
unreachable target to the selected view's bounded RGB volume before applying
the inverse. This does not move the source palette's gamut-boundary caps;
instead, it chooses a bounded display target that the inverse output transform
can represent. Separate lower-gamut and upper-peak projection counts,
the original channel extrema, and the maximum XYZ adjustment are recorded in
the report and EXR metadata. The OCIO intermediate round-trip check uses its
configured absolute tolerance plus a small relative allowance because the CPU
transforms operate in float32 and HDR intermediate values extend well above
one.

The compensated source palettes use their own logarithmic chroma companding:
`sRGB-D65` defaults to `k=2.5` and `P3-D65` defaults to `k=4.0`.  These values
are intentionally separate from the ordinary palette values (`10` and `12`),
which remain unchanged.  Override them with
`--compensation-srgb-k` and `--compensation-p3-k`, or the corresponding keys
in `[compensation]` in a TOML file.

Automatic compensation fitting is enabled by default.  For each profile, the
generator fits one intermediate neutral anchor against the ACES 2.0 output
transform using the nine exposure samples `-2, -1.5, ..., 2` stops.  The fit
objective is the RMS error of every unique valid ring color and cap relative
to the transformed neutral `J` at each exposure.  The fitted anchor, search
diagnostics, exposure grid, and legacy-`0.18` comparison are written to the
filename, EXR metadata, comments, and report.  Use
`--compensation-fit-mode manual` (or `fit_mode = "manual"`) to retain the
explicit `target_intermediate_center` anchor and the legacy compensation
filename structure.  Supplying a numeric center without a fit mode in a TOML
mapping also selects manual mode for backwards compatibility.  Ordinary
palettes never enter this fit and retain their original geometry, names, and
exact ACEScg white center.

The supplied ACES 2.0 CG config has no AP1-specific output target, so the
default run has two compensated variants (five files total); AP1 remains the
ordinary scene-linear palette.

Disable variants with `--no-compensation`, select profiles with repeated
`--compensation-profile`, or point at another OCIO config with `--ocio-config`.
The checked-in `cg-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio` is the default.

Ordinary palettes always publish an exact ACEScg white center `(1, 1, 1)`.
That publishing value is independent of the CAM16 neutral-Y used to solve a
palette; compensated source renders retain their profile-specific model center
until the inverse-view normalization step. A fitted HDR anchor can require a
source neutral above one because ACES scene-linear values are not restricted to
the unit interval.
