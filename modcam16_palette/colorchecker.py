"""ColorChecker data conversion and palette-marker matching."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from . import colorimetry
from .aces_jmh import jmh_to_cartesian, params_for_profile
from .cam16_hk import AppearanceModel
from .config import ColorCheckerConfig, MarkerConfig, SolverConfig
from .gamut import find_maximum_gamut_chroma_for_hues

CHROMATIC_PATCH_NAMES = (
    "Dark Skin",
    "Light Skin",
    "Blue Sky",
    "Foliage",
    "Blue Flower",
    "Bluish Green",
    "Orange",
    "Purplish Blue",
    "Moderate Red",
    "Purple",
    "Yellow Green",
    "Orange Yellow",
    "Blue",
    "Green",
    "Red",
    "Yellow",
    "Magenta",
    "Cyan",
)

OFFICIAL_LAB_D50 = np.array(
    [
        [37.54, 14.37, 14.92],
        [64.66, 19.27, 17.50],
        [49.32, -3.82, -22.54],
        [43.46, -12.74, 22.72],
        [54.94, 9.61, -24.79],
        [70.48, -32.26, -0.37],
        [62.73, 35.83, 56.50],
        [39.43, 10.75, -45.17],
        [50.57, 48.64, 16.67],
        [30.10, 22.54, -20.87],
        [71.77, -24.13, 58.19],
        [71.51, 18.24, 67.37],
        [28.37, 15.42, -49.80],
        [54.38, -39.72, 32.27],
        [42.43, 51.05, 28.62],
        [81.80, 2.67, 80.41],
        [50.63, 51.28, -14.12],
        [49.57, -29.71, -28.32],
    ],
    dtype=np.float64,
)

MCCAMY_XYY_C = np.array(
    [
        [0.4002, 0.3504, 0.1005],
        [0.3773, 0.3446, 0.3582],
        [0.2470, 0.2514, 0.1933],
        [0.3372, 0.4220, 0.1329],
        [0.2651, 0.2400, 0.2427],
        [0.2608, 0.3430, 0.4306],
        [0.5060, 0.4070, 0.3005],
        [0.2110, 0.1750, 0.1200],
        [0.4533, 0.3058, 0.1977],
        [0.2845, 0.2020, 0.0656],
        [0.3800, 0.4887, 0.4429],
        [0.4729, 0.4375, 0.4306],
        [0.1866, 0.1285, 0.0611],
        [0.3046, 0.4782, 0.2339],
        [0.5385, 0.3129, 0.1200],
        [0.4480, 0.4703, 0.5910],
        [0.3635, 0.2325, 0.1977],
        [0.1958, 0.2519, 0.1977],
    ],
    dtype=np.float64,
)


@dataclass(frozen=True)
class ColorCheckerTargets:
    names: tuple[str, ...]
    xyz_d65: np.ndarray
    appearance: dict[str, np.ndarray]
    dataset_label: str
    adaptation_method: str


def get_colorchecker_targets(
    config: ColorCheckerConfig,
    model: AppearanceModel | None = None,
) -> ColorCheckerTargets:
    """Convert the selected eighteen-patch source dataset to D65.

    When ``model`` is supplied, the legacy CAM16 attributes are also
    populated for ordinary saturation/hue matching.  Compensated matching
    intentionally uses only the fixed D65 XYZ targets and supplies its own
    ACES JMh conversion, so it can call this function without coupling the
    target measurements to a profile-specific source neutral.
    """

    if config.dataset == "official_after_2014":
        source_xyz = colorimetry.lab_to_xyz(OFFICIAL_LAB_D50, colorimetry.D50_WHITE_XY)
        source_white_xy = colorimetry.D50_WHITE_XY
        dataset_label = "Official post-2014 Lab/D50"
    elif config.dataset == "mccamy":
        source_xyz = colorimetry.xyy_to_xyz(MCCAMY_XYY_C)
        source_white_xy = colorimetry.ILLUMINANT_C_WHITE_XY
        dataset_label = "McCamy xyY/Illuminant-C"
    else:
        raise RuntimeError(f"Unsupported ColorChecker dataset: {config.dataset}")

    adaptation = colorimetry.chromatic_adaptation_matrix(
        source_white_xy,
        colorimetry.D65_WHITE_XY,
        method=config.adaptation_method,
    )
    xyz_d65 = colorimetry.apply_matrix(adaptation, source_xyz)
    if not np.all(np.isfinite(xyz_d65)):
        raise RuntimeError("ColorChecker conversion produced non-finite XYZ values.")
    appearance: dict[str, np.ndarray]
    if model is None:
        appearance = {}
    else:
        appearance = model.xyz_d65_to_attributes(xyz_d65)
        if not np.all(np.isfinite(appearance["h"])):
            raise RuntimeError("ColorChecker conversion produced non-finite hues.")
        if not np.all(np.isfinite(appearance["s"])):
            raise RuntimeError(
                "ColorChecker conversion produced non-finite saturations."
            )
    return ColorCheckerTargets(
        CHROMATIC_PATCH_NAMES,
        xyz_d65,
        appearance,
        dataset_label,
        config.adaptation_method,
    )


def saturation_hue_cartesian(
    saturation: np.ndarray, hue_degrees: np.ndarray
) -> np.ndarray:
    saturation = np.asarray(saturation, dtype=np.float64)
    hue_radians = np.radians(np.asarray(hue_degrees, dtype=np.float64))
    return np.stack(
        (saturation * np.cos(hue_radians), saturation * np.sin(hue_radians)), axis=-1
    )


def build_boundary_marker_tables(
    hue_angles: np.ndarray,
    nominal_level_chroma: np.ndarray,
    selected_cmax_raw: np.ndarray,
    inclusion_tolerance: float,
    model: AppearanceModel,
    solver: SolverConfig,
    marker_config: MarkerConfig,
) -> tuple[np.ndarray, dict[str, np.ndarray], dict[str, np.ndarray | None], int]:
    """Build enabled sRGB/P3 crossing tables for one selected gamut."""

    definitions = (
        (
            "sRGB-D65",
            colorimetry.XYZ_D65_TO_LINEAR_SRGB,
            marker_config.enable_srgb_boundary_markers,
        ),
        (
            "P3-D65",
            colorimetry.XYZ_D65_TO_P3_D65,
            marker_config.enable_p3_boundary_markers,
        ),
    )
    table_shape = (len(nominal_level_chroma), len(hue_angles))
    marker_tables = {
        name: np.zeros(table_shape, dtype=bool)
        for name, _matrix, _enabled in definitions
    }
    marker_boundary_cmax: dict[str, np.ndarray | None] = {
        name: None for name, _matrix, _enabled in definitions
    }
    for marker_name, matrix, enabled in definitions:
        if not enabled:
            continue
        reference_cmax = find_maximum_gamut_chroma_for_hues(
            hue_angles, matrix, model, solver, marker_name
        )
        marker_boundary_cmax[marker_name] = reference_cmax
        marker_table = marker_tables[marker_name]
        for hue_index, boundary_c in enumerate(reference_cmax):
            selected_drawn_limit = (
                float(selected_cmax_raw[hue_index]) * solver.gamut_boundary_safety
            )
            if selected_drawn_limit <= float(boundary_c) + inclusion_tolerance:
                continue
            next_level_index = int(
                np.searchsorted(
                    nominal_level_chroma,
                    float(boundary_c) + inclusion_tolerance,
                    side="right",
                )
            )
            if next_level_index < len(nominal_level_chroma):
                marker_table[next_level_index, hue_index] = True

    combined = np.zeros(table_shape, dtype=bool)
    for marker_name, _matrix, enabled in definitions:
        if enabled:
            combined |= marker_tables[marker_name]
    overlap = 0
    if (
        marker_config.enable_srgb_boundary_markers
        and marker_config.enable_p3_boundary_markers
    ):
        overlap = int(
            np.count_nonzero(marker_tables["sRGB-D65"] & marker_tables["P3-D65"])
        )
    return combined, marker_tables, marker_boundary_cmax, overlap


def circular_hue_error(
    actual_degrees: np.ndarray, expected_degrees: np.ndarray
) -> np.ndarray:
    return np.abs((actual_degrees - expected_degrees + 180.0) % 360.0 - 180.0)


def build_colorchecker_marker_assignments(
    palette_appearance: dict[str, np.ndarray],
    palette_chroma: np.ndarray,
    c3_raw: float,
    relative_chroma_levels: np.ndarray,
    valid_ring_indices: np.ndarray,
    valid_hue_indices: np.ndarray,
    hue_angles: np.ndarray,
    model: AppearanceModel,
    config: ColorCheckerConfig,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, object]], int]:
    """Match patches in saturation/hue space and return unique dot locations."""

    level_count = len(relative_chroma_levels)
    hue_count = len(hue_angles)
    full_marker_table = np.zeros((level_count, hue_count), dtype=bool)
    cap_marker_table = np.zeros(hue_count, dtype=bool)
    if not config.enabled:
        return full_marker_table, cap_marker_table, [], 0

    full_candidate_count = len(valid_ring_indices)
    candidate_count = full_candidate_count + (
        hue_count if config.include_caps_in_matching else 0
    )
    if candidate_count <= 0:
        raise RuntimeError(
            "No drawable palette candidates exist for ColorChecker matching."
        )
    candidate_hue = np.asarray(
        palette_appearance["h"][:candidate_count], dtype=np.float64
    )
    candidate_saturation = np.asarray(
        palette_appearance["s"][:candidate_count], dtype=np.float64
    )
    candidate_chroma = np.asarray(palette_chroma[:candidate_count], dtype=np.float64)
    candidate_coordinates = saturation_hue_cartesian(
        candidate_saturation, candidate_hue
    )
    targets = get_colorchecker_targets(config, model)
    target_hue = np.asarray(targets.appearance["h"], dtype=np.float64)
    target_saturation = np.asarray(targets.appearance["s"], dtype=np.float64)
    target_coordinates = saturation_hue_cartesian(target_saturation, target_hue)
    assignments: list[dict[str, object]] = []
    for patch_index, patch_name in enumerate(targets.names):
        difference = candidate_coordinates - target_coordinates[patch_index]
        distance_squared = np.sum(difference * difference, axis=-1)
        best_index = int(np.argmin(distance_squared))
        distance = float(np.sqrt(distance_squared[best_index]))
        if best_index < full_candidate_count:
            candidate_type = "block"
            ring_index = int(valid_ring_indices[best_index])
            hue_index = int(valid_hue_indices[best_index])
            full_marker_table[ring_index, hue_index] = True
            level_number = ring_index + 1
            relative_chroma = float(relative_chroma_levels[ring_index])
        else:
            candidate_type = "cap"
            hue_index = best_index - full_candidate_count
            ring_index = None
            cap_marker_table[hue_index] = True
            level_number = None
            relative_chroma = float(candidate_chroma[best_index] / c3_raw)
        assignments.append(
            {
                "patch_index": patch_index,
                "patch_name": patch_name,
                "target_hue": float(target_hue[patch_index]),
                "target_saturation": float(target_saturation[patch_index]),
                "candidate_type": candidate_type,
                "ring_index": ring_index,
                "level_number": level_number,
                "hue_index": hue_index,
                "palette_sector_hue": float(hue_angles[hue_index]),
                "candidate_hue": float(candidate_hue[best_index]),
                "candidate_saturation": float(candidate_saturation[best_index]),
                "candidate_chroma": float(candidate_chroma[best_index]),
                "candidate_relative_chroma": relative_chroma,
                "distance": distance,
            }
        )
    unique_count = int(np.count_nonzero(full_marker_table)) + int(
        np.count_nonzero(cap_marker_table)
    )
    return full_marker_table, cap_marker_table, assignments, unique_count


COMPENSATED_COLORCHECKER_MATCHING_MODE = "post-view ACES JMh exposure"
COMPENSATED_COLORCHECKER_ASSIGNMENT_POLICY = (
    "independent per-patch minimum Euclidean normalized Cartesian ACES JMh "
    "distance; candidate locations may be reused"
)


def build_compensated_colorchecker_marker_assignments(
    stored_candidate_acescg: np.ndarray,
    palette_appearance: dict[str, np.ndarray],
    palette_chroma: np.ndarray,
    c3_raw: float,
    relative_chroma_levels: np.ndarray,
    valid_ring_indices: np.ndarray,
    valid_hue_indices: np.ndarray,
    hue_angles: np.ndarray,
    processor: Any,
    profile_name: str,
    config: ColorCheckerConfig,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, object]], int, dict[str, object]]:
    """Match compensated candidates after the ACES 2.0 forward view.

    ``stored_candidate_acescg`` must contain the logical palette candidates in
    renderer order: valid complete-ring cells followed by hue-order caps.
    Each candidate is multiplied by every configured exposure multiplier,
    transformed to display-reference XYZ by the selected ACES view, and
    compared with the fixed D65 CC18 XYZ targets in normalized ACES JMh
    Cartesian space.  Every CC18 patch is matched independently: a candidate
    is never consumed by an earlier patch, and one ring/cap location may
    therefore receive more than one marker.  The marker itself is attached
    to the winning logical location; the selected exposure is diagnostic
    metadata only.
    """

    level_count = len(relative_chroma_levels)
    hue_count = len(hue_angles)
    full_marker_table = np.zeros((level_count, hue_count), dtype=bool)
    cap_marker_table = np.zeros(hue_count, dtype=bool)
    exposure_stops = tuple(config.compensated_marker_exposure_stops)
    metadata: dict[str, object] = {
        "colorchecker_matching_mode": COMPENSATED_COLORCHECKER_MATCHING_MODE,
        "colorchecker_exposure_min_stops": float(exposure_stops[0])
        if exposure_stops
        else 0.0,
        "colorchecker_exposure_max_stops": float(exposure_stops[-1])
        if exposure_stops
        else 0.0,
        "colorchecker_exposure_step_stops": (
            float(exposure_stops[1] - exposure_stops[0])
            if len(exposure_stops) > 1
            else 0.0
        ),
        "colorchecker_exposure_stops": exposure_stops,
        "colorchecker_exposure_sample_count": len(exposure_stops),
        "colorchecker_candidate_count": 0,
        "colorchecker_evaluation_count": 0,
        "colorchecker_distance_metric": (
            "Euclidean normalized Cartesian ACES JMh: "
            "(J/100, M/100*cos(h), M/100*sin(h))"
        ),
        "colorchecker_assignment_policy": COMPENSATED_COLORCHECKER_ASSIGNMENT_POLICY,
    }
    if not config.enabled:
        return full_marker_table, cap_marker_table, [], 0, metadata
    if not exposure_stops:
        raise RuntimeError("Compensated ColorChecker exposure grid is empty.")

    valid_ring_indices = np.asarray(valid_ring_indices, dtype=np.int64)
    valid_hue_indices = np.asarray(valid_hue_indices, dtype=np.int64)
    if valid_ring_indices.shape != valid_hue_indices.shape:
        raise ValueError("Valid ring and hue index arrays must have equal shape.")
    full_candidate_count = len(valid_ring_indices)
    cap_candidate_count = hue_count if config.include_caps_in_matching else 0
    candidate_count = full_candidate_count + cap_candidate_count
    if candidate_count <= 0:
        raise RuntimeError(
            "No drawable palette candidates exist for compensated ColorChecker matching."
        )
    stored = np.asarray(stored_candidate_acescg, dtype=np.float32)
    if stored.ndim != 2 or stored.shape[-1] != 3 or stored.shape[0] < candidate_count:
        raise ValueError(
            "stored_candidate_acescg must have shape N x 3 with one row per candidate."
        )
    stored = stored[:candidate_count]
    if not np.all(np.isfinite(stored)):
        raise ValueError("Stored compensated candidate colors must be finite.")
    palette_chroma = np.asarray(palette_chroma, dtype=np.float64)
    if palette_chroma.ndim != 1 or palette_chroma.shape[0] < candidate_count:
        raise ValueError("palette_chroma does not contain all candidates.")
    palette_chroma = palette_chroma[:candidate_count]
    source_hue = np.asarray(palette_appearance.get("h", ()), dtype=np.float64)
    source_saturation = np.asarray(palette_appearance.get("s", ()), dtype=np.float64)
    if source_hue.ndim != 1 or source_hue.shape[0] < candidate_count:
        raise ValueError("palette_appearance['h'] does not contain all candidates.")
    if source_saturation.ndim != 1 or source_saturation.shape[0] < candidate_count:
        raise ValueError(
            "palette_appearance['s'] does not contain all candidates."
        )
    source_hue = source_hue[:candidate_count]
    source_saturation = source_saturation[:candidate_count]
    if not np.all(np.isfinite(source_hue)) or not np.all(
        np.isfinite(source_saturation)
    ):
        raise ValueError("Palette candidate appearance values must be finite.")

    targets = get_colorchecker_targets(config)
    params = params_for_profile(profile_name)
    multipliers = np.exp2(np.asarray(exposure_stops, dtype=np.float64))
    if not np.all(np.isfinite(multipliers)):
        raise ValueError("Compensated-marker exposure stops produce non-finite multipliers.")
    exposed = (
        stored[:, None, :]
        * multipliers[None, :, None].astype(np.float32)
    ).reshape(-1, 3)
    display_xyz = np.asarray(processor.target_forward_values(exposed))
    expected_shape = (candidate_count * len(exposure_stops), 3)
    if display_xyz.shape != expected_shape:
        raise RuntimeError(
            f"ACES output transform returned shape {display_xyz.shape}, "
            f"expected {expected_shape} for {profile_name}."
        )
    if not np.all(np.isfinite(display_xyz)):
        raise RuntimeError(
            f"ACES output transform produced non-finite values for {profile_name}."
        )
    display_xyz = display_xyz.reshape(candidate_count, len(exposure_stops), 3)
    candidate_jmh = params.xyz_to_jmh(display_xyz)
    target_jmh = params.xyz_to_jmh(targets.xyz_d65)
    candidate_coordinates = jmh_to_cartesian(candidate_jmh)
    target_coordinates = jmh_to_cartesian(target_jmh)
    difference = candidate_coordinates[None, ...] - target_coordinates[:, None, None, :]
    distances = np.sqrt(np.sum(difference * difference, axis=-1))
    if not np.all(np.isfinite(distances)):
        raise RuntimeError(
            f"ACES JMh matching produced non-finite distances for {profile_name}."
        )

    candidate_ring = np.concatenate(
        (
            valid_ring_indices,
            np.full(cap_candidate_count, -1, dtype=np.int64),
        )
    )
    candidate_hue_index = np.concatenate(
        (
            valid_hue_indices,
            np.arange(cap_candidate_count, dtype=np.int64),
        )
    )
    assignments: list[dict[str, object]] = []
    for patch_index, patch_name in enumerate(targets.names):
        patch_distances = distances[patch_index]
        # Solve each patch independently with the distance metric itself.
        # ``argmin``'s native row-major order is used only to make an exact
        # numerical tie deterministic; no candidate is removed or reserved
        # for another patch.
        best_flat_index = int(np.argmin(patch_distances))
        best_candidate, best_exposure = (
            int(index)
            for index in np.unravel_index(best_flat_index, patch_distances.shape)
        )
        best_distance = float(patch_distances[best_candidate, best_exposure])
        ring_index = int(candidate_ring[best_candidate])
        hue_index = int(candidate_hue_index[best_candidate])
        if ring_index >= 0:
            candidate_type = "block"
            full_marker_table[ring_index, hue_index] = True
            level_number: int | None = ring_index + 1
            relative_chroma = float(relative_chroma_levels[ring_index])
        else:
            candidate_type = "cap"
            cap_marker_table[hue_index] = True
            level_number = None
            if not np.isfinite(c3_raw) or c3_raw <= 0.0:
                raise ValueError("c3_raw must be finite and positive for cap matching.")
            relative_chroma = float(palette_chroma[best_candidate] / c3_raw)
        selected_jmh = candidate_jmh[best_candidate, best_exposure]
        target_values = target_jmh[patch_index]
        selected_xyz = display_xyz[best_candidate, best_exposure]
        target_xyz = targets.xyz_d65[patch_index]
        assignments.append(
            {
                "patch_index": patch_index,
                "patch_name": patch_name,
                "matching_mode": COMPENSATED_COLORCHECKER_MATCHING_MODE,
                "target_xyz_d65": tuple(float(value) for value in target_xyz),
                "target_J": float(target_values[0]),
                "target_M": float(target_values[1]),
                "target_hue": float(target_values[2]),
                "target_jmh": tuple(float(value) for value in target_values),
                "candidate_index": best_candidate,
                "candidate_type": candidate_type,
                "ring_index": ring_index if ring_index >= 0 else None,
                "level_number": level_number,
                "hue_index": hue_index,
                "palette_sector_hue": float(hue_angles[hue_index]),
                "candidate_xyz_d65": tuple(float(value) for value in selected_xyz),
                "candidate_J": float(selected_jmh[0]),
                "candidate_M": float(selected_jmh[1]),
                "candidate_hue": float(source_hue[best_candidate]),
                "candidate_post_view_hue": float(selected_jmh[2]),
                "candidate_jmh": tuple(float(value) for value in selected_jmh),
                "candidate_saturation": float(source_saturation[best_candidate]),
                "candidate_chroma": float(palette_chroma[best_candidate]),
                "candidate_relative_chroma": relative_chroma,
                "ev_stops": float(exposure_stops[best_exposure]),
                "exposure_multiplier": float(multipliers[best_exposure]),
                "distance": best_distance,
                "post_view_distance": best_distance,
            }
        )
    unique_count = int(np.count_nonzero(full_marker_table)) + int(
        np.count_nonzero(cap_marker_table)
    )
    metadata.update(
        {
            "colorchecker_candidate_count": candidate_count,
            "colorchecker_evaluation_count": len(targets.names)
            * candidate_count
            * len(exposure_stops),
            "colorchecker_unique_marker_count": unique_count,
        }
    )
    return full_marker_table, cap_marker_table, assignments, unique_count, metadata
