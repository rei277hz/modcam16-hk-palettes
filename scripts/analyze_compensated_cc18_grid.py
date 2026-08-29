"""Analyze exposure-grid stability for compensated CC18 marker matching.

The script deliberately performs no rendering or file writes.  It fits each
selected compensation profile once, then evaluates the same logical ring/cap
candidates over several exposure grids and reports endpoint pressure,
assignment churn, and distance changes.  It is useful when deciding whether
the configurable compensated-marker sweep is wider/finer than necessary.
"""

from __future__ import annotations

import argparse
from dataclasses import replace

import numpy as np

from modcam16_palette.colorchecker import (
    build_compensated_colorchecker_marker_assignments,
)
from modcam16_palette.config import (
    COMPENSATION_PROFILE_DEFINITIONS,
    default_config,
    load_config,
)
from modcam16_palette.fitting import fit_profile
from modcam16_palette.ocio_compensation import (
    compensate_candidate_colors,
    load_compensation_processor,
)


def _grid(minimum: float, maximum: float, step: float) -> tuple[float, ...]:
    span = (maximum - minimum) / step
    count = round(span)
    if count < 1 or not np.isclose(span, count, atol=1.0e-9, rtol=0.0):
        raise ValueError("Grid span must be a positive integer multiple of step.")
    return tuple(float(value) for value in np.linspace(minimum, maximum, count + 1))


def _assignments_for_grid(fit, processor, profile_name: str, grid: tuple[float, ...]):
    result = fit.palette
    full = result.color_table[result.block_valid_table]
    candidates = np.concatenate((full, result.cap_color_table), axis=0)
    stored = compensate_candidate_colors(candidates, processor, fit.intermediate_anchor)
    cc = replace(
        fit.source_config.colorchecker,
        compensated_marker_exposure_min_stops=grid[0],
        compensated_marker_exposure_max_stops=grid[-1],
        compensated_marker_exposure_step_stops=(
            grid[1] - grid[0] if len(grid) > 1 else 1.0
        ),
    )
    return build_compensated_colorchecker_marker_assignments(
        stored,
        result.palette_appearance,
        result.palette_chroma,
        float(result.statistics["c3_raw"]),
        result.statistics["relative_chroma_levels"],
        result.valid_ring_indices,
        result.valid_hue_indices,
        result.statistics["hue_angles"],
        processor,
        profile_name,
        cc,
    )


def _candidate_key(assignment: dict[str, object]) -> tuple[str, int | None, int]:
    return (
        str(assignment["candidate_type"]),
        assignment["ring_index"],
        int(assignment["hue_index"]),
    )


def analyze_profile(config, profile_name: str, grids):
    profile = COMPENSATION_PROFILE_DEFINITIONS[profile_name]
    processor = load_compensation_processor(config.compensation, profile_name)
    fit = fit_profile(config, profile, processor=processor)
    evaluated = []
    for label, grid in grids:
        _full, _caps, assignments, _unique, metadata = _assignments_for_grid(
            fit, processor, profile_name, grid
        )
        evaluated.append((label, grid, assignments, metadata))
    reference = evaluated[-1][2]
    print(
        f"\n{profile_name}: "
        f"{fit.diagnostics.evaluated_color_count} logical candidates"
    )
    for label, grid, assignments, metadata in evaluated:
        endpoint_wins = sum(
            abs(float(item["ev_stops"]) - grid[0]) < 1.0e-9
            or abs(float(item["ev_stops"]) - grid[-1]) < 1.0e-9
            for item in assignments
        )
        print(
            f"  {label:<14} samples={len(grid):4d} "
            f"range={grid[0]:+.2f}..{grid[-1]:+.2f} "
            f"step={(grid[1]-grid[0]):.4g} "
            f"endpoint_wins={endpoint_wins:2d} "
            f"mean_d={np.mean([float(item['distance']) for item in assignments]):.6f}"
        )
    baseline = evaluated[0][2]
    changed = sum(
        _candidate_key(a) != _candidate_key(b)
        for a, b in zip(baseline, reference)
    )
    ev_changed = sum(
        abs(float(a["ev_stops"]) - float(b["ev_stops"])) > 1.0e-9
        for a, b in zip(baseline, reference)
    )
    print(
        f"  baseline vs reference: candidate_changes={changed}, "
        f"EV_changes={ev_changed}"
    )
    for assignment in reference:
        print(
            f"    {assignment['patch_name']:<16} "
            f"candidate={_candidate_key(assignment)} "
            f"EV={float(assignment['ev_stops']):+6.2f} "
            f"d={float(assignment['distance']):.6f}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile",
        action="append",
        choices=tuple(COMPENSATION_PROFILE_DEFINITIONS),
        help="profile(s) to analyze (default: both)",
    )
    parser.add_argument("--config", help="optional TOML configuration file")
    parser.add_argument(
        "--reference-min", type=float, default=-8.0, help="reference-grid minimum EV"
    )
    parser.add_argument(
        "--reference-max", type=float, default=8.0, help="reference-grid maximum EV"
    )
    parser.add_argument(
        "--reference-step", type=float, default=0.125, help="reference-grid step"
    )
    parser.add_argument(
        "--image-size",
        type=int,
        default=512,
        help="small raster size retained for fitting/render geometry (default: 512)",
    )
    parser.add_argument("--hue-count", type=int, default=12)
    parser.add_argument("--chroma-level-count", type=int, default=3)
    args = parser.parse_args()
    base = load_config(args.config) if args.config else default_config()
    base = replace(
        base,
        palette=replace(
            base.palette,
            hue_count=args.hue_count,
            chroma_level_count=args.chroma_level_count,
        ),
        raster=replace(base.raster, image_size=args.image_size),
        markers=replace(
            base.markers,
            enable_srgb_boundary_markers=False,
            enable_p3_boundary_markers=False,
        ),
        colorchecker=replace(base.colorchecker, enabled=True),
        compensation=replace(
            base.compensation,
            profiles=tuple(args.profile or COMPENSATION_PROFILE_DEFINITIONS),
        ),
    )
    initial = _grid(
        base.colorchecker.compensated_marker_exposure_min_stops,
        base.colorchecker.compensated_marker_exposure_max_stops,
        base.colorchecker.compensated_marker_exposure_step_stops,
    )
    reference = _grid(args.reference_min, args.reference_max, args.reference_step)
    grids = (("initial", initial), ("reference", reference))
    for profile_name in base.compensation.profiles:
        analyze_profile(base, profile_name, grids)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
