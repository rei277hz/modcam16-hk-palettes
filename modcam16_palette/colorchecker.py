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


DIRECT_COLORCHECKER_MATCHING_MODE = "source CAM16 saturation/hue exposure"
DIRECT_COLORCHECKER_DISTANCE_METRIC = (
    "Euclidean source modCAM16 distance in (s*cos(h), s*sin(h)); "
    "brightness excluded"
)
COLORCHECKER_ASSIGNMENT_POLICY = (
    "independent per-patch minimum Euclidean source CAM16 saturation/hue "
    "distance over the exposure grid; candidate locations may be reused"
)


def _colorchecker_exposure_metadata(
    matching_mode: str,
    distance_metric: str,
    assignment_policy: str,
    exposure_stops: tuple[float, ...],
) -> dict[str, object]:
    """Build the common diagnostic fields for an exposure-sweep matcher."""

    return {
        "colorchecker_matching_mode": matching_mode,
        "colorchecker_exposure_min_stops": (
            float(exposure_stops[0]) if exposure_stops else 0.0
        ),
        "colorchecker_exposure_max_stops": (
            float(exposure_stops[-1]) if exposure_stops else 0.0
        ),
        "colorchecker_exposure_step_stops": (
            float(exposure_stops[1] - exposure_stops[0])
            if len(exposure_stops) > 1
            else 0.0
        ),
        "colorchecker_exposure_stops": exposure_stops,
        "colorchecker_exposure_sample_count": len(exposure_stops),
        "colorchecker_candidate_count": 0,
        "colorchecker_evaluation_count": 0,
        "colorchecker_distance_metric": distance_metric,
        "colorchecker_assignment_policy": assignment_policy,
    }


def _normalise_colorchecker_candidates(
    palette_appearance: dict[str, np.ndarray],
    palette_chroma: np.ndarray,
    valid_ring_indices: np.ndarray,
    valid_hue_indices: np.ndarray,
    hue_count: int,
    include_caps: bool,
) -> tuple[int, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Validate and normalize the logical candidate arrays shared by matchers."""

    valid_ring_indices = np.asarray(valid_ring_indices, dtype=np.int64)
    valid_hue_indices = np.asarray(valid_hue_indices, dtype=np.int64)
    if valid_ring_indices.shape != valid_hue_indices.shape:
        raise ValueError("Valid ring and hue index arrays must have equal shape.")
    full_candidate_count = len(valid_ring_indices)
    cap_candidate_count = hue_count if include_caps else 0
    candidate_count = full_candidate_count + cap_candidate_count
    if candidate_count <= 0:
        raise RuntimeError("No drawable palette candidates exist for ColorChecker matching.")

    candidate_hue = np.asarray(palette_appearance.get("h", ()), dtype=np.float64)
    candidate_saturation = np.asarray(
        palette_appearance.get("s", ()), dtype=np.float64
    )
    if candidate_hue.ndim != 1 or candidate_hue.shape[0] < candidate_count:
        raise ValueError("palette_appearance['h'] does not contain all candidates.")
    if (
        candidate_saturation.ndim != 1
        or candidate_saturation.shape[0] < candidate_count
    ):
        raise ValueError("palette_appearance['s'] does not contain all candidates.")
    candidate_hue = candidate_hue[:candidate_count]
    candidate_saturation = candidate_saturation[:candidate_count]
    if not np.all(np.isfinite(candidate_hue)) or not np.all(
        np.isfinite(candidate_saturation)
    ):
        raise ValueError("Palette candidate appearance values must be finite.")

    candidate_chroma = np.asarray(palette_chroma, dtype=np.float64)
    if candidate_chroma.ndim != 1 or candidate_chroma.shape[0] < candidate_count:
        raise ValueError("palette_chroma does not contain all candidates.")
    candidate_chroma = candidate_chroma[:candidate_count]
    if not np.all(np.isfinite(candidate_chroma)):
        raise ValueError("Palette candidate chroma values must be finite.")
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
    return (
        candidate_count,
        candidate_hue,
        candidate_saturation,
        candidate_chroma,
        candidate_ring,
        candidate_hue_index,
    )


def build_direct_colorchecker_marker_assignments(
    palette_appearance: dict[str, np.ndarray],
    palette_chroma: np.ndarray,
    c3_raw: float,
    relative_chroma_levels: np.ndarray,
    valid_ring_indices: np.ndarray,
    valid_hue_indices: np.ndarray,
    hue_angles: np.ndarray,
    model: AppearanceModel,
    config: ColorCheckerConfig,
    *,
    candidate_xyz_d65: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, object]], int, dict[str, object]]:
    """Match direct-palette ColorChecker dots with a modCAM16 exposure sweep.

    Direct palettes never enter an ACES view transform.  Candidate XYZ-D65
    values are multiplied by each configured exposure multiplier and evaluated
    with the same revised CAM16-HK model that built the palette.  Matching is
    performed in source CAM16 saturation/hue Cartesian coordinates, preserving
    the historical direct-palette metric while making exposure handling
    consistent with compensated markers.

    ``candidate_xyz_d65`` is optional for callers using the historical API. If
    omitted, the candidate XYZ values are reconstructed from the supplied
    CAM16-HK appearance arrays when possible.
    """

    level_count = len(relative_chroma_levels)
    hue_count = len(hue_angles)
    full_marker_table = np.zeros((level_count, hue_count), dtype=bool)
    cap_marker_table = np.zeros(hue_count, dtype=bool)
    exposure_stops = tuple(config.marker_exposure_stops)
    metadata = _colorchecker_exposure_metadata(
        DIRECT_COLORCHECKER_MATCHING_MODE,
        DIRECT_COLORCHECKER_DISTANCE_METRIC,
        COLORCHECKER_ASSIGNMENT_POLICY,
        exposure_stops,
    )
    if not config.enabled:
        return full_marker_table, cap_marker_table, [], 0, metadata
    if not exposure_stops:
        raise RuntimeError("ColorChecker exposure grid is empty.")

    (
        candidate_count,
        candidate_hue,
        candidate_saturation,
        candidate_chroma,
        candidate_ring,
        candidate_hue_index,
    ) = _normalise_colorchecker_candidates(
        palette_appearance,
        palette_chroma,
        valid_ring_indices,
        valid_hue_indices,
        hue_count,
        config.include_caps_in_matching,
    )

    if candidate_xyz_d65 is not None:
        candidate_xyz = np.asarray(candidate_xyz_d65, dtype=np.float64)
        if candidate_xyz.ndim != 2 or candidate_xyz.shape[-1] != 3:
            raise ValueError("candidate_xyz_d65 must have shape N x 3.")
        if candidate_xyz.shape[0] < candidate_count:
            raise ValueError("candidate_xyz_d65 does not contain all candidates.")
        candidate_xyz = candidate_xyz[:candidate_count]
        if not np.all(np.isfinite(candidate_xyz)):
            raise ValueError("Candidate XYZ-D65 values must be finite.")
    else:
        # Reconstruct direct candidate XYZ values for legacy callers.  The
        # palette builder supplies explicit XYZ values, but the original public
        # function accepted only appearance/chroma arrays.  Those candidates
        # are samples on the model's constant-J_HK locus, so the model neutral
        # target is the correct reconstruction when J_HK was not supplied.
        candidate_cam_chroma = np.asarray(
            palette_appearance.get("C", candidate_chroma), dtype=np.float64
        )
        if (
            candidate_cam_chroma.ndim != 1
            or candidate_cam_chroma.shape[0] < candidate_count
        ):
            raise ValueError("palette_appearance['C'] does not contain all candidates.")
        candidate_cam_chroma = candidate_cam_chroma[:candidate_count]
        if not np.all(np.isfinite(candidate_cam_chroma)):
            raise ValueError("Palette candidate CAM16 chroma values must be finite.")

        candidate_j_hk = palette_appearance.get("J_HK")
        if candidate_j_hk is None:
            candidate_j = palette_appearance.get("J")
            if candidate_j is not None:
                candidate_j = np.asarray(candidate_j, dtype=np.float64)
                if candidate_j.ndim != 1 or candidate_j.shape[0] < candidate_count:
                    raise ValueError("palette_appearance['J'] does not contain all candidates.")
                candidate_j = candidate_j[:candidate_count]
                candidate_j_hk = np.sqrt(
                    np.maximum(
                        candidate_j * candidate_j
                        + model.config.hk_chroma_coefficient * candidate_cam_chroma,
                        0.0,
                    )
                )
        if candidate_j_hk is None:
            candidate_j_hk = np.full(candidate_count, model.target_j_hk, dtype=np.float64)
        else:
            candidate_j_hk = np.asarray(candidate_j_hk, dtype=np.float64)
            if candidate_j_hk.ndim == 0:
                candidate_j_hk = np.full(
                    candidate_count, float(candidate_j_hk), dtype=np.float64
                )
            elif candidate_j_hk.ndim != 1 or candidate_j_hk.shape[0] < candidate_count:
                raise ValueError("palette_appearance['J_HK'] does not contain all candidates.")
            else:
                candidate_j_hk = candidate_j_hk[:candidate_count]
        if not np.all(np.isfinite(candidate_j_hk)):
            raise ValueError("Palette candidate J_HK values must be finite.")
        if np.all(candidate_j_hk == candidate_j_hk[0]):
            candidate_xyz = model.modcam16_hk_to_xyz_d65(
                float(candidate_j_hk[0]), candidate_cam_chroma, candidate_hue
            )
        else:
            # The model inverse historically takes one scalar J_HK because
            # palette construction uses a constant perceived-brightness locus.
            # Preserve support for legacy callers that provide varying values.
            candidate_xyz = np.stack(
                tuple(
                    model.modcam16_hk_to_xyz_d65(float(j_hk), chroma, hue)
                    for j_hk, chroma, hue in zip(
                        candidate_j_hk, candidate_cam_chroma, candidate_hue,
                        strict=True,
                    )
                ),
                axis=0,
            )
        if not np.all(np.isfinite(candidate_xyz)):
            raise ValueError("Reconstructed candidate XYZ-D65 values must be finite.")

    targets = get_colorchecker_targets(config, model)
    target_hue = np.asarray(targets.appearance["h"], dtype=np.float64)
    target_saturation = np.asarray(targets.appearance["s"], dtype=np.float64)
    target_coordinates = saturation_hue_cartesian(target_saturation, target_hue)
    multipliers = np.exp2(np.asarray(exposure_stops, dtype=np.float64))
    if not np.all(np.isfinite(multipliers)):
        raise ValueError("ColorChecker exposure stops produce non-finite multipliers.")

    if candidate_xyz is None:
        candidate_hue_sweep = np.broadcast_to(
            candidate_hue[:, None], (candidate_count, len(exposure_stops))
        )
        candidate_saturation_sweep = np.broadcast_to(
            candidate_saturation[:, None], (candidate_count, len(exposure_stops))
        )
    else:
        exposed_xyz = candidate_xyz[:, None, :] * multipliers[None, :, None]
        exposed_appearance = model.xyz_d65_to_attributes(
            exposed_xyz.reshape(-1, 3)
        )
        candidate_hue_sweep = np.asarray(
            exposed_appearance["h"], dtype=np.float64
        ).reshape(candidate_count, len(exposure_stops))
        candidate_saturation_sweep = np.asarray(
            exposed_appearance["s"], dtype=np.float64
        ).reshape(candidate_count, len(exposure_stops))
        if not np.all(np.isfinite(candidate_hue_sweep)) or not np.all(
            np.isfinite(candidate_saturation_sweep)
        ):
            raise RuntimeError("CAM16 exposure sweep produced non-finite attributes.")

    candidate_coordinates = saturation_hue_cartesian(
        candidate_saturation_sweep, candidate_hue_sweep
    )
    difference = candidate_coordinates[None, ...] - target_coordinates[:, None, None, :]
    distances = np.sqrt(np.sum(difference * difference, axis=-1))
    if not np.all(np.isfinite(distances)):
        raise RuntimeError("CAM16 ColorChecker matching produced non-finite distances.")

    assignments: list[dict[str, object]] = []
    for patch_index, patch_name in enumerate(targets.names):
        patch_distances = distances[patch_index]
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
            relative_chroma = float(candidate_chroma[best_candidate] / c3_raw)
        selected_hue = float(candidate_hue_sweep[best_candidate, best_exposure])
        selected_saturation = float(
            candidate_saturation_sweep[best_candidate, best_exposure]
        )
        assignment: dict[str, object] = {
            "patch_index": patch_index,
            "patch_name": patch_name,
            "matching_mode": DIRECT_COLORCHECKER_MATCHING_MODE,
            "target_hue": float(target_hue[patch_index]),
            "target_saturation": float(target_saturation[patch_index]),
            "candidate_index": best_candidate,
            "candidate_type": candidate_type,
            "ring_index": ring_index if ring_index >= 0 else None,
            "level_number": level_number,
            "hue_index": hue_index,
            "palette_sector_hue": float(hue_angles[hue_index]),
            # Preserve the historical direct-assignment fields as the
            # unexposed palette appearance.  The winning sweep sample is
            # available explicitly for diagnostics.
            "candidate_hue": float(candidate_hue[best_candidate]),
            "candidate_saturation": float(candidate_saturation[best_candidate]),
            "candidate_exposure_hue": selected_hue,
            "candidate_exposure_saturation": selected_saturation,
            "candidate_source_hue": float(candidate_hue[best_candidate]),
            "candidate_source_saturation": float(
                candidate_saturation[best_candidate]
            ),
            "candidate_chroma": float(candidate_chroma[best_candidate]),
            "candidate_relative_chroma": relative_chroma,
            "ev_stops": float(exposure_stops[best_exposure]),
            "exposure_multiplier": float(multipliers[best_exposure]),
            "distance": best_distance,
        }
        if candidate_xyz is not None:
            selected_xyz = candidate_xyz[best_candidate] * multipliers[best_exposure]
            assignment["candidate_xyz_d65"] = tuple(
                float(value) for value in selected_xyz
            )
            assignment["candidate_base_xyz_d65"] = tuple(
                float(value) for value in candidate_xyz[best_candidate]
            )
        assignments.append(assignment)

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
    *,
    candidate_xyz_d65: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, object]], int]:
    """Backward-compatible four-value wrapper for direct matching.

    New callers that need exposure-grid metadata can use
    :func:`build_direct_colorchecker_marker_assignments` directly.  Keeping
    this wrapper preserves the original public return shape.
    """

    result = build_direct_colorchecker_marker_assignments(
        palette_appearance,
        palette_chroma,
        c3_raw,
        relative_chroma_levels,
        valid_ring_indices,
        valid_hue_indices,
        hue_angles,
        model,
        config,
        candidate_xyz_d65=candidate_xyz_d65,
    )
    return result[:4]


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
