"""Modular modCAM16-HK radial palette generator."""

from .cam16_hk import AppearanceModel
from .colorimetry import GAMUT_MATRICES
from .config import (
    COMPENSATION_PROFILE_CHOICES,
    COMPENSATION_PROFILE_DEFINITIONS,
    COMPENSATION_PROFILE_NAMES,
    COMPENSATION_PROFILES,
    DEFAULT_COMPENSATION_P3_CHROMA_COMPANDING_K,
    DEFAULT_COMPENSATION_SRGB_CHROMA_COMPANDING_K,
    PUBLISHED_CENTER_ACESCG,
    CompensationConfig,
    CompensationProfile,
    CompensationProfileConfig,
    Config,
    default_config,
    load_config,
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
from .palette import PaletteResult, build_palette
from .render import (
    RenderedPalette,
    render_palette_layers,
    render_radial_palette_with_masks,
)

__all__ = [
    "COMPENSATION_PROFILES",
    "COMPENSATION_PROFILE_CHOICES",
    "COMPENSATION_PROFILE_DEFINITIONS",
    "COMPENSATION_PROFILE_NAMES",
    "DEFAULT_COMPENSATION_P3_CHROMA_COMPANDING_K",
    "DEFAULT_COMPENSATION_SRGB_CHROMA_COMPANDING_K",
    "GAMUT_MATRICES",
    "PUBLISHED_CENTER_ACESCG",
    "AppearanceModel",
    "CompensationConfig",
    "CompensationDiagnostics",
    "CompensationProcessor",
    "CompensationProfile",
    "CompensationProfileConfig",
    "Config",
    "PaletteResult",
    "RenderedPalette",
    "apply_inverse_view_compensation",
    "build_palette",
    "compensate_foreground",
    "default_config",
    "load_compensation_processor",
    "load_config",
    "load_ocio_processors",
    "render_palette_layers",
    "render_radial_palette_with_masks",
    "solve_neutral_y",
    "solve_profile_neutral_y",
    "solve_source_neutral_y",
]
