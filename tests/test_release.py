import tomllib
from pathlib import Path

from modcam16_palette import cli
from modcam16_palette.config import config_from_mapping, default_config
from modcam16_palette.naming import (
    RELEASE_COMPENSATED_FILENAMES,
    RELEASE_DIRECT_FILENAMES,
)

ROOT = Path(__file__).resolve().parents[1]


def test_release_toml_matches_example_toml_exactly():
    example_path = ROOT / "config.example.toml"
    release_path = ROOT / "config.release.toml"
    assert release_path.read_bytes() == example_path.read_bytes()
    with example_path.open("rb") as handle:
        example_values = tomllib.load(handle)
    with release_path.open("rb") as handle:
        release_values = tomllib.load(handle)
    assert release_values == example_values


def test_example_values_are_the_built_in_defaults():
    with (ROOT / "config.example.toml").open("rb") as handle:
        example_values = tomllib.load(handle)
    example = config_from_mapping(example_values)
    default = default_config()
    assert example == default


def test_release_names_are_short_and_unique():
    names = tuple(RELEASE_DIRECT_FILENAMES.values()) + tuple(
        RELEASE_COMPENSATED_FILENAMES.values()
    )
    assert len(names) == 5
    assert len(set(names)) == 5
    assert all(len(Path(name).stem.split("_")) <= 3 for name in names)


def test_generate_release_enforces_five_palette_contract(monkeypatch, tmp_path):
    expected_names = (
        "sRGB_Direct_Palette.exr",
        "P3_Direct_Palette.exr",
        "AP1_Direct_Palette.exr",
        "sRGB_ACES2_SDR.exr",
        "P3_ACES2_HDR.exr",
    )
    calls = []

    def fake_generate(config, *, verbose, simple_names):
        calls.append((config, verbose, simple_names))
        return [config.output.output_dir / name for name in expected_names]

    monkeypatch.setattr(cli, "generate", fake_generate)
    paths = cli.generate_release(
        ROOT / "config.release.toml", output_dir=tmp_path, verbose=False
    )
    assert tuple(path.name for path in paths) == expected_names
    assert len(calls) == 1
    assert calls[0][1:] == (False, True)
    assert all(path.parent == tmp_path for path in paths)


def test_release_main_quiet_prints_paths(monkeypatch, capsys, tmp_path):
    paths = [
        tmp_path / name
        for name in ("a.exr", "b.exr", "c.exr", "d.exr", "e.exr")
    ]
    monkeypatch.setattr(cli, "generate_release", lambda *args, **kwargs: paths)
    assert cli.release_main(["--quiet", "--output-dir", str(tmp_path)]) == 0
    assert capsys.readouterr().out.splitlines() == [str(path) for path in paths]
