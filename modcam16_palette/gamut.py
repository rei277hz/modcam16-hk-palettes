"""Unbounded RGB-gamut-cone boundary and C3 calculations."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .cam16_hk import AppearanceModel
from .colorimetry import GamutMatrices, apply_matrix
from .config import PaletteConfig, SolverConfig


@dataclass(frozen=True)
class C3Result:
    value: float
    hue: float
    source: str
    refinement_candidate_count: int
    rgb: np.ndarray
    active_face: str


def is_inside_linear_rgb_gamut_cone(
    rgb: np.ndarray, epsilon: float = 0.0
) -> np.ndarray:
    rgb = np.asarray(rgb, dtype=np.float64)
    return np.all(np.isfinite(rgb), axis=-1) & np.all(rgb >= -epsilon, axis=-1)


def chroma_hue_to_gamut_rgb(
    chroma: np.ndarray,
    hue_degrees: np.ndarray,
    xyz_d65_to_gamut_rgb: np.ndarray,
    model: AppearanceModel,
) -> np.ndarray:
    xyz_d65 = model.chroma_hue_to_xyz_d65(chroma, hue_degrees)
    return apply_matrix(xyz_d65_to_gamut_rgb, xyz_d65)


def find_maximum_gamut_chroma_for_hues(
    hue_degrees: np.ndarray,
    xyz_d65_to_gamut_rgb: np.ndarray,
    model: AppearanceModel,
    solver: SolverConfig,
    gamut_name: str = "gamut",
) -> np.ndarray:
    """Find the first zero-channel cone boundary at each hue."""

    original_hues = np.asarray(hue_degrees, dtype=np.float64)
    original_shape = original_hues.shape
    hues = original_hues.reshape(-1)
    if hues.size == 0:
        raise ValueError("At least one hue is required.")

    neutral_rgb = chroma_hue_to_gamut_rgb(
        np.zeros_like(hues), hues, xyz_d65_to_gamut_rgb, model
    )
    if not np.all(
        is_inside_linear_rgb_gamut_cone(neutral_rgb, epsilon=solver.gamut_test_epsilon)
    ):
        raise RuntimeError(f"Neutral is outside the {gamut_name} gamut cone.")

    lower = np.zeros_like(hues)
    upper = np.full_like(hues, np.nan)
    still_inside = np.ones(hues.shape, dtype=bool)
    previous_chroma = 0.0
    for step_index in range(1, solver.boundary_coarse_steps + 1):
        candidate_chroma = (
            model.hk_chroma_domain_limit * step_index / solver.boundary_coarse_steps
        )
        candidate_rgb = chroma_hue_to_gamut_rgb(
            np.full_like(hues, candidate_chroma), hues, xyz_d65_to_gamut_rgb, model
        )
        candidate_inside = is_inside_linear_rgb_gamut_cone(candidate_rgb, epsilon=0.0)
        newly_outside = still_inside & ~candidate_inside
        lower[newly_outside] = previous_chroma
        upper[newly_outside] = candidate_chroma
        still_inside &= candidate_inside
        previous_chroma = candidate_chroma

    if np.any(still_inside):
        failed_hues = hues[still_inside][:8]
        raise RuntimeError(
            "No zero-channel gamut boundary found before the constant-J_HK model limit:\n"
            f"  Gamut: {gamut_name}\n  Example hues: {failed_hues}\n"
            f"  Model C limit: {model.hk_chroma_domain_limit:.12f}"
        )

    for _ in range(solver.boundary_binary_iterations):
        middle = 0.5 * (lower + upper)
        candidate_rgb = chroma_hue_to_gamut_rgb(
            middle, hues, xyz_d65_to_gamut_rgb, model
        )
        candidate_inside = is_inside_linear_rgb_gamut_cone(candidate_rgb, epsilon=0.0)
        lower = np.where(candidate_inside, middle, lower)
        upper = np.where(candidate_inside, upper, middle)

    boundary_rgb = chroma_hue_to_gamut_rgb(lower, hues, xyz_d65_to_gamut_rgb, model)
    if not np.all(
        is_inside_linear_rgb_gamut_cone(boundary_rgb, epsilon=solver.gamut_test_epsilon)
    ):
        raise RuntimeError(f"Internal {gamut_name} boundary search failed.")
    distance_to_zero_face = np.min(np.abs(boundary_rgb), axis=-1)
    if np.any(distance_to_zero_face > solver.boundary_face_tolerance):
        bad_index = int(
            np.flatnonzero(distance_to_zero_face > solver.boundary_face_tolerance)[0]
        )
        raise RuntimeError(
            "Boundary path did not converge to a zero-channel face:\n"
            f"  Gamut: {gamut_name}\n  Hue: {hues[bad_index]:.8f}°\n"
            f"  C: {lower[bad_index]:.12f}\n  RGB: {boundary_rgb[bad_index]}\n"
            f"  Face distance: {distance_to_zero_face[bad_index]:.12g}"
        )
    return lower.reshape(original_shape)


def scalar_boundary_chroma(
    hue_degrees: float,
    xyz_d65_to_gamut_rgb: np.ndarray,
    model: AppearanceModel,
    solver: SolverConfig,
    gamut_name: str,
) -> float:
    result = find_maximum_gamut_chroma_for_hues(
        np.array([hue_degrees % 360.0], dtype=np.float64),
        xyz_d65_to_gamut_rgb,
        model,
        solver,
        gamut_name,
    )
    return float(result[0])


def golden_section_maximize(
    function,
    lower: float,
    upper: float,
    solver: SolverConfig,
) -> tuple[float, float]:
    inverse_phi = (math.sqrt(5.0) - 1.0) / 2.0
    c = upper - inverse_phi * (upper - lower)
    d = lower + inverse_phi * (upper - lower)
    f_c = function(c)
    f_d = function(d)
    for _ in range(solver.c3_refinement_iterations):
        if upper - lower <= solver.c3_refinement_tolerance_degrees:
            break
        if f_c >= f_d:
            upper, d, f_d = d, c, f_c
            c = upper - inverse_phi * (upper - lower)
            f_c = function(c)
        else:
            lower, c, f_c = c, d, f_d
            d = lower + inverse_phi * (upper - lower)
            f_d = function(d)
    candidates = (lower, c, d, upper, 0.5 * (lower + upper))
    values = np.array(
        [function(candidate) for candidate in candidates], dtype=np.float64
    )
    best_index = int(np.argmax(values))
    return float(candidates[best_index]), float(values[best_index])


def refine_global_c3_maximum(
    sample_hues: np.ndarray,
    sampled_cmax: np.ndarray,
    xyz_d65_to_gamut_rgb: np.ndarray,
    model: AppearanceModel,
    solver: SolverConfig,
    gamut_name: str,
) -> tuple[float, float, int]:
    sample_hues = np.asarray(sample_hues, dtype=np.float64)
    sampled_cmax = np.asarray(sampled_cmax, dtype=np.float64)
    hue_step = 360.0 / len(sample_hues)
    previous_values = np.roll(sampled_cmax, 1)
    next_values = np.roll(sampled_cmax, -1)
    local_maximum_indices = np.flatnonzero(
        (sampled_cmax >= previous_values) & (sampled_cmax >= next_values)
    )
    sampled_best_index = int(np.argmax(sampled_cmax))
    if local_maximum_indices.size == 0:
        local_maximum_indices = np.array([sampled_best_index], dtype=np.int64)
    sorted_local_indices = local_maximum_indices[
        np.argsort(-sampled_cmax[local_maximum_indices])
    ]
    candidate_indices = sorted_local_indices[: solver.c3_max_refinement_candidates]
    if sampled_best_index not in candidate_indices:
        candidate_indices = np.concatenate(
            (np.array([sampled_best_index], dtype=np.int64), candidate_indices)
        )
    best_hue = float(sample_hues[sampled_best_index])
    best_c = float(sampled_cmax[sampled_best_index])

    def objective(hue: float) -> float:
        return scalar_boundary_chroma(
            hue, xyz_d65_to_gamut_rgb, model, solver, gamut_name
        )

    for candidate_index in candidate_indices:
        center_hue = float(sample_hues[candidate_index])
        refined_hue, refined_c = golden_section_maximize(
            objective, center_hue - hue_step, center_hue + hue_step, solver
        )
        if refined_c > best_c:
            best_c = refined_c
            best_hue = refined_hue % 360.0
    return best_c, best_hue, len(candidate_indices)


def determine_c3(
    rendered_hues: np.ndarray,
    rendered_cmax: np.ndarray,
    gamut: GamutMatrices,
    model: AppearanceModel,
    palette: PaletteConfig,
    solver: SolverConfig,
    gamut_name: str,
) -> C3Result:
    rendered_maximum_index = int(np.argmax(rendered_cmax))
    if palette.c3_reference_domain == "continuous":
        sample_hues = np.linspace(
            0.0, 360.0, solver.c3_hue_sample_count, endpoint=False, dtype=np.float64
        )
        sampled_cmax = find_maximum_gamut_chroma_for_hues(
            sample_hues, gamut.xyz_d65_to_gamut_rgb, model, solver, gamut_name
        )
        c3_raw, c3_hue, candidate_count = refine_global_c3_maximum(
            sample_hues,
            sampled_cmax,
            gamut.xyz_d65_to_gamut_rgb,
            model,
            solver,
            gamut_name,
        )
        source = "continuous refined hue"
        if rendered_cmax[rendered_maximum_index] > c3_raw:
            c3_raw = float(rendered_cmax[rendered_maximum_index])
            c3_hue = float(rendered_hues[rendered_maximum_index])
            source = "rendered-hue numerical override"
    else:
        c3_raw = float(rendered_cmax[rendered_maximum_index])
        c3_hue = float(rendered_hues[rendered_maximum_index])
        candidate_count = 0
        source = "rendered hue"

    if not np.isfinite(c3_raw) or c3_raw <= 0.0:
        raise RuntimeError(f"Invalid {gamut_name} C3: {c3_raw}")
    if c3_raw >= model.hk_chroma_domain_limit:
        raise RuntimeError(
            f"{gamut_name} C3 reached the H-K model limit:\n"
            f"  C3: {c3_raw:.12f}\n  Model limit: {model.hk_chroma_domain_limit:.12f}"
        )
    c3_rgb = chroma_hue_to_gamut_rgb(c3_raw, c3_hue, gamut.xyz_d65_to_gamut_rgb, model)
    if not is_inside_linear_rgb_gamut_cone(c3_rgb, epsilon=solver.gamut_test_epsilon):
        raise RuntimeError(f"{gamut_name} C3 lies outside its gamut cone: {c3_rgb}")
    face_distance = float(np.min(np.abs(c3_rgb)))
    if face_distance > solver.boundary_face_tolerance:
        raise RuntimeError(
            f"{gamut_name} C3 did not reach a zero-channel face:\n"
            f"  Hue: {c3_hue:.10f}°\n  C3: {c3_raw:.12f}\n"
            f"  RGB: {c3_rgb}\n  Face distance: {face_distance:.12g}"
        )
    labels = ("R=0", "G=0", "B=0")
    active_face = labels[int(np.argmin(np.abs(c3_rgb)))]
    return C3Result(
        c3_raw, c3_hue % 360.0, source, candidate_count, c3_rgb, active_face
    )
