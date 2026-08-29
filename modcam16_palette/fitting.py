"""Exposure-robust ACES 2.0 compensation-anchor fitting.

The inverse-view palette has one free scalar: the neutral value ``A`` in the
ACES display-reference space before the final foreground normalization.  The
legacy implementation fixed that value at ``0.18``.  This module chooses it
by measuring the actual ACES 2.0 output-transform ``J`` response over a small
exposure range while keeping the project's palette construction unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from itertools import pairwise

import numpy as np

from .aces_jmh import params_for_profile
from .cam16_hk import AppearanceModel
from .colorimetry import GAMUT_MATRICES, GamutMatrices
from .config import (
    COMPENSATION_PROFILE_DEFINITIONS,
    CompensationProfileConfig,
    Config,
    _normalize_compensation_profile_name,
)
from .ocio_compensation import (
    CompensationProcessor,
    solve_neutral_y,
)
from .palette import PaletteResult, build_palette


@dataclass(frozen=True)
class CompensationFitDiagnostics:
    """Objective and search information for one fitted profile."""

    profile_name: str
    fit_mode: str
    fitted_anchor: float
    fitted_anchor_log2: float
    solved_source_y: float
    exposure_stops: tuple[float, ...]
    objective_name: str
    evaluated_color_count: int
    evaluated_sample_count: int
    rms_error: float
    maximum_error: float
    per_stop_rms: tuple[float, ...]
    search_evaluation_count: int
    legacy_anchor: float
    legacy_rms_error: float

    def as_statistics(self) -> dict[str, object]:
        return {
            "compensation_fit_mode": self.fit_mode,
            "compensation_fitted_anchor": self.fitted_anchor,
            "compensation_fitted_anchor_log2": self.fitted_anchor_log2,
            "compensation_fit_exposure_min_stops": self.exposure_stops[0],
            "compensation_fit_exposure_max_stops": self.exposure_stops[-1],
            "compensation_fit_exposure_step_stops": (
                self.exposure_stops[1] - self.exposure_stops[0]
                if len(self.exposure_stops) > 1
                else 0.0
            ),
            "compensation_fit_exposure_stops": self.exposure_stops,
            "compensation_fit_objective": self.objective_name,
            "compensation_fit_evaluated_color_count": self.evaluated_color_count,
            "compensation_fit_evaluated_sample_count": self.evaluated_sample_count,
            "compensation_fit_rms_error": self.rms_error,
            "compensation_fit_maximum_error": self.maximum_error,
            "compensation_fit_per_stop_rms": self.per_stop_rms,
            "compensation_fit_search_evaluation_count": self.search_evaluation_count,
            "compensation_fit_legacy_anchor": self.legacy_anchor,
            "compensation_fit_legacy_rms_error": self.legacy_rms_error,
        }


@dataclass(frozen=True)
class CompensationFitResult:
    """Winning source palette and diagnostics returned by :func:`fit_profile`."""

    profile: CompensationProfileConfig
    gamut: GamutMatrices
    source_config: Config
    source_model: AppearanceModel
    palette: PaletteResult
    source_y: float
    intermediate_anchor: float
    intermediate_center: np.ndarray
    diagnostics: CompensationFitDiagnostics

    @property
    def anchor(self) -> float:
        """Short alias for the fitted intermediate anchor."""

        return self.intermediate_anchor


def unique_palette_colors(result: PaletteResult) -> np.ndarray:
    """Return each valid complete-ring color and cap exactly once.

    ``color_table`` contains zero placeholders for invalid ring/hue pairs, so
    indexing with ``block_valid_table`` is essential.  A stable exact-row
    deduplication keeps the objective independent of raster pixel coverage.
    """

    color_table = np.asarray(result.color_table)
    valid_table = np.asarray(result.block_valid_table, dtype=bool)
    cap_table = np.asarray(result.cap_color_table)
    if color_table.ndim != 3 or color_table.shape[-1] != 3:
        raise ValueError("Palette color_table must have shape N x H x 3.")
    if valid_table.shape != color_table.shape[:2]:
        raise ValueError("Palette block_valid_table shape does not match color_table.")
    if cap_table.ndim != 2 or cap_table.shape[-1] != 3:
        raise ValueError("Palette cap_color_table must have shape H x 3.")
    full = color_table[valid_table]
    colors = np.concatenate((full, cap_table), axis=0)
    if colors.size == 0:
        return np.empty((0, 3), dtype=np.float32)
    if not np.all(np.isfinite(colors)):
        raise ValueError("Palette colors must be finite.")
    _unique, first_indices = np.unique(colors, axis=0, return_index=True)
    return colors[np.sort(first_indices)].astype(np.float32, copy=False)


def _profile_and_gamut(
    profile: CompensationProfileConfig | str,
    gamut: GamutMatrices | None,
) -> tuple[CompensationProfileConfig, GamutMatrices]:
    if isinstance(profile, str):
        try:
            profile = COMPENSATION_PROFILE_DEFINITIONS[
                _normalize_compensation_profile_name(profile)
            ]
        except (KeyError, ValueError) as exc:
            raise ValueError(f"Unknown compensation profile: {profile}") from exc
    if not isinstance(profile, CompensationProfileConfig):
        raise TypeError("profile must be a compensation profile or profile name.")
    if gamut is None:
        gamut = GAMUT_MATRICES[profile.source_gamut]
    if gamut.name != profile.source_gamut:
        raise ValueError(
            f"Compensation profile {profile.name} targets {profile.source_gamut}, "
            f"not {gamut.name}."
        )
    return profile, gamut


def _source_config_for_anchor(
    config: Config,
    gamut: GamutMatrices,
    source_y: float,
    compensated_k: float,
    intermediate_anchor: float,
) -> Config:
    if gamut.name == "sRGB-D65":
        palette = replace(config.palette, srgb_chroma_companding_k=compensated_k)
    elif gamut.name == "P3-D65":
        palette = replace(config.palette, p3_chroma_companding_k=compensated_k)
    else:  # pragma: no cover - profile validation makes this unreachable
        raise ValueError(f"No compensated palette field exists for {gamut.name}.")
    return replace(
        config,
        palette=palette,
        appearance=replace(config.appearance, reference_neutral_y=float(source_y)),
        compensation=replace(
            config.compensation,
            target_intermediate_center=float(intermediate_anchor),
        ),
    )


def _scaled_inverse_colors(
    colors: np.ndarray,
    processor: CompensationProcessor,
    anchor: float,
) -> np.ndarray:
    values = np.asarray(colors, dtype=np.float32)
    if values.ndim != 2 or values.shape[-1] != 3:
        raise ValueError("colors must have shape N x 3.")
    if not np.isfinite(anchor) or anchor <= 0.0:
        raise ValueError("Compensation anchor must be finite and positive.")
    if values.size == 0:
        return np.empty((0, 3), dtype=np.float32)
    comparison = processor.source_comparison(values)
    inverse = processor.target_inverse_values(comparison)
    inverse = np.asarray(inverse, dtype=np.float32)
    if inverse.shape != values.shape:
        raise RuntimeError(
            f"OCIO inverse compensation returned shape {inverse.shape}, "
            f"expected {values.shape} for {processor.profile.name}."
        )
    if not np.all(np.isfinite(inverse)):
        raise RuntimeError(
            f"OCIO inverse compensation produced non-finite values for {processor.profile.name}."
        )
    # A tiny negative can arise from OCIO float round-off at a gamut boundary;
    # values materially below zero make the exposure objective undefined.
    if inverse.size and np.min(inverse) < -1.0e-6:
        raise RuntimeError(
            f"OCIO inverse compensation produced negative values for {processor.profile.name}."
        )
    return np.maximum(inverse, 0.0) / np.float32(anchor)


def evaluate_anchor_objective(
    scaled_colors: np.ndarray,
    processor: CompensationProcessor,
    profile_name: str,
    exposure_stops: tuple[float, ...] | list[float] | np.ndarray,
) -> tuple[float, float, tuple[float, ...]]:
    """Evaluate RMS/max center-relative ACES output-J error for one anchor."""

    params = params_for_profile(profile_name)
    colors = np.asarray(scaled_colors, dtype=np.float32)
    if colors.ndim != 2 or colors.shape[-1] != 3:
        raise ValueError("scaled_colors must have shape N x 3.")
    if not np.all(np.isfinite(colors)):
        raise ValueError("scaled_colors must be finite.")
    try:
        stops = tuple(float(value) for value in exposure_stops)
    except (TypeError, ValueError) as exc:
        raise ValueError("exposure_stops must contain finite numbers.") from exc
    if not stops:
        return 0.0, 0.0, ()
    if not np.all(np.isfinite(stops)):
        raise ValueError("exposure_stops must contain finite numbers.")
    if any(later <= earlier for earlier, later in pairwise(stops)):
        raise ValueError("exposure_stops must be strictly increasing.")
    if colors.shape[0] == 0:
        return 0.0, 0.0, tuple(0.0 for _ in stops)

    multipliers = np.exp2(np.asarray(stops, dtype=np.float64))
    if not np.all(np.isfinite(multipliers)):
        raise ValueError("exposure_stops produce non-finite exposure multipliers.")
    # Evaluate the full unique-color set in two batched OCIO calls.  The
    # transform is still applied independently at every exposure sample, but
    # no color is accidentally weighted by raster pixel coverage.
    color_values = (
        colors[None, :, :] * multipliers[:, None, None].astype(np.float32)
    ).reshape(-1, 3)
    center_values = np.broadcast_to(
        multipliers[:, None].astype(np.float32), (len(stops), 3)
    ).copy()
    color_xyz = np.asarray(processor.target_forward_values(color_values))
    center_xyz = np.asarray(processor.target_forward_values(center_values))
    expected_color_shape = (len(stops) * colors.shape[0], 3)
    if color_xyz.shape != expected_color_shape:
        raise RuntimeError(
            f"ACES output transform returned shape {color_xyz.shape}, "
            f"expected {expected_color_shape} for {profile_name}."
        )
    if center_xyz.shape != center_values.shape:
        raise RuntimeError(
            f"ACES center transform returned shape {center_xyz.shape}, "
            f"expected {center_values.shape} for {profile_name}."
        )
    if not np.all(np.isfinite(color_xyz)) or not np.all(np.isfinite(center_xyz)):
        raise RuntimeError(
            f"ACES output transform produced non-finite values for {profile_name}."
        )
    color_j = params.xyz_to_j(color_xyz).reshape(len(stops), colors.shape[0])
    center_j = params.xyz_to_j(center_xyz)
    error = np.asarray(color_j - center_j[:, None], dtype=np.float64)
    if not np.all(np.isfinite(error)):
        raise RuntimeError(
            f"ACES output-J evaluation produced non-finite values for {profile_name}."
        )
    per_stop = np.sqrt(np.mean(error * error, axis=1))
    joined = error.reshape(-1)
    return (
        float(np.sqrt(np.mean(joined * joined))),
        float(np.max(np.abs(joined))) if joined.size else 0.0,
        tuple(float(value) for value in per_stop),
    )


@dataclass
class _Candidate:
    anchor_log2: float
    anchor: float
    source_y: float
    source_config: Config
    source_model: AppearanceModel
    palette: PaletteResult
    intermediate_center: np.ndarray
    scaled_colors: np.ndarray
    color_count: int
    rms_error: float
    maximum_error: float
    per_stop_rms: tuple[float, ...]


def _candidate_factory(
    config: Config,
    gamut: GamutMatrices,
    profile: CompensationProfileConfig,
    processor: CompensationProcessor,
    anchor_log2: float,
) -> _Candidate:
    anchor = float(np.exp2(anchor_log2))
    if not np.isfinite(anchor) or anchor <= 0.0:
        raise RuntimeError("Anchor search generated a non-positive value.")
    anchor_config = replace(
        config.compensation,
        target_intermediate_center=anchor,
    )
    source_y, intermediate = solve_neutral_y(processor, anchor_config)
    compensated_k = config.compensation.companding_by_source_gamut[gamut.name]
    source_config = _source_config_for_anchor(
        config, gamut, source_y, compensated_k, anchor
    )
    source_model = AppearanceModel.from_config(source_config.appearance)
    palette = build_palette(gamut, source_config, source_model)
    colors = unique_palette_colors(palette)
    scaled = _scaled_inverse_colors(colors, processor, anchor)
    rms, maximum, per_stop = evaluate_anchor_objective(
        scaled,
        processor,
        profile.name,
        tuple(config.compensation.exposure_stops),
    )
    return _Candidate(
        anchor_log2=float(anchor_log2),
        anchor=anchor,
        source_y=float(source_y),
        source_config=source_config,
        source_model=source_model,
        palette=palette,
        intermediate_center=np.asarray(intermediate, dtype=np.float64),
        scaled_colors=scaled,
        color_count=len(colors),
        rms_error=rms,
        maximum_error=maximum,
        per_stop_rms=per_stop,
    )


def _manual_candidate(
    config: Config,
    gamut: GamutMatrices,
    profile: CompensationProfileConfig,
    processor: CompensationProcessor,
) -> _Candidate:
    anchor = float(config.compensation.target_intermediate_center)
    return _candidate_factory(config, gamut, profile, processor, float(np.log2(anchor)))


def _fit_candidate(
    config: Config,
    gamut: GamutMatrices,
    profile: CompensationProfileConfig,
    processor: CompensationProcessor,
) -> tuple[_Candidate, _Candidate, int]:
    """Search log2(anchor), returning the winning and legacy candidates.

    The objective is smooth for the ACES profiles, so a bounded directional
    bracket followed by golden-section refinement gives a good fit without
    rebuilding the palette on a dense fixed grid.  Both immediate directions
    are evaluated before selecting a downhill direction; invalid candidates
    terminate that direction and never discard the best valid sample.
    """

    compensation = config.compensation
    seed = float(np.log2(compensation.target_intermediate_center))
    lower = seed - float(compensation.anchor_search_max_stops)
    upper = seed + float(compensation.anchor_search_max_stops)
    step = float(compensation.anchor_search_initial_step_stops)
    tolerance = float(compensation.anchor_search_tolerance)
    if not np.isfinite(seed):
        raise ValueError("target_intermediate_center must be finite and positive.")
    if not np.isfinite(lower) or not np.isfinite(upper) or lower >= upper:
        raise ValueError("Anchor search bounds are invalid.")
    if not np.isfinite(step) or step <= 0.0:
        raise ValueError("anchor_search_initial_step_stops must be positive.")
    if not np.isfinite(tolerance) or tolerance <= 0.0:
        raise ValueError("anchor_search_tolerance must be positive.")
    if (
        not isinstance(compensation.anchor_search_max_iterations, int)
        or compensation.anchor_search_max_iterations <= 0
    ):
        raise ValueError("anchor_search_max_iterations must be positive.")
    cache: dict[float, _Candidate | None] = {}

    def evaluate(x: float) -> _Candidate | None:
        x = float(np.clip(x, lower, upper))
        key = float(np.round(x, 12))
        if key in cache:
            return cache[key]
        try:
            candidate = _candidate_factory(config, gamut, profile, processor, key)
        except (
            RuntimeError,
            ValueError,
            FloatingPointError,
            OverflowError,
            np.linalg.LinAlgError,
        ):
            candidate = None
        cache[key] = candidate
        return candidate

    def score(candidate: _Candidate | None) -> float:
        return np.inf if candidate is None else float(candidate.rms_error)

    def walk(
        direction: float,
        first_candidate: _Candidate | None,
    ) -> tuple[_Candidate | None, tuple[float, float] | None]:
        """Walk downhill and return the best sample plus a local bracket."""

        if first_candidate is None or score(first_candidate) >= score(legacy):
            return first_candidate, None
        previous = legacy
        current = first_candidate
        max_steps = min(
            128,
            max(1, int(np.ceil((upper - lower) / step))),
        )
        for _ in range(max_steps):
            next_x = float(
                np.clip(current.anchor_log2 + direction * step, lower, upper)
            )
            if next_x == current.anchor_log2:
                # The search interval itself is the bracket when the minimum
                # is reached at a configured bound.
                return current, tuple(
                    sorted((previous.anchor_log2, current.anchor_log2))
                )
            next_candidate = evaluate(next_x)
            if next_candidate is None:
                # The last two valid points bound the usable region.  Keep the
                # invalid endpoint out of the objective, but retain the
                # bounded interval for deterministic refinement.
                return current, tuple(
                    sorted((previous.anchor_log2, current.anchor_log2))
                )
            if score(next_candidate) >= score(current):
                return current, tuple(
                    sorted((previous.anchor_log2, next_candidate.anchor_log2))
                )
            previous, current = current, next_candidate
        return current, tuple(sorted((previous.anchor_log2, current.anchor_log2)))

    def refine(interval: tuple[float, float] | None) -> None:
        if interval is None:
            return
        a, b = interval
        if not np.isfinite(a) or not np.isfinite(b) or b <= a:
            return
        if b - a <= tolerance:
            return
        # Golden-section refinement is local to a valid bracket.  Failed
        # candidates are represented by +inf and remain cached.
        phi = (np.sqrt(5.0) - 1.0) * 0.5
        c_x = b - phi * (b - a)
        d_x = a + phi * (b - a)
        c_candidate = evaluate(c_x)
        d_candidate = evaluate(d_x)
        for _ in range(compensation.anchor_search_max_iterations):
            if b - a <= tolerance:
                break
            if score(c_candidate) <= score(d_candidate):
                b, d_x, d_candidate = d_x, c_x, c_candidate
                c_x = b - phi * (b - a)
                c_candidate = evaluate(c_x)
            else:
                a, c_x, c_candidate = c_x, d_x, d_candidate
                d_x = a + phi * (b - a)
                d_candidate = evaluate(d_x)

    legacy = evaluate(seed)
    if legacy is None:
        raise RuntimeError(f"Legacy anchor could not be evaluated for {profile.name}.")
    left_x = float(np.clip(seed - step, lower, upper))
    right_x = float(np.clip(seed + step, lower, upper))
    left = evaluate(left_x) if left_x != seed else legacy
    right = evaluate(right_x) if right_x != seed else legacy

    left_best, left_bracket = walk(-1.0, left)
    right_best, right_bracket = walk(1.0, right)
    if left_bracket is None and right_bracket is None:
        # Neither adjacent sample improves on the seed.  Refine the interval
        # spanning both neighbors so a minimum between the half-open samples
        # is still discoverable.
        finite_neighbors = [
            candidate for candidate in (left, right) if candidate is not None
        ]
        if len(finite_neighbors) == 2:
            refine(
                tuple(
                    sorted(
                        (
                            finite_neighbors[0].anchor_log2,
                            finite_neighbors[1].anchor_log2,
                        )
                    )
                )
            )
    elif score(left_best) < score(right_best):
        refine(left_bracket)
    elif score(right_best) < score(left_best):
        refine(right_bracket)
    else:
        # A tie between directional walks is bracketed by the nearest valid
        # samples on either side when possible.
        finite_neighbors = [
            candidate for candidate in (left, right) if candidate is not None
        ]
        if len(finite_neighbors) == 2:
            refine(
                tuple(
                    sorted(
                        (
                            finite_neighbors[0].anchor_log2,
                            finite_neighbors[1].anchor_log2,
                        )
                    )
                )
            )
    all_finite = [candidate for candidate in cache.values() if candidate is not None]
    if not all_finite:
        raise RuntimeError(
            f"No finite ACES-J anchor objective could be evaluated for {profile.name}."
        )
    best = min(
        all_finite, key=lambda candidate: (candidate.rms_error, candidate.anchor_log2)
    )
    return best, legacy, len(cache)


def fit_profile(
    config: Config,
    profile: CompensationProfileConfig | str,
    processor: CompensationProcessor | None = None,
    gamut: GamutMatrices | None = None,
) -> CompensationFitResult:
    """Fit (or manually select) one compensation profile's anchor."""

    config.validate()
    profile, gamut = _profile_and_gamut(profile, gamut)
    if processor is None:
        from .ocio_compensation import load_compensation_processor

        processor = load_compensation_processor(config.compensation, profile.name)
    processor_profile = getattr(processor, "profile", None)
    processor_profile_name = getattr(processor_profile, "name", None)
    if processor_profile_name is not None and processor_profile_name != profile.name:
        raise ValueError(
            f"Processor profile {processor_profile_name} does not match {profile.name}."
        )
    if config.compensation.automatic_fit:
        winning, legacy, evaluations = _fit_candidate(config, gamut, profile, processor)
        fit_mode = "auto"
    else:
        winning = _manual_candidate(config, gamut, profile, processor)
        legacy = winning
        evaluations = 1
        fit_mode = "manual"
    diagnostics = CompensationFitDiagnostics(
        profile_name=profile.name,
        fit_mode=fit_mode,
        fitted_anchor=winning.anchor,
        fitted_anchor_log2=winning.anchor_log2,
        solved_source_y=winning.source_y,
        exposure_stops=tuple(config.compensation.exposure_stops),
        objective_name="RMS center-relative ACES 2.0 output J",
        evaluated_color_count=winning.color_count,
        evaluated_sample_count=winning.color_count
        * len(config.compensation.exposure_stops),
        rms_error=winning.rms_error,
        maximum_error=winning.maximum_error,
        per_stop_rms=winning.per_stop_rms,
        search_evaluation_count=evaluations,
        legacy_anchor=float(config.compensation.target_intermediate_center),
        legacy_rms_error=legacy.rms_error,
    )
    return CompensationFitResult(
        profile=profile,
        gamut=gamut,
        source_config=winning.source_config,
        source_model=winning.source_model,
        palette=winning.palette,
        source_y=winning.source_y,
        intermediate_anchor=winning.anchor,
        intermediate_center=winning.intermediate_center,
        diagnostics=diagnostics,
    )


# Friendly aliases for callers using the terminology from the design notes.
fit_compensation_anchor = fit_profile
fit_profile_anchor = fit_profile
evaluate_aces_j_objective = evaluate_anchor_objective


__all__ = [
    "CompensationFitDiagnostics",
    "CompensationFitResult",
    "evaluate_aces_j_objective",
    "evaluate_anchor_objective",
    "fit_compensation_anchor",
    "fit_profile",
    "fit_profile_anchor",
    "unique_palette_colors",
]
