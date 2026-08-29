# modCAM16-HK palettes

The generator is split into an importable `modcam16_palette` package. The
original `make_modcam16-hk_palettes4.0.py` filename remains an executable
compatibility launcher.

Install the runtime dependencies with `python3 -m pip install -e .` and run
the default three-gamut generation with:

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
