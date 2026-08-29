"""Stable output filename construction."""

from __future__ import annotations

from pathlib import Path

from .colorimetry import GamutMatrices
from .config import Config


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
