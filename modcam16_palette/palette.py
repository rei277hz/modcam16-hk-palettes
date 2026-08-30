"""Construct C3-relative palette tables for one RGB gamut."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from . import colorimetry
from .cam16_hk import CAM16_RESPONSE_LOWER, CAM16_RESPONSE_UPPER, AppearanceModel
from .colorchecker import (
    build_boundary_marker_tables,
    build_direct_colorchecker_marker_assignments,
    circular_hue_error,
)
from .colorimetry import GamutMatrices
from .config import Config
from .gamut import (
    C3Result,
    determine_c3,
    find_maximum_gamut_chroma_for_hues,
    is_inside_linear_rgb_gamut_cone,
)


@dataclass
class PaletteResult:
    """All data needed to render, write, and report one palette."""

    gamut: GamutMatrices
    color_table: np.ndarray
    block_valid_table: np.ndarray
    cap_color_table: np.ndarray
    cap_after_level_counts: np.ndarray
    boundary_marker_table: np.ndarray
    colorchecker_full_marker_table: np.ndarray
    colorchecker_cap_marker_table: np.ndarray
    statistics: dict[str, object]
    palette_appearance: dict[str, np.ndarray]
    palette_chroma: np.ndarray
    palette_hues: np.ndarray
    valid_ring_indices: np.ndarray
    valid_hue_indices: np.ndarray
    reference_neutral_acescg: np.ndarray | None = None


def make_log_companded_chroma_levels(
    chroma_level_count: float,
    companding_k: float | None = None,
) -> np.ndarray:
    """Return C/C3 levels for uniformly spaced radial/index positions."""

    # The two-argument form is the package API.  Accept the old one-argument
    # form as a convenience for callers that used the legacy default count.
    if companding_k is None:
        companding_k = float(chroma_level_count)
        chroma_level_count = 10
    if not isinstance(chroma_level_count, int) or chroma_level_count <= 0:
        raise ValueError("chroma_level_count must be a positive integer.")
    companding_k = float(companding_k)
    if not np.isfinite(companding_k) or companding_k < 0.0:
        raise ValueError("Chroma-companding k must be finite and nonnegative.")
    fractions = (
        np.arange(1, chroma_level_count + 1, dtype=np.float64) / chroma_level_count
    )
    if companding_k == 0.0:
        levels = fractions.copy()
    else:
        levels = np.expm1(np.log1p(companding_k) * fractions) / companding_k
    levels[-1] = 1.0
    if not np.all(np.diff(levels) > 0.0):
        raise RuntimeError("Generated chroma levels are not strictly increasing.")
    return levels


def inverse_log_companded_chroma(
    relative_chroma: np.ndarray, companding_k: float
) -> np.ndarray:
    relative_chroma = np.asarray(relative_chroma, dtype=np.float64)
    companding_k = float(companding_k)
    if companding_k == 0.0:
        return relative_chroma.copy()
    return np.log1p(companding_k * relative_chroma) / np.log1p(companding_k)


def _make_hue_angles(config: Config) -> np.ndarray:
    count = config.palette.hue_count
    step = 360.0 / count
    return np.mod(
        config.palette.hue_offset_degrees + np.arange(count, dtype=np.float64) * step,
        360.0,
    )


def _normalize_additional_gamut_constraints(
    constraints: Sequence[tuple[str, np.ndarray]] | None,
) -> tuple[tuple[str, np.ndarray], ...]:
    """Validate extra XYZ-D65 RGB cones applied to per-hue palette limits."""

    if constraints is None:
        return ()
    normalized: list[tuple[str, np.ndarray]] = []
    for item in constraints:
        if not isinstance(item, (tuple, list)) or len(item) != 2:
            raise TypeError(
                "additional_gamut_constraints entries must be (name, matrix) pairs."
            )
        name, matrix = item
        if not isinstance(name, str) or not name.strip():
            raise ValueError(
                "Additional gamut constraint names must be non-empty strings."
            )
        matrix_value = np.asarray(matrix, dtype=np.float64)
        if matrix_value.shape != (3, 3) or not np.all(np.isfinite(matrix_value)):
            raise ValueError(
                f"Additional gamut constraint {name!r} must have a finite 3x3 matrix."
            )
        normalized.append((name, matrix_value.copy()))
    return tuple(normalized)


def _validate_raw_boundaries(
    gamut: GamutMatrices,
    model: AppearanceModel,
    config: Config,
    hue_angles: np.ndarray,
    rendered_cmax_raw: np.ndarray,
    additional_gamut_constraints: Sequence[tuple[str, np.ndarray]] = (),
) -> tuple[np.ndarray, dict[str, int]]:
    solver = config.solver
    raw_boundary_xyz = model.modcam16_hk_to_xyz_d65(
        model.target_j_hk, rendered_cmax_raw, hue_angles
    )
    raw_boundary_rgb = colorimetry.apply_matrix(
        gamut.xyz_d65_to_gamut_rgb, raw_boundary_xyz
    )
    if np.any(raw_boundary_rgb < -solver.gamut_test_epsilon):
        bad_hue, bad_channel = np.argwhere(
            raw_boundary_rgb < -solver.gamut_test_epsilon
        )[0]
        raise RuntimeError(
            "Raw Cmax boundary lies outside gamut cone:\n"
            f"  Gamut: {gamut.name}\n  Hue: {hue_angles[bad_hue]:.8f}°\n"
            f"  RGB: {raw_boundary_rgb[bad_hue]}\n  Channel index: {bad_channel}"
        )

    # An additional constraint can be the limiting cone for a hue.  In that
    # case the source-gamut RGB is still strictly positive, so requiring every
    # source RGB triplet to touch a zero face would reject the intended
    # intersection boundary.  Validate that each boundary touches at least
    # one of the configured cones instead.
    boundary_constraints = (
        (gamut.name, gamut.xyz_d65_to_gamut_rgb),
        *tuple(additional_gamut_constraints),
    )
    boundary_rgbs = [raw_boundary_rgb]
    for _name, matrix in additional_gamut_constraints:
        boundary_rgbs.append(colorimetry.apply_matrix(matrix, raw_boundary_xyz))
    all_boundary_rgb = np.stack(boundary_rgbs, axis=0)
    if not np.all(
        is_inside_linear_rgb_gamut_cone(
            all_boundary_rgb, epsilon=solver.gamut_test_epsilon
        )
    ):
        bad_constraint, bad_hue, bad_channel = np.argwhere(
            all_boundary_rgb < -solver.gamut_test_epsilon
        )[0]
        constraint_name = boundary_constraints[int(bad_constraint)][0]
        raise RuntimeError(
            "Raw Cmax boundary lies outside a gamut cone:\n"
            f"  Gamut: {constraint_name}\n  Hue: {hue_angles[bad_hue]:.8f}°\n"
            f"  RGB: {all_boundary_rgb[bad_constraint, bad_hue]}\n"
            f"  Channel index: {bad_channel}"
        )
    face_distances = np.min(np.abs(all_boundary_rgb), axis=-1)
    effective_face_distance = np.min(face_distances, axis=0)
    if np.any(effective_face_distance > solver.boundary_face_tolerance):
        bad_hue = int(np.argmax(effective_face_distance))
        active_constraint = int(np.argmin(face_distances[:, bad_hue]))
        constraint_name = boundary_constraints[active_constraint][0]
        raise RuntimeError(
            "Raw Cmax failed to reach a zero-channel boundary:\n"
            f"  Gamut: {constraint_name}\n  Hue: {hue_angles[bad_hue]:.8f}°\n"
            f"  RGB: {all_boundary_rgb[active_constraint, bad_hue]}\n"
            f"  Face distance: {effective_face_distance[bad_hue]:.12g}"
        )

    # Preserve the legacy R/G/B keys when there is no extra constraint.  For
    # an intersection, expose the limiting cone in the diagnostic key so a
    # report can distinguish (for example) a Rec.2020 B=0 boundary from a
    # P3 B=0 boundary.
    if additional_gamut_constraints:
        active_constraint_indices = np.argmin(face_distances, axis=0)
        active_channel_indices = np.array(
            [
                int(np.argmin(np.abs(all_boundary_rgb[c, h])))
                for h, c in enumerate(active_constraint_indices)
            ],
            dtype=np.int64,
        )
        labels = ("R=0", "G=0", "B=0")
        counts = {
            f"{boundary_constraints[c][0]}:{labels[channel]}": int(
                np.count_nonzero(
                    (active_constraint_indices == c)
                    & (active_channel_indices == channel)
                )
            )
            for c in range(len(boundary_constraints))
            for channel in range(3)
        }
    else:
        active_indices = np.argmin(np.abs(raw_boundary_rgb), axis=-1)
        labels = ("R=0", "G=0", "B=0")
        counts = {
            label: int(np.count_nonzero(active_indices == index))
            for index, label in enumerate(labels)
        }
    return raw_boundary_rgb, counts


def _build_statistics(
    *,
    config: Config,
    gamut: GamutMatrices,
    model: AppearanceModel,
    relative_chroma_levels: np.ndarray,
    c3: C3Result,
    rendered_cmax_raw: np.ndarray,
    hue_angles: np.ndarray,
    available_relative_chroma: np.ndarray,
    available_progression_position: np.ndarray,
    available_level_counts: np.ndarray,
    blocks_per_level: np.ndarray,
    total_drawn_full_blocks: int,
    total_possible_full_blocks: int,
    total_palette_colors: int,
    boundary_adjusted_count: int,
    additional_gamut_constraints: Sequence[tuple[str, np.ndarray]],
    active_face_counts: dict[str, int],
    raw_boundary_rgb: np.ndarray,
    stored_maximum_channel: float,
    stored_channels_above_one: int,
    stored_colors_above_one: int,
    cap_colors_above_one: int,
    largest_cap_zero_face_inset: float,
    individual_marker_counts: dict[str, int],
    combined_marker_count: int,
    marker_overlap_count: int,
    marker_boundary_cmax: dict[str, np.ndarray | None],
    colorchecker_assignments: list[dict[str, object]],
    colorchecker_unique_marker_count: int,
    colorchecker_full_marker_table: np.ndarray,
    colorchecker_cap_marker_table: np.ndarray,
    j_hk_error: float,
    chroma_error: float,
    hue_error: float,
) -> dict[str, object]:
    return {
        "chroma_companding_k": float(config.palette.companding_by_gamut[gamut.name]),
        "target_j_hk": model.target_j_hk,
        "target_q_hk": model.target_q_hk,
        "reference_neutral_y": float(config.appearance.reference_neutral_y),
        "reference_neutral_acescg": colorimetry.apply_matrix(
            colorimetry.XYZ_D65_TO_ACESCG, model.reference_neutral_xyz_d65
        ),
        "relative_chroma_levels": relative_chroma_levels,
        "c3_raw": c3.value,
        "c3_hue": c3.hue,
        "c3_source": c3.source,
        "c3_active_face": c3.active_face,
        "c3_raw_rgb": c3.rgb,
        "c3_refinement_candidate_count": c3.refinement_candidate_count,
        "rendered_cmax_raw": rendered_cmax_raw,
        "hue_angles": hue_angles,
        "available_relative_chroma": available_relative_chroma,
        "available_progression_position": available_progression_position,
        "available_level_counts": available_level_counts,
        "blocks_per_level": blocks_per_level,
        "total_drawn_full_blocks": total_drawn_full_blocks,
        "total_possible_full_blocks": total_possible_full_blocks,
        "total_palette_colors": total_palette_colors,
        "boundary_adjusted_count": boundary_adjusted_count,
        "additional_gamut_constraints": tuple(
            name for name, _matrix in additional_gamut_constraints
        ),
        "active_face_counts": active_face_counts,
        "raw_boundary_maximum_channel": float(np.max(raw_boundary_rgb)),
        "stored_maximum_channel": stored_maximum_channel,
        "stored_channels_above_one": stored_channels_above_one,
        "stored_colors_above_one": stored_colors_above_one,
        "cap_colors_above_one": cap_colors_above_one,
        "largest_cap_zero_face_inset": largest_cap_zero_face_inset,
        "individual_marker_counts": individual_marker_counts,
        "combined_marker_count": combined_marker_count,
        "marker_overlap_count": marker_overlap_count,
        "marker_boundary_cmax": marker_boundary_cmax,
        # The direct matcher replaces these defaults with its complete
        # exposure-grid metadata below.  Keeping defaults here makes the
        # statistics schema stable for disabled/legacy callers.
        "colorchecker_matching_mode": "source CAM16 saturation/hue exposure",
        "colorchecker_distance_metric": (
            "Euclidean distance in (s*cos(h), s*sin(h)); brightness excluded"
        ),
        "colorchecker_assignment_policy": (
            "independent per-patch minimum Euclidean source CAM16 saturation/hue "
            "distance over the exposure grid; candidate locations may be reused"
        ),
        "colorchecker_exposure_min_stops": float(
            config.colorchecker.compensated_marker_exposure_min_stops
        ),
        "colorchecker_exposure_max_stops": float(
            config.colorchecker.compensated_marker_exposure_max_stops
        ),
        "colorchecker_exposure_step_stops": float(
            config.colorchecker.compensated_marker_exposure_step_stops
        ),
        "colorchecker_exposure_stops": config.colorchecker.marker_exposure_stops,
        "colorchecker_exposure_sample_count": len(
            config.colorchecker.marker_exposure_stops
        ),
        "colorchecker_candidate_count": 0,
        "colorchecker_evaluation_count": 0,
        "colorchecker_assignments": colorchecker_assignments,
        "colorchecker_unique_marker_count": colorchecker_unique_marker_count,
        "colorchecker_full_marker_count": int(
            np.count_nonzero(colorchecker_full_marker_table)
        ),
        "colorchecker_cap_marker_count": int(
            np.count_nonzero(colorchecker_cap_marker_table)
        ),
        "j_hk_error": j_hk_error,
        "chroma_error": chroma_error,
        "hue_error": hue_error,
    }


def build_palette(
    gamut: GamutMatrices,
    config: Config,
    model: AppearanceModel | None = None,
    *,
    additional_gamut_constraints: Sequence[tuple[str, np.ndarray]] | None = None,
) -> PaletteResult:
    """Build one complete palette while retaining the legacy numerical order.

    ``additional_gamut_constraints`` applies extra nonnegative RGB cones to
    the per-hue constant-``J_HK`` boundary.  It is useful when a source gamut
    is slightly wider than the limiting gamut of a downstream view transform;
    colors are then reduced in modCAM16-HK chroma before conversion to RGB.
    The source gamut remains the C3 reference domain.
    """

    config.validate()
    model = AppearanceModel.from_config(config.appearance) if model is None else model
    additional_gamut_constraints = _normalize_additional_gamut_constraints(
        additional_gamut_constraints
    )
    p = config.palette
    solver = config.solver
    n = p.chroma_level_count
    h_count = p.hue_count
    companding_k = p.companding_by_gamut[gamut.name]
    relative_chroma_levels = make_log_companded_chroma_levels(n, companding_k)
    hue_angles = _make_hue_angles(config)
    reference_neutral_acescg = colorimetry.apply_matrix(
        colorimetry.XYZ_D65_TO_ACESCG, model.reference_neutral_xyz_d65
    )
    neutral_in_gamut = colorimetry.apply_matrix(
        gamut.acescg_to_gamut_rgb, reference_neutral_acescg
    )
    expected_neutral = np.full(
        3, config.appearance.reference_neutral_y, dtype=np.float64
    )
    if not np.allclose(neutral_in_gamut, expected_neutral, atol=8.0e-6, rtol=0.0):
        raise RuntimeError(
            f"{gamut.name} neutral conversion failed:\n"
            f"  Expected: {expected_neutral}\n  Received: {neutral_in_gamut}"
        )

    source_cmax_raw = find_maximum_gamut_chroma_for_hues(
        hue_angles, gamut.xyz_d65_to_gamut_rgb, model, solver, gamut.name
    )
    rendered_cmax_raw = source_cmax_raw.copy()
    for constraint_name, constraint_matrix in additional_gamut_constraints:
        constraint_cmax = find_maximum_gamut_chroma_for_hues(
            hue_angles,
            constraint_matrix,
            model,
            solver,
            constraint_name,
        )
        rendered_cmax_raw = np.minimum(rendered_cmax_raw, constraint_cmax)
    # The continuous C3 domain is defined by the source gamut and remains the
    # stable reference scale for compensated palettes.  In the explicitly
    # rendered domain, however, the additional intersection constraint is part
    # of the requested sampled boundary and must determine C3 as well.
    c3_boundary = (
        rendered_cmax_raw
        if p.c3_reference_domain == "rendered"
        else source_cmax_raw
    )
    c3 = determine_c3(
        hue_angles,
        c3_boundary,
        gamut,
        model,
        p,
        solver,
        gamut.name,
    )

    nominal_level_chroma = relative_chroma_levels * c3.value
    nominal_chroma_table = np.broadcast_to(
        nominal_level_chroma[:, None], (n, h_count)
    ).copy()
    inclusion_tolerance = solver.level_inclusion_relative_tolerance * max(1.0, c3.value)
    block_valid_table = (
        nominal_chroma_table <= rendered_cmax_raw[None, :] + inclusion_tolerance
    )
    if np.any(np.diff(block_valid_table.astype(np.int8), axis=0) > 0):
        raise RuntimeError(f"{gamut.name} block-validity table is not contiguous.")
    available_level_counts = np.sum(block_valid_table, axis=0, dtype=np.int16)
    available_relative_chroma = rendered_cmax_raw / c3.value
    if np.any(
        available_relative_chroma > 1.0 + solver.level_inclusion_relative_tolerance
    ):
        bad_hue = int(np.argmax(available_relative_chroma))
        raise RuntimeError(
            f"{gamut.name} rendered hue exceeds C3:\n"
            f"  Hue: {hue_angles[bad_hue]:.8f}°\n"
            f"  Cmax/C3: {available_relative_chroma[bad_hue]:.12g}"
        )
    available_progression_position = inverse_log_companded_chroma(
        np.clip(available_relative_chroma, 0.0, 1.0), companding_k
    )
    safe_boundary_chroma = rendered_cmax_raw * solver.gamut_boundary_safety
    rendered_chroma_table = np.minimum(
        nominal_chroma_table, safe_boundary_chroma[None, :]
    )
    rendered_chroma_table = np.where(block_valid_table, rendered_chroma_table, np.nan)
    boundary_adjusted_table = block_valid_table & (
        rendered_chroma_table < nominal_chroma_table
    )
    cap_chroma = safe_boundary_chroma
    cap_after_level_counts = available_level_counts.copy()

    (
        boundary_marker_table,
        individual_marker_tables,
        marker_boundary_cmax,
        marker_overlap_count,
    ) = build_boundary_marker_tables(
        hue_angles,
        nominal_level_chroma,
        rendered_cmax_raw,
        inclusion_tolerance,
        model,
        solver,
        config.markers,
    )

    valid_positions = np.argwhere(block_valid_table)
    if valid_positions.size:
        valid_ring_indices = valid_positions[:, 0]
        valid_hue_indices = valid_positions[:, 1]
        selected_chroma = rendered_chroma_table[valid_ring_indices, valid_hue_indices]
        selected_hues = hue_angles[valid_hue_indices]
        selected_xyz_d65 = model.chroma_hue_to_xyz_d65(selected_chroma, selected_hues)
    else:
        valid_ring_indices = np.empty(0, dtype=np.int64)
        valid_hue_indices = np.empty(0, dtype=np.int64)
        selected_chroma = np.empty(0, dtype=np.float64)
        selected_hues = np.empty(0, dtype=np.float64)
        selected_xyz_d65 = np.empty((0, 3), dtype=np.float64)

    cap_xyz_d65 = model.chroma_hue_to_xyz_d65(cap_chroma, hue_angles)
    cap_cam16_cone_rgb = (
        colorimetry.apply_matrix(colorimetry.CAT16_MATRIX, cap_xyz_d65 * 100.0)
        * model.cam_adaptation_factors
    )
    # Complete blocks first, then all caps, matching the original candidate order.
    all_chroma = np.concatenate((selected_chroma, cap_chroma))
    all_hues = np.concatenate((selected_hues, hue_angles))
    all_xyz_d65 = np.concatenate((selected_xyz_d65, cap_xyz_d65), axis=0)
    all_gamut_rgb = colorimetry.apply_matrix(gamut.xyz_d65_to_gamut_rgb, all_xyz_d65)
    if not np.all(
        is_inside_linear_rgb_gamut_cone(
            all_gamut_rgb, epsilon=solver.rendered_gamut_epsilon
        )
    ):
        bad_index = int(
            np.flatnonzero(
                ~is_inside_linear_rgb_gamut_cone(
                    all_gamut_rgb, epsilon=solver.rendered_gamut_epsilon
                )
            )[0]
        )
        raise RuntimeError(
            "Unexpected gamut-cone violation:\n"
            f"  Gamut: {gamut.name}\n  C: {all_chroma[bad_index]:.12f}\n"
            f"  RGB: {all_gamut_rgb[bad_index]}"
        )

    raw_boundary_rgb, active_face_counts = _validate_raw_boundaries(
        gamut,
        model,
        config,
        hue_angles,
        rendered_cmax_raw,
        additional_gamut_constraints,
    )

    appearance_round_trip = model.xyz_d65_to_attributes(all_xyz_d65)
    j_hk_error = float(
        np.max(np.abs(appearance_round_trip["J_HK"] - model.target_j_hk))
    )
    chroma_error = float(np.max(np.abs(appearance_round_trip["C"] - all_chroma)))
    hue_mask = all_chroma > solver.hue_validation_minimum_c
    hue_error = float(
        np.max(
            circular_hue_error(appearance_round_trip["h"][hue_mask], all_hues[hue_mask])
        )
        if np.any(hue_mask)
        else 0.0
    )
    if (
        not np.isfinite(j_hk_error)
        or not np.isfinite(chroma_error)
        or not np.isfinite(hue_error)
        or j_hk_error > 2.0e-7
        or chroma_error > 2.0e-7
        or hue_error > 2.0e-6
    ):
        raise RuntimeError(
            "modCAM16-HK round-trip validation failed:\n"
            f"  Gamut: {gamut.name}\n  Maximum J_HK error: {j_hk_error:.12g}\n"
            f"  Maximum C error: {chroma_error:.12g}\n  Maximum hue error: {hue_error:.12g}°"
        )

    (
        colorchecker_full_marker_table,
        colorchecker_cap_marker_table,
        colorchecker_assignments,
        colorchecker_unique_marker_count,
        colorchecker_metadata,
    ) = build_direct_colorchecker_marker_assignments(
        appearance_round_trip,
        all_chroma,
        c3.value,
        relative_chroma_levels,
        valid_ring_indices,
        valid_hue_indices,
        hue_angles,
        model,
        config.colorchecker,
        candidate_xyz_d65=all_xyz_d65,
    )

    all_acescg_float64 = colorimetry.apply_matrix(
        colorimetry.XYZ_D65_TO_ACESCG, all_xyz_d65
    )
    gamut_round_trip = colorimetry.apply_matrix(
        gamut.acescg_to_gamut_rgb, all_acescg_float64
    )
    if not np.allclose(gamut_round_trip, all_gamut_rgb, atol=2.0e-9, rtol=2.0e-12):
        maximum_error = float(np.max(np.abs(gamut_round_trip - all_gamut_rgb)))
        raise RuntimeError(
            f"ACEScg colorimetric round-trip failed:\n  Gamut: {gamut.name}\n  Maximum RGB error: {maximum_error:.12g}"
        )

    full_count = len(selected_chroma)
    color_table = np.zeros((n, h_count, 3), dtype=np.float32)
    if full_count:
        color_table[valid_ring_indices, valid_hue_indices] = all_acescg_float64[
            :full_count
        ].astype(np.float32)
    cap_color_table = all_acescg_float64[full_count:].astype(np.float32)

    if full_count:
        stored_selected_acescg = color_table[
            valid_ring_indices, valid_hue_indices
        ].astype(np.float64)
    else:
        stored_selected_acescg = np.empty((0, 3), dtype=np.float64)
    stored_cap_acescg = cap_color_table.astype(np.float64)
    stored_all_acescg = np.concatenate(
        (stored_selected_acescg, stored_cap_acescg), axis=0
    )
    stored_all_gamut_rgb = colorimetry.apply_matrix(
        gamut.acescg_to_gamut_rgb, stored_all_acescg
    )
    storage_scale = max(1.0, float(np.max(np.abs(stored_all_gamut_rgb))))
    fp32_epsilon = solver.fp32_cone_validation_relative_epsilon * storage_scale
    if not np.all(
        is_inside_linear_rgb_gamut_cone(stored_all_gamut_rgb, epsilon=fp32_epsilon)
    ):
        bad_index = int(
            np.flatnonzero(
                ~is_inside_linear_rgb_gamut_cone(
                    stored_all_gamut_rgb, epsilon=fp32_epsilon
                )
            )[0]
        )
        raise RuntimeError(
            "Float32 storage moved a palette color materially outside its gamut cone:\n"
            f"  Gamut: {gamut.name}\n  Stored RGB: {stored_all_gamut_rgb[bad_index]}\n"
            f"  Validation epsilon: {fp32_epsilon:.12g}"
        )
    stored_cap_gamut_rgb = stored_all_gamut_rgb[full_count:]
    minimum_stored_channel = float(np.min(stored_all_gamut_rgb))
    maximum_stored_channel = float(np.max(stored_all_gamut_rgb))
    stored_channels_above_one = int(np.count_nonzero(stored_all_gamut_rgb > 1.0))
    stored_colors_above_one = int(
        np.count_nonzero(np.any(stored_all_gamut_rgb > 1.0, axis=-1))
    )
    cap_colors_above_one = int(
        np.count_nonzero(np.any(stored_cap_gamut_rgb > 1.0, axis=-1))
    )
    largest_cap_zero_face_inset = float(
        np.max(np.min(np.abs(stored_cap_gamut_rgb), axis=-1))
    )
    total_drawn_full_blocks = int(np.count_nonzero(block_valid_table))
    total_possible_full_blocks = n * h_count
    total_palette_colors = total_drawn_full_blocks + h_count
    blocks_per_level = np.sum(block_valid_table, axis=1, dtype=np.int16)
    individual_marker_counts = {
        name: int(np.count_nonzero(table))
        for name, table in individual_marker_tables.items()
    }
    combined_marker_count = int(np.count_nonzero(boundary_marker_table))

    statistics = _build_statistics(
        config=config,
        gamut=gamut,
        model=model,
        relative_chroma_levels=relative_chroma_levels,
        c3=c3,
        rendered_cmax_raw=rendered_cmax_raw,
        hue_angles=hue_angles,
        available_relative_chroma=available_relative_chroma,
        available_progression_position=available_progression_position,
        available_level_counts=available_level_counts,
        blocks_per_level=blocks_per_level,
        total_drawn_full_blocks=total_drawn_full_blocks,
        total_possible_full_blocks=total_possible_full_blocks,
        total_palette_colors=total_palette_colors,
        boundary_adjusted_count=int(np.count_nonzero(boundary_adjusted_table)),
        additional_gamut_constraints=additional_gamut_constraints,
        active_face_counts=active_face_counts,
        raw_boundary_rgb=raw_boundary_rgb,
        stored_maximum_channel=maximum_stored_channel,
        stored_channels_above_one=stored_channels_above_one,
        stored_colors_above_one=stored_colors_above_one,
        cap_colors_above_one=cap_colors_above_one,
        largest_cap_zero_face_inset=largest_cap_zero_face_inset,
        individual_marker_counts=individual_marker_counts,
        combined_marker_count=combined_marker_count,
        marker_overlap_count=marker_overlap_count,
        marker_boundary_cmax=marker_boundary_cmax,
        colorchecker_assignments=colorchecker_assignments,
        colorchecker_unique_marker_count=colorchecker_unique_marker_count,
        colorchecker_full_marker_table=colorchecker_full_marker_table,
        colorchecker_cap_marker_table=colorchecker_cap_marker_table,
        j_hk_error=j_hk_error,
        chroma_error=chroma_error,
        hue_error=hue_error,
    )
    statistics.update(colorchecker_metadata)
    statistics["minimum_stored_channel"] = minimum_stored_channel
    statistics["maximum_below_zero"] = max(0.0, -minimum_stored_channel)
    statistics["cap_cam16_minimum_response"] = float(np.min(cap_cam16_cone_rgb))
    statistics["cap_cam16_maximum_response"] = float(np.max(cap_cam16_cone_rgb))
    statistics["cap_cam16_below_lower_count"] = int(
        np.count_nonzero(cap_cam16_cone_rgb < CAM16_RESPONSE_LOWER)
    )
    statistics["cap_cam16_above_upper_count"] = int(
        np.count_nonzero(cap_cam16_cone_rgb > CAM16_RESPONSE_UPPER)
    )

    return PaletteResult(
        gamut=gamut,
        reference_neutral_acescg=reference_neutral_acescg,
        color_table=color_table,
        block_valid_table=block_valid_table,
        cap_color_table=cap_color_table,
        cap_after_level_counts=cap_after_level_counts,
        boundary_marker_table=boundary_marker_table,
        colorchecker_full_marker_table=colorchecker_full_marker_table,
        colorchecker_cap_marker_table=colorchecker_cap_marker_table,
        statistics=statistics,
        palette_appearance=appearance_round_trip,
        palette_chroma=all_chroma,
        palette_hues=all_hues,
        valid_ring_indices=valid_ring_indices,
        valid_hue_indices=valid_hue_indices,
    )
