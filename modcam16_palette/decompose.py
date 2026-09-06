"""ACES 2.0 image decomposition into base color and exposure.

The decomposition operates in ACES2065-1 scene-linear RGB.  An input pixel is
first sent through the ACES 2.0 ``Un-tone-mapped`` view and then through the
inverse of the selected output view.  The resulting AP0 value is split into a
chromatic base and a scalar exposure whose base is normalized by the
modCAM16-HK lightness correlate.
"""

from __future__ import annotations

import argparse
import io
import math
import os
import struct
import sys
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .aces_jmh import REC709_D65_PRIMARIES_XY, REC2020_D65_PRIMARIES_XY
from .cam16_hk import AppearanceModel
from .colorimetry import (
    AP1_PRIMARIES_XY,
    D65_WHITE_XY,
    P3_D65_PRIMARIES_XY,
    normalized_primary_matrix,
)
from .config import DEFAULT_OCIO_CONFIG_PATH, default_config
from .ocio_compensation import _import_ocio, _resolve_config_path

EXPOSURE_MIN = -10.0
EXPOSURE_MAX = 10.0
EXPOSURE_SCALE = 20.0
EXPOSURE_OFFSET = 10.0
DEFAULT_REFL = 0.5
DEFAULT_CHUNK_SIZE = 65_536
DEFAULT_SOLVER_ITERATIONS = 32
DEFAULT_J_HK_TOLERANCE = 1.0e-4
DEFAULT_ROUND_TRIP_TOLERANCE = 2.0e-4
DEFAULT_WORKERS = os.cpu_count() or 1
DEFAULT_GAUSSIAN_BLUR_SIGMA = 0.0

INPUT_COLOR_SPACES = (
    "ACES2065-1",
    "ACEScg",
    "Linear P3-D65",
    "Linear Rec.2020",
    "Linear Rec.709 (sRGB)",
    "Linear AdobeRGB",
)

INPUT_GAMUTS = (
    "Rec.709 / sRGB",
    "Display P3 / P3-D65",
    "Rec.2020",
    "Adobe RGB",
    "ACEScg",
    "ACES2065-1",
)

INPUT_TRANSFER_FUNCTIONS = (
    "Linear",
    "sRGB",
    "Gamma 1.8",
    "Gamma 2.2",
    "Gamma 2.4 / BT.1886",
    "BT.709 / BT.2020",
    "PQ / ST 2084",
    "HLG / BT.2100",
)

# EXR chromaticities use the standard AP0/AP1 and D65 display primaries.  The
# input images are allowed the small quantization error normally introduced by
# writing these attributes as 32-bit floats.
_INPUT_CHROMATICITIES = {
    "ACES2065-1": (
        (0.7347, 0.2653),
        (0.0000, 1.0000),
        (0.0001, -0.0770),
        (0.32168, 0.33767),
    ),
    "ACEScg": (
        tuple(float(x) for x in AP1_PRIMARIES_XY[0]),
        tuple(float(x) for x in AP1_PRIMARIES_XY[1]),
        tuple(float(x) for x in AP1_PRIMARIES_XY[2]),
        (0.32168, 0.33767),
    ),
    "Linear Rec.2020": (
        (0.7080, 0.2920),
        (0.1700, 0.7970),
        (0.1310, 0.0460),
        tuple(float(x) for x in D65_WHITE_XY),
    ),
    "Linear Rec.709 (sRGB)": (
        (0.6400, 0.3300),
        (0.3000, 0.6000),
        (0.1500, 0.0600),
        tuple(float(x) for x in D65_WHITE_XY),
    ),
    "Linear P3-D65": (
        (0.6800, 0.3200),
        (0.2650, 0.6900),
        (0.1500, 0.0600),
        tuple(float(x) for x in D65_WHITE_XY),
    ),
    "Linear AdobeRGB": (
        (0.6400, 0.3300),
        (0.2100, 0.7100),
        (0.1500, 0.0600),
        tuple(float(x) for x in D65_WHITE_XY),
    ),
}

_ACESCG_CHROMATICITIES = (
    0.713,
    0.293,
    0.165,
    0.830,
    0.128,
    0.044,
    0.32168,
    0.33767,
)


@dataclass(frozen=True)
class DecompositionProfile:
    """One supported ACES 2.0 output view."""

    name: str
    label: str
    view_transform: str
    limiting_primaries_xy: tuple[tuple[float, float], ...]
    display_peak_luminance_nits: float


DECOMPOSITION_PROFILE_DEFINITIONS = {
    "rec709-sdr100": DecompositionProfile(
        "rec709-sdr100",
        "Rec.709-D65 SDR 100 nit",
        "ACES 2.0 - SDR 100 nits (Rec.709)",
        tuple(tuple(float(v) for v in row) for row in REC709_D65_PRIMARIES_XY),
        100.0,
    ),
    "p3-hdr1000": DecompositionProfile(
        "p3-hdr1000",
        "P3-D65 HDR 1000 nit",
        "ACES 2.0 - HDR 1000 nits (P3 D65)",
        tuple(tuple(float(v) for v in row) for row in P3_D65_PRIMARIES_XY),
        1000.0,
    ),
    "rec2020-hdr1000": DecompositionProfile(
        "rec2020-hdr1000",
        "Rec.2020-D65 HDR 1000 nit",
        "ACES 2.0 - HDR 1000 nits (Rec.2020)",
        tuple(tuple(float(v) for v in row) for row in REC2020_D65_PRIMARIES_XY),
        1000.0,
    ),
}


@dataclass(frozen=True)
class DecompositionInput:
    """Decoded RGB pixels and the source metadata used to interpret them."""

    pixels: np.ndarray
    color_space: str
    pixel_type: str
    header: Mapping[str, Any]
    source_gamut: str | None = None
    source_transfer: str | None = None
    metadata_source: str | None = None


@dataclass(frozen=True)
class DecompositionResult:
    """Base/exposure images and numerical diagnostics."""

    base: np.ndarray
    exposure: np.ndarray
    input_color_space: str
    profile: DecompositionProfile
    refl: float
    target_j_hk: float
    diagnostics: Mapping[str, float | int | str]
    source_gamut: str | None = None
    source_transfer: str | None = None
    metadata_source: str | None = None
    input_format: str | None = None


@dataclass
class DecompositionProcessor:
    """Float32 OCIO processors for one input space and ACES 2.0 view."""

    ocio_config: Any
    profile: DecompositionProfile
    config_path: Path
    input_to_ap0: Any
    ap0_to_ap1: Any
    un_tone_mapped: Any
    forward_view: Any
    inverse_view: Any

    @staticmethod
    def _apply(processor: Any, values: np.ndarray) -> np.ndarray:
        array = np.ascontiguousarray(values, dtype=np.float32).copy()
        if array.ndim == 0 or array.shape[-1] != 3:
            raise ValueError("OCIO RGB arrays must have a final dimension of three.")
        if array.size:
            processor.applyRGB(array)
        return array

    def to_ap0(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.input_to_ap0, values)

    def to_ap1(self, values: np.ndarray) -> np.ndarray:
        """Convert ACES2065-1 (AP0) values to linear ACEScg (AP1)."""

        return self._apply(self.ap0_to_ap1, values)

    def un_tone(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.un_tone_mapped, values)

    def forward(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.forward_view, values)

    def inverse(self, values: np.ndarray) -> np.ndarray:
        return self._apply(self.inverse_view, values)


def canonical_input_color_space(value: str) -> str:
    """Return an exact supported input-space name or raise ``ValueError``."""

    text = str(value).strip()
    if text in INPUT_COLOR_SPACES:
        return text
    raise ValueError(
        f"Unsupported input color space {value!r}; choose one of "
        + ", ".join(INPUT_COLOR_SPACES)
        + "."
    )


def canonical_input_gamut(value: str) -> str:
    text = str(value).strip()
    if text not in INPUT_GAMUTS:
        raise ValueError(
            f"Unsupported input gamut {value!r}; choose one of "
            + ", ".join(INPUT_GAMUTS)
            + "."
        )
    return text


def canonical_input_transfer_function(value: str) -> str:
    text = str(value).strip()
    if text not in INPUT_TRANSFER_FUNCTIONS:
        raise ValueError(
            f"Unsupported input transfer function {value!r}; choose one of "
            + ", ".join(INPUT_TRANSFER_FUNCTIONS)
            + "."
        )
    return text


def _strip_metadata_prefix(value: Any) -> str:
    text = _metadata_text(value)
    return text.lstrip("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f")


def canonical_profile(value: str) -> DecompositionProfile:
    """Resolve one exact supported profile ID."""

    name = str(value)
    try:
        return DECOMPOSITION_PROFILE_DEFINITIONS[name]
    except KeyError as exc:
        choices = ", ".join(DECOMPOSITION_PROFILE_DEFINITIONS)
        raise ValueError(f"Unknown decomposition profile {value!r}; choose {choices}.") from exc


def _metadata_text(value: Any) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="strict").strip("\x00 \t\r\n")
        except UnicodeDecodeError:
            return ""
    if value is None:
        return ""
    return str(value).strip("\x00 \t\r\n")


def _chromaticities_tuple(value: Any) -> tuple[tuple[float, float], ...] | None:
    try:
        points = (value.red, value.green, value.blue, value.white)
        return tuple((float(point.x), float(point.y)) for point in points)
    except (AttributeError, TypeError, ValueError):
        try:
            flat = tuple(float(item) for item in np.asarray(value).reshape(-1))
            if len(flat) == 8:
                return tuple((flat[index], flat[index + 1]) for index in range(0, 8, 2))
        except (TypeError, ValueError):
            pass
        return None


def detect_input_color_space(
    header: Mapping[str, Any], ocio_config: Any | None = None
) -> str | None:
    """Detect a supported input space from OCIO metadata or chromaticities."""

    for key in ("ocioColorSpace", "colorInteropID"):
        raw = _strip_metadata_prefix(header.get(key))
        if not raw:
            continue
        if ocio_config is not None:
            try:
                parsed = _strip_metadata_prefix(ocio_config.parseColorSpaceFromString(raw))
            except (TypeError, ValueError):
                parsed = ""
            if parsed:
                raw = parsed
        try:
            return canonical_input_color_space(raw)
        except ValueError:
            # An unrelated OCIO colorspace does not override recognizable
            # standard chromaticities below.
            continue

    chromaticities = _chromaticities_tuple(header.get("chromaticities"))
    if chromaticities is None:
        return None
    observed = np.asarray(chromaticities, dtype=np.float64)
    for name, expected in _INPUT_CHROMATICITIES.items():
        if np.allclose(observed, np.asarray(expected), atol=5.0e-4, rtol=0.0):
            return name
    return None


def _gamut_to_linear_space(gamut: str) -> str:
    return {
        "Rec.709 / sRGB": "Linear Rec.709 (sRGB)",
        "Display P3 / P3-D65": "Linear P3-D65",
        "Rec.2020": "Linear Rec.2020",
        "Adobe RGB": "Linear AdobeRGB",
        "ACEScg": "ACEScg",
        "ACES2065-1": "ACES2065-1",
    }[canonical_input_gamut(gamut)]


def _linear_space_to_gamut(space: str) -> str:
    return {
        "Linear Rec.709 (sRGB)": "Rec.709 / sRGB",
        "Linear P3-D65": "Display P3 / P3-D65",
        "Linear Rec.2020": "Rec.2020",
        "Linear AdobeRGB": "Adobe RGB",
        "ACEScg": "ACEScg",
        "ACES2065-1": "ACES2065-1",
    }[canonical_input_color_space(space)]


def _transfer_from_input_space(space: str) -> str:
    return "Linear"


def _input_spec_from_combined_space(space: str) -> tuple[str, str]:
    canonical = canonical_input_color_space(space)
    return _linear_space_to_gamut(canonical), _transfer_from_input_space(canonical)


def _transfer_decode(values: np.ndarray, transfer: str) -> np.ndarray:
    """Decode normalized encoded RGB values to relative scene-linear RGB."""

    source = np.asarray(values, dtype=np.float32)
    name = canonical_input_transfer_function(transfer)
    if name == "Linear":
        return source.copy()
    if name == "sRGB":
        positive = np.maximum(source, 0.0)
        return np.where(
            positive <= 0.04045,
            positive / 12.92,
            np.power((positive + 0.055) / 1.055, 2.4),
        ).astype(np.float32)
    if name.startswith("Gamma"):
        gamma = float(name.split()[1])
        return np.sign(source) * np.power(np.abs(source), gamma)
    if name == "BT.709 / BT.2020":
        positive = np.maximum(source, 0.0)
        return np.where(
            positive < 0.081,
            positive / 4.5,
            np.power((positive + 0.099) / 1.099, 1.0 / 0.45),
        ).astype(np.float32)
    if name == "PQ / ST 2084":
        # SMPTE ST 2084 EOTF, normalized to 100 cd/m^2 for ACES scene values.
        n = np.maximum(source, 0.0).astype(np.float64)
        m1, m2 = 2610.0 / 16384.0, 2523.0 / 32.0
        c1, c2, c3 = 3424.0 / 4096.0, 2413.0 / 128.0, 2392.0 / 128.0
        ratio = np.power(n, 1.0 / m2)
        luminance = np.power(np.maximum(ratio - c1, 0.0) / (c2 - c3 * ratio), 1.0 / m1)
        return (luminance / 100.0).astype(np.float32)
    if name == "HLG / BT.2100":
        n = np.maximum(source, 0.0).astype(np.float64)
        a, b, c = 0.17883277, 0.28466892, 0.55991073
        return np.where(n <= 0.5, (n * n) / 3.0, (np.exp((n - c) / a) + b) / 12.0).astype(np.float32)
    raise AssertionError(f"Unhandled transfer function {name!r}")


def _ocio_source_space_for(gamut: str, transfer: str) -> str | None:
    if canonical_input_transfer_function(transfer) == "Linear":
        return _gamut_to_linear_space(gamut)
    names = {
        ("Rec.709 / sRGB", "sRGB"): "sRGB Encoded Rec.709 (sRGB)",
        ("Display P3 / P3-D65", "sRGB"): "sRGB Encoded P3-D65",
        ("Rec.709 / sRGB", "Gamma 1.8"): "Gamma 1.8 Encoded Rec.709",
        ("Rec.709 / sRGB", "Gamma 2.2"): "Gamma 2.2 Encoded Rec.709",
        ("Rec.709 / sRGB", "Gamma 2.4 / BT.1886"): "Gamma 2.4 Encoded Rec.709",
        ("Adobe RGB", "Gamma 2.2"): "Gamma 2.2 Encoded AdobeRGB",
        ("ACEScg", "sRGB"): "sRGB Encoded AP1",
        ("ACEScg", "Gamma 2.2"): "Gamma 2.2 Encoded AP1",
    }
    return names.get((canonical_input_gamut(gamut), canonical_input_transfer_function(transfer)))


def prompt_input_color_space() -> str:
    """Prompt for a source space when no usable metadata is present."""

    if not sys.stdin.isatty():
        raise ValueError(
            "Input color space metadata is missing or unsupported; use "
            "--input-color-space in a non-interactive run."
        )
    print("Input color space metadata was not found. Choose the scene-linear space:")
    for index, name in enumerate(INPUT_COLOR_SPACES, start=1):
        print(f"  {index}. {name}")
    while True:
        try:
            answer = input("Color space [1-4]: ").strip()
        except EOFError as exc:
            raise ValueError(
                "Input color space selection was cancelled; use --input-color-space."
            ) from exc
        try:
            index = int(answer)
        except ValueError:
            index = 0
        if 1 <= index <= len(INPUT_COLOR_SPACES):
            return INPUT_COLOR_SPACES[index - 1]
        print(f"Please enter a number from 1 to {len(INPUT_COLOR_SPACES)}.")


def prompt_input_gamut_and_transfer() -> tuple[str, str]:
    if not sys.stdin.isatty():
        raise ValueError(
            "Input gamut/transfer metadata is missing or unsupported; use "
            "--input-gamut and --input-transfer-function in a non-interactive run."
        )
    print("Input gamut metadata was not found. Choose the exact gamut name:")
    for index, name in enumerate(INPUT_GAMUTS, start=1):
        print(f"  {index}. {name}")
    while True:
        try:
            gamut_answer = input(f"Gamut [1-{len(INPUT_GAMUTS)}]: ").strip()
        except EOFError as exc:
            raise ValueError("Input gamut selection was cancelled.") from exc
        try:
            index = int(gamut_answer)
            gamut = INPUT_GAMUTS[index - 1]
            break
        except (ValueError, IndexError):
            print(f"Please enter a number from 1 to {len(INPUT_GAMUTS)}.")
    print("Input transfer metadata was not found. Choose the exact transfer name:")
    for index, name in enumerate(INPUT_TRANSFER_FUNCTIONS, start=1):
        print(f"  {index}. {name}")
    while True:
        try:
            transfer_answer = input(
                f"Transfer function [1-{len(INPUT_TRANSFER_FUNCTIONS)}]: "
            ).strip()
        except EOFError as exc:
            raise ValueError("Input transfer-function selection was cancelled.") from exc
        try:
            index = int(transfer_answer)
            transfer = INPUT_TRANSFER_FUNCTIONS[index - 1]
            break
        except (ValueError, IndexError):
            print(f"Please enter a number from 1 to {len(INPUT_TRANSFER_FUNCTIONS)}.")
    return gamut, transfer


def _png_chunks(path: str | Path):
    with open(path, "rb") as stream:
        signature = stream.read(8)
        if signature != b"\x89PNG\r\n\x1a\n":
            return
        while True:
            size_bytes = stream.read(4)
            if len(size_bytes) != 4:
                return
            size = struct.unpack(">I", size_bytes)[0]
            chunk_type = stream.read(4)
            payload = stream.read(size)
            stream.read(4)
            if len(chunk_type) != 4 or len(payload) != size:
                return
            yield chunk_type, payload
            if chunk_type == b"IEND":
                return


def _profile_gamut_transfer(description: str) -> tuple[str, str] | None:
    text = description.strip().casefold()
    if "display p3" in text or "p3-d65" in text:
        return "Display P3 / P3-D65", "sRGB"
    if "rec. 2020" in text or "rec2020" in text or "bt.2020" in text or "bt2020" in text:
        return "Rec.2020", "BT.709 / BT.2020"
    if "adobe rgb" in text:
        return "Adobe RGB", "Gamma 2.2"
    if "srgb" in text or "s rgb" in text:
        return "Rec.709 / sRGB", "sRGB"
    if "acescg" in text:
        return "ACEScg", "Linear"
    return None


def _png_metadata(path: str | Path, info: Mapping[str, Any]) -> tuple[str, str, str] | None:
    icc = info.get("icc_profile")
    if icc:
        try:
            from PIL import ImageCms

            description = _metadata_text(ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))))
            detected = _profile_gamut_transfer(description)
            if detected:
                return (*detected, "PNG ICC profile")
        except (ImportError, OSError, TypeError, ValueError):
            pass
    for chunk_type, payload in _png_chunks(path):
        if chunk_type == b"cICP" and len(payload) >= 4:
            primaries, transfer = payload[0], payload[1]
            gamut = {1: "Rec.709 / sRGB", 9: "Rec.2020", 12: "Display P3 / P3-D65"}.get(primaries)
            transfer_name = {1: "BT.709 / BT.2020", 13: "sRGB", 16: "PQ / ST 2084", 18: "HLG / BT.2100"}.get(transfer)
            if gamut and transfer_name:
                return gamut, transfer_name, "PNG cICP"
        if chunk_type == b"sRGB":
            return "Rec.709 / sRGB", "sRGB", "PNG sRGB chunk"
    chromaticity = info.get("chromaticity")
    try:
        values = tuple(float(item) for item in chromaticity)
        if len(values) == 8:
            observed = np.asarray(
                ((values[2], values[3]), (values[4], values[5]), (values[6], values[7]), (values[0], values[1])),
                dtype=np.float64,
            )
            for gamut, expected in (
                ("Rec.709 / sRGB", _INPUT_CHROMATICITIES["Linear Rec.709 (sRGB)"]),
                ("Display P3 / P3-D65", _INPUT_CHROMATICITIES["Linear P3-D65"]),
                ("Rec.2020", _INPUT_CHROMATICITIES["Linear Rec.2020"]),
            ):
                if np.allclose(observed, np.asarray(expected), atol=5.0e-4, rtol=0.0):
                    return gamut, "sRGB", "PNG chromaticity"
    except (TypeError, ValueError):
        pass
    gamma = info.get("gamma")
    if gamma is not None:
        try:
            gamma_value = float(gamma)
        except (TypeError, ValueError):
            gamma_value = 0.0
        transfer = {
            1.0: "Linear",
            1.8: "Gamma 1.8",
            2.2: "Gamma 2.2",
            2.4: "Gamma 2.4 / BT.1886",
        }.get(round(gamma_value, 1))
        if transfer:
            return "Rec.709 / sRGB", transfer, "PNG gAMA"
    return None


def _pillow_pixels(image: Any) -> np.ndarray:
    mode = str(getattr(image, "mode", ""))
    if mode not in {"RGB", "RGBA", "RGB;16", "I;16", "I", "F"}:
        image = image.convert("RGB")
    elif mode == "RGBA":
        image = image.convert("RGB")
    array = np.asarray(image)
    if array.ndim != 3 or array.shape[-1] != 3:
        raise ValueError("Input image must contain RGB channels.")
    if np.issubdtype(array.dtype, np.integer):
        maximum = float(np.iinfo(array.dtype).max)
        array = array.astype(np.float32) / maximum
    else:
        array = array.astype(np.float32)
    return np.ascontiguousarray(array)


def _read_raster_image(path: str | Path) -> DecompositionInput:
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow is required to read JPEG and PNG images.") from exc
    path = Path(path)
    with Image.open(path) as image:
        image.load()
        info = dict(getattr(image, "info", {}))
        pixels = _pillow_pixels(image)
        detected = _png_metadata(path, info) if path.suffix.casefold() == ".png" else None
        if detected is None and info.get("icc_profile"):
            try:
                from PIL import ImageCms

                description = _metadata_text(
                    ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(info["icc_profile"])))
                )
                profile_detected = _profile_gamut_transfer(description)
                if profile_detected:
                    detected = (*profile_detected, "JPEG ICC profile")
            except (ImportError, OSError, TypeError, ValueError):
                pass
        if detected is None and path.suffix.casefold() in {".jpg", ".jpeg"}:
            try:
                exif_space = int(image.getexif().get(0xA001, 0))
            except (AttributeError, TypeError, ValueError):
                exif_space = 0
            if exif_space == 1:
                detected = ("Rec.709 / sRGB", "sRGB", "JPEG EXIF ColorSpace")
            elif exif_space == 2:
                detected = ("Adobe RGB", "Gamma 2.2", "JPEG EXIF ColorSpace")
    return DecompositionInput(
        pixels=pixels,
        color_space="",
        pixel_type=str(pixels.dtype),
        header=info,
        source_gamut=detected[0] if detected else None,
        source_transfer=detected[1] if detected else None,
        metadata_source=detected[2] if detected else None,
    )


def _read_heif_image(path: str | Path) -> DecompositionInput:
    try:
        import pillow_heif
    except ImportError as exc:
        raise RuntimeError("pillow-heif is required to read HEIC and HEIF images.") from exc
    try:
        heif_file = pillow_heif.open_heif(path, convert_hdr_to_8bit=False, hdr_to_16bit=True)
    except TypeError:
        heif_file = pillow_heif.open_heif(path, convert_hdr_to_8bit=False)
    image = heif_file[0] if hasattr(heif_file, "__getitem__") else heif_file
    info = dict(getattr(image, "info", {}) or getattr(heif_file, "info", {}) or {})
    aux = info.get("aux") or getattr(heif_file, "info", {}).get("aux", {})
    if aux:
        try:
            from apple_hdr_heic import load_as_displayp3_linear
        except ImportError as exc:
            raise RuntimeError(
                "This HEIC contains an auxiliary HDR gain map; install apple-hdr-heic and exiftool."
            ) from exc
        pixels = np.asarray(load_as_displayp3_linear(path), dtype=np.float32) * np.float32(203.0 / 100.0)
        return DecompositionInput(
            pixels=pixels,
            color_space="Linear P3-D65",
            pixel_type=str(pixels.dtype),
            header=info,
            source_gamut="Display P3 / P3-D65",
            source_transfer="Linear",
            metadata_source="Apple HDR gain map",
        )
    pixels = _pillow_pixels(image)
    profile = info.get("nclx_profile") or {}
    if info.get("icc_profile"):
        try:
            from PIL import ImageCms

            description = _metadata_text(ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(info["icc_profile"]))))
            detected = _profile_gamut_transfer(description)
        except (ImportError, OSError, TypeError, ValueError):
            detected = None
    else:
        gamut = {1: "Rec.709 / sRGB", 9: "Rec.2020", 12: "Display P3 / P3-D65"}.get(profile.get("color_primaries"))
        transfer = {1: "BT.709 / BT.2020", 13: "sRGB", 16: "PQ / ST 2084", 18: "HLG / BT.2100"}.get(profile.get("transfer_characteristics"))
        detected = (gamut, transfer) if gamut and transfer else None
    return DecompositionInput(
        pixels=pixels,
        color_space="",
        pixel_type=str(pixels.dtype),
        header=info,
        source_gamut=detected[0] if detected else None,
        source_transfer=detected[1] if detected else None,
        metadata_source="HEIF metadata" if detected else None,
    )


def read_image(path: str | Path) -> DecompositionInput:
    """Read one supported image format and return normalized RGB samples."""

    path = Path(path)
    suffix = path.suffix.casefold()
    if suffix == ".exr":
        return read_rgb_exr(path)
    if suffix in {".jpg", ".jpeg", ".png"}:
        return _read_raster_image(path)
    if suffix in {".heic", ".heif", ".hif"}:
        return _read_heif_image(path)
    raise ValueError("Unsupported input image format; use .exr, .jpg, .jpeg, .png, .heic, or .heif.")


def read_rgb_exr(path: str | Path) -> DecompositionInput:
    """Read a three-channel fp16/fp32 scanline OpenEXR as float32 RGB."""

    try:
        import Imath
        import OpenEXR
    except ImportError as exc:  # pragma: no cover - dependency is project-required
        raise RuntimeError("OpenEXR and Imath are required to read EXR images.") from exc

    input_file = OpenEXR.InputFile(str(path))
    try:
        header = input_file.header()
        channel_info = header.get("channels", {})
        if not all(name in channel_info for name in ("R", "G", "B")):
            raise ValueError("Input EXR must contain R, G, and B channels.")
        types = {str(channel_info[name].type) for name in ("R", "G", "B")}
        if types == {"HALF"}:
            pixel_type = "fp16"
        elif types == {"FLOAT"}:
            pixel_type = "fp32"
        else:
            raise ValueError("Input EXR R/G/B channels must all be fp16 or all be fp32.")
        window = header.get("dataWindow")
        if window is None:
            raise ValueError("Input EXR has no dataWindow attribute.")
        width = int(window.max.x - window.min.x + 1)
        height = int(window.max.y - window.min.y + 1)
        if width <= 0 or height <= 0:
            raise ValueError("Input EXR dataWindow is empty.")
        float_type = Imath.PixelType(Imath.PixelType.FLOAT)
        channels = []
        for name in ("R", "G", "B"):
            raw = input_file.channel(name, float_type)
            values = np.frombuffer(raw, dtype=np.float32)
            expected = width * height
            if values.size != expected:
                raise ValueError(
                    f"Input EXR channel {name} has {values.size} samples; expected {expected}."
                )
            channels.append(values.reshape(height, width))
        pixels = np.stack(channels, axis=-1)
        detected = detect_input_color_space(header)
        return DecompositionInput(
            pixels=pixels,
            color_space=detected or "",
            pixel_type=pixel_type,
            header=header,
            source_gamut=_linear_space_to_gamut(detected) if detected else None,
            source_transfer="Linear" if detected else None,
            metadata_source="OpenEXR metadata" if detected else None,
        )
    finally:
        input_file.close()


def load_decomposition_processor(
    input_color_space: str,
    profile: str | DecompositionProfile,
    ocio_config_path: str | Path = DEFAULT_OCIO_CONFIG_PATH,
) -> DecompositionProcessor:
    """Load direct AP0 and view-reference processors for decomposition."""

    input_space = canonical_input_color_space(input_color_space)
    selected = profile if isinstance(profile, DecompositionProfile) else canonical_profile(profile)
    config_path = _resolve_config_path(ocio_config_path)
    ocio = _import_ocio()
    config = ocio.Config.CreateFromFile(str(config_path))
    for name in ("ACES2065-1", "ACEScg", input_space):
        if config.getColorSpace(name) is None:
            raise ValueError(f"OCIO color space not found: {name}")
    for view_name in ("Un-tone-mapped", selected.view_transform):
        if config.getViewTransform(view_name) is None:
            raise ValueError(f"OCIO view transform not found: {view_name}")

    un_tone = config.getViewTransform("Un-tone-mapped").getTransform(
        ocio.VIEWTRANSFORM_DIR_FROM_REFERENCE
    )
    view = config.getViewTransform(selected.view_transform).getTransform(
        ocio.VIEWTRANSFORM_DIR_FROM_REFERENCE
    )
    input_to_ap0 = config.getProcessor(input_space, "ACES2065-1").getDefaultCPUProcessor()
    ap0_to_ap1 = config.getProcessor("ACES2065-1", "ACEScg").getDefaultCPUProcessor()
    un_tone_processor = config.getProcessor(un_tone).getDefaultCPUProcessor()
    forward_processor = config.getProcessor(view).getDefaultCPUProcessor()
    inverse_processor = config.getProcessor(
        view, ocio.TRANSFORM_DIR_INVERSE
    ).getDefaultCPUProcessor()
    return DecompositionProcessor(
        ocio_config=config,
        profile=selected,
        config_path=config_path,
        input_to_ap0=input_to_ap0,
        ap0_to_ap1=ap0_to_ap1,
        un_tone_mapped=un_tone_processor,
        forward_view=forward_processor,
        inverse_view=inverse_processor,
    )


def project_unreachable_display_values(
    values: np.ndarray, profile: DecompositionProfile | str
) -> tuple[np.ndarray, np.ndarray, float]:
    """Project display XYZ values into a view's finite limiting RGB volume.

    ACES output views are bounded by their limiting display primaries and peak
    luminance.  The inverse is not defined outside that volume; projection is
    therefore explicit and returns a mask plus maximum XYZ adjustment for
    diagnostics rather than hiding the color change.
    """

    selected = profile if isinstance(profile, DecompositionProfile) else canonical_profile(profile)
    source = np.ascontiguousarray(values, dtype=np.float32)
    if source.ndim == 0 or source.shape[-1] != 3:
        raise ValueError("Display XYZ arrays must have a final dimension of three.")
    if not np.all(np.isfinite(source)):
        raise ValueError("Display XYZ values must be finite.")
    rgb_to_xyz = normalized_primary_matrix(
        np.asarray(selected.limiting_primaries_xy, dtype=np.float64), D65_WHITE_XY
    )
    xyz_to_rgb = np.linalg.inv(rgb_to_xyz)
    limit = float(selected.display_peak_luminance_nits) / 100.0
    rgb = np.einsum("ij,...j->...i", xyz_to_rgb, source.astype(np.float64))
    mask = np.any((rgb < 0.0) | (rgb > limit), axis=-1)
    projected = source.copy()
    if np.any(mask):
        clipped = np.clip(rgb[mask], 0.0, limit)
        projected[mask] = np.einsum("ij,...j->...i", rgb_to_xyz, clipped).astype(
            np.float32
        )
        adjustment = projected[mask].astype(np.float64) - source[mask].astype(np.float64)
        maximum_adjustment = float(np.max(np.abs(adjustment)))
    else:
        maximum_adjustment = 0.0
    return projected, mask, maximum_adjustment


def _validate_positive_finite(name: str, value: float) -> float:
    value = float(value)
    if not np.isfinite(value) or value <= 0.0:
        raise ValueError(f"{name} must be finite and positive.")
    return value


def _validate_blur_sigma(value: float) -> float:
    sigma = float(value)
    if not np.isfinite(sigma) or sigma < 0.0:
        raise ValueError("gaussian_blur_sigma must be finite and nonnegative.")
    return sigma


def _gaussian_kernel(sigma: float) -> np.ndarray:
    """Build a normalized one-dimensional Gaussian kernel."""

    sigma = _validate_blur_sigma(sigma)
    if sigma == 0.0:
        return np.array([1.0], dtype=np.float64)
    radius = max(1, math.ceil(3.0 * sigma))
    coordinates = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (coordinates / sigma) ** 2)
    return kernel / np.sum(kernel)


def _gaussian_blur_array(values: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """Apply a separable reflected-boundary Gaussian to an image array."""

    source = np.asarray(values, dtype=np.float32)
    if source.ndim not in (2, 3):
        raise ValueError("Gaussian-blurred arrays must be 2-D or 3-D images.")
    if source.ndim == 3 and source.shape[-1] <= 0:
        raise ValueError("Gaussian-blurred RGB images must have channels.")
    if source.shape[0] == 0 or source.shape[1] == 0:
        return source.copy()
    radius = (kernel.size - 1) // 2
    if radius == 0:
        return source.copy()
    padded = np.pad(
        source,
        ((radius, radius), (radius, radius))
        if source.ndim == 2
        else ((radius, radius), (radius, radius), (0, 0)),
        mode=(
            "reflect"
            if source.shape[0] > radius and source.shape[1] > radius
            else "symmetric"
        ),
    )
    horizontal = np.empty_like(source, dtype=np.float32)
    channels = 1 if source.ndim == 2 else source.shape[-1]
    for row in range(source.shape[0]):
        for channel in range(channels):
            source_row = padded[row + radius, :,] if source.ndim == 2 else padded[
                row + radius, :, channel
            ]
            destination = (
                horizontal[row, :]
                if source.ndim == 2
                else horizontal[row, :, channel]
            )
            destination[:] = np.convolve(source_row, kernel, mode="valid").astype(
                np.float32, copy=False
            )
    padded = np.pad(
        horizontal,
        ((radius, radius), (0, 0))
        if source.ndim == 2
        else ((radius, radius), (0, 0), (0, 0)),
        mode="reflect" if source.shape[0] > radius else "symmetric",
    )
    blurred = np.empty_like(source, dtype=np.float32)
    for column in range(source.shape[1]):
        for channel in range(channels):
            source_column = (
                padded[:, column]
                if source.ndim == 2
                else padded[:, column, channel]
            )
            destination = (
                blurred[:, column]
                if source.ndim == 2
                else blurred[:, column, channel]
            )
            destination[:] = np.convolve(source_column, kernel, mode="valid").astype(
                np.float32, copy=False
            )
    return blurred


def gaussian_blur_working(values: np.ndarray, sigma: float) -> np.ndarray:
    """Blur the AP0 working image before base/exposure decomposition."""

    sigma = _validate_blur_sigma(sigma)
    source = np.asarray(values, dtype=np.float32)
    if source.ndim != 3 or source.shape[-1] != 3:
        raise ValueError("Working image must have shape H x W x 3.")
    if not np.all(np.isfinite(source)):
        raise ValueError("Gaussian-blurred working image must contain finite values.")
    if sigma == 0.0:
        return source.copy()
    return _gaussian_blur_array(source, _gaussian_kernel(sigma))


def base_ap1_above_one_statistics(
    base_ap0: np.ndarray, processor: DecompositionProcessor
) -> tuple[int, float]:
    """Count AP1 base pixels with at least one RGB channel strictly above 1."""

    values = np.asarray(base_ap0, dtype=np.float32)
    if values.ndim != 3 or values.shape[-1] != 3:
        raise ValueError("Base image must have shape H x W x 3.")
    if not np.all(np.isfinite(values)):
        raise ValueError("Base image must contain finite values.")
    ap1 = processor.to_ap1(values.reshape(-1, 3))
    if not np.all(np.isfinite(ap1)):
        raise RuntimeError("AP0-to-ACEScg conversion produced non-finite base values.")
    above_one = np.any(ap1 > np.float32(1.0), axis=-1)
    count = int(np.count_nonzero(above_one))
    total = int(above_one.size)
    percent = 100.0 * count / total if total else 0.0
    return count, percent


def _solve_chunk(
    q: np.ndarray,
    processor: DecompositionProcessor,
    model: AppearanceModel,
    target_j_hk: float,
    *,
    refl: float,
    solver_iterations: int,
    j_hk_tolerance: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float, int]:
    """Solve one batch, returning base/exposure, masks, and J_HK error."""

    if q.ndim != 2 or q.shape[-1] != 3:
        raise ValueError("Working pixels must have shape N x 3.")
    if not np.all(np.isfinite(q)):
        raise RuntimeError("Inverse ACES transform produced non-finite values.")
    negative = np.min(q, axis=-1) < -1.0e-6
    if np.any(negative):
        count = int(np.count_nonzero(negative))
        minimum = float(np.min(q[negative]))
        raise RuntimeError(
            "Selected ACES 2.0 view cannot invert "
            f"{count} pixel(s) without negative AP0 values (minimum={minimum:.9g})."
        )
    q = np.maximum(q, 0.0)
    zero = np.all(q == 0.0, axis=-1)
    base = np.empty_like(q, dtype=np.float32)
    exposure = np.empty(q.shape[0], dtype=np.float32)
    base[zero] = np.float32(refl)
    exposure[zero] = 0.0
    active = ~zero
    if not np.any(active):
        return base, exposure, zero, np.zeros_like(zero), 0.0, 0

    values = q[active].astype(np.float32, copy=False)
    # e is log2(s).  Increasing e makes the base darker and monotonically
    # lowers the output-view J_HK for the valid positive scene values.
    lower_e = np.full(values.shape[0], EXPOSURE_MIN, dtype=np.float64)
    upper_e = np.full(values.shape[0], EXPOSURE_MAX, dtype=np.float64)

    def evaluate(e: np.ndarray) -> np.ndarray:
        scaled = values.astype(np.float64) * np.exp2(-e)[..., None]
        if not np.all(np.isfinite(scaled)):
            raise RuntimeError("Exposure solve overflowed while evaluating the ACES view.")
        display = processor.forward(scaled.astype(np.float32))
        if not np.all(np.isfinite(display)):
            raise RuntimeError("ACES view produced non-finite values during exposure solve.")
        attributes = model.xyz_d65_to_attributes(display)
        result = np.asarray(attributes["J_HK"], dtype=np.float64)
        if not np.all(np.isfinite(result)):
            raise RuntimeError("modCAM16-HK produced non-finite J_HK values.")
        return result

    low_j = evaluate(lower_e)
    high_j = evaluate(upper_e)
    below_range = low_j < target_j_hk - j_hk_tolerance
    above_range = high_j > target_j_hk + j_hk_tolerance

    # Find an unconstrained root first.  The serialized exposure is limited to
    # [-10, 10], but clipping the scalar must not change the base color's J_HK.
    for _ in range(8):
        if np.any(below_range):
            candidate_lower = lower_e - 10.0
            candidate_j = evaluate(candidate_lower)
            lower_e = np.where(below_range, candidate_lower, lower_e)
            low_j = np.where(below_range, candidate_j, low_j)
            reached = candidate_j >= target_j_hk - j_hk_tolerance
            below_range = below_range & ~reached
        if np.any(above_range):
            candidate_upper = upper_e + 10.0
            candidate_j = evaluate(candidate_upper)
            upper_e = np.where(above_range, candidate_upper, upper_e)
            high_j = np.where(above_range, candidate_j, high_j)
            reached = candidate_j <= target_j_hk + j_hk_tolerance
            above_range = above_range & ~reached
        if not np.any(below_range | above_range):
            break
    if np.any(below_range | above_range):
        bad = np.flatnonzero(below_range | above_range)
        raise RuntimeError(
            f"{bad.size} pixel(s) have no finite exposure root for the selected "
            "ACES view; cannot determine a base color."
        )

    bracket = np.ones(values.shape[0], dtype=bool)

    for _ in range(solver_iterations):
        middle = (lower_e + upper_e) * 0.5
        middle_j = evaluate(middle)
        too_bright = middle_j > target_j_hk
        lower_e = np.where(bracket & too_bright, middle, lower_e)
        upper_e = np.where(bracket & ~too_bright, middle, upper_e)
    solved_e = (lower_e + upper_e) * 0.5
    clipped = (solved_e < EXPOSURE_MIN) | (solved_e > EXPOSURE_MAX)
    solved_base = values.astype(np.float64) * np.exp2(-solved_e)[..., None]
    solved_base = np.asarray(solved_base, dtype=np.float32)
    final_j = np.asarray(model.xyz_d65_to_attributes(processor.forward(solved_base))["J_HK"])
    j_hk_error = np.abs(final_j - target_j_hk)
    maximum_error = float(np.max(j_hk_error, initial=0.0))
    # Clipping the exposure is an intentional representational limit.  Roots
    # inside the range must still satisfy the requested perceptual invariant.
    j_hk_exceedance_count = int(np.count_nonzero(j_hk_error > j_hk_tolerance))
    base[active] = solved_base
    stored_e = np.clip(solved_e, EXPOSURE_MIN, EXPOSURE_MAX)
    exposure[active] = (
        (stored_e + EXPOSURE_OFFSET) / EXPOSURE_SCALE
    ).astype(np.float32)
    return base, exposure, zero, clipped, maximum_error, j_hk_exceedance_count


def decompose_image(
    pixels: np.ndarray,
    processor: DecompositionProcessor,
    *,
    refl: float = DEFAULT_REFL,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    solver_iterations: int = DEFAULT_SOLVER_ITERATIONS,
    j_hk_tolerance: float = DEFAULT_J_HK_TOLERANCE,
    round_trip_tolerance: float = DEFAULT_ROUND_TRIP_TOLERANCE,
    workers: int = DEFAULT_WORKERS,
    project_unreachable: bool = False,
    gaussian_blur_sigma: float = DEFAULT_GAUSSIAN_BLUR_SIGMA,
) -> DecompositionResult:
    """Decompose scene-linear input pixels using one selected ACES view."""

    refl = _validate_positive_finite("refl", refl)
    if not isinstance(chunk_size, int) or chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer.")
    if not isinstance(solver_iterations, int) or solver_iterations <= 0:
        raise ValueError("solver_iterations must be a positive integer.")
    if not isinstance(workers, int) or workers <= 0:
        raise ValueError("workers must be a positive integer.")
    j_hk_tolerance = _validate_positive_finite("j_hk_tolerance", j_hk_tolerance)
    round_trip_tolerance = _validate_positive_finite(
        "round_trip_tolerance", round_trip_tolerance
    )
    gaussian_blur_sigma = _validate_blur_sigma(gaussian_blur_sigma)
    source = np.asarray(pixels, dtype=np.float32)
    if source.ndim != 3 or source.shape[-1] != 3:
        raise ValueError("Input pixels must have shape H x W x 3.")
    if not np.all(np.isfinite(source)):
        raise ValueError("Input pixels contain non-finite values.")

    model = AppearanceModel.from_config(default_config().appearance)
    neutral_scene = np.full((1, 3), np.float32(refl), dtype=np.float32)
    neutral_display = processor.forward(neutral_scene)
    target_j_hk = float(model.xyz_d65_to_attributes(neutral_display)["J_HK"][0])
    if not np.isfinite(target_j_hk):
        raise RuntimeError("Neutral display target produced non-finite J_HK.")

    height, width = source.shape[:2]
    source_flat = source.reshape(-1, 3)
    working_flat = np.empty_like(source_flat, dtype=np.float32)
    base_flat = np.empty_like(source_flat, dtype=np.float32)
    exposure_flat = np.empty(source_flat.shape[0], dtype=np.float32)
    max_inverse_round_trip = 0.0
    max_reconstructed_error = 0.0
    reconstructed_exceedances = 0
    inverse_round_trip_failures = 0
    inverse_round_trip_exceedances = 0
    zero_count = 0
    clipped_exposure_count = 0
    maximum_j_hk_error = 0.0
    j_hk_exceedances = 0
    projected_pixel_count = 0
    maximum_projection_error = 0.0
    negative_ap0_clamped_count = 0

    chunks = [
        (start, min(start + chunk_size, source_flat.shape[0]))
        for start in range(0, source_flat.shape[0], chunk_size)
    ]

    def prepare_chunk(start_stop: tuple[int, int]):
        start, stop = start_stop
        scene = processor.to_ap0(source_flat[start:stop])
        if not np.all(np.isfinite(scene)):
            raise RuntimeError("Input-to-ACES2065-1 conversion produced non-finite values.")
        display_original = processor.un_tone(scene)
        if not np.all(np.isfinite(display_original)):
            raise RuntimeError("Un-tone-mapped ACES transform produced non-finite values.")
        if project_unreachable:
            display_target, projection_mask, projection_error = (
                project_unreachable_display_values(
                    display_original, processor.profile
                )
            )
        else:
            display_target = display_original
            projection_mask = np.zeros(display_original.shape[0], dtype=bool)
            projection_error = 0.0
        working = processor.inverse(display_target)
        if not np.all(np.isfinite(working)):
            raise RuntimeError("Selected ACES 2.0 inverse produced non-finite AP0 values.")
        negative_working = np.min(working, axis=-1) < -1.0e-6
        if np.any(negative_working) and not project_unreachable:
            count = int(np.count_nonzero(negative_working))
            minimum = float(np.min(working[negative_working]))
            raise RuntimeError(
                "Selected ACES 2.0 view cannot invert "
                f"{count} pixel(s) without negative AP0 values "
                f"(minimum={minimum:.9g}); rerun with --project-unreachable "
                "to project and clamp those pixels."
            )
        reconstructed_display = processor.forward(working)
        residual = np.max(
            np.abs(
                reconstructed_display.astype(np.float64)
                - display_target.astype(np.float64)
            ),
            axis=-1,
        )
        chunk_inverse_round_trip = float(np.max(residual, initial=0.0))
        exceedance_count = int(np.count_nonzero(residual > round_trip_tolerance))
        # Projection and negative-AP0 clamping are explicit lossy operations.
        # All round-trip residuals are retained in diagnostics; tolerance
        # exceedances do not prevent output publication.
        unreachable_mask = projection_mask | negative_working
        failures = (residual > round_trip_tolerance) & ~unreachable_mask
        if project_unreachable and np.any(negative_working):
            working = np.maximum(working, 0.0)
        return (
            start,
            stop,
            working,
            int(np.count_nonzero(failures)),
            exceedance_count,
            chunk_inverse_round_trip,
            int(np.count_nonzero(projection_mask)),
            projection_error,
            int(np.count_nonzero(negative_working)),
        )

    # CPUProcessor and the NumPy appearance-model operations are read-only for
    # each call's input arrays, so independent image chunks can be evaluated in
    # parallel.  Results are copied into their original ranges as futures
    # complete, keeping the output deterministic regardless of completion order.
    # Keep the requested pool size even when a small image has fewer chunks;
    # ThreadPoolExecutor creates threads lazily, while larger images can use
    # every available CPU as soon as enough chunks are queued.
    worker_count = workers
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(prepare_chunk, chunk) for chunk in chunks]
        try:
            for future in as_completed(futures):
                (
                    start,
                    stop,
                    chunk_working,
                    failure_count,
                    exceedance_count,
                    chunk_inverse_round_trip,
                    chunk_projected_count,
                    chunk_projection_error,
                    chunk_negative_count,
                ) = future.result()
                working_flat[start:stop] = chunk_working
                inverse_round_trip_failures += failure_count
                inverse_round_trip_exceedances += exceedance_count
                max_inverse_round_trip = max(
                    max_inverse_round_trip, chunk_inverse_round_trip
                )
                projected_pixel_count += chunk_projected_count
                maximum_projection_error = max(
                    maximum_projection_error, chunk_projection_error
                )
                negative_ap0_clamped_count += chunk_negative_count
        except BaseException:
            for future in futures:
                future.cancel()
            raise

    # The blur must happen to the AP0 working image before its per-pixel
    # lightness solve.  Blurring base and exposure after decomposition would
    # destroy the relationship Q = B * s.
    working_image = working_flat.reshape(height, width, 3)
    if gaussian_blur_sigma > 0.0:
        working_image = gaussian_blur_working(working_image, gaussian_blur_sigma)
    working_flat = working_image.reshape(-1, 3)

    def solve_chunk(start_stop: tuple[int, int]):
        start, stop = start_stop
        chunk_working = working_flat[start:stop]
        (
            chunk_base,
            chunk_exposure,
            zero,
            clipped,
            chunk_j_hk_error,
            chunk_j_hk_exceedance_count,
        ) = _solve_chunk(
            chunk_working,
            processor,
            model,
            target_j_hk,
            refl=refl,
            solver_iterations=solver_iterations,
            j_hk_tolerance=j_hk_tolerance,
        )
        decoded = np.empty_like(chunk_working, dtype=np.float32)
        decoded[zero] = 0.0
        active = ~zero
        if np.any(active):
            encoded_e = (
                chunk_exposure[active].astype(np.float64) * EXPOSURE_SCALE
                - EXPOSURE_OFFSET
            )
            decoded[active] = chunk_base[active] * np.exp2(encoded_e)[..., None]
        decoded_error = np.max(
            np.abs(decoded.astype(np.float64) - chunk_working.astype(np.float64)),
            axis=-1,
        )
        reconstructed_exceedance_count = int(
            np.count_nonzero(decoded_error > round_trip_tolerance)
        )
        return (
            start,
            stop,
            chunk_base,
            chunk_exposure,
            zero,
            int(np.count_nonzero(clipped)),
            chunk_j_hk_error,
            float(np.max(decoded_error, initial=0.0)),
            chunk_j_hk_exceedance_count,
            reconstructed_exceedance_count,
        )

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(solve_chunk, chunk) for chunk in chunks]
        try:
            for future in as_completed(futures):
                (
                    start,
                    stop,
                    chunk_base,
                    chunk_exposure,
                    zero,
                    clipped_count,
                    chunk_j_hk_error,
                    chunk_reconstructed_error,
                    chunk_j_hk_exceedance_count,
                    chunk_reconstructed_exceedance_count,
                ) = future.result()
                base_flat[start:stop] = chunk_base
                exposure_flat[start:stop] = chunk_exposure
                zero_count += int(np.count_nonzero(zero))
                clipped_exposure_count += clipped_count
                maximum_j_hk_error = max(maximum_j_hk_error, chunk_j_hk_error)
                max_reconstructed_error = max(
                    max_reconstructed_error, chunk_reconstructed_error
                )
                j_hk_exceedances += chunk_j_hk_exceedance_count
                reconstructed_exceedances += chunk_reconstructed_exceedance_count
        except BaseException:
            for future in futures:
                future.cancel()
            raise

    base_image = base_flat.reshape(height, width, 3)
    exposure_image = exposure_flat.reshape(height, width)

    return DecompositionResult(
        base=base_image,
        exposure=exposure_image,
        input_color_space="",
        profile=processor.profile,
        refl=refl,
        target_j_hk=target_j_hk,
        diagnostics={
            "inverse_round_trip_max_error": max_inverse_round_trip,
            "inverse_round_trip_failure_count": inverse_round_trip_failures,
            "inverse_round_trip_exceedance_count": inverse_round_trip_exceedances,
            "reconstructed_working_max_error": max_reconstructed_error,
            "reconstructed_working_exceedance_count": reconstructed_exceedances,
            "zero_pixel_count": zero_count,
            "exposure_clipped_pixel_count": clipped_exposure_count,
            "maximum_j_hk_error": maximum_j_hk_error,
            "j_hk_exceedance_count": j_hk_exceedances,
        "workers": worker_count,
        "project_unreachable": int(project_unreachable),
            "projected_pixel_count": projected_pixel_count,
            "maximum_projection_error": maximum_projection_error,
            "negative_ap0_clamped_pixel_count": negative_ap0_clamped_count,
            "gaussian_blur_sigma": gaussian_blur_sigma,
        },
    )


def _comments(
    result: DecompositionResult,
    input_color_space: str,
    processor: DecompositionProcessor,
) -> str:
    return (
        "modCAM16-HK ACES 2.0 image decomposition; "
        f"input color space={input_color_space}; working space=ACES2065-1; "
        f"profile={result.profile.name}; view={result.profile.view_transform}; "
        f"Refl={result.refl:.9g}; target J_HK={result.target_j_hk:.9g}; "
        "base output=linear ACEScg/AP1 fp16; exposure output=fp16; "
        "base >1.0 report counts AP1 pixels with any channel strictly >1; "
        f"pre-decomposition Gaussian blur sigma={result.diagnostics.get('gaussian_blur_sigma', 0.0):.9g}px; "
        "exposure channel=clamp(log2(s),-10,10)/20+0.5; "
        "nonzero AP0 reconstruction=B*2^(exposure*20-10); stored base=AP1(B); "
        "zero working pixels use neutral base and explicit s=0; "
        f"workers={result.diagnostics.get('workers', 1)}; "
        f"source gamut={result.source_gamut or 'unspecified'}; "
        f"source transfer={result.source_transfer or 'unspecified'}; "
        f"metadata source={result.metadata_source or 'explicit selection'}; "
        f"input format={result.input_format or 'unknown'}; "
        f"OCIO config={processor.config_path}"
    )


def _copy_geometry_attributes(source_header: Mapping[str, Any] | None) -> dict[str, Any]:
    """Translate low-level OpenEXR geometry attributes for ``OpenEXR.File``."""

    if not source_header:
        return {}
    copied: dict[str, Any] = {}
    for key in ("dataWindow", "displayWindow"):
        value = source_header.get(key)
        try:
            copied[key] = (
                (int(value.min.x), int(value.min.y)),
                (int(value.max.x), int(value.max.y)),
            )
        except (AttributeError, TypeError, ValueError):
            pass
    for key in ("pixelAspectRatio", "screenWindowWidth"):
        value = source_header.get(key)
        if isinstance(value, (int, float, np.integer, np.floating)):
            copied[key] = float(value)
    value = source_header.get("screenWindowCenter")
    try:
        copied["screenWindowCenter"] = (float(value.x), float(value.y))
    except (AttributeError, TypeError, ValueError):
        pass
    return copied


def write_decomposition_exrs(
    base_path: str | Path,
    exposure_path: str | Path,
    result: DecompositionResult,
    *,
    input_color_space: str,
    processor: DecompositionProcessor,
    source_header: Mapping[str, Any] | None = None,
) -> None:
    """Write a linear ACEScg/AP1 fp16 base and fp16 exposure EXR."""

    try:
        import OpenEXR
    except ImportError as exc:  # pragma: no cover - dependency is project-required
        raise RuntimeError("OpenEXR is required to write decomposition EXRs.") from exc
    base_path = Path(base_path)
    exposure_path = Path(exposure_path)
    base_path.parent.mkdir(parents=True, exist_ok=True)
    exposure_path.parent.mkdir(parents=True, exist_ok=True)
    base_ap1 = processor.to_ap1(
        np.asarray(result.base, dtype=np.float32).reshape(-1, 3)
    ).reshape(result.base.shape)
    if not np.all(np.isfinite(base_ap1)):
        raise RuntimeError("AP0-to-ACEScg conversion produced non-finite base values.")
    base_pixels = np.asarray(base_ap1, dtype=np.float16)
    if not np.all(np.isfinite(base_pixels)):
        maximum = float(np.max(np.abs(base_ap1)))
        raise RuntimeError(
            "Base color contains values that cannot be represented in fp16 "
            f"(maximum absolute value={maximum:.9g})."
        )
    base_above_one = np.any(base_ap1 > np.float32(1.0), axis=-1)
    base_above_one_count = int(np.count_nonzero(base_above_one))
    base_pixel_count = int(base_above_one.size)
    base_above_one_percent = (
        100.0 * base_above_one_count / base_pixel_count
        if base_pixel_count
        else 0.0
    )
    exposure_pixels = np.asarray(result.exposure, dtype=np.float16)
    if not np.all(np.isfinite(exposure_pixels)):
        raise RuntimeError("Exposure contains non-finite values and cannot be written as fp16.")
    comments = _comments(result, input_color_space, processor)
    geometry = _copy_geometry_attributes(source_header)
    base_header = {
        "compression": OpenEXR.ZIP_COMPRESSION,
        "type": OpenEXR.scanlineimage,
        "ocioColorSpace": "ACEScg",
        "decompositionWorkingColorSpace": "ACES2065-1",
        "decompositionBaseColorSpace": "ACEScg",
        "decompositionBasePixelType": "fp16",
        "decompositionBaseAboveOnePixels": base_above_one_count,
        "decompositionBaseAboveOnePercent": base_above_one_percent,
        "decompositionGaussianBlurSigma": float(
            result.diagnostics.get("gaussian_blur_sigma", 0.0)
        ),
        "decompositionComponent": "base",
        "decompositionInputColorSpace": input_color_space,
        "decompositionInputGamut": result.source_gamut or "",
        "decompositionInputTransferFunction": result.source_transfer or "",
        "decompositionInputMetadataSource": result.metadata_source or "",
        "decompositionInputFormat": result.input_format or "",
        "decompositionProfile": result.profile.name,
        "decompositionRefl": float(result.refl),
        "decompositionTargetJHK": float(result.target_j_hk),
        "decompositionExposureEncoding": "clamp(log2(s),-10,10)/20+0.5; zero s=0",
        "decompositionExposureClippedPixels": int(
            result.diagnostics.get("exposure_clipped_pixel_count", 0)
        ),
        "decompositionMaximumJHKError": float(
            result.diagnostics.get("maximum_j_hk_error", 0.0)
        ),
        "decompositionJHKExceedances": int(
            result.diagnostics.get("j_hk_exceedance_count", 0)
        ),
        "decompositionReconstructedWorkingExceedances": int(
            result.diagnostics.get("reconstructed_working_exceedance_count", 0)
        ),
        "decompositionWorkers": int(result.diagnostics.get("workers", 1)),
        "decompositionInverseRoundTripMaxError": float(
            result.diagnostics.get("inverse_round_trip_max_error", 0.0)
        ),
        "decompositionInverseRoundTripExceedances": int(
            result.diagnostics.get("inverse_round_trip_exceedance_count", 0)
        ),
        "decompositionNegativeAP0ClampedPixels": int(
            result.diagnostics.get("negative_ap0_clamped_pixel_count", 0)
        ),
        "decompositionProjectUnreachable": int(
            result.diagnostics.get("project_unreachable", 0)
        ),
        "decompositionProjectedPixels": int(
            result.diagnostics.get("projected_pixel_count", 0)
        ),
        "decompositionMaximumProjectionError": float(
            result.diagnostics.get("maximum_projection_error", 0.0)
        ),
        "comments": comments,
        **geometry,
        # AP1 chromaticities make the stored ACEScg gamut unambiguous to
        # applications that do not consume the OCIO metadata field.
        "chromaticities": _ACESCG_CHROMATICITIES,
    }
    exposure_header = {
        "compression": OpenEXR.ZIP_COMPRESSION,
        "type": OpenEXR.scanlineimage,
        "decompositionWorkingColorSpace": "ACES2065-1",
        "decompositionExposurePixelType": "fp16",
        "decompositionBaseAboveOnePixels": base_above_one_count,
        "decompositionBaseAboveOnePercent": base_above_one_percent,
        "decompositionGaussianBlurSigma": float(
            result.diagnostics.get("gaussian_blur_sigma", 0.0)
        ),
        "decompositionComponent": "exposure",
        "decompositionInputColorSpace": input_color_space,
        "decompositionInputGamut": result.source_gamut or "",
        "decompositionInputTransferFunction": result.source_transfer or "",
        "decompositionInputMetadataSource": result.metadata_source or "",
        "decompositionInputFormat": result.input_format or "",
        "decompositionProfile": result.profile.name,
        "decompositionRefl": float(result.refl),
        "decompositionTargetJHK": float(result.target_j_hk),
        "decompositionExposureEncoding": "clamp(log2(s),-10,10)/20+0.5; zero s=0",
        "decompositionExposureClippedPixels": int(
            result.diagnostics.get("exposure_clipped_pixel_count", 0)
        ),
        "decompositionMaximumJHKError": float(
            result.diagnostics.get("maximum_j_hk_error", 0.0)
        ),
        "decompositionJHKExceedances": int(
            result.diagnostics.get("j_hk_exceedance_count", 0)
        ),
        "decompositionReconstructedWorkingExceedances": int(
            result.diagnostics.get("reconstructed_working_exceedance_count", 0)
        ),
        "decompositionWorkers": int(result.diagnostics.get("workers", 1)),
        "decompositionInverseRoundTripMaxError": float(
            result.diagnostics.get("inverse_round_trip_max_error", 0.0)
        ),
        "decompositionInverseRoundTripExceedances": int(
            result.diagnostics.get("inverse_round_trip_exceedance_count", 0)
        ),
        "decompositionNegativeAP0ClampedPixels": int(
            result.diagnostics.get("negative_ap0_clamped_pixel_count", 0)
        ),
        "decompositionProjectUnreachable": int(
            result.diagnostics.get("project_unreachable", 0)
        ),
        "decompositionProjectedPixels": int(
            result.diagnostics.get("projected_pixel_count", 0)
        ),
        "decompositionMaximumProjectionError": float(
            result.diagnostics.get("maximum_projection_error", 0.0)
        ),
        "comments": comments,
        **geometry,
    }
    with OpenEXR.File(base_header, {"RGB": base_pixels}) as output:
        output.write(str(base_path))
    with OpenEXR.File(
        exposure_header, {"exposure": exposure_pixels}
    ) as output:
        output.write(str(exposure_path))


def decompose_file(
    input_path: str | Path,
    *,
    profile: str | DecompositionProfile,
    refl: float = DEFAULT_REFL,
    input_color_space: str | None = None,
    input_gamut: str | None = None,
    input_transfer_function: str | None = None,
    ocio_config_path: str | Path = DEFAULT_OCIO_CONFIG_PATH,
    base_output: str | Path | None = None,
    exposure_output: str | Path | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    solver_iterations: int = DEFAULT_SOLVER_ITERATIONS,
    j_hk_tolerance: float = DEFAULT_J_HK_TOLERANCE,
    round_trip_tolerance: float = DEFAULT_ROUND_TRIP_TOLERANCE,
    workers: int = DEFAULT_WORKERS,
    project_unreachable: bool = False,
    gaussian_blur_sigma: float = DEFAULT_GAUSSIAN_BLUR_SIGMA,
) -> tuple[Path, Path, DecompositionResult]:
    """Read, decompose, and write one input image."""

    input_path = Path(input_path)
    decoded = read_image(input_path)
    config_path = _resolve_config_path(ocio_config_path)
    ocio = _import_ocio()
    ocio_config = ocio.Config.CreateFromFile(str(config_path))
    detected_input = (
        detect_input_color_space(decoded.header, ocio_config)
        if input_path.suffix.casefold() == ".exr"
        else None
    )
    if input_color_space is not None:
        if input_gamut is not None or input_transfer_function is not None:
            raise ValueError(
                "--input-color-space cannot be combined with --input-gamut or "
                "--input-transfer-function."
            )
        selected_input = canonical_input_color_space(input_color_space)
        selected_gamut, selected_transfer = _input_spec_from_combined_space(selected_input)
    elif detected_input or decoded.color_space:
        selected_input = canonical_input_color_space(detected_input or decoded.color_space)
        selected_gamut, selected_transfer = _input_spec_from_combined_space(selected_input)
    else:
        selected_gamut = decoded.source_gamut
        selected_transfer = decoded.source_transfer
        if input_gamut is not None:
            selected_gamut = canonical_input_gamut(input_gamut)
        if input_transfer_function is not None:
            selected_transfer = canonical_input_transfer_function(input_transfer_function)
        if selected_gamut is None or selected_transfer is None:
            prompted_gamut, prompted_transfer = prompt_input_gamut_and_transfer()
            selected_gamut = selected_gamut or prompted_gamut
            selected_transfer = selected_transfer or prompted_transfer
        selected_gamut = canonical_input_gamut(selected_gamut)
        selected_transfer = canonical_input_transfer_function(selected_transfer)
        selected_input = _gamut_to_linear_space(selected_gamut)
    if selected_transfer != "Linear":
        working_pixels = _transfer_decode(decoded.pixels, selected_transfer)
    else:
        working_pixels = decoded.pixels
    processor = load_decomposition_processor(
        selected_input, profile, ocio_config_path=config_path
    )
    result = decompose_image(
        working_pixels,
        processor,
        refl=refl,
        chunk_size=chunk_size,
        solver_iterations=solver_iterations,
        j_hk_tolerance=j_hk_tolerance,
        round_trip_tolerance=round_trip_tolerance,
        workers=workers,
        project_unreachable=project_unreachable,
        gaussian_blur_sigma=gaussian_blur_sigma,
    )
    base_above_one_count, base_above_one_percent = base_ap1_above_one_statistics(
        result.base, processor
    )
    diagnostics = dict(result.diagnostics)
    diagnostics.update(
        {
            "base_ap1_above_one_pixel_count": base_above_one_count,
            "base_ap1_above_one_pixel_percent": base_above_one_percent,
        }
    )
    result = DecompositionResult(
        base=result.base,
        exposure=result.exposure,
        input_color_space=selected_input,
        profile=result.profile,
        refl=result.refl,
        target_j_hk=result.target_j_hk,
        diagnostics=diagnostics,
        source_gamut=selected_gamut,
        source_transfer=selected_transfer,
        metadata_source=decoded.metadata_source,
        input_format=input_path.suffix.casefold().lstrip("."),
    )
    base_path = (
        Path(base_output)
        if base_output is not None
        else input_path.with_name(f"{input_path.stem}-base-{result.refl:.9g}.exr")
    )
    exposure_path = (
        Path(exposure_output)
        if exposure_output is not None
        else input_path.with_name(f"{input_path.stem}-exposure-{result.refl:.9g}.exr")
    )
    if base_path.resolve() == exposure_path.resolve():
        raise ValueError("base-output and exposure-output must be different files.")
    write_decomposition_exrs(
        base_path,
        exposure_path,
        result,
        input_color_space=selected_input,
        processor=processor,
        source_header=decoded.header,
    )
    return base_path, exposure_path, result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="modcam16-decompose",
        description="Decompose an image into modCAM16-HK base and exposure EXRs.",
    )
    parser.add_argument("input", type=Path, help="input EXR, JPEG, PNG, HEIC, or HEIF image")
    parser.add_argument(
        "--profile",
        dest="profile",
        required=True,
        metavar="PROFILE",
        choices=tuple(DECOMPOSITION_PROFILE_DEFINITIONS),
    )
    parser.add_argument("--refl", type=float, default=DEFAULT_REFL)
    parser.add_argument(
        "--input-color-space",
        dest="input_color_space",
        choices=INPUT_COLOR_SPACES,
    )
    parser.add_argument("--input-gamut", choices=INPUT_GAMUTS)
    parser.add_argument("--input-transfer-function", choices=INPUT_TRANSFER_FUNCTIONS)
    parser.add_argument("--ocio-config", type=Path, default=DEFAULT_OCIO_CONFIG_PATH)
    parser.add_argument("--base-output", dest="base_output", type=Path)
    parser.add_argument(
        "--exposure-output", dest="exposure_output", type=Path
    )
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    parser.add_argument("--solver-iterations", type=int, default=DEFAULT_SOLVER_ITERATIONS)
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"parallel worker threads (default: CPU count = {DEFAULT_WORKERS})",
    )
    parser.add_argument("--j-hk-tolerance", type=float, default=DEFAULT_J_HK_TOLERANCE)
    parser.add_argument(
        "--round-trip-tolerance", type=float, default=DEFAULT_ROUND_TRIP_TOLERANCE
    )
    parser.add_argument(
        "--project-unreachable",
        action="store_true",
        help="project out-of-gamut/over-peak display values before inversion",
    )
    parser.add_argument(
        "--gaussian-blur",
        dest="gaussian_blur_sigma",
        type=float,
        default=DEFAULT_GAUSSIAN_BLUR_SIGMA,
        metavar="SIGMA_PX",
        help=(
            "Gaussian blur sigma in pixels for base and exposure "
            f"(default: {DEFAULT_GAUSSIAN_BLUR_SIGMA:g}; opt-in)"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        base_path, exposure_path, result = decompose_file(
            args.input,
            profile=args.profile,
            refl=args.refl,
            input_color_space=args.input_color_space,
            input_gamut=args.input_gamut,
            input_transfer_function=args.input_transfer_function,
            ocio_config_path=args.ocio_config,
            base_output=args.base_output,
            exposure_output=args.exposure_output,
            chunk_size=args.chunk_size,
            solver_iterations=args.solver_iterations,
            j_hk_tolerance=args.j_hk_tolerance,
            round_trip_tolerance=args.round_trip_tolerance,
            workers=args.workers,
            project_unreachable=args.project_unreachable,
            gaussian_blur_sigma=args.gaussian_blur_sigma,
        )
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise SystemExit(f"error: {exc}") from exc
    print(f"Input color space: {result.input_color_space}")
    print(f"Input gamut: {result.source_gamut or 'unspecified'}")
    print(f"Input transfer function: {result.source_transfer or 'unspecified'}")
    print(f"Input format: {result.input_format or 'unknown'}")
    print(f"Profile: {result.profile.label}")
    print(f"Refl: {result.refl:.9g}")
    print(f"Base output: {base_path}")
    print(f"Exposure output: {exposure_path}")
    print(f"Zero pixels: {result.diagnostics['zero_pixel_count']}")
    print(
        "Exposure-clipped pixels: "
        f"{result.diagnostics['exposure_clipped_pixel_count']}"
    )
    print(
        "Inverse round-trip max error: "
        f"{result.diagnostics['inverse_round_trip_max_error']:.9g}"
    )
    print(
        "Inverse round-trip exceedances: "
        f"{result.diagnostics['inverse_round_trip_exceedance_count']}"
    )
    print(
        "J_HK tolerance exceedances: "
        f"{result.diagnostics['j_hk_exceedance_count']}"
    )
    print(
        "Reconstructed working tolerance exceedances: "
        f"{result.diagnostics['reconstructed_working_exceedance_count']}"
    )
    print(
        "Negative AP0 clamped pixels: "
        f"{result.diagnostics['negative_ap0_clamped_pixel_count']}"
    )
    print(
        "Base pixels with an AP1 RGB channel > 1.0: "
        f"{result.diagnostics['base_ap1_above_one_pixel_count']} "
        f"({result.diagnostics['base_ap1_above_one_pixel_percent']:.6f}%)"
    )
    print(f"Workers: {result.diagnostics['workers']}")
    print(f"Projected pixels: {result.diagnostics['projected_pixel_count']}")
    return 0


__all__ = [
    "DECOMPOSITION_PROFILE_DEFINITIONS",
    "DEFAULT_GAUSSIAN_BLUR_SIGMA",
    "DEFAULT_REFL",
    "DEFAULT_WORKERS",
    "INPUT_COLOR_SPACES",
    "INPUT_GAMUTS",
    "INPUT_TRANSFER_FUNCTIONS",
    "DecompositionInput",
    "DecompositionProcessor",
    "DecompositionProfile",
    "DecompositionResult",
    "canonical_input_color_space",
    "canonical_input_gamut",
    "canonical_input_transfer_function",
    "canonical_profile",
    "decompose_file",
    "decompose_image",
    "detect_input_color_space",
    "gaussian_blur_working",
    "load_decomposition_processor",
    "main",
    "project_unreachable_display_values",
    "prompt_input_color_space",
    "read_rgb_exr",
    "read_image",
    "write_decomposition_exrs",
]


if __name__ == "__main__":  # pragma: no cover - exercised by the console script
    raise SystemExit(main())
