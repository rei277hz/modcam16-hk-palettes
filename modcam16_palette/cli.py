"""Command-line entry point and generation orchestration."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import numpy as np

from .cam16_hk import AppearanceModel
from .colorchecker import build_compensated_colorchecker_marker_assignments
from .colorimetry import GAMUT_MATRICES
from .config import (
    COMPENSATION_PROFILE_CHOICES,
    COMPENSATION_PROFILE_DEFINITIONS,
    GAMUT_NAMES,
    PUBLISHED_CENTER_ACESCG,
    Config,
    load_config,
)
from .fitting import fit_profile
from .naming import output_path_for_compensation, output_path_for_gamut
from .ocio_compensation import (
    compensate_candidate_colors,
    compensate_foreground,
    load_compensation_processor,
)
from .palette import build_palette
from .render import render_palette_layers, render_radial_palette
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
    parser.add_argument(
        "--colorchecker-compensated-exposure-min",
        "--colorchecker-compensated-exposure-min-stops",
        "--compensated-marker-exposure-min",
        dest="colorchecker_compensated_exposure_min",
        type=float,
        help="minimum exposure sample for compensated CC18 matching (stops)",
    )
    parser.add_argument(
        "--colorchecker-compensated-exposure-max",
        "--colorchecker-compensated-exposure-max-stops",
        "--compensated-marker-exposure-max",
        dest="colorchecker_compensated_exposure_max",
        type=float,
        help="maximum exposure sample for compensated CC18 matching (stops)",
    )
    parser.add_argument(
        "--colorchecker-compensated-exposure-step",
        "--colorchecker-compensated-exposure-step-stops",
        "--compensated-marker-exposure-step",
        dest="colorchecker_compensated_exposure_step",
        type=float,
        help="exposure spacing for compensated CC18 matching (stops)",
    )
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
    parser.add_argument(
        "--compensation-fit-mode",
        "--compensation-mode",
        dest="compensation_fit_mode",
        choices=("auto", "automatic", "manual", "legacy"),
        help="choose an exposure-fitted or explicit legacy compensation anchor",
    )
    parser.add_argument(
        "--compensation-exposure-min",
        "--fit-exposure-min",
        dest="compensation_exposure_min",
        type=float,
        help="minimum exposure sample in stops for ACES-J fitting",
    )
    parser.add_argument(
        "--compensation-exposure-max",
        "--fit-exposure-max",
        dest="compensation_exposure_max",
        type=float,
        help="maximum exposure sample in stops for ACES-J fitting",
    )
    parser.add_argument(
        "--compensation-exposure-step",
        "--fit-exposure-step",
        dest="compensation_exposure_step",
        type=float,
        help="exposure sample spacing in stops for ACES-J fitting",
    )
    parser.add_argument(
        "--compensation-fit-tolerance",
        "--fit-anchor-tolerance",
        dest="compensation_fit_tolerance",
        type=float,
        help="anchor-search tolerance in stops",
    )
    parser.add_argument(
        "--compensation-fit-iterations",
        "--fit-anchor-iterations",
        dest="compensation_fit_iterations",
        type=int,
        help="maximum anchor-search iterations",
    )
    parser.add_argument(
        "--compensation-round-trip-relative-tolerance",
        "--round-trip-relative-tolerance",
        dest="compensation_round_trip_relative_tolerance",
        type=float,
        help="float32-aware relative allowance for ACES inverse round-trip checks",
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
    if args.colorchecker_compensated_exposure_min is not None:
        colorchecker["compensated_marker_exposure_min_stops"] = (
            args.colorchecker_compensated_exposure_min
        )
    if args.colorchecker_compensated_exposure_max is not None:
        colorchecker["compensated_marker_exposure_max_stops"] = (
            args.colorchecker_compensated_exposure_max
        )
    if args.colorchecker_compensated_exposure_step is not None:
        colorchecker["compensated_marker_exposure_step_stops"] = (
            args.colorchecker_compensated_exposure_step
        )
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
    if getattr(args, "compensation_fit_mode", None) is not None:
        compensation["fit_mode"] = args.compensation_fit_mode
    if getattr(args, "compensation_exposure_min", None) is not None:
        compensation["exposure_min_stops"] = args.compensation_exposure_min
    if getattr(args, "compensation_exposure_max", None) is not None:
        compensation["exposure_max_stops"] = args.compensation_exposure_max
    if getattr(args, "compensation_exposure_step", None) is not None:
        compensation["exposure_step_stops"] = args.compensation_exposure_step
    if getattr(args, "compensation_fit_tolerance", None) is not None:
        compensation["anchor_search_tolerance"] = args.compensation_fit_tolerance
    if getattr(args, "compensation_fit_iterations", None) is not None:
        compensation["anchor_search_max_iterations"] = args.compensation_fit_iterations
    if getattr(args, "compensation_round_trip_relative_tolerance", None) is not None:
        compensation["round_trip_relative_tolerance"] = (
            args.compensation_round_trip_relative_tolerance
        )
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
            fit = fit_profile(config, profile, processor=processor, gamut=gamut)
            source_y = fit.source_y
            source_config = fit.source_config
            source_result = fit.palette
            if not 0.0 < source_y:
                raise RuntimeError(
                    f"Solved source neutral Y is outside the supported range for "
                    f"{profile.name}: {source_y:.15g}"
                )
            compensated_result = source_result
            if source_config.colorchecker.enabled:
                source_full_candidates = source_result.color_table[
                    source_result.block_valid_table
                ]
                source_candidates = np.concatenate(
                    (source_full_candidates, source_result.cap_color_table), axis=0
                )
                stored_candidates = compensate_candidate_colors(
                    source_candidates,
                    processor,
                    fit.intermediate_anchor,
                )
                (
                    compensated_full_markers,
                    compensated_cap_markers,
                    compensated_assignments,
                    compensated_unique_count,
                    compensated_marker_metadata,
                ) = build_compensated_colorchecker_marker_assignments(
                    stored_candidates,
                    source_result.palette_appearance,
                    source_result.palette_chroma,
                    float(source_result.statistics["c3_raw"]),
                    source_result.statistics["relative_chroma_levels"],
                    source_result.valid_ring_indices,
                    source_result.valid_hue_indices,
                    source_result.statistics["hue_angles"],
                    processor,
                    profile.name,
                    source_config.colorchecker,
                )
                compensated_statistics = dict(source_result.statistics)
                compensated_statistics.update(compensated_marker_metadata)
                compensated_statistics.update(
                    {
                        "colorchecker_assignments": compensated_assignments,
                        "colorchecker_unique_marker_count": compensated_unique_count,
                        "colorchecker_full_marker_count": int(
                            np.count_nonzero(compensated_full_markers)
                        ),
                        "colorchecker_cap_marker_count": int(
                            np.count_nonzero(compensated_cap_markers)
                        ),
                    }
                )
                compensated_result = replace(
                    source_result,
                    colorchecker_full_marker_table=compensated_full_markers,
                    colorchecker_cap_marker_table=compensated_cap_markers,
                    statistics=compensated_statistics,
                )
            rendered = render_palette_layers(
                compensated_result,
                source_config,
                center_color=compensated_result.reference_neutral_acescg,
            )
            image, diagnostics = compensate_foreground(
                rendered.image,
                rendered.foreground_mask,
                processor,
                compensation,
                source_y,
                rendered.center_mask,
                fit.intermediate_anchor,
            )
            statistics = dict(compensated_result.statistics)
            statistics.update(diagnostics.as_statistics())
            statistics.update(fit.diagnostics.as_statistics())
            output_path = output_path_for_compensation(
                config,
                gamut,
                profile,
                source_y,
                intermediate_anchor=fit.intermediate_anchor,
                fit_mode=fit.diagnostics.fit_mode,
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
                print(f"Compensation anchor: {fit.intermediate_anchor:.15g}")
                print(f"ACES-J fit RMS: {fit.diagnostics.rms_error:.9g}")
                print(
                    "Intermediate center after inverse view: "
                    + ", ".join(f"{x:.9g}" for x in diagnostics.intermediate_center)
                )
                print(f"Created: {output_path.resolve()}")
                print_palette_report(
                    replace(source_result, statistics=statistics), source_config
                )
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
                "Ordinary ColorChecker dots use source saturation/hue; compensated dots use exposure-aware post-view ACES JMh matching."
            )
        if eligible_profiles:
            print(
                "Compensated variants inverse their ACES 2.0 view transform, then scale foreground colors to center (1, 1, 1)."
            )
            print(
                "Compensation targets are bounded by each selected view's limiting gamut and finite display peak."
            )
        print("Ordinary variants have no display transform baked in.")
        print("Ordinary palette gamut cones have no upper RGB bound.")
    return paths


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_config(args.config, _overrides_from_args(args))
        generate(config)
    except (TypeError, ValueError, RuntimeError, OSError) as exc:
        raise SystemExit(f"error: {exc}") from exc
    return 0
