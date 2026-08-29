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
palettes and two additional compensated variants. The sRGB variant is built at
a solved low source neutral and uses the inverse of the ACES 2.0 SDR 100-nit
Rec.709 view transform (with Rec.1886/BT.1886 display diagnostics). The P3
variant uses the ACES 2.0 HDR 1000-nit Rec.2020 view transform (with
Rec.2100-PQ diagnostics). In both cases the inverse is evaluated in the OCIO
view reference path `ACEScg -> ACES2065-1 -> CIE XYZ-D65`; display encoding is
not baked into the scene-linear EXR. Foreground palette pixels are normalized
after inversion so the published center remains `(1, 1, 1)`; background and
marker pixels are left untouched.

The compensated source palettes use their own logarithmic chroma companding:
`sRGB-D65` defaults to `k=2.5` and `P3-D65` defaults to `k=4.0`.  These values
are intentionally separate from the ordinary palette values (`10` and `12`),
which remain unchanged.  Override them with
`--compensation-srgb-k` and `--compensation-p3-k`, or the corresponding keys
in `[compensation]` in a TOML file.

The supplied ACES 2.0 CG config has no AP1-specific output target, so the
default run has two compensated variants (five files total); AP1 remains the
ordinary scene-linear palette.

Disable variants with `--no-compensation`, select profiles with repeated
`--compensation-profile`, or point at another OCIO config with `--ocio-config`.
The checked-in `cg-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio` is the default.

Ordinary palettes always publish an exact ACEScg white center `(1, 1, 1)`.
That publishing value is independent of the CAM16 neutral-Y used to solve a
palette; compensated source renders retain their low-Y model center until the
inverse-view normalization step.
