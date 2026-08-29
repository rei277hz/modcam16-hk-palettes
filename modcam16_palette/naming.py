"""Stable output filename construction."""

from __future__ import annotations

import math
from pathlib import Path

from .colorimetry import GamutMatrices
from .config import (
    COMPENSATION_PROFILE_DEFINITIONS,
    CompensationProfileConfig,
    Config,
    _normalize_compensation_profile_name,
)


def filename_number_tag(value: float) -> str:
    text = f"{float(value):.12g}"
    return text.replace("-", "m").replace("+", "").replace(".", "p")


def make_layout_filename_tag(config: Config, companding_k: float) -> str:
    marker = config.markers
    if marker.enable_srgb_boundary_markers and marker.enable_p3_boundary_markers:
        marker_tag = "sRGBP3RectMarkers"
    elif marker.enable_srgb_boundary_markers:
        marker_tag = "sRGBRectMarkers"
    elif marker.enable_p3_boundary_markers:
        marker_tag = "P3RectMarkers"
    else:
        marker_tag = "NoReferenceMarkers"
    cc = config.colorchecker
    if cc.enabled:
        cc_tag = (
            "CC18OfficialDots"
            if cc.dataset == "official_after_2014"
            else "CC18McCamyDots"
        )
    else:
        cc_tag = "NoColorCheckerDots"
    return (
        f"{config.palette.chroma_level_count}Step_"
        f"LogK{filename_number_tag(companding_k)}_"
        f"Cap{filename_number_tag(config.palette.cap_relative_height)}_"
        f"{marker_tag}_{cc_tag}"
    )


def output_path_for_gamut(config: Config, gamut: GamutMatrices) -> Path:
    tag = filename_number_tag(config.appearance.reference_white_luminance_nits)
    companding_k = config.palette.companding_by_gamut[gamut.name]
    if gamut.name == "sRGB-D65":
        prefix = "sRGBGamutCone_C3"
    elif gamut.name == "P3-D65":
        prefix = "P3D65GamutCone_C3"
    elif gamut.name == "ACEScg/AP1-D60":
        prefix = "AP1GamutCone_C3"
    else:
        raise ValueError(f"Unsupported gamut: {gamut.name}")
    filename = (
        f"modCAM16HK_{tag}nit_{prefix}_"
        f"{make_layout_filename_tag(config, companding_k)}_"
        "ACEScg_Radial_32f.exr"
    )
    return config.output.output_dir / filename


def output_path_for_compensation(
    config: Config,
    gamut: GamutMatrices,
    profile: CompensationProfileConfig | str,
    source_y: float,
) -> Path:
    """Build a distinct filename for an ACES 2.0 compensated palette."""

    if isinstance(profile, str):
        try:
            profile = COMPENSATION_PROFILE_DEFINITIONS[
                _normalize_compensation_profile_name(profile)
            ]
        except KeyError as exc:
            raise ValueError(f"Unknown compensation profile: {profile}") from exc
        except ValueError as exc:
            raise ValueError(f"Unknown compensation profile: {profile}") from exc
    if not isinstance(profile, CompensationProfileConfig):
        raise TypeError("profile must be a compensation profile or profile name.")
    if profile.source_gamut != gamut.name:
        raise ValueError(
            f"Compensation profile {profile.name} targets {profile.source_gamut}, "
            f"not {gamut.name}."
        )
    if not math.isfinite(float(source_y)) or float(source_y) <= 0.0:
        raise ValueError("source_y must be finite and positive.")
    white_tag = filename_number_tag(config.appearance.reference_white_luminance_nits)
    companding_k = config.palette.companding_by_gamut[gamut.name]
    if gamut.name == "sRGB-D65":
        prefix = "sRGBGamutCone_C3"
    elif gamut.name == "P3-D65":
        prefix = "P3D65GamutCone_C3"
    else:
        raise ValueError(
            f"Compensation profile {profile.name} is not available for {gamut.name}."
        )
    layout = make_layout_filename_tag(config, companding_k)
    target_tag = filename_number_tag(config.compensation.target_intermediate_center)
    scale_tag = filename_number_tag(
        1.0 / config.compensation.target_intermediate_center
    )
    filename = (
        f"modCAM16HK_{white_tag}nit_{prefix}_{layout}_"
        f"{profile.filename_tag}_SourceY{filename_number_tag(source_y)}_"
        f"TargetY{target_tag}_Scale{scale_tag}_ACEScg_Radial_32f.exr"
    )
    return config.output.output_dir / filename
