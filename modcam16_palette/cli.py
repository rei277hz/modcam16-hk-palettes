"""Command-line entry point and generation orchestration."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

from .cam16_hk import AppearanceModel
from .colorimetry import GAMUT_MATRICES
from .config import (
    COMPENSATION_PROFILE_CHOICES,
    COMPENSATION_PROFILE_DEFINITIONS,
    GAMUT_NAMES,
    PUBLISHED_CENTER_ACESCG,
    Config,
    load_config,
)
from .naming import output_path_for_compensation, output_path_for_gamut
from .ocio_compensation import (
    compensate_foreground,
    load_compensation_processor,
    solve_neutral_y,
)
from .palette import build_palette
from .render import render_palette_layers, render_radial_palette
from .report import print_generation_header, print_palette_report

_PALETTE_COMPANDING_FIELD_BY_GAMUT = {
    "sRGB-D65": "srgb_chroma_companding_k",
    "P3-D65": "p3_chroma_companding_k",
}


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
    parser.add_argument(
        "--compensation",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="enable/disable ACES 2.0 compensated variants",
    )
    parser.add_argument(
        "--compensation-profile",
        action="append",
        choices=COMPENSATION_PROFILE_CHOICES,
        help="compensation profile(s) to generate; repeat to select multiple",
    )
    parser.add_argument("--ocio-config", type=Path)
    parser.add_argument(
        "--compensation-srgb-k",
        "--compensation-srgb-chroma-companding-k",
        dest="compensation_srgb_k",
        type=float,
        help="log companding k for the compensated sRGB palette",
    )
    parser.add_argument(
        "--compensation-p3-k",
        "--compensation-p3-chroma-companding-k",
        dest="compensation_p3_k",
        type=float,
        help="log companding k for the compensated P3 palette",
    )
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


def _canonical_compensation_profiles(
    values: list[str] | None,
) -> tuple[str, ...] | None:
    if not values:
        return None
    aliases = {
        "srgb": "srgb_rec709_bt1886",
        "sRGB": "srgb_rec709_bt1886",
        "rec709": "srgb_rec709_bt1886",
        "rec709_bt1886": "srgb_rec709_bt1886",
        "p3": "p3_rec2020_pq",
        "P3": "p3_rec2020_pq",
        "rec2020": "p3_rec2020_pq",
        "rec2020_pq": "p3_rec2020_pq",
    }
    result = tuple(aliases.get(value, value) for value in values)
    if len(set(result)) != len(result):
        raise ValueError("Each compensation profile may be selected only once.")
    return result


def _overrides_from_args(args: argparse.Namespace) -> dict[str, dict[str, object]]:
    overrides: dict[str, dict[str, object]] = {}
    output: dict[str, object] = {}
    palette: dict[str, object] = {}
    raster: dict[str, object] = {}
    markers: dict[str, object] = {}
    colorchecker: dict[str, object] = {}
    compensation: dict[str, object] = {}
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
    if args.compensation is not None:
        compensation["enabled"] = args.compensation
    if args.compensation_profile is not None:
        compensation["profiles"] = list(
            _canonical_compensation_profiles(args.compensation_profile)
        )
    if args.ocio_config is not None:
        compensation["ocio_config_path"] = str(args.ocio_config)
    if getattr(args, "compensation_srgb_k", None) is not None:
        compensation["srgb_chroma_companding_k"] = args.compensation_srgb_k
    if getattr(args, "compensation_p3_k", None) is not None:
        compensation["p3_chroma_companding_k"] = args.compensation_p3_k
    for name, values in (
        ("output", output),
        ("palette", palette),
        ("raster", raster),
        ("markers", markers),
        ("colorchecker", colorchecker),
        ("compensation", compensation),
    ):
        if values:
            overrides[name] = values
    return overrides


def generate(config: Config, *, verbose: bool = True) -> list[Path]:
    """Generate selected palettes and return their output paths."""

    config.validate()
    # Keep the model's configured neutral Y for ordinary palettes.  The
    # published center is set explicitly at render time, so a custom neutral
    # reference cannot leak into the white center patch.
    ordinary_config = config
    model = AppearanceModel.from_config(ordinary_config.appearance)
    if verbose:
        print_generation_header(ordinary_config, model)
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
                f"Chroma-companding k: {ordinary_config.palette.companding_by_gamut[gamut_name]:g}"
            )
        result = build_palette(gamut, ordinary_config, model)
        image = render_radial_palette(
            result,
            ordinary_config,
            center_color=PUBLISHED_CENTER_ACESCG,
        )
        output_path = output_path_for_gamut(ordinary_config, gamut)
        write_float_rgb_exr(
            output_path, image, gamut_name, ordinary_config, result.statistics
        )
        paths.append(output_path)
        if verbose:
            print(f"Created: {output_path.resolve()}")
            print_palette_report(result, ordinary_config)

    # Compensation is profile-specific and only follows a selected source
    # gamut.  This keeps ``--gamut ap1`` a one-file request while the default
    # all-gamut request emits the ordinary three files plus two variants.
    compensation = config.compensation
    eligible_profiles = (
        [
            COMPENSATION_PROFILE_DEFINITIONS[name]
            for name in compensation.profiles
            if COMPENSATION_PROFILE_DEFINITIONS[name].source_gamut
            in config.output.selected_gamuts
        ]
        if compensation.enabled
        else []
    )
    if eligible_profiles:
        processor_cache: dict[str, object] = {}
        for profile in eligible_profiles:
            gamut = GAMUT_MATRICES[profile.source_gamut]
            companding_field = _PALETTE_COMPANDING_FIELD_BY_GAMUT[gamut.name]
            compensated_k = compensation.companding_by_source_gamut[gamut.name]
            if verbose:
                print()
                print("=" * 92)
                print(
                    f"Generating {profile.name} compensated {profile.source_gamut} palette..."
                )
                print(f"OCIO view: {profile.view_transform}")
                print(f"OCIO display: {profile.display_name}")
                print(f"Chroma-companding k: {compensated_k:g}")
            processor = processor_cache.get(profile.name)
            if processor is None:
                processor = load_compensation_processor(compensation, profile.name)
                processor_cache[profile.name] = processor
            source_y, _intermediate_center = solve_neutral_y(processor, compensation)
            if not 0.0 < source_y <= 1.0:
                raise RuntimeError(
                    f"Solved source neutral Y is outside the supported range for "
                    f"{profile.name}: {source_y:.15g}"
                )
            source_config = replace(
                config,
                palette=replace(
                    config.palette,
                    **{companding_field: compensated_k},
                ),
                appearance=replace(
                    config.appearance,
                    reference_neutral_y=source_y,
                ),
            )
            source_model = AppearanceModel.from_config(source_config.appearance)
            source_result = build_palette(gamut, source_config, source_model)
            rendered = render_palette_layers(
                source_result,
                source_config,
                center_color=source_result.reference_neutral_acescg,
            )
            image, diagnostics = compensate_foreground(
                rendered.image,
                rendered.foreground_mask,
                processor,
                compensation,
                source_y,
                rendered.center_mask,
            )
            statistics = dict(source_result.statistics)
            statistics.update(diagnostics.as_statistics())
            output_path = output_path_for_compensation(
                config, gamut, profile, source_y
            )
            write_float_rgb_exr(
                output_path,
                image,
                gamut.name,
                source_config,
                statistics,
            )
            paths.append(output_path)
            if verbose:
                print(f"Solved source neutral Y: {source_y:.15g}")
                print(
                    "Intermediate center after inverse view: "
                    + ", ".join(f"{x:.9g}" for x in diagnostics.intermediate_center)
                )
                print(f"Created: {output_path.resolve()}")
                print_palette_report(source_result, source_config)
    if verbose:
        print()
        print("=" * 92)
        print(
            "All EXRs were written as scene-linear ACEScg/AP1, 32-bit float, ZIP-compressed."
        )
        print("Ordinary palette centers are ACEScg (1, 1, 1).")
        print("Every hue has a thin gamut-boundary cap.")
        if config.colorchecker.enabled:
            print(
                "ColorChecker dots mark unique nearest palette locations using saturation and hue only."
            )
        if eligible_profiles:
            print(
                "Compensated variants inverse their ACES 2.0 view transform, then scale foreground colors to center (1, 1, 1)."
            )
        print("Ordinary variants have no display transform baked in.")
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
