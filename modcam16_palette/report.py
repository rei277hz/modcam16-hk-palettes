"""Human-readable generation diagnostics."""

from __future__ import annotations

import math

import numpy as np

from .config import Config
from .palette import PaletteResult


def print_generation_header(config: Config, model) -> None:
    a = config.appearance
    p = config.palette
    r = config.raster
    print(
        "Generating sRGB-D65-, P3-D65-, and AP1-gamut-cone C3-relative modCAM16-HK palettes..."
    )
    print()
    print(f"H-K model: J_HK = sqrt(J^2 + {a.hk_chroma_coefficient:g} C)")
    print("Underlying attributes: Hellwig-Fairchild revised CAM16")
    print("Boundary: nonnegative RGB gamut cone; no upper RGB limit")
    print(f"C3 reference domain: {p.c3_reference_domain}")
    print()
    print(f"Image size: {r.image_size} x {r.image_size}")
    print(f"Reference white: {a.reference_white_luminance_nits:.6f} cd/m^2")
    print("Neutral ACEScg value: (1.0, 1.0, 1.0)")
    print(
        f"Neutral physical luminance: {config.reference_neutral_luminance_nits:.6f} cd/m^2"
    )
    print(f"Background ratio: {a.reference_background_ratio:.6%}")
    print(f"Background luminance: {config.background_luminance_nits:.6f} cd/m^2")
    print(f"Background ACEScg value: {config.background_value:.10f}")
    print(f"Adapting luminance: {a.adapting_luminance_nits:.6f} cd/m^2")
    print(f"CAM background Y_b: {model.cam_y_b:.10f}")
    print(f"Surround: dark (c={a.surround_c:.6f}, N_c={a.surround_n_c:.6f})")
    print(f"Degree of adaptation D: {a.degree_of_adaptation:.6f}")
    print()
    print(f"Target J_HK: {model.target_j_hk:.10f}")
    print(f"Target Q_HK: {model.target_q_hk:.10f}")
    print(f"Constant-J_HK mathematical C limit: {model.hk_chroma_domain_limit:.10f}")
    print()
    print(f"Hue sectors: {p.hue_count}")
    print(f"Complete chromatic levels: {p.chroma_level_count}")


def print_colorchecker_assignments(result: PaletteResult, config: Config) -> None:
    if not config.colorchecker.enabled:
        print("ColorChecker markers: disabled")
        return
    stats = result.statistics
    print("ColorChecker chromatic-patch matches:")
    print("  Metric: Euclidean distance in (s*cos(h), s*sin(h)); brightness excluded")
    print(f"  Dataset: {config.colorchecker.dataset}")
    print(f"  Chromatic adaptation: {config.colorchecker.adaptation_method} -> D65")
    print(
        f"  Caps included as candidates: {config.colorchecker.include_caps_in_matching}"
    )
    print()
    for assignment in stats["colorchecker_assignments"]:
        if assignment["candidate_type"] == "block":
            location_text = (
                f"step {assignment['level_number']}/{config.palette.chroma_level_count}"
            )
        else:
            location_text = "boundary cap"
        print(
            f"  {assignment['patch_name']:<16} "
            f"target h={assignment['target_hue']:7.2f}°, s={assignment['target_saturation']:8.3f} "
            f"-> {location_text}, sector={assignment['palette_sector_hue']:6.1f}°, "
            f"C/C3={assignment['candidate_relative_chroma']:7.3%}, "
            f"palette h={assignment['candidate_hue']:7.2f}°, "
            f"s={assignment['candidate_saturation']:8.3f}, d={assignment['distance']:.4f}"
        )
    print()
    print(f"  Source chromatic patches: {len(stats['colorchecker_assignments'])}")
    print(
        f"  Unique visible dot locations: {stats['colorchecker_unique_marker_count']}"
    )
    print(f"  Dots on complete blocks: {stats['colorchecker_full_marker_count']}")
    print(f"  Dots on boundary caps: {stats['colorchecker_cap_marker_count']}")


def print_palette_report(result: PaletteResult, config: Config) -> None:
    stats = result.statistics
    hue_angles = stats["hue_angles"]
    rendered_cmax = stats["rendered_cmax_raw"]
    min_index = int(np.argmin(rendered_cmax))
    max_index = int(np.argmax(rendered_cmax))
    print()
    print(f"{result.gamut.name} C3:")
    print(f"  Raw C3: {stats['c3_raw']:.10f}")
    print(f"  C3 hue: {stats['c3_hue']:.7f}°")
    print(f"  C3 source: {stats['c3_source']}")
    print(f"  C3 active boundary: {stats['c3_active_face']}")
    print(f"  C3 raw boundary RGB: {stats['c3_raw_rgb']}")
    underlying_j = math.sqrt(
        max(
            0.0,
            stats["target_j_hk"] ** 2
            - config.appearance.hk_chroma_coefficient * stats["c3_raw"],
        )
    )
    print(f"  C3 underlying J: {underlying_j:.10f}")
    print()
    print(f"Rendered-sector {result.gamut.name} Cmax range:")
    print(f"  Minimum Cmax: {rendered_cmax[min_index]:.10f}")
    print(f"  At hue: {hue_angles[min_index]:.2f}°")
    print(f"  Cmax/C3: {stats['available_relative_chroma'][min_index]:.6%}")
    print(f"  Maximum Cmax: {rendered_cmax[max_index]:.10f}")
    print(f"  At hue: {hue_angles[max_index]:.2f}°")
    print(f"  Cmax/C3: {stats['available_relative_chroma'][max_index]:.6%}")
    print()
    print("Complete blocks drawn at each C3-relative level:")
    fractions = (
        np.arange(1, config.palette.chroma_level_count + 1)
        / config.palette.chroma_level_count
    )
    for index, (fraction, relative, count) in enumerate(
        zip(fractions, stats["relative_chroma_levels"], stats["blocks_per_level"]),
        start=1,
    ):
        print(
            f"  Step {index:>2}/{config.palette.chroma_level_count}: index={fraction:>7.1%}, C/C3={relative:>8.3%}, blocks={int(count):>2}/{config.palette.hue_count}"
        )
    print()
    print_colorchecker_assignments(result, config)
    print()
    print("Reference-gamut boundary markers:")
    for marker_name, enabled in (
        ("sRGB-D65", config.markers.enable_srgb_boundary_markers),
        ("P3-D65", config.markers.enable_p3_boundary_markers),
    ):
        print(
            f"  {marker_name}: {stats['individual_marker_counts'][marker_name] if enabled else 'disabled'}"
            + (" rectangle markers" if enabled else "")
        )
    print(f"  Combined visible marker positions: {stats['combined_marker_count']}")
    print(f"  Coincident sRGB/P3 marker positions: {stats['marker_overlap_count']}")
    print()
    print("Palette occupancy:")
    print(
        f"  Complete chromatic blocks: {stats['total_drawn_full_blocks']}/{stats['total_possible_full_blocks']}"
    )
    print(f"  Boundary caps: {config.palette.hue_count}")
    print(f"  Total palette colors: {stats['total_palette_colors']}")
    print()
    print("Appearance-model validation:")
    print(f"  Maximum J_HK error: {stats['j_hk_error']:.12g}")
    print(f"  Maximum C error: {stats['chroma_error']:.12g}")
    print(f"  Maximum hue error: {stats['hue_error']:.12g}°")
