"""Scene-linear fp32 ACEScg OpenEXR output."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import OpenEXR

from .config import Config


def make_comments(
    config: Config,
    gamut_name: str,
    statistics: dict[str, object],
) -> str:
    enabled_names = config.markers.enabled_reference_names
    if enabled_names:
        marker_comment = (
            "background-colored radial rectangles identify genuine "
            f"crossings of {' and '.join(enabled_names)} boundaries; "
        )
    else:
        marker_comment = "reference-gamut boundary markers disabled; "

    cc = config.colorchecker
    if cc.enabled:
        colorchecker_comment = (
            f"ColorChecker dataset={cc.dataset}; "
            f"ColorChecker adaptation={cc.adaptation_method}; "
            "first eighteen chromatic patches only; "
            "nearest matching uses Hellwig saturation and hue only; "
            f"ColorChecker dot radius={cc.dot_radius_pixels:g} pixels; "
        )
    else:
        colorchecker_comment = "ColorChecker markers disabled; "

    p = config.palette
    a = config.appearance
    compensation_comment = ""
    if statistics.get("compensation_enabled"):
        projection_count = int(
            statistics.get("compensation_target_gamut_projection_pixel_count", 0)
        )
        projection_max = float(
            statistics.get("compensation_target_gamut_projection_max_error", 0.0)
        )
        projection_lower_count = int(
            statistics.get("compensation_target_gamut_lower_projection_pixel_count", 0)
        )
        projection_upper_count = int(
            statistics.get("compensation_target_gamut_upper_projection_pixel_count", 0)
        )
        display_peak = float(
            statistics.get("compensation_target_display_peak_luminance_nits", 0.0)
        )
        fit_comment = ""
        if "compensation_fit_mode" in statistics:
            fit_comment = (
                f"fit mode={statistics['compensation_fit_mode']}; "
                f"fitted anchor={statistics['compensation_fitted_anchor']:.9g}; "
                f"fit objective={statistics['compensation_fit_objective']}; "
                f"fit exposure={statistics['compensation_fit_exposure_min_stops']:.9g}.."
                f"{statistics['compensation_fit_exposure_max_stops']:.9g} stops @ "
                f"{statistics['compensation_fit_exposure_step_stops']:.9g}; "
                f"fit RMS={statistics['compensation_fit_rms_error']:.9g}; "
                f"fit max={statistics['compensation_fit_maximum_error']:.9g}; "
            )
        compensation_comment = (
            "ACES 2.0 inverse-view compensation; "
            f"profile={statistics['compensation_profile']}; "
            f"view={statistics['compensation_view_transform']}; "
            f"display={statistics['compensation_display_name']}; "
            f"source Y={statistics['compensation_solved_source_y']:.15g}; "
            f"intermediate center={statistics['compensation_target_intermediate_center']:.9g}; "
            f"intermediate center max error={statistics['compensation_intermediate_center_max_error']:.9g}; "
            f"target-gamut projected pixels={projection_count}; "
            f"lower={projection_lower_count}; upper/peak={projection_upper_count}; "
            f"target-gamut projection max={projection_max:.9g}; "
            f"display peak={display_peak:.9g} nits; "
            f"foreground scale={statistics['compensation_scale_factor']:.9g}; "
            f"OCIO config={statistics['compensation_ocio_config_path']}; "
            f"OCIO cache ID={statistics['compensation_ocio_config_cache_id']}; "
            f"intermediate round-trip max={statistics['compensation_intermediate_round_trip_max_error']:.9g}; "
            f"round-trip tolerances abs={config.compensation.round_trip_tolerance:.9g}, "
            f"rel={config.compensation.round_trip_relative_tolerance:.9g}; "
            f"encoded round-trip max={statistics['compensation_encoded_display_round_trip_max_error']:.9g}; "
            f"post-scale encoded max={statistics['compensation_post_scale_display_max_error']:.9g}; "
            + fit_comment
        )
    center_comment = (
        "center ACEScg=(1,1,1); "
        if not statistics.get("compensation_enabled")
        else "published center ACEScg=(1,1,1); source neutral is profile-specific; "
    )
    transform_comment = (
        "no transfer function, clipping, tone mapping, gamut mapping, "
        "or display transform baked in."
        if not statistics.get("compensation_enabled")
        else "inverse ACES 2.0 view transform is baked into foreground colors; "
        "display encoding is not baked in; source targets outside the view's "
        "reachable RGB volume are component-wise clamped before inversion."
    )
    gamut_comment = (
        f"content constrained to nonnegative linear {gamut_name} RGB gamut cone; "
        "no upper RGB bound; values above one permitted; "
        if not statistics.get("compensation_enabled")
        else f"source palette was constrained to the {gamut_name} RGB gamut cone; "
        "source cap geometry is unchanged by target-volume projection; "
        "inverse foreground values have no upper bound; "
    )
    return (
        "Equal-perceived-brightness radial palette; "
        "Hellwig-Fairchild revised CAM16 attributes; "
        f"J_HK=sqrt(J^2+{a.hk_chroma_coefficient:.10g}*C); "
        f"target J_HK={statistics['target_j_hk']:.10f}; "
        f"reference white={a.reference_white_luminance_nits:.6f} cd/m^2; "
        + center_comment
        + compensation_comment
        + f"C3={statistics['c3_raw']:.10f}; "
        + f"C3 domain={p.c3_reference_domain}; "
        + f"full levels={p.chroma_level_count}; "
        + f"chroma companding k={statistics['chroma_companding_k']:g}; "
        + f"C/C3=((1+k)^(n/{p.chroma_level_count})-1)/k; "
        + f"cap height={p.cap_relative_height:g} of a full block; "
        + "one gamut-boundary cap per hue; "
        + f"{marker_comment}"
        + f"{colorchecker_comment}"
        + gamut_comment
        + "pixels encoded as scene-linear ACEScg/AP1; "
        + transform_comment
    )


def write_float_rgb_exr(
    output_path: str | Path,
    image: np.ndarray,
    gamut_name: str,
    config: Config,
    statistics: dict[str, object],
) -> None:
    """Write an H x W x three-channel fp32 OpenEXR."""

    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("Image must have shape H x W x 3.")
    if config.output.exr_compression.lower() != "zip":
        raise ValueError("Only ZIP OpenEXR compression is supported.")
    rgb_pixels = np.ascontiguousarray(image, dtype=np.float32)
    comments = make_comments(config, gamut_name, statistics)
    header = {
        "compression": OpenEXR.ZIP_COMPRESSION,
        "type": OpenEXR.scanlineimage,
        "ocioColorSpace": "ACEScg",
        "comments": comments,
        # Keep the legacy metadata value for generated-file compatibility.
        "software": "make_modcam16hk_c3_log_caps_markers_colorchecker.py",
    }
    if statistics.get("compensation_enabled"):
        compensation_header = {
            "compensationProfile": str(statistics["compensation_profile"]),
            "compensationSourceGamut": str(statistics["compensation_source_gamut"]),
            "compensationDisplay": str(statistics["compensation_display_name"]),
            "compensationView": str(statistics["compensation_view_transform"]),
            "compensationOCIOConfig": str(statistics["compensation_ocio_config_path"]),
            "compensationOCIOCacheID": str(
                statistics["compensation_ocio_config_cache_id"]
            ),
            "compensationSourceY": float(statistics["compensation_solved_source_y"]),
            "compensationIntermediateCenter": float(
                statistics["compensation_target_intermediate_center"]
            ),
            "compensationIntermediateCenterError": float(
                statistics["compensation_intermediate_center_max_error"]
            ),
            "compensationScale": float(statistics["compensation_scale_factor"]),
            "compensationPostScaleMinimum": float(
                statistics["compensation_post_scale_minimum"]
            ),
            "compensationPostScaleMaximum": float(
                statistics["compensation_post_scale_maximum"]
            ),
            "compensationPostScaleNonfinite": int(
                statistics["compensation_post_scale_nonfinite_count"]
            ),
            "compensationPostScaleNegative": int(
                statistics["compensation_post_scale_negative_count"]
            ),
            "compensationRoundTripMax": float(
                statistics["compensation_intermediate_round_trip_max_error"]
            ),
            "compensationRoundTripNormalizedMax": float(
                statistics.get(
                    "compensation_intermediate_round_trip_max_normalized_error",
                    0.0,
                )
            ),
            "compensationRoundTripCount": int(
                statistics[
                    "compensation_intermediate_round_trip_pixels_above_tolerance"
                ]
            ),
            "compensationRoundTripAbsoluteTolerance": float(
                config.compensation.round_trip_tolerance
            ),
            "compensationRoundTripRelativeTolerance": float(
                config.compensation.round_trip_relative_tolerance
            ),
            "compensationEncodedRoundTripMax": float(
                statistics["compensation_encoded_display_round_trip_max_error"]
            ),
            "compensationEncodedRoundTripCount": int(
                statistics[
                    "compensation_encoded_display_round_trip_pixels_above_tolerance"
                ]
            ),
            "compensationPostScaleDisplayMax": float(
                statistics["compensation_post_scale_display_max_error"]
            ),
            "compensationPostScaleDisplayCount": int(
                statistics["compensation_post_scale_display_pixels_above_tolerance"]
            ),
            "compensationTargetGamutMinimum": float(
                statistics.get("compensation_target_gamut_minimum_channel", 0.0)
            ),
            "compensationTargetGamutMaximum": float(
                statistics.get("compensation_target_gamut_maximum_channel", 0.0)
            ),
            "compensationTargetGamutMaximumLimit": float(
                statistics.get("compensation_target_gamut_maximum_channel_limit", 0.0)
            ),
            "compensationTargetGamutProjectionMax": float(
                statistics.get("compensation_target_gamut_projection_max_error", 0.0)
            ),
            "compensationTargetGamutProjectionCount": int(
                statistics.get("compensation_target_gamut_projection_pixel_count", 0)
            ),
            "compensationTargetGamutLowerProjectionCount": int(
                statistics.get(
                    "compensation_target_gamut_lower_projection_pixel_count", 0
                )
            ),
            "compensationTargetGamutUpperProjectionCount": int(
                statistics.get(
                    "compensation_target_gamut_upper_projection_pixel_count", 0
                )
            ),
            "compensationDisplayPeakNits": float(
                statistics.get("compensation_target_display_peak_luminance_nits", 0.0)
            ),
        }
        if "compensation_fit_mode" in statistics:
            compensation_header.update(
                {
                    "compensationFitMode": str(statistics["compensation_fit_mode"]),
                    "compensationFittedAnchor": float(
                        statistics["compensation_fitted_anchor"]
                    ),
                    "compensationFittedAnchorLog2": float(
                        statistics["compensation_fitted_anchor_log2"]
                    ),
                    "compensationFitExposureMin": float(
                        statistics["compensation_fit_exposure_min_stops"]
                    ),
                    "compensationFitExposureMax": float(
                        statistics["compensation_fit_exposure_max_stops"]
                    ),
                    "compensationFitExposureStep": float(
                        statistics["compensation_fit_exposure_step_stops"]
                    ),
                    "compensationFitObjective": str(
                        statistics["compensation_fit_objective"]
                    ),
                    "compensationFitColorCount": int(
                        statistics["compensation_fit_evaluated_color_count"]
                    ),
                    "compensationFitSampleCount": int(
                        statistics["compensation_fit_evaluated_sample_count"]
                    ),
                    "compensationFitRMS": float(
                        statistics["compensation_fit_rms_error"]
                    ),
                    "compensationFitMax": float(
                        statistics["compensation_fit_maximum_error"]
                    ),
                    "compensationFitPerStopRMS": ",".join(
                        f"{float(value):.9g}"
                        for value in statistics["compensation_fit_per_stop_rms"]
                    ),
                    "compensationFitSearchEvaluations": int(
                        statistics["compensation_fit_search_evaluation_count"]
                    ),
                    "compensationFitLegacyAnchor": float(
                        statistics["compensation_fit_legacy_anchor"]
                    ),
                    "compensationFitLegacyRMS": float(
                        statistics["compensation_fit_legacy_rms_error"]
                    ),
                }
            )
        header.update(compensation_header)
    channels = {"RGB": rgb_pixels}
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with OpenEXR.File(header, channels) as output_file:
        output_file.write(str(output_path))
