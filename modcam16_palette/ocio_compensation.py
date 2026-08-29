"""ACES 2.0 view-reference inverse compensation.

The OCIO configuration supplied with this project exposes ACES 2.0 output
transforms as ``ViewTransform`` entries.  A compensated palette is therefore
constructed with the following colorimetric path:

``ACEScg -> ACES2065-1 -> Un-tone-mapped (CIE XYZ-D65)``

followed by the inverse of the requested ACES 2.0 view transform back to
ACEScg.  Display encoding is used only for diagnostics; it is deliberately
not part of the inverse scene-color path.
"""

from __future__ import annotations

import sysconfig
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .config import (
    COMPENSATION_PROFILE_DEFINITIONS,
    DEFAULT_OCIO_CONFIG_PATH,
    CompensationConfig,
    CompensationProfileConfig,
    _normalize_compensation_profile_name,
)


@dataclass(frozen=True)
class CompensationDiagnostics:
    """Numerical diagnostics emitted as EXR metadata."""

    profile_name: str
    source_gamut: str
    display_name: str
    view_transform: str
    ocio_config_path: str
    ocio_config_cache_id: str
    solved_source_y: float
    target_intermediate_center: float
    scale_factor: float
    intermediate_center: tuple[float, float, float]
    intermediate_center_max_error: float
    intermediate_round_trip_max_error: float
    intermediate_round_trip_pixels_above_tolerance: int
    encoded_display_round_trip_max_error: float
    encoded_display_round_trip_pixels_above_tolerance: int
    post_scale_display_max_error: float
    post_scale_display_pixels_above_tolerance: int
    foreground_pixel_count: int
    post_scale_minimum: float
    post_scale_maximum: float
    post_scale_nonfinite_count: int
    post_scale_negative_count: int

    def as_statistics(self) -> dict[str, object]:
        return {
            "compensation_enabled": True,
            "compensation_profile": self.profile_name,
            "compensation_source_gamut": self.source_gamut,
            "compensation_display_name": self.display_name,
            "compensation_view_transform": self.view_transform,
            "compensation_ocio_config_path": self.ocio_config_path,
            "compensation_ocio_config_cache_id": self.ocio_config_cache_id,
            "compensation_solved_source_y": self.solved_source_y,
            "compensation_target_intermediate_center": self.target_intermediate_center,
            "compensation_scale_factor": self.scale_factor,
            "compensation_intermediate_center": self.intermediate_center,
            "compensation_intermediate_center_max_error": self.intermediate_center_max_error,
            "compensation_intermediate_round_trip_max_error": self.intermediate_round_trip_max_error,
            "compensation_intermediate_round_trip_pixels_above_tolerance": self.intermediate_round_trip_pixels_above_tolerance,
            "compensation_encoded_display_round_trip_max_error": self.encoded_display_round_trip_max_error,
            "compensation_encoded_display_round_trip_pixels_above_tolerance": self.encoded_display_round_trip_pixels_above_tolerance,
            "compensation_post_scale_display_max_error": self.post_scale_display_max_error,
            "compensation_post_scale_display_pixels_above_tolerance": self.post_scale_display_pixels_above_tolerance,
            "compensation_foreground_pixel_count": self.foreground_pixel_count,
            "compensation_post_scale_minimum": self.post_scale_minimum,
            "compensation_post_scale_maximum": self.post_scale_maximum,
            "compensation_post_scale_nonfinite_count": self.post_scale_nonfinite_count,
            "compensation_post_scale_negative_count": self.post_scale_negative_count,
        }


@dataclass
class CompensationProcessor:
    """CPU processors needed for one compensation profile."""

    ocio_config: Any
    profile: CompensationProfileConfig
    source_comparison_forward: Any
    target_inverse: Any
    target_forward: Any
    display_forward: Any
    config_path: Path

    @property
    def cache_id(self) -> str:
        return str(self.ocio_config.getCacheID())

    @staticmethod
    def _apply(processor: Any, values: np.ndarray) -> np.ndarray:
        array = np.ascontiguousarray(values, dtype=np.float32).copy()
        if array.size == 0:
            return array
        if array.shape[-1] != 3:
            raise ValueError("OCIO RGB arrays must have a final dimension of three.")
        processor.applyRGB(array)
        return array

    def source_comparison(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.source_comparison_forward, values)

    def target_inverse_values(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.target_inverse, values)

    def target_forward_values(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.target_forward, values)

    def display_values(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.display_forward, values)

    # Concise aliases useful to callers working directly with the processor.
    def forward_reference(self, values: np.ndarray) -> np.ndarray:
        return self.source_comparison(values)

    def inverse_view(self, values: np.ndarray) -> np.ndarray:
        return self.target_inverse_values(values)

    def forward_view(self, values: np.ndarray) -> np.ndarray:
        return self.target_forward_values(values)


def _import_ocio() -> Any:
    try:
        import PyOpenColorIO as ocio
    except ImportError as exc:  # pragma: no cover - exercised in missing-dependency installs
        raise RuntimeError(
            "ACES compensation requires PyOpenColorIO (opencolorio==2.5.2)."
        ) from exc
    return ocio


def _resolve_config_path(path: str | Path) -> Path:
    requested = Path(path)
    candidates = [requested]
    if not requested.is_absolute():
        # The checked-in config lives beside the package in source checkouts;
        # this fallback also makes the default useful when invoked elsewhere.
        candidates.append(Path(__file__).resolve().parent.parent / requested)
        # Wheel installs place the checked-in config in the platform data
        # directory via ``tool.setuptools.data-files``.
        if requested == DEFAULT_OCIO_CONFIG_PATH:
            candidates.append(
                Path(sysconfig.get_path("data"))
                / "share"
                / "modcam16-palette"
                / requested.name
            )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        f"OpenColorIO configuration was not found: {requested}"
    )


def _view_reference_group(ocio: Any, config: Any, view_name: str) -> Any:
    view = config.getViewTransform(view_name)
    if view is None:
        raise ValueError(f"OCIO view transform not found: {view_name}")
    view_transform = view.getTransform(ocio.VIEWTRANSFORM_DIR_FROM_REFERENCE)
    if view_transform is None:
        raise ValueError(
            f"OCIO view transform has no scene-reference direction: {view_name}"
        )
    colorspace = ocio.ColorSpaceTransform()
    colorspace.setSrc("ACEScg")
    colorspace.setDst("ACES2065-1")
    group = ocio.GroupTransform()
    group.appendTransform(colorspace)
    group.appendTransform(view_transform)
    return group


def load_compensation_processor(
    compensation: CompensationConfig, profile_name: str
) -> CompensationProcessor:
    """Load and validate one configured OCIO compensation profile."""

    try:
        canonical_name = _normalize_compensation_profile_name(profile_name)
    except ValueError:
        canonical_name = profile_name
    try:
        profile = COMPENSATION_PROFILE_DEFINITIONS[canonical_name]
    except KeyError as exc:
        raise ValueError(f"Unknown compensation profile: {profile_name}") from exc
    config_path = _resolve_config_path(compensation.ocio_config_path)
    ocio = _import_ocio()
    ocio_config = ocio.Config.CreateFromFile(str(config_path))

    # Validate all names before building processors.  ``getViewTransform``
    # returns None for an unknown name in some OCIO Python builds.
    for view_name in ("Un-tone-mapped", profile.view_transform):
        if ocio_config.getViewTransform(view_name) is None:
            raise ValueError(f"OCIO view transform not found: {view_name}")
    for colorspace_name in ("ACEScg", "ACES2065-1"):
        if ocio_config.getColorSpace(colorspace_name) is None:
            raise ValueError(f"OCIO color space not found: {colorspace_name}")
    if ocio_config.getColorSpace("CIE XYZ-D65 - Display-referred") is None:
        raise ValueError("OCIO display connection space is missing.")
    if ocio_config.getColorSpace(profile.display_name) is None:
        raise ValueError(f"OCIO display color space not found: {profile.display_name}")

    source_group = _view_reference_group(ocio, ocio_config, "Un-tone-mapped")
    target_group = _view_reference_group(ocio, ocio_config, profile.view_transform)
    source_forward = ocio_config.getProcessor(source_group).getDefaultCPUProcessor()
    target_inverse = ocio_config.getProcessor(
        target_group, ocio.TRANSFORM_DIR_INVERSE
    ).getDefaultCPUProcessor()
    target_forward = ocio_config.getProcessor(target_group).getDefaultCPUProcessor()
    display_forward = ocio_config.getProcessor(
        "CIE XYZ-D65 - Display-referred", profile.display_name
    ).getDefaultCPUProcessor()
    return CompensationProcessor(
        ocio_config=ocio_config,
        profile=profile,
        source_comparison_forward=source_forward,
        target_inverse=target_inverse,
        target_forward=target_forward,
        display_forward=display_forward,
        config_path=config_path,
    )


def _neutral_intermediate(
    processor: CompensationProcessor, source_y: float
) -> np.ndarray:
    source = np.full(3, np.float32(source_y), dtype=np.float32)
    comparison_xyz = processor.source_comparison(source)
    return processor.target_inverse_values(comparison_xyz)


def solve_neutral_y(
    processor: CompensationProcessor,
    compensation: CompensationConfig,
) -> tuple[float, np.ndarray]:
    """Solve a deterministic source neutral Y for the requested center.

    OCIO processors are 32-bit float processors.  The returned Y is therefore
    the best representable scalar found by a fixed bisection plus endpoint
    comparison, rather than a claim of exact real-valued equality.
    """

    target = float(compensation.target_intermediate_center)
    if not np.isfinite(target) or target <= 0.0:
        raise ValueError("target_intermediate_center must be finite and positive.")
    if (
        not np.isfinite(compensation.solver_tolerance)
        or compensation.solver_tolerance <= 0.0
    ):
        raise ValueError("solver_tolerance must be finite and positive.")
    if (
        not isinstance(compensation.solver_max_iterations, int)
        or compensation.solver_max_iterations <= 0
    ):
        raise ValueError("solver_max_iterations must be a positive integer.")

    def residual(y: float) -> tuple[np.ndarray, float]:
        value = _neutral_intermediate(processor, y)
        if not np.all(np.isfinite(value)):
            raise RuntimeError("OCIO neutral solve produced a non-finite value.")
        return value, float(np.mean(value) - target)

    low = 0.0
    high = 1.0
    low_value, low_residual = residual(low)
    high_value, high_residual = residual(high)
    while high_residual < 0.0 and high < 65536.0:
        high *= 2.0
        high_value, high_residual = residual(high)
    if low_residual > 0.0 or high_residual < 0.0:
        raise RuntimeError(
            f"Could not bracket OCIO neutral target {target:g} for "
            f"{processor.profile.name}."
        )

    candidates: list[tuple[float, np.ndarray]] = [(low, low_value), (high, high_value)]
    for _ in range(compensation.solver_max_iterations):
        middle = (low + high) * 0.5
        middle_value, middle_residual = residual(middle)
        candidates.append((middle, middle_value))
        if middle_residual < 0.0:
            low = middle
        else:
            high = middle
        if high - low <= compensation.solver_tolerance:
            break

    y_value, intermediate = min(
        candidates,
        key=lambda item: (
            float(np.max(np.abs(item[1] - target))),
            abs(float(np.mean(item[1])) - target),
            item[0],
        ),
    )
    return float(y_value), intermediate.astype(np.float64)


def solve_profile_neutral_y(
    compensation: CompensationConfig, profile_name: str
) -> tuple[float, np.ndarray, CompensationProcessor]:
    """Convenience helper that loads a profile and solves its source neutral."""

    processor = load_compensation_processor(compensation, profile_name)
    source_y, intermediate = solve_neutral_y(processor, compensation)
    return source_y, intermediate, processor


def compensate_foreground(
    image: np.ndarray,
    foreground_mask: np.ndarray,
    processor: CompensationProcessor,
    compensation: CompensationConfig,
    solved_source_y: float,
    center_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, CompensationDiagnostics]:
    """Inverse-transform and normalize foreground pixels only."""

    if not np.isfinite(solved_source_y) or solved_source_y <= 0.0:
        raise ValueError("solved_source_y must be finite and positive.")
    if (
        not np.isfinite(compensation.target_intermediate_center)
        or compensation.target_intermediate_center <= 0.0
    ):
        raise ValueError("target_intermediate_center must be finite and positive.")
    if (
        not np.isfinite(compensation.round_trip_tolerance)
        or compensation.round_trip_tolerance <= 0.0
    ):
        raise ValueError("round_trip_tolerance must be finite and positive.")

    values = np.asarray(image, dtype=np.float32)
    mask = np.asarray(foreground_mask, dtype=bool)
    if values.ndim != 3 or values.shape[-1] != 3:
        raise ValueError("Image must have shape H x W x 3.")
    if mask.shape != values.shape[:2]:
        raise ValueError("Foreground mask shape does not match image dimensions.")
    if not np.all(np.isfinite(values)):
        raise ValueError("Source image contains non-finite values.")

    result = values.copy()
    source_values = values[mask]
    comparison_xyz = processor.source_comparison(source_values)
    inverse_values = processor.target_inverse_values(comparison_xyz)
    reconstructed_xyz = processor.target_forward_values(inverse_values)
    for label, array in (
        ("source comparison", comparison_xyz),
        ("inverse", inverse_values),
        ("forward", reconstructed_xyz),
    ):
        if not np.all(np.isfinite(array)):
            raise RuntimeError(
                f"OCIO compensation produced non-finite {label} values for "
                f"{processor.profile.name}."
            )
    residual = reconstructed_xyz.astype(np.float64) - comparison_xyz.astype(np.float64)
    residual_norm = np.max(np.abs(residual), axis=-1) if residual.size else np.empty(0)
    tolerance = float(compensation.round_trip_tolerance)
    round_trip_max = float(np.max(residual_norm)) if residual_norm.size else 0.0
    round_trip_count = int(np.count_nonzero(residual_norm > tolerance))
    if round_trip_count:
        raise RuntimeError(
            f"OCIO intermediate round-trip exceeded tolerance for "
            f"{processor.profile.name}: max={round_trip_max:.9g}, "
            f"count={round_trip_count}, tolerance={tolerance:.9g}."
        )

    encoded_source = processor.display_values(comparison_xyz)
    encoded_reconstructed = processor.display_values(reconstructed_xyz)
    if not np.all(np.isfinite(encoded_source)) or not np.all(
        np.isfinite(encoded_reconstructed)
    ):
        raise RuntimeError(
            f"OCIO display encoding produced non-finite values for "
            f"{processor.profile.name}."
        )
    encoded_residual = encoded_reconstructed.astype(np.float64) - encoded_source.astype(
        np.float64
    )
    encoded_norm = (
        np.max(np.abs(encoded_residual), axis=-1)
        if encoded_residual.size
        else np.empty(0)
    )
    encoded_max = float(np.max(encoded_norm)) if encoded_norm.size else 0.0
    encoded_count = int(np.count_nonzero(encoded_norm > tolerance))

    if inverse_values.size and (
        not np.all(np.isfinite(inverse_values)) or np.any(inverse_values < 0.0)
    ):
        minimum = float(np.nanmin(inverse_values))
        raise RuntimeError(
            f"OCIO inverse compensation produced invalid foreground values for "
            f"{processor.profile.name} (minimum={minimum:.9g})."
        )


    target = float(compensation.target_intermediate_center)
    scale_factor = 1.0 / target
    scaled = inverse_values * np.float32(scale_factor)
    if scaled.size and np.any(scaled < 0.0):
        raise RuntimeError(
            f"OCIO inverse compensation produced negative scaled values for "
            f"{processor.profile.name}."
        )
    if scaled.size:
        result[mask] = scaled
    # The source center is deliberately part of the foreground mask.  Force
    # its published value to exactly one after the float32 processor/scaling
    # path, while preserving all non-foreground pixels byte-for-byte.
    result[mask] = np.asarray(result[mask], dtype=np.float32)
    if center_mask is not None:
        center = np.asarray(center_mask, dtype=bool)
        if center.shape != mask.shape:
            raise ValueError("Center mask shape does not match image dimensions.")
        result[center & mask] = np.ones(3, dtype=np.float32)
    if not np.all(np.isfinite(result)):
        raise RuntimeError("Compensated image contains non-finite values.")

    post_values = result[mask]
    post_scale_xyz = processor.target_forward_values(post_values)
    post_scale_display = processor.display_values(post_scale_xyz)
    if not np.all(np.isfinite(post_scale_xyz)) or not np.all(
        np.isfinite(post_scale_display)
    ):
        raise RuntimeError(
            f"OCIO post-scale display validation produced non-finite values for "
            f"{processor.profile.name}."
        )
    post_scale_residual = post_scale_display.astype(np.float64) - encoded_source.astype(
        np.float64
    )
    post_scale_norm = (
        np.max(np.abs(post_scale_residual), axis=-1)
        if post_scale_residual.size
        else np.empty(0)
    )
    post_scale_display_max = (
        float(np.max(post_scale_norm)) if post_scale_norm.size else 0.0
    )
    post_scale_display_count = int(np.count_nonzero(post_scale_norm > tolerance))
    intermediate_center = _neutral_intermediate(processor, solved_source_y)
    if not np.all(np.isfinite(intermediate_center)):
        raise RuntimeError(
            f"OCIO neutral validation produced non-finite values for "
            f"{processor.profile.name}."
        )
    intermediate_center_error = float(np.max(np.abs(intermediate_center - target)))
    if intermediate_center_error > tolerance:
        raise RuntimeError(
            f"OCIO neutral solve exceeded tolerance for {processor.profile.name}: "
            f"max={intermediate_center_error:.9g}, tolerance={tolerance:.9g}."
        )
    diagnostics = CompensationDiagnostics(
        profile_name=processor.profile.name,
        source_gamut=processor.profile.source_gamut,
        display_name=processor.profile.display_name,
        view_transform=processor.profile.view_transform,
        ocio_config_path=str(processor.config_path),
        ocio_config_cache_id=processor.cache_id,
        solved_source_y=float(solved_source_y),
        target_intermediate_center=target,
        scale_factor=float(scale_factor),
        intermediate_center=tuple(float(x) for x in intermediate_center),
        intermediate_center_max_error=intermediate_center_error,
        intermediate_round_trip_max_error=round_trip_max,
        intermediate_round_trip_pixels_above_tolerance=round_trip_count,
        encoded_display_round_trip_max_error=encoded_max,
        encoded_display_round_trip_pixels_above_tolerance=encoded_count,
        post_scale_display_max_error=post_scale_display_max,
        post_scale_display_pixels_above_tolerance=post_scale_display_count,
        foreground_pixel_count=int(np.count_nonzero(mask)),
        post_scale_minimum=float(np.min(post_values)) if post_values.size else 0.0,
        post_scale_maximum=float(np.max(post_values)) if post_values.size else 0.0,
        post_scale_nonfinite_count=int(np.count_nonzero(~np.isfinite(post_values))),
        post_scale_negative_count=int(np.count_nonzero(post_values < 0.0)),
    )
    return result, diagnostics


# Descriptive aliases retained for callers that use the terminology from the
# ACES/OCIO plan ("source Y" and "inverse view") directly.
solve_source_neutral_y = solve_neutral_y
load_ocio_processors = load_compensation_processor
apply_inverse_view_compensation = compensate_foreground
