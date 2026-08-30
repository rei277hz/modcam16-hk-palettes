from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from modcam16_palette import fitting
from modcam16_palette.aces_jmh import (
    REC709_D65_PRIMARIES_XY,
    REC2020_D65_PRIMARIES_XY,
    init_jmh_params,
)
from modcam16_palette.cli import generate
from modcam16_palette.colorimetry import GAMUT_MATRICES
from modcam16_palette.config import (
    COMPENSATION_PROFILE_DEFINITIONS,
    CompensationConfig,
    default_config,
    load_config,
)
from modcam16_palette.fitting import (
    evaluate_anchor_objective,
    unique_palette_colors,
)
from modcam16_palette.ocio_compensation import (
    compensate_foreground,
    load_compensation_processor,
    project_target_to_limiting_gamut,
    solve_neutral_y,
)


def _tiny_fit_config(output_dir, *, fit_mode="auto"):
    base = default_config()
    return replace(
        base,
        palette=replace(base.palette, hue_count=4, chroma_level_count=1),
        solver=replace(
            base.solver,
            c3_hue_sample_count=60,
            c3_max_refinement_candidates=2,
            boundary_coarse_steps=64,
            boundary_binary_iterations=40,
            boundary_face_tolerance=1.0e-6,
        ),
        raster=replace(
            base.raster,
            image_size=256,
            outer_margin=16.0,
            center_radius=32.0,
            radial_gap_pixels=3.0,
        ),
        markers=replace(base.markers, enable_srgb_boundary_markers=False),
        colorchecker=replace(base.colorchecker, enabled=False),
        output=replace(
            base.output,
            selected_gamuts=("sRGB-D65",),
            output_dir=output_dir,
        ),
        compensation=replace(
            base.compensation,
            profiles=("srgb_rec709_bt1886",),
            fit_mode=fit_mode,
            anchor_search_tolerance=0.25,
            anchor_search_max_iterations=2,
            anchor_search_max_stops=2.0,
        ),
    )


def test_aces_j_neutral_is_reference_white_for_both_profiles():
    for primaries in (REC709_D65_PRIMARIES_XY, REC2020_D65_PRIMARIES_XY):
        params = init_jmh_params(primaries)
        white_xyz = params.rgb_to_xyz @ np.ones(3)
        assert np.isclose(params.xyz_to_j(white_xyz), 100.0, atol=1.0e-10)
        assert params.xyz_to_j(np.zeros(3)) == 0.0
        assert params.xyz_to_j(-white_xyz) == 0.0
        with pytest.raises(ValueError):
            params.xyz_to_j(np.ones(2))


def test_default_exposure_grid_matches_release_example():
    config = default_config()
    assert config.compensation.exposure_stops == (
        -3.0,
        -2.5,
        -2.0,
        -1.5,
        -1.0,
        -0.5,
        0.0,
    )
    assert config.compensation.exposure_grid == config.compensation.exposure_stops


def test_compensation_profiles_define_finite_display_rgb_limits():
    sdr = COMPENSATION_PROFILE_DEFINITIONS["srgb_rec709_bt1886"]
    hdr = COMPENSATION_PROFILE_DEFINITIONS["p3_rec2020_pq"]
    assert sdr.display_peak_luminance_nits == 100.0
    assert sdr.display_reference_luminance_nits == 100.0
    assert sdr.limiting_rgb_maximum == 1.0
    assert hdr.display_peak_luminance_nits == 1000.0
    assert hdr.display_reference_luminance_nits == 100.0
    assert hdr.limiting_rgb_maximum == 10.0


def test_target_projection_handles_p3_red_sliver_outside_rec2020():
    """P3's red boundary is just outside the Rec.2020 limiting triangle."""

    params = init_jmh_params(REC2020_D65_PRIMARIES_XY)
    # A large P3-red-like XYZ value, expressed in the display-reference
    # coordinates used by the ACES output transform.
    p3_red_xyz = np.array([[3.9356625, 2.1430945, 0.02316724]], dtype=np.float32)
    before = params.xyz_to_rgb @ p3_red_xyz[0].astype(np.float64)
    assert before[2] < 0.0

    projection = project_target_to_limiting_gamut(p3_red_xyz, "p3_rec2020_pq")
    after = params.xyz_to_rgb @ projection.xyz[0].astype(np.float64)
    assert projection.projected_count == 1
    assert projection.maximum_xyz_adjustment > 0.0
    assert after[2] >= 0.0
    assert np.all(after[:2] >= 0.0)
    assert projection.lower_projected_count == 1
    assert projection.upper_projected_count == 0


def test_target_projection_handles_hdr_channel_above_1000_nit_peak():
    params = init_jmh_params(REC2020_D65_PRIMARIES_XY)
    limiting_rgb = np.array([[0.7705399, 0.14858342, 10.44053054]])
    target_xyz = np.asarray(limiting_rgb @ params.rgb_to_xyz.T, dtype=np.float32)

    projection = project_target_to_limiting_gamut(target_xyz, "p3_rec2020_pq")
    projected_rgb = projection.xyz.astype(np.float64) @ params.xyz_to_rgb.T

    assert projection.projected_count == 1
    assert projection.lower_projected_count == 0
    assert projection.upper_projected_count == 1
    assert projection.maximum_channel > 10.0
    assert projection.maximum_channel_limit == 10.0
    assert projection.maximum_xyz_adjustment > 0.4
    assert np.all(projected_rgb >= -1.0e-6)
    assert np.all(projected_rgb <= 10.0 + 1.0e-6)
    assert np.isclose(projected_rgb[0, 2], 10.0, atol=1.0e-6)


def test_round_trip_relative_tolerance_is_validated():
    base = default_config()
    assert base.compensation.round_trip_relative_tolerance == 2.0e-6
    config = replace(
        base,
        compensation=replace(base.compensation, round_trip_relative_tolerance=0.0),
    )
    config.validate()
    with pytest.raises(ValueError):
        replace(
            base,
            compensation=replace(base.compensation, round_trip_relative_tolerance=-1.0),
        ).validate()


def test_invalid_exposure_grid_is_rejected():
    base = default_config()
    for change in (
        {"exposure_step_stops": 0.4},
        {"exposure_max_stops": -4.0},
        {"exposure_step_stops": 0.0},
    ):
        config = replace(base, compensation=replace(base.compensation, **change))
        with pytest.raises(ValueError):
            config.validate()


def test_numeric_mapping_anchor_selects_manual_mode_but_explicit_auto_wins():
    manual = load_config(
        overrides={"compensation": {"target_intermediate_center": 0.42}}
    )
    assert manual.compensation.fit_mode == "manual"
    assert manual.compensation.manual_anchor == 0.42

    automatic = load_config(
        overrides={
            "compensation": {
                "target_intermediate_center": 0.42,
                "fit_mode": "automatic",
            }
        }
    )
    assert automatic.compensation.fit_mode == "auto"


def test_legacy_compensation_positional_constructor_order_is_preserved():
    config = CompensationConfig(
        True,
        ("srgb_rec709_bt1886",),
        Path("profile.ocio"),
        0.18,
        1.0e-5,
        1.0e-12,
        100,
        2.5,
        4.0,
    )
    assert config.target_intermediate_center == 0.18
    assert config.round_trip_tolerance == 1.0e-5
    assert config.srgb_chroma_companding_k == 2.5
    assert config.fit_mode == "auto"


def test_reference_neutral_y_above_one_is_valid_for_hdr_source():
    base = default_config()
    config = replace(
        base,
        appearance=replace(base.appearance, reference_neutral_y=1.25),
        compensation=replace(base.compensation, enabled=False),
    )
    config.validate()
    assert np.isclose(
        config.appearance.reference_neutral_y,
        1.25,
    )


def test_unique_palette_colors_excludes_invalid_rows_and_deduplicates_caps():
    result = SimpleNamespace(
        color_table=np.array(
            [
                [[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
                [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]],
            ],
            dtype=np.float32,
        ),
        block_valid_table=np.array([[True, False], [True, True]]),
        cap_color_table=np.array([[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32),
    )
    colors = unique_palette_colors(result)
    assert np.array_equal(
        colors,
        np.array(
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            dtype=np.float32,
        ),
    )


class _LinearXYZProcessor:
    def __init__(self, profile_name="srgb_rec709_bt1886"):
        self.profile = SimpleNamespace(name=profile_name)
        self.calls = []
        self._params = init_jmh_params(REC709_D65_PRIMARIES_XY)

    def target_forward_values(self, values):
        values = np.asarray(values, dtype=np.float32)
        self.calls.append(values.shape)
        return values @ self._params.rgb_to_xyz.T


def test_objective_batches_each_unique_color_at_each_exposure_once():
    processor = _LinearXYZProcessor()
    colors = np.array([[1.0, 1.0, 1.0], [0.2, 0.4, 0.8]], dtype=np.float32)
    rms, maximum, per_stop = evaluate_anchor_objective(
        colors,
        processor,
        "srgb_rec709_bt1886",
        (-1.0, 0.0, 1.0),
    )
    assert np.isfinite(rms)
    assert np.isfinite(maximum)
    assert len(per_stop) == 3
    assert processor.calls == [(6, 3), (3, 3)]
    with pytest.raises(ValueError):
        evaluate_anchor_objective(colors, processor, "srgb_rec709_bt1886", (0.0, 0.0))


def test_directional_fit_finds_minimum_on_either_side_and_survives_invalid_samples(
    monkeypatch,
):
    base = default_config()
    config = replace(
        base,
        compensation=replace(
            base.compensation,
            anchor_search_tolerance=0.01,
            anchor_search_max_iterations=8,
            anchor_search_initial_step_stops=1.0,
            anchor_search_max_stops=3.0,
        ),
    )
    profile = COMPENSATION_PROFILE_DEFINITIONS["srgb_rec709_bt1886"]
    gamut = GAMUT_MATRICES["sRGB-D65"]

    def run(target, invalid_lower=None, invalid_upper=None):
        def factory(_config, _gamut, _profile, _processor, x):
            if invalid_lower is not None and x < invalid_lower:
                raise RuntimeError("lower side unavailable")
            if invalid_upper is not None and x > invalid_upper:
                raise RuntimeError("upper side unavailable")
            error = (x - target) ** 2
            return SimpleNamespace(
                anchor_log2=float(x),
                anchor=float(2.0**x),
                rms_error=float(error),
                source_y=1.0,
                source_config=config,
                source_model=None,
                palette=None,
                intermediate_center=np.ones(3),
                scaled_colors=np.empty((0, 3), dtype=np.float32),
                color_count=0,
                maximum_error=float(error),
                per_stop_rms=(float(error),),
            )

        monkeypatch.setattr(fitting, "_candidate_factory", factory)
        return fitting._fit_candidate(config, gamut, profile, object())

    seed = np.log2(config.compensation.target_intermediate_center)
    right, legacy, _ = run(seed + 1.8, invalid_upper=seed + 2.4)
    assert right.anchor_log2 > seed
    assert right.rms_error < legacy.rms_error

    left, legacy, _ = run(seed - 1.8, invalid_lower=seed - 2.4)
    assert left.anchor_log2 < seed
    assert left.rms_error < legacy.rms_error


def test_automatic_generation_publishes_white_and_fit_metadata(tmp_path):
    pytest.importorskip("OpenEXR")
    config = _tiny_fit_config(tmp_path)
    paths = generate(config, verbose=False)
    ordinary = [path for path in paths if "ACESJFit" not in path.name]
    compensated = [path for path in paths if "ACESJFit" in path.name]
    assert len(ordinary) == 1
    assert len(compensated) == 1
    assert "ACESJFit_A" in compensated[0].name

    import OpenEXR

    with OpenEXR.File(str(compensated[0])) as exr:
        header = exr.header()
        pixels = exr.channels()["RGB"].pixels
        assert pixels.dtype == np.float32
        assert np.array_equal(pixels[128, 128], np.ones(3, dtype=np.float32))
        assert header["compensationFitMode"] == "auto"
        assert header["compensationFitExposureMin"] == -3.0
        assert header["compensationFitExposureMax"] == 0.0
        assert header["compensationFitExposureStep"] == 0.5
        assert header["compensationFitSampleCount"] == (
            header["compensationFitColorCount"] * 7
        )
        assert header["compensationFitRMS"] <= header["compensationFitLegacyRMS"]
        assert header["compensationTargetGamutProjectionCount"] == 0
        assert header["compensationTargetGamutLowerProjectionCount"] == 0
        assert header["compensationTargetGamutUpperProjectionCount"] == 0
        assert header["compensationTargetGamutMaximumLimit"] == 1.0
        assert header["compensationDisplayPeakNits"] == 100.0
        assert header["compensationRoundTripNormalizedMax"] >= 0.0
        assert "fitted anchor=" in header["comments"]

    with OpenEXR.File(str(ordinary[0])) as exr:
        assert np.array_equal(
            exr.channels()["RGB"].pixels[128, 128],
            np.ones(3, dtype=np.float32),
        )
        assert "compensationFitMode" not in exr.header()


def test_compensated_generation_uses_post_view_colorchecker_markers(tmp_path):
    pytest.importorskip("OpenEXR")
    base = _tiny_fit_config(tmp_path)
    config = replace(
        base,
        colorchecker=replace(
            base.colorchecker,
            enabled=True,
            compensated_marker_exposure_min_stops=-1.0,
            compensated_marker_exposure_max_stops=1.0,
            compensated_marker_exposure_step_stops=1.0,
        ),
    )
    paths = generate(config, verbose=False)
    compensated = [path for path in paths if "ACESJFit" in path.name]
    assert len(compensated) == 1
    import OpenEXR

    with OpenEXR.File(str(compensated[0])) as exr:
        header = exr.header()
        assert header["colorCheckerMatchMode"] == "post-view ACES JMh exposure"
        assert header["colorCheckerMatchExposureMin"] == -1.0
        assert header["colorCheckerMatchExposureMax"] == 1.0
        assert header["colorCheckerMatchExposureStep"] == 1.0
        assert header["colorCheckerMatchExposureSamples"] == 3
        assert "candidate locations may be reused" in header[
            "colorCheckerMatchAssignmentPolicy"
        ]
        assert header["colorCheckerMatchCandidateCount"] > 0
        assert header["colorCheckerMatchEvaluationCount"] == 18 * (
            header["colorCheckerMatchCandidateCount"]
        ) * 3
        assert "post-view ACES JMh" in header["comments"]


def test_manual_fit_keeps_legacy_anchor_and_filename(tmp_path):
    pytest.importorskip("OpenEXR")
    config = _tiny_fit_config(tmp_path, fit_mode="manual")
    paths = generate(config, verbose=False)
    compensated = [path for path in paths if "ACES2Inv" in path.name]
    assert len(compensated) == 1
    assert "TargetY0p18_Scale5p55555555556" in compensated[0].name
    assert "ACESJFit" not in compensated[0].name


def test_p3_hdr_compensation_projects_boundary_cap_and_completes():
    """The Rec.2020-limited HDR inverse accepts the P3 red boundary cap."""

    try:
        base = default_config()
        anchor = 4.068553612582953
        compensation = replace(
            base.compensation,
            profiles=("p3_rec2020_pq",),
            target_intermediate_center=anchor,
            fit_mode="manual",
        )
        processor = load_compensation_processor(compensation, "p3_rec2020_pq")
    except RuntimeError as exc:
        if "PyOpenColorIO" in str(exc):
            return
        raise

    source_y, _center = solve_neutral_y(
        processor, compensation, target_intermediate_center=anchor
    )
    # This is the P3 hue-30 cap from the default HDR fit, represented as an
    # ACEScg pixel. It has a negative Rec.2020 blue channel by about 4e-4.
    image = np.array([[[5.8542004, 0.8500895, 0.04895351]]], dtype=np.float32)
    mask = np.ones((1, 1), dtype=bool)
    compensated, diagnostics = compensate_foreground(
        image,
        mask,
        processor,
        compensation,
        source_y,
        intermediate_center_target=anchor,
    )
    assert np.all(np.isfinite(compensated))
    assert diagnostics.target_gamut_projection_pixel_count == 1
    assert diagnostics.target_gamut_projection_max_error > 0.0
    assert diagnostics.intermediate_round_trip_pixels_above_tolerance == 0


def test_p3_hdr_compensation_projects_1000_nit_peak_and_completes():
    """A P3 target above the Rec.2020 1000-nit ceiling remains invertible."""

    try:
        base = default_config()
        anchor = 4.341653734057282
        compensation = replace(
            base.compensation,
            profiles=("p3_rec2020_pq",),
            p3_chroma_companding_k=20.0,
            target_intermediate_center=anchor,
            fit_mode="manual",
        )
        processor = load_compensation_processor(compensation, "p3_rec2020_pq")
    except RuntimeError as exc:
        if "PyOpenColorIO" in str(exc):
            return
        raise

    source_y, _center = solve_neutral_y(
        processor, compensation, target_intermediate_center=anchor
    )
    # This ACEScg color maps to approximately (0.77054, 0.14858, 10.44053)
    # in the Rec.2020 display-reference RGB coordinates.  The blue channel is
    # above the 1000-nit peak and must be projected to exactly 10 before the
    # inverse view transform.
    image = np.array([[[0.8115921, 0.17345583, 10.141659]]], dtype=np.float32)
    compensated, diagnostics = compensate_foreground(
        image,
        np.ones((1, 1), dtype=bool),
        processor,
        compensation,
        source_y,
        intermediate_center_target=anchor,
    )
    assert np.all(np.isfinite(compensated))
    assert diagnostics.target_gamut_projection_pixel_count == 1
    assert diagnostics.target_gamut_lower_projection_pixel_count == 0
    assert diagnostics.target_gamut_upper_projection_pixel_count == 1
    assert diagnostics.target_gamut_maximum_channel_limit == 10.0
    assert diagnostics.intermediate_round_trip_pixels_above_tolerance == 0
