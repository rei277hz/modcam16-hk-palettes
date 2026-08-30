# modCAM16-HK palettes

Language / 语言: [English](README.md) | [中文](README.zh.md)

`modcam16-palette` generates radial color palettes whose chromatic samples are
held to a common perceived brightness.  It is intended for color scientists,
HDR/display engineers, and artists working in ACES or a wide-gamut RGB
workflow.  The original `make_modcam16-hk_palettes4.0.py` script remains a
compatibility launcher for the package.

## What the model does

The Helmholtz-Kohlrausch (H-K) effect is the increase in perceived brightness
that normally accompanies increasing colorfulness at the same measured
luminance.  The palette uses the revised CAM16 attributes `J` (lightness), `C`
(chroma), `Q` (brightness), and `A_W` (the achromatic response of the reference
white), then applies the Hellwig 2023 H-K extension:

```text
J_HK = sqrt(J^2 + 66 C)
Q_HK = (2 / c) (J_HK / 100) A_W
```

`c` is the surround-dependent CAM16 coefficient.  The `66` value is the
default `appearance.hk_chroma_coefficient` and can be changed in TOML; the
equations above describe the built-in behavior.  Every radial ring is a
constant-`J_HK` sample.  Chroma is limited per hue by the selected RGB gamut,
so a final boundary cap is available for each hue.

In the underlying revised-CAM16 equations, `A` is the stimulus achromatic
response and `z = 1.48 + sqrt(Y_b / Y_w)` is derived from the background and
white luminances.  Viewing-condition parameters are configurable in the
`[appearance]` TOML section.

## Which palette should I use?

All ordinary and compensated files are scene-linear ACEScg OpenEXR files
(ACEScg uses AP1 primaries).  Here, "direct" means no additional palette
compensation.  It does not mean that a display-monitoring or view transform is
unnecessary in the application that opens the file.

| Variant | Intended use |
| --- | --- |
| **Direct ACEScg/AP1** | Default general-purpose palette for ACES 1.3/2.0 drawing, DaVinci color grading, and base-color texture work; includes the default sRGB boundary markers. |
| **Direct sRGB-D65** | General drawing, grading, or texture work when the source colors should remain within the sRGB gamut. |
| **Direct P3-D65** | General drawing or texture work for P3-capable workflows; no view-transform compensation is applied. |
| **P3-D65 compensated for ACES 2.0 HDR** | HDR content production; pair with the matching ACES 2.0 Rec.2020 / Rec.2100-PQ view transform. The inverse compensation is designed to keep the palette H-K-evenly bright after that view transform, and its 18 ColorChecker dots are matched after the view transform. |
| **sRGB-D65 compensated for ACES 2.0 SDR** | Intended for the Rec.709 / BT.1886 ACES 2.0 path, but not yet tested in practice. Treat it as experimental and use caution. |

The compensated variants are source palettes in sRGB-D65 or P3-D65, converted
to ACEScg after an inverse ACES 2.0 view transform.  Display encoding is not
baked into the EXR.  The supplied ACES 2.0 CG configuration currently defines
the P3/Rec.2020 HDR and sRGB/Rec.709 SDR profiles; it does not define an AP1
compensation profile.

## Generated features

- Equal-`J_HK` radial rings with logarithmically companded chroma levels.
- One per-hue gamut-boundary cap, with a configurable safety inset.
- Optional sRGB and P3 boundary rectangles over the palette.
- Optional dots for the first 18 chromatic ColorChecker patches.
- Optional ACES 2.0 inverse-view variants, including profile-specific neutral
  solving and exposure-robust ACES-`J` anchor fitting.

Direct ColorChecker dots are assigned with an exposure sweep in the source
revised modCAM16-HK saturation/hue space; ACES is not used for direct matching.
Compensated dots are assigned after the inverse-view colors are fixed: each
candidate is evaluated over the same exposure grid, sent through the selected
forward view, and compared with the fixed D65 targets in normalized Cartesian
ACES `JMh`.  Each patch is matched independently, so a candidate location may
be reused.  The built-in ColorChecker marker grid is inclusive `-5` to `+5`
stops in `0.1`-stop increments (101 samples) for both palette kinds.

The grid can be tuned with the `colorchecker.compensated_marker_exposure_*`
TOML keys (or the neutral `colorchecker.exposure_*` aliases) and the
corresponding CLI flags.  The helper script
[`scripts/analyze_compensated_cc18_grid.py`](scripts/analyze_compensated_cc18_grid.py)
compares a configured grid with a finer reference grid.

For the P3 HDR profile, the source P3 boundary is also intersected with the
Rec.2020-D65 cone because P3 has a tiny red-primary sliver outside Rec.2020.
The selected ACES view has a finite display peak: the SDR 100-nit path is
bounded at linear RGB `1`, while the HDR 1000-nit path is bounded at `10` in
the display-reference space.  Unreachable targets are projected into that
bounded volume before inversion; projection and round-trip diagnostics are
reported in metadata.

## Install

Python 3.11 or newer is required.  Install the package and its runtime
dependencies from the repository:

```sh
python3 -m pip install -e .
```

For the test dependencies as well:

```sh
python3 -m pip install -e '.[test]'
```

ACES compensation uses `opencolorio==2.5.2` and the bundled
`cg-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio`.  Ordinary palettes do not need to
load OCIO processors, but the OpenEXR and NumPy runtime dependencies are still
required for generation.

## Quick start

Generate the default selection (three ordinary palettes and eligible
compensated variants) in the current directory:

```sh
python3 make_modcam16-hk_palettes4.0.py
```

The same entry point is available as a module and as the installed console
script:

```sh
python3 -m modcam16_palette --help
modcam16-palette --help
```

For a quick ordinary-only render in a separate directory:

```sh
python3 make_modcam16-hk_palettes4.0.py \
  --no-compensation \
  --gamut ap1 \
  --output-dir ./out \
  --image-size 512 \
  --hue-count 12 \
  --chroma-level-count 3
```

A practical P3 HDR request is:

```sh
python3 make_modcam16-hk_palettes4.0.py \
  --gamut p3 \
  --compensation-profile p3_rec2020_pq \
  --output-dir ./out
```

Generation prints the solved model, gamut-boundary, ColorChecker, and (when
enabled) ACES compensation diagnostics.  A full-resolution continuous-boundary
run can take substantially longer than the small example above.

## Release Build

The checked-in `config.release.toml` is byte-for-byte identical to
`config.example.toml` and is the reproducible five-palette release input.  Run
the release entry point to generate all three direct palettes and the two
configured ACES 2.0 variants:

```sh
python3 make_release.py
```

The same function is available as `modcam16_palette.generate_release()` and
the installed `modcam16-palette-release` command.  Release files use the short
names `sRGB_Direct_Palette.exr`, `P3_Direct_Palette.exr`,
`AP1_Direct_Palette.exr`, `sRGB_ACES2_SDR.exr`, and `P3_ACES2_HDR.exr`; each
name has no more than three underscore-separated segments.  Use
`--output-dir` to place the set in another directory.

## Configuration

Configuration is read from TOML first; explicit command-line values override
it.  [`config.example.toml`](config.example.toml) contains the complete
schema, including solver tolerances and all compensation controls.  A minimal
ordinary-only configuration looks like this:

```toml
[output]
directory = "./out"
gamuts = ["ap1"]

[compensation]
enabled = false
```

The example file is the canonical release configuration and its values are
the built-in defaults.  Values omitted from a TOML file retain those same
defaults.  Useful built-in palette defaults are:

| Setting | Default |
| --- | ---: |
| Reference white | 200 nits |
| Hue sectors | 48 |
| Complete chroma levels | 12 |
| Ordinary companding `k` (sRGB / P3 / AP1) | 12 / 13 / 15 |
| Cap height | 0.5 of a full block |
| sRGB boundary rectangles | enabled |
| P3 boundary rectangles | disabled |
| ColorChecker dots | enabled, official-after-2014 data, 6-pixel radius |
| ColorChecker matching grid | `-5..+5` stops at `0.1` stop (101 samples) |
| Compensation fitting | automatic, `-3..0` stops at `0.5` stop |
| Compensated companding `k` (sRGB / P3) | 2.0 / 20.0 |

The numeric `target_intermediate_center` is retained for manual/legacy
compensation.  In the default `fit_mode = "auto"`, one anchor is fitted per
profile from the seven exposure samples `-3, -2.5, ..., 0` stops.  Set
`fit_mode = "manual"` (or use `--compensation-fit-mode manual`) to use the
explicit anchor instead.

The canonical compensation profile IDs are `srgb_rec709_bt1886` (ACES 2.0 SDR
100-nit Rec.709, with BT.1886 diagnostics) and `p3_rec2020_pq` (ACES 2.0 HDR
1000-nit Rec.2020, with Rec.2100-PQ diagnostics).

## CLI essentials

Run `--help` for the complete option list.  The most commonly used options are:

| Option | Purpose |
| --- | --- |
| `--config PATH` | Load a TOML file. |
| `--output-dir PATH` | Choose the output directory. |
| `--gamut all` or repeated `--gamut srgb`, `--gamut p3`, `--gamut ap1` | Select source gamut(s). |
| `--image-size N` | Set the square raster size (must be even). |
| `--hue-count N`, `--chroma-level-count N` | Set palette sampling density. |
| `--srgb-k K`, `--p3-k K`, `--ap1-k K` | Set ordinary logarithmic chroma companding. |
| `--srgb-boundary-markers`, `--p3-boundary-markers` | Enable or disable reference-gamut rectangles. |
| `--colorchecker-markers`, `--colorchecker-dataset ...` | Control the 18-patch dots. |
| `--no-compensation` / `--compensation` | Disable or enable ACES 2.0 variants. |
| `--compensation-profile PROFILE` | Select an eligible profile; repeat it for multiple profiles. |
| `--ocio-config PATH` | Use another OCIO configuration. |
| `--compensation-fit-mode auto` or `manual` | Choose fitted or explicit compensation anchors. |
| `--compensation-exposure-*` | Set the ACES-`J` fitting exposure range and step. |
| `--colorchecker-compensated-exposure-*` (or `--colorchecker-exposure-*`) | Set the ColorChecker exposure-matching grid for direct and compensated palettes. |

Aliases such as `srgb`, `p3`, `ap1`, `rec709_bt1886`, and `rec2020_pq` are
accepted where the CLI shows them.  `--gamut all` cannot be combined with an
additional `--gamut` value.

## Files and counts

For each selected source gamut, one ordinary file is written.  Compensation is
profile-specific and only runs when its source gamut is selected:

With all three gamuts selected, the default run writes three ordinary palettes
plus the sRGB and P3 compensated variants: five files total.

| Selection | Ordinary files | Additional files with default compensation |
| --- | ---: | ---: |
| `all` (the default) | 3 | 2, for 5 total |
| `srgb` | 1 | 1 sRGB/Rec.709 SDR profile |
| `p3` | 1 | 1 P3/Rec.2020 HDR profile |
| `ap1` | 1 | none (no AP1 profile is defined) |

`--no-compensation` makes the additional-file count zero.  Selecting a profile
whose source gamut is not selected also produces no extra file.

Ordinary names follow this pattern:

```text
modCAM16HK_<white>nit_<gamut>GamutCone_C3_<levels>Step_LogK<k>_Cap<height>_<markers>_<colorchecker>_ACEScg_Radial_32f.exr
```

Compensated names add the ACES profile, fitted anchor, source neutral, and
fitting exposure grid.  Manual/legacy names instead include the explicit
`TargetY` and `Scale` values.  Naming is deliberately descriptive so changing
sampling, markers, or compensation settings does not silently overwrite a
different palette.

## Output format and metadata

Every output is a scanline OpenEXR with one three-channel `RGB` image:

- scene-linear ACEScg/AP1 values;
- IEEE 32-bit floating-point channels;
- ZIP compression;
- `ocioColorSpace = "ACEScg"` in the header.

Ordinary palettes contain no baked transfer function, clipping, tone mapping,
gamut mapping, or display transform.  Their center is exactly `(1, 1, 1)` even
when a custom CAM16 neutral-Y was used to solve the palette.  Background and
reference-marker rectangles retain the configured background value.  Values
above one are valid scene-linear values and are not clipped.

Compensated files bake the inverse ACES 2.0 view transform into foreground
palette colors and then normalize the foreground center to `(1, 1, 1)`;
display encoding remains separate.  Their headers and comments record the
profile/view, OCIO config and cache ID, solved source Y, fitted/manual anchor,
foreground scale, target-volume projection counts, finite peak, compensated
ColorChecker match data, and round-trip tolerances/errors.  Generation reports
the same diagnostics on stdout.

## Implementation audit and scope

The implementation was checked against the supplied papers and the maintained
`colour-science` Hellwig implementation:

- Hellwig et al. 2023 Equation 8 (`J_HK`) and Equation 9 (`Q_HK`) match the
  equations used by `AppearanceModel`.
- The revised-CAM16 terms shown in the XCR table match the implementation:
  the corrected eccentricity `e_t`, `M = 43 N_c e_t sqrt(a^2 + b^2)`,
  `C = 35 M / A_W`, `s = 100 M / Q`, `J = 100 (A/A_W)^(c z)`, and
  `Q = (2/c) (J/100) A_W`.
- Palette rasterization, radial ring and cap geometry, gamut-boundary solving,
  ColorChecker placement, and ACES inverse-view compensation are project
  extensions.  This repository does not claim to implement the complete XCR
  toolkit or every XCR analysis and visualization.
- The 2022 additive model `J_HK = J + f(h) C^0.587` is related work and is not
  the model used for these palettes.
- XCR Table 1 prints a `0.1457` sine coefficient and appears to duplicate the
  constant term.  Those entries are treated as an apparent
  typesetting/source inconsistency: the retained `0.1475` coefficient and a
  single `+1` agree with the maintained `colour-science` Hellwig code and are
  locked by regression tests here.  The release defaults and the documented
  ColorChecker exposure-matching API are covered by regression tests.

## References

- Hellwig, Stolitzka, and Fairchild, "The brightness of chromatic stimuli,"
  *Color Research and Application* (2024),
  [doi:10.1002/col.22910](https://doi.org/10.1002/col.22910).
- Hellwig, Stolitzka, and Fairchild, "Improvements to CIECAM16 and Future
  Directions," CIE 2023 proceedings,
  [doi:10.25039/x50.2023.pp011](https://doi.org/10.25039/x50.2023.pp011).
- Stolitzka, Agahian, and Poynton, "Modeling the HDR Display with XCR,"
  *Information Display* (2025),
  [doi:10.1002/msid.1596](https://doi.org/10.1002/msid.1596).
- Hellwig, Stolitzka, and Fairchild, "Extending CIECAM02 and CAM16 for the
  Helmholtz-Kohlrausch effect," *Color Research and Application* (2022),
  [doi:10.1002/col.22793](https://doi.org/10.1002/col.22793).

The papers are the model references; the generated EXRs are project artifacts
and should be interpreted with the viewing transform and configuration that
produced them.
