"""Compatibility exports for ACES 2.0 palette compensation helpers."""

from .config import (
    COMPENSATION_PROFILE_CHOICES,
    COMPENSATION_PROFILE_DEFINITIONS,
    COMPENSATION_PROFILE_NAMES,
    COMPENSATION_PROFILES,
    DEFAULT_COMPENSATION_P3_CHROMA_COMPANDING_K,
    DEFAULT_COMPENSATION_SRGB_CHROMA_COMPANDING_K,
    CompensationConfig,
    CompensationProfile,
    CompensationProfileConfig,
)
from .ocio_compensation import (
    CompensationDiagnostics,
    CompensationProcessor,
    apply_inverse_view_compensation,
    compensate_foreground,
    load_compensation_processor,
    load_ocio_processors,
    solve_neutral_y,
    solve_profile_neutral_y,
    solve_source_neutral_y,
)

__all__ = [
    "COMPENSATION_PROFILES",
    "COMPENSATION_PROFILE_CHOICES",
    "COMPENSATION_PROFILE_DEFINITIONS",
    "COMPENSATION_PROFILE_NAMES",
    "DEFAULT_COMPENSATION_P3_CHROMA_COMPANDING_K",
    "DEFAULT_COMPENSATION_SRGB_CHROMA_COMPANDING_K",
    "CompensationConfig",
    "CompensationDiagnostics",
    "CompensationProcessor",
    "CompensationProfile",
    "CompensationProfileConfig",
    "apply_inverse_view_compensation",
    "compensate_foreground",
    "load_compensation_processor",
    "load_ocio_processors",
    "solve_neutral_y",
    "solve_profile_neutral_y",
    "solve_source_neutral_y",
]
