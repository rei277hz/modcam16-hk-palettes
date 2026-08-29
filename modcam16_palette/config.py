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
class CompensationProfileConfig:
    """A named ACES 2.0 inverse-view compensation target.

    The view transform operates from the ACES scene reference to the CIE
    XYZ-D65 display reference.  ``display_name`` is retained for validation
    and for encoded-display diagnostics; it is not inserted into the inverse
    colorimetric transform itself.  The display peak fields describe the
    finite linear-RGB range accepted by the view in that reference space.
    """

    name: str
    source_gamut: str
    display_name: str
    view_transform: str
    filename_tag: str
    # ACES display-reference XYZ is normalized so 1.0 represents 100 cd/m^2.
    # Keep both quantities explicit: the selected output transform, rather
    # than its name, defines the finite linear-RGB volume that can be inverted.
    display_peak_luminance_nits: float = 100.0
    display_reference_luminance_nits: float = 100.0

    @property
    def limiting_rgb_maximum(self) -> float:
        """Maximum reachable display-linear RGB channel for this view."""

        peak = float(self.display_peak_luminance_nits)
        reference = float(self.display_reference_luminance_nits)
        if not np.isfinite(peak) or peak <= 0.0:
            raise ValueError("display_peak_luminance_nits must be finite and positive.")
        if not np.isfinite(reference) or reference <= 0.0:
            raise ValueError(
                "display_reference_luminance_nits must be finite and positive."
            )
        return peak / reference


CompensationProfile = CompensationProfileConfig


COMPENSATION_PROFILE_DEFINITIONS = {
    "srgb_rec709_bt1886": CompensationProfileConfig(
        name="srgb_rec709_bt1886",
        source_gamut="sRGB-D65",
        display_name="Rec.1886 Rec.709 - Display",
        view_transform="ACES 2.0 - SDR 100 nits (Rec.709)",
        filename_tag="ACES2InvODT_Rec709BT1886",
        display_peak_luminance_nits=100.0,
    ),
    "p3_rec2020_pq": CompensationProfileConfig(
        name="p3_rec2020_pq",
        source_gamut="P3-D65",
        display_name="Rec.2100-PQ - Display",
        view_transform="ACES 2.0 - HDR 1000 nits (Rec.2020)",
        filename_tag="ACES2InvODR_Rec2020PQ",
        display_peak_luminance_nits=1000.0,
    ),
}
COMPENSATION_PROFILE_NAMES = tuple(COMPENSATION_PROFILE_DEFINITIONS)
COMPENSATION_PROFILES = COMPENSATION_PROFILE_DEFINITIONS
# Accepted spelling variants for TOML and command-line configuration.  The
# canonical names above remain the values stored in Config.
COMPENSATION_PROFILE_ALIASES = (
    "srgb",
    "sRGB",
    "rec709",
    "rec709_bt1886",
    "p3",
    "P3",
    "rec2020",
    "rec2020_pq",
)
COMPENSATION_PROFILE_CHOICES = COMPENSATION_PROFILE_NAMES + COMPENSATION_PROFILE_ALIASES
DEFAULT_OCIO_CONFIG_PATH = Path("cg-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio")

# Compensation palettes are compared after an ACES 2.0 output transform.  The
# output transform changes the perceived spacing of the source rings, so they
# use a less aggressive logarithmic progression than the ordinary palettes.
# The defaults are calibrated reference values, not a claim that one k is
# optimal for every display, view transform, or number of rings.
# Keep these independent from PaletteConfig: changing a compensated variant
# must not silently change an ordinary/legacy output file.
DEFAULT_COMPENSATION_SRGB_CHROMA_COMPANDING_K = 2.5
DEFAULT_COMPENSATION_P3_CHROMA_COMPANDING_K = 4.0
# Published palette centers are an ACEScg white patch.  This is deliberately
# separate from the CAM16 model's neutral-Y reference, which may be different
# for a source palette used by an inverse-view compensation profile.
PUBLISHED_CENTER_ACESCG = (1.0, 1.0, 1.0)


def _normalize_compensation_fit_mode(value: Any) -> str:
    """Normalize friendly automatic/manual fit-mode spellings."""

    if isinstance(value, bool):
        return "auto" if value else "manual"
    text = str(value).strip().lower().replace("-", "_")
    aliases = {
        "auto": "auto",
        "automatic": "auto",
        "fit": "auto",
        "optimized": "auto",
        "optimised": "auto",
        "manual": "manual",
        "legacy": "manual",
        "explicit": "manual",
        "manual_anchor": "manual",
    }
    try:
        return aliases[text]
    except KeyError as exc:
        raise ValueError("compensation.fit_mode must be 'auto' or 'manual'.") from exc


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
class CompensationConfig:
    """Settings for optional ACES 2.0 inverse-view palette variants."""

    enabled: bool = True
    profiles: tuple[str, ...] = COMPENSATION_PROFILE_NAMES
    ocio_config_path: Path = DEFAULT_OCIO_CONFIG_PATH
    # ``target_intermediate_center`` is retained as the legacy/manual anchor
    # and as the deterministic seed for automatic fitting.  In the default
    # ``auto`` mode it is not used as the final anchor.
    target_intermediate_center: float = 0.18
    round_trip_tolerance: float = 1.0e-5
    solver_tolerance: float = 1.0e-12
    solver_max_iterations: int = 100
    srgb_chroma_companding_k: float = DEFAULT_COMPENSATION_SRGB_CHROMA_COMPANDING_K
    p3_chroma_companding_k: float = DEFAULT_COMPENSATION_P3_CHROMA_COMPANDING_K
    # New fitting controls follow the legacy fields so positional construction
    # by older callers keeps its original meaning.
    fit_mode: str = "auto"
    exposure_min_stops: float = -2.0
    exposure_max_stops: float = 2.0
    exposure_step_stops: float = 0.5
    anchor_search_tolerance: float = 1.0e-3
    anchor_search_max_iterations: int = 12
    anchor_search_initial_step_stops: float = 1.0
    anchor_search_max_stops: float = 8.0
    # OCIO's CPU processors operate on float32 values.  The absolute
    # round-trip tolerance remains the minimum allowance, while this relative
    # term prevents otherwise harmless ulp-scale errors from being reported as
    # failures for HDR values several times larger than one.
    round_trip_relative_tolerance: float = 2.0e-6

    def __post_init__(self) -> None:
        # Normalize aliases for callers constructing the dataclass directly;
        # TOML/CLI mappings use the same helper before merging fields.
        object.__setattr__(
            self, "fit_mode", _normalize_compensation_fit_mode(self.fit_mode)
        )

    @property
    def selected_profiles(self) -> tuple[str, ...]:
        """Compatibility/readability alias for the profile selection list."""

        return self.profiles

    @property
    def ocio_path(self) -> Path:
        """Short alias for the configured OCIO profile path."""

        return self.ocio_config_path

    @property
    def automatic_fit(self) -> bool:
        """Whether the ACES-J exposure fit should choose the anchor."""

        return self.fit_mode == "auto"

    @property
    def manual_anchor(self) -> float:
        """The explicit legacy anchor used in manual mode."""

        return float(self.target_intermediate_center)

    @property
    def exposure_stops(self) -> tuple[float, ...]:
        """Return the deterministic inclusive exposure sample grid."""

        count = round(
            (float(self.exposure_max_stops) - float(self.exposure_min_stops))
            / float(self.exposure_step_stops)
        )
        return tuple(
            float(self.exposure_min_stops + index * self.exposure_step_stops)
            for index in range(count + 1)
        )

    @property
    def exposure_grid(self) -> tuple[float, ...]:
        """Compatibility alias for :attr:`exposure_stops`."""

        return self.exposure_stops

    # Verbose aliases make the intended relationship to the fitter explicit
    # for callers configuring the dataclass directly.
    @property
    def fit_exposure_min_stops(self) -> float:
        return float(self.exposure_min_stops)

    @property
    def fit_exposure_max_stops(self) -> float:
        return float(self.exposure_max_stops)

    @property
    def fit_exposure_step_stops(self) -> float:
        return float(self.exposure_step_stops)

    @property
    def fit_tolerance(self) -> float:
        """Compatibility alias for the log-anchor search tolerance."""

        return float(self.anchor_search_tolerance)

    @property
    def fit_max_iterations(self) -> int:
        """Compatibility alias for the anchor search iteration limit."""

        return int(self.anchor_search_max_iterations)

    @property
    def fit_search_tolerance(self) -> float:
        return float(self.anchor_search_tolerance)

    @property
    def fit_search_max_iterations(self) -> int:
        return int(self.anchor_search_max_iterations)

    @property
    def companding_by_source_gamut(self) -> dict[str, float]:
        """Return compensated chroma companding by source gamut."""

        return {
            "sRGB-D65": self.srgb_chroma_companding_k,
            "P3-D65": self.p3_chroma_companding_k,
        }

    @property
    def companding_by_gamut(self) -> dict[str, float]:
        """Compatibility alias for :attr:`companding_by_source_gamut`."""

        return self.companding_by_source_gamut


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
    compensation: CompensationConfig = field(default_factory=CompensationConfig)

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
        if not np.isfinite(a.reference_neutral_y) or a.reference_neutral_y <= 0.0:
            raise ValueError("reference_neutral_y must be finite and positive.")
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

        c = self.compensation
        if not isinstance(c.enabled, bool):
            raise TypeError("compensation.enabled must be Boolean.")
        if not isinstance(c.fit_mode, str) or c.fit_mode not in ("auto", "manual"):
            raise ValueError("compensation.fit_mode must be 'auto' or 'manual'.")
        if not isinstance(c.profiles, (tuple, list)):
            raise TypeError("compensation.profiles must be a list or tuple.")
        if not all(isinstance(name, str) for name in c.profiles):
            raise TypeError("compensation.profiles entries must be strings.")
        unknown_profiles = [
            name for name in c.profiles if name not in COMPENSATION_PROFILE_DEFINITIONS
        ]
        if unknown_profiles:
            raise ValueError(
                "Unknown compensation profile(s): " + ", ".join(unknown_profiles)
            )
        if len(set(c.profiles)) != len(c.profiles):
            raise ValueError("compensation.profiles must not contain duplicates.")
        if not isinstance(c.ocio_config_path, (str, Path)):
            raise TypeError("compensation.ocio_config_path must be a path.")
        for name, value in c.companding_by_source_gamut.items():
            if not np.isfinite(value) or value < 0.0:
                raise ValueError(
                    f"{name} compensation companding k must be finite and nonnegative."
                )
        if (
            not np.isfinite(c.target_intermediate_center)
            or c.target_intermediate_center <= 0.0
        ):
            raise ValueError("target_intermediate_center must be finite and positive.")
        if not np.isfinite(c.round_trip_tolerance) or c.round_trip_tolerance <= 0.0:
            raise ValueError("round_trip_tolerance must be finite and positive.")
        if (
            not np.isfinite(c.round_trip_relative_tolerance)
            or c.round_trip_relative_tolerance < 0.0
        ):
            raise ValueError(
                "round_trip_relative_tolerance must be finite and nonnegative."
            )
        if not np.isfinite(c.solver_tolerance) or c.solver_tolerance <= 0.0:
            raise ValueError("solver_tolerance must be finite and positive.")
        if not isinstance(c.solver_max_iterations, int) or c.solver_max_iterations <= 0:
            raise ValueError("solver_max_iterations must be a positive integer.")
        if not np.isfinite(c.exposure_min_stops) or not np.isfinite(
            c.exposure_max_stops
        ):
            raise ValueError("Compensation exposure bounds must be finite.")
        if c.exposure_max_stops <= c.exposure_min_stops:
            raise ValueError("exposure_max_stops must exceed exposure_min_stops.")
        if not np.isfinite(c.exposure_step_stops) or c.exposure_step_stops <= 0.0:
            raise ValueError("exposure_step_stops must be finite and positive.")
        exposure_span = (
            c.exposure_max_stops - c.exposure_min_stops
        ) / c.exposure_step_stops
        if not np.isfinite(exposure_span) or exposure_span < 1.0:
            raise ValueError(
                "Compensation exposure grid must contain at least two samples."
            )
        if not np.isclose(exposure_span, round(exposure_span), atol=1.0e-9, rtol=0.0):
            raise ValueError(
                "exposure_max_stops - exposure_min_stops must be an integer multiple of exposure_step_stops."
            )
        if round(exposure_span) > 10001:
            raise ValueError("Compensation exposure grid is unreasonably large.")
        for value, label in (
            (c.anchor_search_tolerance, "anchor_search_tolerance"),
            (c.anchor_search_initial_step_stops, "anchor_search_initial_step_stops"),
            (c.anchor_search_max_stops, "anchor_search_max_stops"),
        ):
            if not np.isfinite(value) or value <= 0.0:
                raise ValueError(f"{label} must be finite and positive.")
        if (
            not isinstance(c.anchor_search_max_iterations, int)
            or c.anchor_search_max_iterations <= 0
        ):
            raise ValueError("anchor_search_max_iterations must be a positive integer.")
        if c.anchor_search_initial_step_stops > c.anchor_search_max_stops:
            raise ValueError(
                "anchor_search_initial_step_stops must not exceed anchor_search_max_stops."
            )
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
    if section == "compensation":
        if "ocio_config_path" in converted:
            converted["ocio_config_path"] = Path(converted["ocio_config_path"])
        if "profiles" in converted:
            converted["profiles"] = tuple(converted["profiles"])
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
        "compensation",
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
        "compensation": {
            "ocio_path": "ocio_config_path",
            "config_path": "ocio_config_path",
            "selected_profiles": "profiles",
            "profile_names": "profiles",
            "srgb_k": "srgb_chroma_companding_k",
            "p3_k": "p3_chroma_companding_k",
            "srgb_companding_k": "srgb_chroma_companding_k",
            "p3_companding_k": "p3_chroma_companding_k",
            "center": "target_intermediate_center",
            "tolerance": "round_trip_tolerance",
            "iterations": "solver_max_iterations",
            "mode": "fit_mode",
            "fit": "fit_mode",
            "auto_fit": "fit_mode",
            "target_center": "target_intermediate_center",
            "intermediate_center": "target_intermediate_center",
            "exposure_min": "exposure_min_stops",
            "exposure_max": "exposure_max_stops",
            "exposure_step": "exposure_step_stops",
            "min_exposure_stops": "exposure_min_stops",
            "max_exposure_stops": "exposure_max_stops",
            "step_exposure_stops": "exposure_step_stops",
            "fit_tolerance": "anchor_search_tolerance",
            "search_tolerance": "anchor_search_tolerance",
            "fit_iterations": "anchor_search_max_iterations",
            "search_iterations": "anchor_search_max_iterations",
            "initial_step_stops": "anchor_search_initial_step_stops",
            "max_search_stops": "anchor_search_max_stops",
            "fit_exposure_min_stops": "exposure_min_stops",
            "fit_exposure_max_stops": "exposure_max_stops",
            "fit_exposure_step_stops": "exposure_step_stops",
            "fit_search_tolerance": "anchor_search_tolerance",
            "fit_search_max_iterations": "anchor_search_max_iterations",
            "relative_tolerance": "round_trip_relative_tolerance",
            "round_trip_relative": "round_trip_relative_tolerance",
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
        # A numeric center in a TOML/override mapping is the established
        # manual-anchor interface.  Keep the default dataclass mode automatic,
        # but make the intent explicit when this key is supplied.
        explicit_center = section == "compensation" and any(
            key in normalized_values
            for key in (
                "target_intermediate_center",
                "center",
                "target_center",
                "intermediate_center",
            )
        )
        explicit_mode = section == "compensation" and any(
            key in normalized_values for key in ("fit_mode", "mode", "fit", "auto_fit")
        )
        for old_name, new_name in section_aliases.items():
            if old_name in normalized_values:
                if new_name in normalized_values:
                    raise ValueError(
                        f"Configuration section '{section}' contains both '{old_name}' and '{new_name}'."
                    )
                normalized_values[new_name] = normalized_values.pop(old_name)
        if section == "compensation" and "auto_fit" in values:
            normalized_values["fit_mode"] = "auto" if values["auto_fit"] else "manual"
        if section == "compensation" and "fit_mode" in normalized_values:
            normalized_values["fit_mode"] = _normalize_compensation_fit_mode(
                normalized_values["fit_mode"]
            )
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
        if section == "compensation" and explicit_center and not explicit_mode:
            normalized_values["fit_mode"] = "manual"
        if section == "compensation" and "companding" in normalized_values:
            companding = normalized_values.pop("companding")
            if not isinstance(companding, Mapping):
                raise ValueError("compensation.companding must be a TOML table.")
            gamut_aliases = {
                "srgb": "srgb_chroma_companding_k",
                "sRGB": "srgb_chroma_companding_k",
                "sRGB-D65": "srgb_chroma_companding_k",
                "srgb_k": "srgb_chroma_companding_k",
                "srgb_chroma_companding_k": "srgb_chroma_companding_k",
                "srgb_rec709_bt1886": "srgb_chroma_companding_k",
                "p3": "p3_chroma_companding_k",
                "P3": "p3_chroma_companding_k",
                "P3-D65": "p3_chroma_companding_k",
                "p3_k": "p3_chroma_companding_k",
                "p3_chroma_companding_k": "p3_chroma_companding_k",
                "p3_rec2020_pq": "p3_chroma_companding_k",
            }
            for name, value in companding.items():
                if name not in gamut_aliases:
                    raise ValueError(f"Unknown compensation.companding key: {name}")
                field_name = gamut_aliases[name]
                if field_name in normalized_values:
                    raise ValueError(
                        "Configuration section 'compensation' contains both "
                        f"'{name}' companding and '{field_name}'."
                    )
                normalized_values[field_name] = value
        if section == "output" and "selected_gamuts" in normalized_values:
            normalized_values["selected_gamuts"] = tuple(
                _normalize_gamut_name(name)
                for name in normalized_values["selected_gamuts"]
            )
        if section == "compensation" and "profiles" in normalized_values:
            normalized_values["profiles"] = tuple(
                _normalize_compensation_profile_name(name)
                for name in normalized_values["profiles"]
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


def _normalize_compensation_profile_name(name: str) -> str:
    aliases = {
        "srgb": "srgb_rec709_bt1886",
        "sRGB": "srgb_rec709_bt1886",
        "rec709": "srgb_rec709_bt1886",
        "rec709_bt1886": "srgb_rec709_bt1886",
        "srgb_rec709_bt1886": "srgb_rec709_bt1886",
        "p3": "p3_rec2020_pq",
        "P3": "p3_rec2020_pq",
        "rec2020": "p3_rec2020_pq",
        "rec2020_pq": "p3_rec2020_pq",
        "p3_rec2020_pq": "p3_rec2020_pq",
    }
    try:
        return aliases[name]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"Unknown compensation profile: {name}") from exc


def load_config(
    path: str | Path | None = None, overrides: Mapping[str, Any] | None = None
) -> Config:
    """Load defaults, an optional TOML file, then explicit overrides."""

    mapping: dict[str, Any] = {}
    explicit_ocio_path = False
    if path is not None:
        import tomllib

        config_path = Path(path)
        with config_path.open("rb") as handle:
            loaded = tomllib.load(handle)
        mapping.update(loaded)
        compensation_mapping = loaded.get("compensation")
        if isinstance(compensation_mapping, Mapping):
            explicit_ocio_path = any(
                key in compensation_mapping
                for key in ("ocio_config_path", "ocio_path", "config_path")
            )
    config = config_from_mapping(mapping)
    if (
        path is not None
        and explicit_ocio_path
        and not config.compensation.ocio_config_path.is_absolute()
    ):
        # Resolve a TOML-relative OCIO path against the TOML file location;
        # command-line and default configurations remain relative to cwd.
        config = replace(
            config,
            compensation=replace(
                config.compensation,
                ocio_config_path=(
                    Path(path).resolve().parent / config.compensation.ocio_config_path
                ),
            ),
        )
    elif path is not None and not explicit_ocio_path:
        # Keep the built-in default discoverable from a TOML launched in a
        # different working directory; an explicitly supplied path above is
        # always interpreted relative to that TOML file.
        default_path = config.compensation.ocio_config_path
        if not default_path.is_file():
            sibling = Path(path).resolve().parent / default_path
            if sibling.is_file():
                config = replace(
                    config,
                    compensation=replace(
                        config.compensation,
                        ocio_config_path=sibling,
                    ),
                )
    if overrides:
        config = config_from_mapping(overrides, base=config)
    return config.validate()
