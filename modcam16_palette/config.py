"""Configuration, defaults, validation, and TOML loading.

The original generator kept all settings as import-time constants.  The
dataclasses here retain those defaults while making a complete configuration
an explicit value that can be passed through the pipeline.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np

GAMUT_NAMES = (
    "sRGB-D65",
    "P3-D65",
    "ACEScg/AP1-D60",
)


@dataclass(frozen=True)
class AppearanceConfig:
    reference_white_luminance_nits: float = 200.0
    reference_background_ratio: float = 20.0 / 200.0
    reference_neutral_y: float = 1.0
    adapting_luminance_nits: float = 20.0
    surround_c: float = 0.525
    surround_n_c: float = 0.8
    degree_of_adaptation: float = 1.0
    hk_chroma_coefficient: float = 66.0


@dataclass(frozen=True)
class SolverConfig:
    c3_hue_sample_count: int = 3600
    c3_max_refinement_candidates: int = 16
    c3_refinement_iterations: int = 40
    c3_refinement_tolerance_degrees: float = 1.0e-7
    gamut_boundary_safety: float = 0.999999
    level_inclusion_relative_tolerance: float = 1.0e-10
    boundary_coarse_steps: int = 256
    boundary_binary_iterations: int = 72
    gamut_test_epsilon: float = 1.0e-12
    rendered_gamut_epsilon: float = 1.0e-9
    boundary_face_tolerance: float = 1.0e-7
    fp32_cone_validation_relative_epsilon: float = 2.0e-6
    hue_validation_minimum_c: float = 1.0e-8


@dataclass(frozen=True)
class PaletteConfig:
    hue_count: int = 36
    chroma_level_count: int = 10
    srgb_chroma_companding_k: float = 10.0
    p3_chroma_companding_k: float = 12.0
    ap1_chroma_companding_k: float = 15.0
    cap_relative_height: float = 0.5
    c3_reference_domain: str = "continuous"
    hue_offset_degrees: float = 0.0
    clockwise: bool = False

    @property
    def companding_by_gamut(self) -> dict[str, float]:
        return {
            "sRGB-D65": self.srgb_chroma_companding_k,
            "P3-D65": self.p3_chroma_companding_k,
            "ACEScg/AP1-D60": self.ap1_chroma_companding_k,
        }


@dataclass(frozen=True)
class MarkerConfig:
    enable_srgb_boundary_markers: bool = True
    enable_p3_boundary_markers: bool = False
    boundary_marker_block_overlap_pixels: float = 5.0
    boundary_marker_tangential_width_pixels: float = 12.0

    @property
    def enabled_reference_names(self) -> tuple[str, ...]:
        names: list[str] = []
        if self.enable_srgb_boundary_markers:
            names.append("sRGB-D65")
        if self.enable_p3_boundary_markers:
            names.append("P3-D65")
        return tuple(names)


@dataclass(frozen=True)
class ColorCheckerConfig:
    enabled: bool = True
    dataset: str = "official_after_2014"
    adaptation_method: str = "CAT02"
    include_caps_in_matching: bool = True
    dot_radius_pixels: float = 5.0


@dataclass(frozen=True)
class RasterConfig:
    image_size: int = 2048
    outer_margin: float = 64.0
    center_radius: float = 112.0
    radial_gap_pixels: float = 7.0
    angular_gap_degrees: float = 0.9


@dataclass(frozen=True)
class OutputConfig:
    output_dir: Path = Path(".")
    selected_gamuts: tuple[str, ...] = GAMUT_NAMES
    exr_compression: str = "zip"


@dataclass(frozen=True)
class Config:
    """Complete generator configuration.

    ``background_value`` is derived from the appearance settings and is kept
    as a property to avoid duplicating a source of truth in TOML.
    """

    appearance: AppearanceConfig = field(default_factory=AppearanceConfig)
    solver: SolverConfig = field(default_factory=SolverConfig)
    palette: PaletteConfig = field(default_factory=PaletteConfig)
    markers: MarkerConfig = field(default_factory=MarkerConfig)
    colorchecker: ColorCheckerConfig = field(default_factory=ColorCheckerConfig)
    raster: RasterConfig = field(default_factory=RasterConfig)
    output: OutputConfig = field(default_factory=OutputConfig)

    @property
    def reference_neutral_luminance_nits(self) -> float:
        return (
            self.appearance.reference_neutral_y
            * self.appearance.reference_white_luminance_nits
        )

    @property
    def background_luminance_nits(self) -> float:
        return (
            self.appearance.reference_background_ratio
            * self.appearance.reference_white_luminance_nits
        )

    @property
    def background_value(self) -> float:
        return (
            self.background_luminance_nits
            / self.appearance.reference_white_luminance_nits
        )

    @property
    def any_reference_boundary_markers_enabled(self) -> bool:
        return bool(self.markers.enabled_reference_names)

    def validate(self) -> Config:
        """Validate user-facing values before expensive numerical work."""

        p = self.palette
        a = self.appearance
        s = self.solver
        m = self.markers
        cc = self.colorchecker
        r = self.raster
        o = self.output

        if not isinstance(p.hue_count, int) or p.hue_count <= 0:
            raise ValueError("hue_count must be a positive integer.")
        if not isinstance(p.chroma_level_count, int) or p.chroma_level_count <= 0:
            raise ValueError("chroma_level_count must be a positive integer.")
        for name, value in p.companding_by_gamut.items():
            if not np.isfinite(value) or value < 0.0:
                raise ValueError(f"{name} companding k must be finite and nonnegative.")
        if (
            not np.isfinite(p.cap_relative_height)
            or not 0.0 < p.cap_relative_height <= 1.0
        ):
            raise ValueError("cap_relative_height must lie in (0, 1].")
        if p.c3_reference_domain not in ("continuous", "rendered"):
            raise ValueError("c3_reference_domain must be 'continuous' or 'rendered'.")
        if not np.isfinite(p.hue_offset_degrees):
            raise ValueError("hue_offset_degrees must be finite.")
        if not isinstance(p.clockwise, bool):
            raise TypeError("clockwise must be Boolean.")

        if (
            not np.isfinite(a.reference_white_luminance_nits)
            or a.reference_white_luminance_nits <= 0.0
        ):
            raise ValueError("reference_white_luminance_nits must be positive.")
        if a.reference_neutral_y != 1.0:
            raise ValueError("reference_neutral_y must be exactly one.")
        if not np.isfinite(a.reference_background_ratio):
            raise ValueError("reference_background_ratio must be finite.")
        if not 0.0 < self.background_luminance_nits < a.reference_white_luminance_nits:
            raise ValueError(
                "background_luminance_nits must be positive and below the reference white."
            )
        if (
            not np.isfinite(a.adapting_luminance_nits)
            or a.adapting_luminance_nits <= 0.0
        ):
            raise ValueError("adapting_luminance_nits must be positive.")
        if not np.isfinite(a.surround_c) or a.surround_c <= 0.0:
            raise ValueError("surround_c must be finite and positive.")
        if not np.isfinite(a.surround_n_c) or a.surround_n_c <= 0.0:
            raise ValueError("surround_n_c must be finite and positive.")
        if not 0.0 <= a.degree_of_adaptation <= 1.0:
            raise ValueError("degree_of_adaptation must lie in [0, 1].")
        if not np.isfinite(a.hk_chroma_coefficient) or a.hk_chroma_coefficient <= 0.0:
            raise ValueError("hk_chroma_coefficient must be finite and positive.")

        for value, label in (
            (s.c3_hue_sample_count, "c3_hue_sample_count"),
            (s.c3_max_refinement_candidates, "c3_max_refinement_candidates"),
            (s.c3_refinement_iterations, "c3_refinement_iterations"),
            (s.boundary_coarse_steps, "boundary_coarse_steps"),
            (s.boundary_binary_iterations, "boundary_binary_iterations"),
        ):
            if not isinstance(value, int) or value <= 0:
                raise ValueError(f"{label} must be a positive integer.")
        for value, label in (
            (s.c3_refinement_tolerance_degrees, "c3_refinement_tolerance_degrees"),
            (s.gamut_boundary_safety, "gamut_boundary_safety"),
            (
                s.level_inclusion_relative_tolerance,
                "level_inclusion_relative_tolerance",
            ),
            (s.gamut_test_epsilon, "gamut_test_epsilon"),
            (s.rendered_gamut_epsilon, "rendered_gamut_epsilon"),
            (s.boundary_face_tolerance, "boundary_face_tolerance"),
            (
                s.fp32_cone_validation_relative_epsilon,
                "fp32_cone_validation_relative_epsilon",
            ),
            (s.hue_validation_minimum_c, "hue_validation_minimum_c"),
        ):
            if not np.isfinite(value) or value < 0.0:
                raise ValueError(f"{label} must be finite and nonnegative.")
        if not 0.0 < s.gamut_boundary_safety <= 1.0:
            raise ValueError("gamut_boundary_safety must lie in (0, 1].")

        if not isinstance(m.enable_srgb_boundary_markers, bool) or not isinstance(
            m.enable_p3_boundary_markers, bool
        ):
            raise TypeError("reference boundary marker switches must be Boolean.")
        if self.any_reference_boundary_markers_enabled:
            if (
                not np.isfinite(m.boundary_marker_block_overlap_pixels)
                or m.boundary_marker_block_overlap_pixels <= 0.0
            ):
                raise ValueError("boundary marker overlap must be finite and positive.")
            if (
                not np.isfinite(m.boundary_marker_tangential_width_pixels)
                or m.boundary_marker_tangential_width_pixels <= 0.0
            ):
                raise ValueError("boundary marker width must be finite and positive.")

        if not isinstance(cc.enabled, bool) or not isinstance(
            cc.include_caps_in_matching, bool
        ):
            raise TypeError("ColorChecker switches must be Boolean.")
        if cc.dataset not in ("official_after_2014", "mccamy"):
            raise ValueError(
                "ColorChecker dataset must be 'official_after_2014' or 'mccamy'."
            )
        if cc.adaptation_method not in ("CAT02", "Bradford"):
            raise ValueError("ColorChecker adaptation must be 'CAT02' or 'Bradford'.")
        if cc.enabled and (
            not np.isfinite(cc.dot_radius_pixels) or cc.dot_radius_pixels <= 0.0
        ):
            raise ValueError("ColorChecker dot radius must be finite and positive.")

        if not isinstance(r.image_size, int) or r.image_size <= 0 or r.image_size % 2:
            raise ValueError("image_size must be a positive even integer.")
        for value, label in (
            (r.outer_margin, "outer_margin"),
            (r.center_radius, "center_radius"),
            (r.radial_gap_pixels, "radial_gap_pixels"),
            (r.angular_gap_degrees, "angular_gap_degrees"),
        ):
            if not np.isfinite(value) or value < 0.0:
                raise ValueError(f"{label} must be finite and nonnegative.")

        if not isinstance(o.selected_gamuts, (tuple, list)):
            raise TypeError("selected_gamuts must be a list or tuple.")
        if not all(isinstance(name, str) for name in o.selected_gamuts):
            raise TypeError("selected_gamuts entries must be strings.")
        unknown = [name for name in o.selected_gamuts if name not in GAMUT_NAMES]
        if unknown:
            raise ValueError(f"Unknown gamut(s): {', '.join(unknown)}")
        if not o.selected_gamuts:
            raise ValueError("At least one gamut must be selected.")
        if len(set(o.selected_gamuts)) != len(o.selected_gamuts):
            raise ValueError("selected_gamuts must not contain duplicates.")
        if not isinstance(o.exr_compression, str):
            raise TypeError("exr_compression must be a string.")
        if o.exr_compression.lower() != "zip":
            raise ValueError("Only ZIP OpenEXR compression is supported.")
        return self


def default_config() -> Config:
    return Config().validate()


def _merge_dataclass(instance: Any, values: Mapping[str, Any], section: str) -> Any:
    allowed = {field.name for field in instance.__dataclass_fields__.values()}
    unknown = set(values) - allowed
    if unknown:
        names = ", ".join(sorted(unknown))
        raise ValueError(f"Unknown {section} configuration key(s): {names}")
    converted = dict(values)
    if section == "output" and "output_dir" in converted:
        converted["output_dir"] = Path(converted["output_dir"])
    if section == "output" and "selected_gamuts" in converted:
        converted["selected_gamuts"] = tuple(converted["selected_gamuts"])
    return replace(instance, **converted)


def config_from_mapping(
    mapping: Mapping[str, Any], base: Config | None = None
) -> Config:
    """Build a config from nested TOML-like mappings."""

    config = default_config() if base is None else base
    sections = (
        "appearance",
        "solver",
        "palette",
        "markers",
        "colorchecker",
        "raster",
        "output",
    )
    aliases = {
        "output": {
            "directory": "output_dir",
            "gamuts": "selected_gamuts",
            "compression": "exr_compression",
        },
        "markers": {
            "srgb_boundary": "enable_srgb_boundary_markers",
            "p3_boundary": "enable_p3_boundary_markers",
            "block_overlap_pixels": "boundary_marker_block_overlap_pixels",
            "tangential_width_pixels": "boundary_marker_tangential_width_pixels",
        },
        "colorchecker": {
            "include_caps": "include_caps_in_matching",
            "dot_radius": "dot_radius_pixels",
        },
        "palette": {
            "srgb_k": "srgb_chroma_companding_k",
            "p3_k": "p3_chroma_companding_k",
            "ap1_k": "ap1_chroma_companding_k",
            "c3_domain": "c3_reference_domain",
            "hue_offset": "hue_offset_degrees",
        },
        "raster": {
            "size": "image_size",
        },
    }
    unknown_sections = set(mapping) - set(sections)
    if unknown_sections:
        names = ", ".join(sorted(unknown_sections))
        raise ValueError(f"Unknown configuration section(s): {names}")
    for section in sections:
        values = mapping.get(section)
        if values is None:
            continue
        if not isinstance(values, Mapping):
            raise TypeError(f"Configuration section '{section}' must be a table.")
        normalized_values = dict(values)
        section_aliases = aliases.get(section, {})
        for old_name, new_name in section_aliases.items():
            if old_name in normalized_values:
                if new_name in normalized_values:
                    raise ValueError(
                        f"Configuration section '{section}' contains both '{old_name}' and '{new_name}'."
                    )
                normalized_values[new_name] = normalized_values.pop(old_name)
        if section == "palette" and "companding" in normalized_values:
            companding = normalized_values.pop("companding")
            if not isinstance(companding, Mapping):
                raise ValueError("palette.companding must be a TOML table.")
            gamut_aliases = {
                "srgb": "srgb_chroma_companding_k",
                "p3": "p3_chroma_companding_k",
                "ap1": "ap1_chroma_companding_k",
                "sRGB-D65": "srgb_chroma_companding_k",
                "P3-D65": "p3_chroma_companding_k",
                "ACEScg/AP1-D60": "ap1_chroma_companding_k",
            }
            for name, value in companding.items():
                if name not in gamut_aliases:
                    raise ValueError(f"Unknown palette.companding key: {name}")
                field_name = gamut_aliases[name]
                if field_name in normalized_values:
                    raise ValueError(
                        f"Configuration section 'palette' contains both '{name}' companding and '{field_name}'."
                    )
                normalized_values[field_name] = value
        if section == "output" and "selected_gamuts" in normalized_values:
            normalized_values["selected_gamuts"] = tuple(
                _normalize_gamut_name(name)
                for name in normalized_values["selected_gamuts"]
            )
        current = getattr(config, section)
        setattr_target = _merge_dataclass(current, normalized_values, section)
        config = replace(config, **{section: setattr_target})
    return config.validate()


def _normalize_gamut_name(name: str) -> str:
    aliases = {
        "srgb": "sRGB-D65",
        "sRGB": "sRGB-D65",
        "sRGB-D65": "sRGB-D65",
        "p3": "P3-D65",
        "P3": "P3-D65",
        "P3-D65": "P3-D65",
        "ap1": "ACEScg/AP1-D60",
        "ACEScg": "ACEScg/AP1-D60",
        "ACEScg/AP1-D60": "ACEScg/AP1-D60",
    }
    try:
        return aliases[name]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"Unknown gamut: {name}") from exc


def load_config(
    path: str | Path | None = None, overrides: Mapping[str, Any] | None = None
) -> Config:
    """Load defaults, an optional TOML file, then explicit overrides."""

    mapping: dict[str, Any] = {}
    if path is not None:
        import tomllib

        config_path = Path(path)
        with config_path.open("rb") as handle:
            loaded = tomllib.load(handle)
        mapping.update(loaded)
    config = config_from_mapping(mapping)
    if overrides:
        config = config_from_mapping(overrides, base=config)
    return config.validate()
