import os
from pathlib import Path

import numpy as np
import pytest

from modcam16_palette.decompose import (
    DEFAULT_WORKERS,
    INPUT_COLOR_SPACES,
    base_ap1_above_one_statistics,
    canonical_input_color_space,
    canonical_input_gamut,
    canonical_input_transfer_function,
    canonical_profile,
    decompose_file,
    decompose_image,
    detect_input_color_space,
    gaussian_blur_working,
    load_decomposition_processor,
    project_unreachable_display_values,
    read_rgb_exr,
    read_image,
    _transfer_decode,
    write_decomposition_exrs,
)


def test_input_spaces_and_profile_names_are_exact():
    assert canonical_input_color_space("Linear Rec.2020") == "Linear Rec.2020"
    assert canonical_input_color_space("Linear Rec.709 (sRGB)") == (
        "Linear Rec.709 (sRGB)"
    )
    assert canonical_profile("rec709-sdr100").name == "rec709-sdr100"
    assert canonical_profile("p3-hdr1000").name == "p3-hdr1000"
    with pytest.raises(ValueError):
        canonical_input_color_space("lin_rec2020")
    assert canonical_input_gamut("Display P3 / P3-D65") == "Display P3 / P3-D65"
    assert canonical_input_transfer_function("PQ / ST 2084") == "PQ / ST 2084"
    with pytest.raises(ValueError):
        canonical_input_gamut("p3")
    with pytest.raises(ValueError):
        canonical_input_transfer_function("pq")
    with pytest.raises(ValueError):
        canonical_profile("rec709")


def test_worker_default_tracks_cpu_count():
    assert DEFAULT_WORKERS == (os.cpu_count() or 1)


def test_chromaticities_detection():
    import Imath

    header = {
        "chromaticities": Imath.Chromaticities(
            Imath.V2f(0.708, 0.292),
            Imath.V2f(0.170, 0.797),
            Imath.V2f(0.131, 0.046),
            Imath.V2f(0.3127, 0.3290),
        )
    }
    assert detect_input_color_space(header) == "Linear Rec.2020"
    assert detect_input_color_space({}) is None
    assert "Linear P3-D65" in INPUT_COLOR_SPACES


def test_p3_chromaticities_detection_from_flat_header():
    header = {
        "chromaticities": (0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.3290)
    }
    assert detect_input_color_space(header) == "Linear P3-D65"
    assert detect_input_color_space({"colorInteropID": "\x10\x00\x00\x00Linear P3-D65"}) == "Linear P3-D65"


def test_png_without_metadata_requires_explicit_source_selection(tmp_path):
    from PIL import Image

    path = tmp_path / "un tagged.png"
    Image.fromarray(np.array([[[128, 64, 32]]], dtype=np.uint8), mode="RGB").save(path)
    decoded = read_image(path)
    assert decoded.source_gamut is None
    assert decoded.source_transfer is None
    assert decoded.pixels.dtype == np.float32


def test_common_transfer_functions_decode_to_linear_values():
    encoded = np.array([[[0.5, 0.5, 0.5]]], dtype=np.float32)
    assert _transfer_decode(encoded, "sRGB")[0, 0, 0] == pytest.approx(0.21404114, abs=1e-6)
    assert _transfer_decode(encoded, "Gamma 2.2")[0, 0, 0] == pytest.approx(0.21763764, abs=1e-6)
    assert _transfer_decode(encoded, "BT.709 / BT.2020")[0, 0, 0] == pytest.approx(0.2595894, abs=1e-6)
    assert _transfer_decode(encoded, "HLG / BT.2100")[0, 0, 0] == pytest.approx(1.0 / 12.0, abs=1e-6)
    assert _transfer_decode(np.array([[[0.5080784] * 3]], dtype=np.float32), "PQ / ST 2084")[0, 0, 0] == pytest.approx(1.0, abs=2e-3)


def _write_input(path: Path, pixels: np.ndarray, *, color_space="ACES2065-1"):
    import OpenEXR

    path.parent.mkdir(parents=True, exist_ok=True)
    header = {
        "compression": OpenEXR.ZIP_COMPRESSION,
        "type": OpenEXR.scanlineimage,
        "ocioColorSpace": color_space,
    }
    with OpenEXR.File(header, {"RGB": np.asarray(pixels, dtype=np.float32)}) as output:
        output.write(str(path))


def test_read_rgb_exr_reads_float_channels_and_metadata(tmp_path):
    path = tmp_path / "input.exr"
    _write_input(path, np.array([[[0.18, 0.18, 0.18]]], dtype=np.float32))
    decoded = read_rgb_exr(path)
    assert decoded.pixel_type == "fp32"
    assert decoded.color_space == "ACES2065-1"
    assert decoded.pixels.dtype == np.float32
    assert decoded.pixels.shape == (1, 1, 3)


def test_decompose_black_and_neutral_round_trip():
    processor = load_decomposition_processor("ACES2065-1", "rec709-sdr100")
    source = np.array([[[0.0, 0.0, 0.0], [0.18, 0.18, 0.18]]], dtype=np.float32)
    result = decompose_image(
        source,
        processor,
        refl=0.18,
        chunk_size=1,
        j_hk_tolerance=1.0e-4,
        round_trip_tolerance=1.0e-4,
        workers=2,
        gaussian_blur_sigma=0.0,
    )
    assert result.base.dtype == np.float32
    assert result.exposure.dtype == np.float32
    assert np.array_equal(result.base[0, 0], np.full(3, 0.18, dtype=np.float32))
    assert result.exposure[0, 0] == 0.0
    assert result.diagnostics["workers"] == 2
    assert np.allclose(result.base[0, 1], 0.18, atol=2.0e-4)
    assert 0.0 < result.exposure[0, 1] < 1.0
    decoded = result.base[0, 1] * np.float32(
        2.0 ** (float(result.exposure[0, 1]) * 20.0 - 10.0)
    )
    working = processor.inverse(processor.un_tone(source.reshape(-1, 3)))[1]
    assert np.allclose(decoded, working, atol=2.0e-4)


def test_gaussian_blur_runs_on_working_image_before_decomposition():
    working = np.zeros((5, 5, 3), dtype=np.float32)
    working[2, 2] = (1.0, 0.5, 0.25)
    blurred = gaussian_blur_working(working, 1.0)
    assert blurred.shape == working.shape
    assert blurred.dtype == np.float32
    assert np.all(blurred[2, 2] < working[2, 2])
    assert np.all(blurred[2, 1] > 0.0)
    assert np.allclose(blurred[..., 1], blurred[..., 0] * 0.5, atol=1.0e-7)
    assert np.allclose(blurred[..., 2], blurred[..., 0] * 0.25, atol=1.0e-7)


def test_gaussian_blur_is_opt_in():
    processor = load_decomposition_processor("ACES2065-1", "rec709-sdr100")
    source = np.full((1, 1, 3), 0.18, dtype=np.float32)
    default_result = decompose_image(source, processor, workers=1)
    disabled_result = decompose_image(
        source, processor, workers=1, gaussian_blur_sigma=0.0
    )
    assert default_result.diagnostics["gaussian_blur_sigma"] == 0.0
    assert disabled_result.diagnostics["gaussian_blur_sigma"] == 0.0


def test_base_ap1_above_one_statistics_counts_pixels_once():
    processor = load_decomposition_processor("ACES2065-1", "rec709-sdr100")
    base = np.array(
        [[[2.0, 0.0, 0.0], [0.18, 0.18, 0.18]], [[0.0, 0.0, 2.0], [0.1, 0.1, 0.1]]],
        dtype=np.float32,
    )
    count, percent = base_ap1_above_one_statistics(base, processor)
    assert count == 2
    assert percent == 50.0


def test_decompose_rejects_unreachable_view_values():
    processor = load_decomposition_processor("ACES2065-1", "rec709-sdr100")
    source = np.array([[[0.02, 0.04, 0.08]]], dtype=np.float32)
    result = decompose_image(source, processor, round_trip_tolerance=1.0e-4)
    assert result.diagnostics["inverse_round_trip_exceedance_count"] >= 1


def test_exposure_is_clipped_but_base_keeps_jhk_target():
    processor = load_decomposition_processor("ACES2065-1", "p3-hdr1000")
    result = decompose_image(
        np.array([[[1.0e-12, 1.0e-12, 1.0e-12]]], dtype=np.float32),
        processor,
        j_hk_tolerance=1.0e-4,
        round_trip_tolerance=1.0e-4,
    )
    assert result.exposure[0, 0] == 0.0
    assert result.diagnostics["exposure_clipped_pixel_count"] == 1
    assert result.diagnostics["maximum_j_hk_error"] <= 1.0e-4


def test_projection_mode_allows_an_out_of_gamut_pixel():
    processor = load_decomposition_processor("ACES2065-1", "rec709-sdr100")
    source = np.array([[[0.02, 0.04, 0.08]]], dtype=np.float32)
    result_without_projection = decompose_image(source, processor, round_trip_tolerance=1.0e-4)
    assert result_without_projection.diagnostics["inverse_round_trip_exceedance_count"] >= 1
    result = decompose_image(
        source,
        processor,
        project_unreachable=True,
        round_trip_tolerance=1.0e-3,
        j_hk_tolerance=1.0e-4,
    )
    assert result.diagnostics["projected_pixel_count"] == 1
    assert result.diagnostics["project_unreachable"] == 1
    projected, mask, adjustment = project_unreachable_display_values(
        processor.un_tone(source.reshape(-1, 3)), processor.profile
    )
    assert bool(mask[0])
    assert adjustment > 0.0
    assert np.all(np.isfinite(projected))


def test_projection_mode_clamps_negative_ap0_after_view_projection():
    processor = load_decomposition_processor("Linear Rec.2020", "p3-hdr1000")
    source = np.array([[[15.71875, 12.7890625, 9.828125]]], dtype=np.float32)
    with pytest.raises(RuntimeError, match="negative AP0"):
        decompose_image(source, processor)
    result = decompose_image(
        source,
        processor,
        project_unreachable=True,
        round_trip_tolerance=2.0e-4,
        j_hk_tolerance=1.0e-4,
    )
    assert result.diagnostics["negative_ap0_clamped_pixel_count"] == 1
    assert np.all(np.isfinite(result.base))
    assert np.all(np.isfinite(result.exposure))


def test_write_outputs_have_expected_components_and_metadata(tmp_path):
    import OpenEXR

    processor = load_decomposition_processor("ACES2065-1", "rec709-sdr100")
    result = decompose_image(
        np.array([[[0.18, 0.18, 0.18]]], dtype=np.float32),
        processor,
        j_hk_tolerance=1.0e-4,
        round_trip_tolerance=1.0e-4,
    )
    base_path = tmp_path / "base.exr"
    exposure_path = tmp_path / "exposure.exr"
    write_decomposition_exrs(
        base_path,
        exposure_path,
        result,
        input_color_space="ACES2065-1",
        processor=processor,
    )
    with OpenEXR.File(str(base_path)) as base:
        assert base.channels()["RGB"].pixels.dtype == np.float16
        assert base.header()["ocioColorSpace"] == "ACEScg"
        assert base.header()["decompositionBasePixelType"] == "fp16"
        assert base.header()["decompositionRefl"] == pytest.approx(0.5)
        assert base.header()["decompositionComponent"] == "base"
    with OpenEXR.File(str(exposure_path)) as exposure:
        assert exposure.channels()["exposure"].pixels.dtype == np.float16
        assert exposure.header()["decompositionExposurePixelType"] == "fp16"
        assert exposure.header()["decompositionRefl"] == pytest.approx(0.5)
        assert exposure.header()["decompositionComponent"] == "exposure"


def test_decompose_file_uses_metadata_and_default_names(tmp_path):
    path = tmp_path / "scene.exr"
    _write_input(path, np.array([[[0.18, 0.18, 0.18]]], dtype=np.float32))
    base_path, exposure_path, result = decompose_file(
        path,
        profile="rec709-sdr100",
        j_hk_tolerance=1.0e-4,
        round_trip_tolerance=1.0e-4,
    )
    assert base_path == tmp_path / "scene-base-0.5.exr"
    assert exposure_path == tmp_path / "scene-exposure-0.5.exr"
    assert result.input_color_space == "ACES2065-1"
