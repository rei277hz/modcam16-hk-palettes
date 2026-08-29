from dataclasses import replace

import numpy as np

from modcam16_palette.cam16_hk import AppearanceModel
from modcam16_palette.cli import generate
from modcam16_palette.colorimetry import GAMUT_MATRICES, XYZ_D65_TO_ACESCG
from modcam16_palette.config import (
    COMPENSATION_PROFILE_DEFINITIONS,
    default_config,
    load_config,
)
from modcam16_palette.naming import output_path_for_compensation, output_path_for_gamut
from modcam16_palette.ocio_compensation import (
    compensate_foreground,
    load_compensation_processor,
    solve_neutral_y,
)
from modcam16_palette.palette import (
    build_palette,
    inverse_log_companded_chroma,
    make_log_companded_chroma_levels,
)
from modcam16_palette.render import render_palette_layers, render_radial_palette


def small_config():
    config = default_config()
    return replace(
        config,
        palette=replace(config.palette, hue_count=12, chroma_level_count=3),
        solver=replace(
            config.solver,
            c3_hue_sample_count=120,
            c3_max_refinement_candidates=4,
            boundary_coarse_steps=64,
            boundary_binary_iterations=40,
        ),
        raster=replace(config.raster, image_size=512),
        markers=replace(config.markers, enable_srgb_boundary_markers=False),
        colorchecker=replace(config.colorchecker, enabled=False),
        output=replace(config.output, selected_gamuts=("ACEScg/AP1-D60",)),
    )


def test_log_companding_round_trip():
    for k in (0.0, 10.0, 15.0):
        levels = make_log_companded_chroma_levels(10, k)
        assert levels[0] > 0.0
        assert levels[-1] == 1.0
        assert np.all(np.diff(levels) > 0.0)
        assert np.allclose(
            inverse_log_companded_chroma(levels, k), np.arange(1, 11) / 10
        )


def test_neutral_appearance_and_inverse():
    config = default_config()
    model = AppearanceModel.from_config(config.appearance)
    appearance = model.xyz_d65_to_attributes(model.reference_neutral_xyz_d65)
    assert np.isclose(float(appearance["C"]), 0.0, atol=1.0e-8)
    assert np.isclose(float(appearance["J_HK"]), model.target_j_hk, atol=1.0e-12)
    inverse = model.modcam16_hk_to_xyz_d65(model.target_j_hk, 0.0, 0.0)
    assert np.allclose(inverse, model.reference_neutral_xyz_d65, atol=5.0e-10, rtol=0.0)
    assert np.allclose(
        XYZ_D65_TO_ACESCG @ model.reference_neutral_xyz_d65,
        np.ones(3),
        atol=8.0e-6,
        rtol=0.0,
    )


def test_small_palette_renders_exact_center():
    config = small_config()
    model = AppearanceModel.from_config(config.appearance)
    result = build_palette(GAMUT_MATRICES["ACEScg/AP1-D60"], config, model)
    image = render_radial_palette(result, config)
    assert image.shape == (512, 512, 3)
    assert image.dtype == np.float32
    assert np.array_equal(image[255, 255], np.ones(3, dtype=np.float32))
    assert np.all(np.isfinite(image))
    assert result.cap_color_table.shape == (12, 3)
    assert result.statistics["total_palette_colors"] == (
        result.statistics["total_drawn_full_blocks"] + 12
    )


def test_boundary_markers_and_exr_output(tmp_path):
    config = small_config()
    config = replace(
        config,
        markers=replace(config.markers, enable_srgb_boundary_markers=True),
        output=replace(config.output, output_dir=tmp_path),
    )
    paths = generate(config, verbose=False)
    assert len(paths) == 1
    assert paths[0].exists()
    assert paths[0].name.endswith(
        "sRGBRectMarkers_NoColorCheckerDots_ACEScg_Radial_32f.exr"
    )
    result = build_palette(
        GAMUT_MATRICES["ACEScg/AP1-D60"],
        config,
        AppearanceModel.from_config(config.appearance),
    )
    assert result.statistics["combined_marker_count"] > 0

    import OpenEXR

    with OpenEXR.File(str(paths[0])) as exr:
        assert exr.header()["ocioColorSpace"] == "ACEScg"
        assert exr.channels()["RGB"].pixels.dtype == np.float32


def test_toml_and_override_precedence(tmp_path):
    path = tmp_path / "settings.toml"
    path.write_text(
        "[palette]\nhue_count = 8\n[output]\ngamuts = ['ap1']\n",
        encoding="utf-8",
    )
    config = load_config(path, {"palette": {"hue_count": 6}})
    assert config.palette.hue_count == 6
    assert config.output.selected_gamuts == ("ACEScg/AP1-D60",)


def test_compensation_toml_aliases_and_disable(tmp_path):
    path = tmp_path / "settings.toml"
    path.write_text(
        "[compensation]\n"
        "enabled = false\n"
        "selected_profiles = ['rec709_bt1886']\n"
        "ocio_path = 'profile.ocio'\n",
        encoding="utf-8",
    )
    config = load_config(path)
    assert not config.compensation.enabled
    assert config.compensation.profiles == ("srgb_rec709_bt1886",)
    assert config.compensation.ocio_config_path == path.parent / "profile.ocio"


def test_default_output_names_are_stable():
    config = default_config()
    assert output_path_for_gamut(config, GAMUT_MATRICES["ACEScg/AP1-D60"]).name == (
        "modCAM16HK_200nit_AP1GamutCone_C3_10Step_LogK15_Cap0p5_"
        "sRGBRectMarkers_CC18OfficialDots_ACEScg_Radial_32f.exr"
    )


def test_reference_neutral_y_accepts_low_source_values():
    config = replace(
        default_config(),
        appearance=replace(default_config().appearance, reference_neutral_y=0.1),
        compensation=replace(default_config().compensation, enabled=False),
    )
    model = AppearanceModel.from_config(config.appearance)
    assert np.isclose(model.reference_neutral_xyz_d65[1], 0.1)


def test_ocio_compensation_profiles_and_foreground_ownership(tmp_path):
    # Keep this test independent of the normal environment's optional import;
    # the package under test is installed in the CI image for compensation
    # tests, while ordinary tests remain usable without OCIO.
    try:
        processor = load_compensation_processor(
            default_config().compensation, "srgb_rec709_bt1886"
        )
    except RuntimeError as exc:
        if "PyOpenColorIO" in str(exc):
            return
        raise
    compensation = default_config().compensation
    source_y, center = solve_neutral_y(processor, compensation)
    assert 0.09 < source_y < 0.11
    assert np.max(np.abs(center - 0.18)) < compensation.round_trip_tolerance

    config = replace(
        default_config(),
        palette=replace(default_config().palette, hue_count=12, chroma_level_count=3),
        solver=replace(
            default_config().solver,
            c3_hue_sample_count=120,
            c3_max_refinement_candidates=4,
            boundary_coarse_steps=64,
            boundary_binary_iterations=40,
        ),
        raster=replace(default_config().raster, image_size=512),
        markers=replace(default_config().markers, enable_srgb_boundary_markers=False),
        colorchecker=replace(default_config().colorchecker, enabled=False),
        output=replace(default_config().output, output_dir=tmp_path),
        appearance=replace(default_config().appearance, reference_neutral_y=source_y),
    )
    from modcam16_palette.colorimetry import GAMUT_MATRICES

    result = build_palette(GAMUT_MATRICES["sRGB-D65"], config)
    rendered = render_palette_layers(result, config)
    compensated, diagnostics = compensate_foreground(
        rendered.image,
        rendered.foreground_mask,
        processor,
        compensation,
        source_y,
        rendered.center_mask,
    )
    assert np.array_equal(compensated[0, 0], rendered.image[0, 0])
    assert np.array_equal(compensated[255, 255], np.ones(3, dtype=np.float32))
    assert diagnostics.intermediate_round_trip_max_error < compensation.round_trip_tolerance
    assert diagnostics.post_scale_display_max_error >= 0.0
    assert diagnostics.post_scale_negative_count == 0
    path = output_path_for_compensation(
        config,
        GAMUT_MATRICES["sRGB-D65"],
        COMPENSATION_PROFILE_DEFINITIONS["srgb_rec709_bt1886"],
        source_y,
    )
    assert "ACES2InvODT_Rec709BT1886" in path.name
