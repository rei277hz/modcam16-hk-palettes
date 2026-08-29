"""Raster geometry and radial palette rendering."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .config import Config
from .palette import PaletteResult


@dataclass(frozen=True)
class RenderedPalette:
    """Rasterized palette plus masks used by post-render compensation."""

    image: np.ndarray
    foreground_mask: np.ndarray
    center_mask: np.ndarray
    overlay_mask: np.ndarray


def draw_solid_dot(
    image: np.ndarray,
    center_x: float,
    center_y: float,
    radius: float,
    color: np.ndarray,
) -> None:
    """Draw a hard-edged solid circular dot into an image."""

    height, width, _channels = image.shape
    x_min = max(0, math.floor(center_x - radius))
    x_max = min(width - 1, math.ceil(center_x + radius))
    y_min = max(0, math.floor(center_y - radius))
    y_max = min(height - 1, math.ceil(center_y + radius))
    if x_min > x_max or y_min > y_max:
        return
    x_coordinates = np.arange(x_min, x_max + 1, dtype=np.float64)
    y_coordinates = np.arange(y_min, y_max + 1, dtype=np.float64)
    local_x = x_coordinates[None, :] - center_x
    local_y = y_coordinates[:, None] - center_y
    mask = local_x * local_x + local_y * local_y <= radius * radius
    image[y_min : y_max + 1, x_min : x_max + 1][mask] = color


def _mark_dot_overlay(
    foreground_mask: np.ndarray,
    overlay_mask: np.ndarray,
    center_x: float,
    center_y: float,
    radius: float,
) -> None:
    """Remove a background-colored dot from foreground ownership masks."""

    height, width = foreground_mask.shape
    x_min = max(0, math.floor(center_x - radius))
    x_max = min(width - 1, math.ceil(center_x + radius))
    y_min = max(0, math.floor(center_y - radius))
    y_max = min(height - 1, math.ceil(center_y + radius))
    if x_min > x_max or y_min > y_max:
        return
    x_coordinates = np.arange(x_min, x_max + 1, dtype=np.float64)
    y_coordinates = np.arange(y_min, y_max + 1, dtype=np.float64)
    local_x = x_coordinates[None, :] - center_x
    local_y = y_coordinates[:, None] - center_y
    mask = local_x * local_x + local_y * local_y <= radius * radius
    foreground_mask[y_min : y_max + 1, x_min : x_max + 1][mask] = False
    overlay_mask[y_min : y_max + 1, x_min : x_max + 1][mask] = True


def polar_position_to_image_xy(
    image_center: float,
    radius: float,
    hue_degrees: float,
    clockwise: bool = False,
) -> tuple[float, float]:
    """Convert wheel radius/hue to image pixel coordinates."""

    physical_clockwise_angle = hue_degrees if clockwise else -hue_degrees
    angle_radians = math.radians(physical_clockwise_angle)
    return (
        image_center + radius * math.sin(angle_radians),
        image_center - radius * math.cos(angle_radians),
    )


def render_palette_layers(result: PaletteResult, config: Config) -> RenderedPalette:
    """Rasterize the palette and retain foreground/overlay ownership masks."""

    config.validate()
    p = config.palette
    r = config.raster
    m = config.markers
    cc = config.colorchecker
    image_size = r.image_size
    n = p.chroma_level_count
    h_count = p.hue_count

    color_table = result.color_table
    block_valid_table = result.block_valid_table
    cap_color_table = result.cap_color_table
    cap_after_level_counts = result.cap_after_level_counts
    boundary_marker_table = result.boundary_marker_table
    colorchecker_full_marker_table = result.colorchecker_full_marker_table
    colorchecker_cap_marker_table = result.colorchecker_cap_marker_table
    expected_full_shape = (n, h_count)
    if color_table.shape != (*expected_full_shape, 3):
        raise ValueError("color_table has an unexpected shape.")
    if block_valid_table.shape != expected_full_shape:
        raise ValueError("block_valid_table has an unexpected shape.")
    if cap_color_table.shape != (h_count, 3):
        raise ValueError("cap_color_table has an unexpected shape.")
    if cap_after_level_counts.shape != (h_count,):
        raise ValueError("cap_after_level_counts has an unexpected shape.")
    if boundary_marker_table.shape != expected_full_shape:
        raise ValueError("boundary_marker_table has an unexpected shape.")
    if colorchecker_full_marker_table.shape != expected_full_shape:
        raise ValueError("colorchecker_full_marker_table has an unexpected shape.")
    if colorchecker_cap_marker_table.shape != (h_count,):
        raise ValueError("colorchecker_cap_marker_table has an unexpected shape.")

    image_center = (image_size - 1) * 0.5
    outer_radius = image_center - r.outer_margin
    if r.center_radius >= outer_radius:
        raise ValueError("CENTER_RADIUS is too large.")
    total_radial_units = n + p.cap_relative_height
    ring_pitch = (outer_radius - r.center_radius) / total_radial_units
    if r.radial_gap_pixels >= ring_pitch:
        raise ValueError("RADIAL_GAP_PIXELS is too large.")
    full_block_drawable_height = ring_pitch - r.radial_gap_pixels
    if (
        config.any_reference_boundary_markers_enabled
        and m.boundary_marker_block_overlap_pixels >= full_block_drawable_height
    ):
        raise ValueError("Boundary-marker overlap would cover a full block.")
    cap_drawable_height = p.cap_relative_height * full_block_drawable_height
    if cap_drawable_height <= 0.0:
        raise ValueError("Configured cap has no drawable height.")
    ring_edges = r.center_radius + np.arange(n + 1, dtype=np.float64) * ring_pitch
    hue_step = 360.0 / h_count
    if r.angular_gap_degrees >= hue_step:
        raise ValueError("ANGULAR_GAP_DEGREES must be smaller than one sector.")

    image = np.full(
        (image_size, image_size, 3), config.background_value, dtype=np.float32
    )
    foreground_mask = np.zeros((image_size, image_size), dtype=bool)
    overlay_mask = np.zeros((image_size, image_size), dtype=bool)
    coordinate = np.arange(image_size, dtype=np.float32) - np.float32(image_center)
    x = coordinate[None, :]
    y = coordinate[:, None]
    radius = np.hypot(x, y).astype(np.float32, copy=False)
    wheel_angle = np.mod(np.degrees(np.arctan2(x, -y)), 360.0).astype(
        np.float32, copy=False
    )
    if not p.clockwise:
        wheel_angle = np.mod(-wheel_angle, 360.0).astype(np.float32, copy=False)
    radial_half_gap = r.radial_gap_pixels * 0.5

    center_mask = radius <= r.center_radius - radial_half_gap
    center_color = result.reference_neutral_acescg
    if center_color is None:
        # Compatibility for callers constructing a PaletteResult manually.
        center_color = np.ones(3, dtype=np.float64)
    center_color = np.asarray(center_color, dtype=np.float32)
    if center_color.shape != (3,) or not np.all(np.isfinite(center_color)):
        raise ValueError("reference_neutral_acescg must be a finite RGB triplet.")
    image[center_mask] = center_color
    foreground_mask[center_mask] = True

    ring_index = np.full((image_size, image_size), -1, dtype=np.int16)
    for current_ring in range(n):
        inner_edge = ring_edges[current_ring] + radial_half_gap
        outer_edge = ring_edges[current_ring + 1] - radial_half_gap
        ring_body = (radius >= inner_edge) & (radius <= outer_edge)
        ring_index[ring_body] = current_ring
    radial_valid = ring_index >= 0
    half_hue_step = hue_step * 0.5
    if p.hue_offset_degrees == 0.0:
        sector_angle = wheel_angle
    else:
        sector_angle = np.mod(wheel_angle - np.float32(p.hue_offset_degrees), 360.0)
    hue_index = np.floor((sector_angle + half_hue_step) / hue_step).astype(np.int16)
    hue_index = np.mod(hue_index, h_count).astype(np.int16)
    sector_center_angle = np.float32(p.hue_offset_degrees) + hue_index.astype(
        np.float32
    ) * np.float32(hue_step)
    angular_distance = (wheel_angle - sector_center_angle + 180.0) % 360.0 - 180.0
    angular_half_width = (hue_step - r.angular_gap_degrees) * 0.5
    angular_valid = np.abs(angular_distance) <= angular_half_width
    safe_ring_index = np.clip(ring_index, 0, n - 1)
    block_exists = block_valid_table[safe_ring_index, hue_index]
    complete_block_mask = radial_valid & angular_valid & block_exists
    image[complete_block_mask] = color_table[
        ring_index[complete_block_mask], hue_index[complete_block_mask]
    ]
    foreground_mask[complete_block_mask] = True

    pixel_cap_after_count = cap_after_level_counts[hue_index]
    pixel_cap_base_radius = r.center_radius + pixel_cap_after_count.astype(
        np.float32
    ) * np.float32(ring_pitch)
    pixel_cap_inner_radius = pixel_cap_base_radius + np.float32(radial_half_gap)
    pixel_cap_outer_radius = pixel_cap_inner_radius + np.float32(cap_drawable_height)
    cap_mask = (
        angular_valid
        & (radius >= pixel_cap_inner_radius)
        & (radius <= pixel_cap_outer_radius)
    )
    image[cap_mask] = cap_color_table[hue_index[cap_mask]]
    foreground_mask[cap_mask] = True

    if np.any(boundary_marker_table):
        marker_radial_half_length = (
            radial_half_gap + m.boundary_marker_block_overlap_pixels
        )
        marker_tangential_half_width = m.boundary_marker_tangential_width_pixels * 0.5
        marker_delta_radians = np.deg2rad(angular_distance).astype(
            np.float32, copy=False
        )
        marker_radial_projection = (radius * np.cos(marker_delta_radians)).astype(
            np.float32, copy=False
        )
        marker_tangential_projection = (radius * np.sin(marker_delta_radians)).astype(
            np.float32, copy=False
        )
        combined_marker_mask = np.zeros((image_size, image_size), dtype=bool)
        for next_level_index in range(n):
            marker_hue_exists = boundary_marker_table[next_level_index, hue_index]
            if not np.any(marker_hue_exists):
                continue
            marker_center_radius = np.float32(ring_edges[next_level_index])
            local_radial_coordinate = marker_radial_projection - marker_center_radius
            rectangle_mask = (
                marker_hue_exists
                & angular_valid
                & (np.abs(local_radial_coordinate) <= marker_radial_half_length)
                & (np.abs(marker_tangential_projection) <= marker_tangential_half_width)
            )
            combined_marker_mask |= rectangle_mask
        image[combined_marker_mask] = np.full(
            3, config.background_value, dtype=np.float32
        )
        foreground_mask[combined_marker_mask] = False
        overlay_mask[combined_marker_mask] = True

    if cc.enabled:
        full_locations = np.argwhere(colorchecker_full_marker_table)
        for ring_location, hue_location in full_locations:
            radial_center = r.center_radius + (float(ring_location) + 0.5) * ring_pitch
            hue_degrees = (
                p.hue_offset_degrees + float(hue_location) * hue_step
            ) % 360.0
            dot_x, dot_y = polar_position_to_image_xy(
                image_center, radial_center, hue_degrees, p.clockwise
            )
            draw_solid_dot(
                image,
                dot_x,
                dot_y,
                cc.dot_radius_pixels,
                np.full(3, config.background_value, dtype=np.float32),
            )
            _mark_dot_overlay(
                foreground_mask,
                overlay_mask,
                dot_x,
                dot_y,
                cc.dot_radius_pixels,
            )
        cap_locations = np.flatnonzero(colorchecker_cap_marker_table)
        for hue_location in cap_locations:
            cap_base_radius = (
                r.center_radius
                + float(cap_after_level_counts[hue_location]) * ring_pitch
            )
            cap_center_radius = (
                cap_base_radius + radial_half_gap + 0.5 * cap_drawable_height
            )
            hue_degrees = (
                p.hue_offset_degrees + float(hue_location) * hue_step
            ) % 360.0
            dot_x, dot_y = polar_position_to_image_xy(
                image_center, cap_center_radius, hue_degrees, p.clockwise
            )
            draw_solid_dot(
                image,
                dot_x,
                dot_y,
                cc.dot_radius_pixels,
                np.full(3, config.background_value, dtype=np.float32),
            )
            _mark_dot_overlay(
                foreground_mask,
                overlay_mask,
                dot_x,
                dot_y,
                cc.dot_radius_pixels,
            )
    return RenderedPalette(image, foreground_mask, center_mask, overlay_mask)


def render_radial_palette(
    result: PaletteResult,
    config: Config,
    *,
    return_masks: bool = False,
) -> np.ndarray | RenderedPalette:
    """Rasterize the palette, optionally returning ownership masks.

    ``return_masks=False`` preserves the original ndarray-returning API.
    ``return_masks=True`` is a shorthand for :func:`render_palette_layers` for
    callers implementing post-render operations.
    """

    rendered = render_palette_layers(result, config)
    return rendered if return_masks else rendered.image


def render_radial_palette_with_masks(
    result: PaletteResult, config: Config
) -> RenderedPalette:
    """Explicit alias for code that needs foreground/overlay ownership."""

    return render_palette_layers(result, config)
