"""Command-line entry point and generation orchestration."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from .cam16_hk import AppearanceModel
from .colorimetry import GAMUT_MATRICES
from .config import GAMUT_NAMES, Config, load_config
from .naming import output_path_for_gamut
from .palette import build_palette
from .render import render_radial_palette
from .report import print_generation_header, print_palette_report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="make_modcam16-hk_palettes4.0.py",
        description="Generate equal-perceived-brightness modCAM16-HK radial palettes.",
    )
    parser.add_argument("--config", type=Path, help="TOML configuration file")
    parser.add_argument("--output-dir", type=Path, help="directory for generated EXRs")
    parser.add_argument(
        "--gamut",
        action="append",
        choices=("all", "srgb", "p3", "ap1", *GAMUT_NAMES),
        help="gamut(s) to generate; repeat to select multiple",
    )
    parser.add_argument("--image-size", type=int)
    parser.add_argument("--hue-count", type=int)
    parser.add_argument("--chroma-level-count", type=int)
    parser.add_argument("--srgb-k", type=float)
    parser.add_argument("--p3-k", type=float)
    parser.add_argument("--ap1-k", type=float)
    parser.add_argument("--c3-domain", choices=("continuous", "rendered"))
    parser.add_argument("--hue-offset", type=float)
    parser.add_argument(
        "--clockwise", action=argparse.BooleanOptionalAction, default=None
    )
    parser.add_argument(
        "--srgb-boundary-markers",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    parser.add_argument(
        "--p3-boundary-markers",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    parser.add_argument(
        "--colorchecker-markers",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    parser.add_argument(
        "--colorchecker-dataset", choices=("official_after_2014", "mccamy")
    )
    parser.add_argument("--colorchecker-adaptation", choices=("CAT02", "Bradford"))
    parser.add_argument(
        "--colorchecker-include-caps",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    parser.add_argument("--colorchecker-dot-radius", type=float)
    return parser


def _canonical_gamuts(values: list[str] | None) -> tuple[str, ...] | None:
    if not values:
        return None
    if "all" in values:
        if len(values) != 1:
            raise ValueError("--gamut all cannot be combined with another gamut.")
        return GAMUT_NAMES
    aliases = {
        "srgb": "sRGB-D65",
        "p3": "P3-D65",
        "ap1": "ACEScg/AP1-D60",
    }
    result = tuple(aliases.get(value, value) for value in values)
    if len(set(result)) != len(result):
        raise ValueError("Each gamut may be selected only once.")
    return result


def _overrides_from_args(args: argparse.Namespace) -> dict[str, dict[str, object]]:
    overrides: dict[str, dict[str, object]] = {}
    output: dict[str, object] = {}
    palette: dict[str, object] = {}
    raster: dict[str, object] = {}
    markers: dict[str, object] = {}
    colorchecker: dict[str, object] = {}
    if args.output_dir is not None:
        output["output_dir"] = str(args.output_dir)
    gamuts = _canonical_gamuts(args.gamut)
    if gamuts is not None:
        output["selected_gamuts"] = list(gamuts)
    if args.image_size is not None:
        raster["image_size"] = args.image_size
    if args.hue_count is not None:
        palette["hue_count"] = args.hue_count
    if args.chroma_level_count is not None:
        palette["chroma_level_count"] = args.chroma_level_count
    for argument, key in (
        (args.srgb_k, "srgb_chroma_companding_k"),
        (args.p3_k, "p3_chroma_companding_k"),
        (args.ap1_k, "ap1_chroma_companding_k"),
    ):
        if argument is not None:
            palette[key] = argument
    if args.c3_domain is not None:
        palette["c3_reference_domain"] = args.c3_domain
    if args.hue_offset is not None:
        palette["hue_offset_degrees"] = args.hue_offset
    if args.clockwise is not None:
        palette["clockwise"] = args.clockwise
    if args.srgb_boundary_markers is not None:
        markers["enable_srgb_boundary_markers"] = args.srgb_boundary_markers
    if args.p3_boundary_markers is not None:
        markers["enable_p3_boundary_markers"] = args.p3_boundary_markers
    if args.colorchecker_markers is not None:
        colorchecker["enabled"] = args.colorchecker_markers
    if args.colorchecker_dataset is not None:
        colorchecker["dataset"] = args.colorchecker_dataset
    if args.colorchecker_adaptation is not None:
        colorchecker["adaptation_method"] = args.colorchecker_adaptation
    if args.colorchecker_include_caps is not None:
        colorchecker["include_caps_in_matching"] = args.colorchecker_include_caps
    if args.colorchecker_dot_radius is not None:
        colorchecker["dot_radius_pixels"] = args.colorchecker_dot_radius
    for name, values in (
        ("output", output),
        ("palette", palette),
        ("raster", raster),
        ("markers", markers),
        ("colorchecker", colorchecker),
    ):
        if values:
            overrides[name] = values
    return overrides


def generate(config: Config, *, verbose: bool = True) -> list[Path]:
    """Generate selected palettes and return their output paths."""

    config.validate()
    model = AppearanceModel.from_config(config.appearance)
    if verbose:
        print_generation_header(config, model)
    paths: list[Path] = []
    # Import lazily so color math and tests do not require OpenEXR until writing.
    from .exr import write_float_rgb_exr

    for gamut_name in config.output.selected_gamuts:
        gamut = GAMUT_MATRICES[gamut_name]
        if verbose:
            print()
            print("=" * 92)
            print(f"Generating {gamut_name} C3-relative palette...")
            print(
                f"Chroma-companding k: {config.palette.companding_by_gamut[gamut_name]:g}"
            )
        result = build_palette(gamut, config, model)
        image = render_radial_palette(result, config)
        output_path = output_path_for_gamut(config, gamut)
        write_float_rgb_exr(output_path, image, gamut_name, config, result.statistics)
        paths.append(output_path)
        if verbose:
            print(f"Created: {output_path.resolve()}")
            print_palette_report(result, config)
    if verbose:
        print()
        print("=" * 92)
        print(
            "All EXRs were written as scene-linear ACEScg/AP1, 32-bit float, ZIP-compressed."
        )
        print("The center is exactly ACEScg (1, 1, 1).")
        print("Every hue has a thin gamut-boundary cap.")
        if config.colorchecker.enabled:
            print(
                "ColorChecker dots mark unique nearest palette locations using saturation and hue only."
            )
        print(
            "No clipping, transfer function, tone mapping, gamut mapping, or display transform was applied."
        )
        print("Finite display peak luminance was not enforced.")
    return paths


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_config(args.config, _overrides_from_args(args))
        generate(config)
    except (TypeError, ValueError, RuntimeError, OSError) as exc:
        raise SystemExit(f"error: {exc}") from exc
    return 0
