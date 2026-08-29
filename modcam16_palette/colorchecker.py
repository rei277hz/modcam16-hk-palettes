"""ColorChecker data conversion and palette-marker matching."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import colorimetry
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
    model: AppearanceModel,
) -> ColorCheckerTargets:
    """Convert the selected eighteen-patch source dataset to D65/CAM16."""

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
    appearance = model.xyz_d65_to_attributes(xyz_d65)
    if not np.all(np.isfinite(appearance["h"])):
        raise RuntimeError("ColorChecker conversion produced non-finite hues.")
    if not np.all(np.isfinite(appearance["s"])):
        raise RuntimeError("ColorChecker conversion produced non-finite saturations.")
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
