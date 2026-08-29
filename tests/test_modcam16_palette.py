from dataclasses import replace

import numpy as np

from modcam16_palette.cam16_hk import AppearanceModel
from modcam16_palette.cli import generate
from modcam16_palette.colorimetry import GAMUT_MATRICES, XYZ_D65_TO_ACESCG
from modcam16_palette.config import default_config, load_config
from modcam16_palette.naming import output_path_for_gamut
from modcam16_palette.palette import (
    build_palette,
    inverse_log_companded_chroma,
    make_log_companded_chroma_levels,
)
from modcam16_palette.render import render_radial_palette


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


def test_default_output_names_are_stable():
    config = default_config()
    assert output_path_for_gamut(config, GAMUT_MATRICES["ACEScg/AP1-D60"]).name == (
        "modCAM16HK_200nit_AP1GamutCone_C3_10Step_LogK15_Cap0p5_"
        "sRGBRectMarkers_CC18OfficialDots_ACEScg_Radial_32f.exr"
    )
