"""Hellwig-Fairchild revised CAM16 with the modCAM16-HK correction."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import colorimetry
from .config import AppearanceConfig

CAM16_RESPONSE_LOWER = 0.26
CAM16_RESPONSE_UPPER = 150.0


def signed_power(value: np.ndarray, exponent: float) -> np.ndarray:
    value = np.asarray(value, dtype=np.float64)
    return np.sign(value) * np.power(np.abs(value), exponent)


def luminance_level_adaptation_factor(adapting_luminance: float) -> float:
    adapting_luminance = float(adapting_luminance)
    if adapting_luminance <= 0.0:
        raise ValueError("ADAPTING_LUMINANCE_NITS must be positive.")
    k = 1.0 / (5.0 * adapting_luminance + 1.0)
    k4 = k**4
    return float(
        0.2 * k4 * 5.0 * adapting_luminance
        + 0.1 * (1.0 - k4) ** 2 * np.cbrt(5.0 * adapting_luminance)
    )


def cam16_hyperbolic_response(cone_response: np.ndarray, f_l: float) -> np.ndarray:
    cone_response = np.asarray(cone_response, dtype=np.float64)
    power_term = np.power(f_l * cone_response / 100.0, 0.42)
    return 400.0 * power_term / (27.13 + power_term)


def cam16_hyperbolic_response_derivative(
    cone_response: np.ndarray, f_l: float
) -> np.ndarray:
    cone_response = np.asarray(cone_response, dtype=np.float64)
    normalized_response = f_l * cone_response / 100.0
    power_term = np.power(normalized_response, 0.42)
    return (
        1.68
        * 27.13
        * f_l
        * np.power(normalized_response, -0.58)
        / np.power(27.13 + power_term, 2.0)
    )


def response_compression_forward(sharpened_rgb: np.ndarray, f_l: float) -> np.ndarray:
    """Apply piecewise CIECAM16 response compression."""

    cone_response = np.asarray(sharpened_rgb, dtype=np.float64)
    lower = CAM16_RESPONSE_LOWER
    upper = CAM16_RESPONSE_UPPER
    response_at_lower = float(cam16_hyperbolic_response(lower, f_l))
    response_at_upper = float(cam16_hyperbolic_response(upper, f_l))
    upper_slope = float(cam16_hyperbolic_response_derivative(upper, f_l))
    middle_input = np.clip(cone_response, lower, upper)
    middle_response = cam16_hyperbolic_response(middle_input, f_l)
    lower_response = response_at_lower * cone_response / lower
    upper_response = response_at_upper + upper_slope * (cone_response - upper)
    unoffset_response = np.where(
        cone_response < lower,
        lower_response,
        np.where(cone_response > upper, upper_response, middle_response),
    )
    return unoffset_response + 0.1


def response_compression_inverse(compressed_rgb: np.ndarray, f_l: float) -> np.ndarray:
    """Invert piecewise CIECAM16 response compression."""

    compressed_rgb = np.asarray(compressed_rgb, dtype=np.float64)
    response = compressed_rgb - 0.1
    lower = CAM16_RESPONSE_LOWER
    upper = CAM16_RESPONSE_UPPER
    response_at_lower = float(cam16_hyperbolic_response(lower, f_l))
    response_at_upper = float(cam16_hyperbolic_response(upper, f_l))
    upper_slope = float(cam16_hyperbolic_response_derivative(upper, f_l))
    middle_response = np.clip(response, response_at_lower, response_at_upper)
    middle_base = 27.13 * middle_response / (400.0 - middle_response)
    middle_cone_response = 100.0 / f_l * np.power(middle_base, 1.0 / 0.42)
    lower_cone_response = lower * response / response_at_lower
    upper_cone_response = upper + (response - response_at_upper) / upper_slope
    cone_response = np.where(
        response < response_at_lower,
        lower_cone_response,
        np.where(
            response > response_at_upper, upper_cone_response, middle_cone_response
        ),
    )
    return np.where(np.isfinite(response), cone_response, np.nan)


def hellwig_eccentricity_factor(hue_degrees: np.ndarray) -> np.ndarray:
    hue_radians = np.radians(np.asarray(hue_degrees, dtype=np.float64))
    return (
        -0.0582 * np.cos(hue_radians)
        - 0.0258 * np.cos(2.0 * hue_radians)
        - 0.1347 * np.cos(3.0 * hue_radians)
        + 0.0289 * np.cos(4.0 * hue_radians)
        - 0.1475 * np.sin(hue_radians)
        - 0.0308 * np.sin(2.0 * hue_radians)
        + 0.0385 * np.sin(3.0 * hue_radians)
        + 0.0096 * np.sin(4.0 * hue_radians)
        + 1.0
    )


@dataclass(frozen=True)
class AppearanceModel:
    """Precomputed viewing context and CAM16-HK conversion methods."""

    config: AppearanceConfig
    cam_xyz_white_100: np.ndarray
    cam_y_w: float
    cam_y_b: float
    cam_background_ratio: float
    cam_z: float
    cam_f_l: float
    cam_rgb_white: np.ndarray
    cam_adaptation_factors: np.ndarray
    cam_adapted_rgb_white: np.ndarray
    cam_compressed_rgb_white: np.ndarray
    cam_a_w: float
    reference_neutral_xyz_d65: np.ndarray
    target_j_hk: float
    target_q_hk: float
    hk_chroma_domain_limit: float

    @classmethod
    def from_config(cls, config: AppearanceConfig) -> AppearanceModel:
        if config.reference_white_luminance_nits <= 0.0:
            raise ValueError("REFERENCE_WHITE_LUMINANCE_NITS must be positive.")
        if config.reference_neutral_y != 1.0:
            raise ValueError("REFERENCE_NEUTRAL_Y must be exactly one.")
        background_luminance = (
            config.reference_background_ratio * config.reference_white_luminance_nits
        )
        if not 0.0 < background_luminance < config.reference_white_luminance_nits:
            raise ValueError(
                "BACKGROUND_LUMINANCE_NITS must be positive and below REFERENCE_WHITE_LUMINANCE_NITS."
            )
        if not 0.0 <= config.degree_of_adaptation <= 1.0:
            raise ValueError("DEGREE_OF_ADAPTATION must lie in [0, 1].")

        cam_xyz_white_100 = colorimetry.xy_to_xyz(colorimetry.D65_WHITE_XY) * 100.0
        cam_y_w = 100.0
        cam_y_b = 100.0 * background_luminance / config.reference_white_luminance_nits
        cam_background_ratio = cam_y_b / cam_y_w
        cam_z = 1.48 + np.sqrt(cam_background_ratio)
        cam_f_l = luminance_level_adaptation_factor(config.adapting_luminance_nits)
        cam_rgb_white = colorimetry.apply_matrix(
            colorimetry.CAT16_MATRIX, cam_xyz_white_100
        )
        cam_adaptation_factors = (
            config.degree_of_adaptation * cam_y_w / cam_rgb_white
            + 1.0
            - config.degree_of_adaptation
        )
        cam_adapted_rgb_white = cam_adaptation_factors * cam_rgb_white
        cam_compressed_rgb_white = response_compression_forward(
            cam_adapted_rgb_white, cam_f_l
        )
        cam_a_w = float(
            2.0 * cam_compressed_rgb_white[0]
            + cam_compressed_rgb_white[1]
            + 0.05 * cam_compressed_rgb_white[2]
            - 0.305
        )
        if cam_a_w <= 0.0:
            raise RuntimeError("Reference-white achromatic response is invalid.")

        model = cls(
            config=config,
            cam_xyz_white_100=cam_xyz_white_100,
            cam_y_w=cam_y_w,
            cam_y_b=float(cam_y_b),
            cam_background_ratio=float(cam_background_ratio),
            cam_z=float(cam_z),
            cam_f_l=float(cam_f_l),
            cam_rgb_white=cam_rgb_white,
            cam_adaptation_factors=cam_adaptation_factors,
            cam_adapted_rgb_white=cam_adapted_rgb_white,
            cam_compressed_rgb_white=cam_compressed_rgb_white,
            cam_a_w=cam_a_w,
            reference_neutral_xyz_d65=(
                colorimetry.xy_to_xyz(colorimetry.D65_WHITE_XY)
                * config.reference_neutral_y
            ),
            target_j_hk=0.0,
            target_q_hk=0.0,
            hk_chroma_domain_limit=0.0,
        )
        neutral = model.xyz_d65_to_attributes(model.reference_neutral_xyz_d65)
        if abs(float(neutral["C"])) > 1.0e-8:
            raise RuntimeError(
                "D65 neutral produced unexpected nonzero chroma:\n"
                f"  C = {float(neutral['C']):.12g}"
            )
        target_j_hk = float(neutral["J_HK"])
        hk_limit = target_j_hk * target_j_hk / config.hk_chroma_coefficient
        result = cls(
            **{
                **model.__dict__,
                "target_j_hk": target_j_hk,
                "target_q_hk": 2.0 / config.surround_c * target_j_hk / 100.0 * cam_a_w,
                "hk_chroma_domain_limit": float(hk_limit),
            }
        )
        neutral_inverse = result.modcam16_hk_to_xyz_d65(target_j_hk, 0.0, 0.0)
        if not np.allclose(
            neutral_inverse, result.reference_neutral_xyz_d65, atol=5.0e-10, rtol=0.0
        ):
            raise RuntimeError(
                "Neutral inverse validation failed:\n"
                f"  Expected XYZ: {result.reference_neutral_xyz_d65}\n"
                f"  Received XYZ: {neutral_inverse}"
            )
        return result

    def xyz_d65_to_attributes(self, xyz_d65: np.ndarray) -> dict[str, np.ndarray]:
        values = np.asarray(xyz_d65, dtype=np.float64)
        xyz_100 = values * 100.0
        sharpened_rgb = colorimetry.apply_matrix(colorimetry.CAT16_MATRIX, xyz_100)
        adapted_rgb = sharpened_rgb * self.cam_adaptation_factors
        compressed_rgb = response_compression_forward(adapted_rgb, self.cam_f_l)
        red = compressed_rgb[..., 0]
        green = compressed_rgb[..., 1]
        blue = compressed_rgb[..., 2]
        opponent_a = red - 12.0 * green / 11.0 + blue / 11.0
        opponent_b = (red + green - 2.0 * blue) / 9.0
        hue_degrees = np.mod(np.degrees(np.arctan2(opponent_b, opponent_a)), 360.0)
        eccentricity = hellwig_eccentricity_factor(hue_degrees)
        achromatic_response = 2.0 * red + green + 0.05 * blue - 0.305
        lightness = 100.0 * signed_power(
            achromatic_response / self.cam_a_w,
            self.config.surround_c * self.cam_z,
        )
        brightness = 2.0 / self.config.surround_c * lightness / 100.0 * self.cam_a_w
        colorfulness = (
            43.0
            * self.config.surround_n_c
            * eccentricity
            * np.hypot(opponent_a, opponent_b)
        )
        chroma = 35.0 * colorfulness / self.cam_a_w
        saturation = np.divide(
            100.0 * colorfulness,
            brightness,
            out=np.zeros_like(colorfulness, dtype=np.float64),
            where=np.abs(brightness) > 1.0e-15,
        )
        hk_lightness = np.sqrt(
            np.maximum(
                lightness * lightness + self.config.hk_chroma_coefficient * chroma, 0.0
            )
        )
        hk_brightness = (
            2.0 / self.config.surround_c * hk_lightness / 100.0 * self.cam_a_w
        )
        return {
            "J": lightness,
            "C": chroma,
            "h": hue_degrees,
            "Q": brightness,
            "M": colorfulness,
            "s": saturation,
            "J_HK": hk_lightness,
            "Q_HK": hk_brightness,
        }

    def modcam16_hk_to_xyz_d65(
        self, hk_lightness: float, chroma: np.ndarray, hue_degrees: np.ndarray
    ) -> np.ndarray:
        chroma = np.asarray(chroma, dtype=np.float64)
        hue_degrees = np.asarray(hue_degrees, dtype=np.float64)
        chroma, hue_degrees = np.broadcast_arrays(chroma, hue_degrees)
        hk_lightness = float(hk_lightness)
        radicand = (
            hk_lightness * hk_lightness - self.config.hk_chroma_coefficient * chroma
        )
        radicand_tolerance = 1.0e-12 * max(1.0, hk_lightness * hk_lightness)
        valid = (
            np.isfinite(chroma)
            & np.isfinite(hue_degrees)
            & (chroma >= 0.0)
            & (radicand >= -radicand_tolerance)
        )
        lightness = np.where(valid, np.sqrt(np.maximum(radicand, 0.0)), np.nan)
        colorfulness = chroma * self.cam_a_w / 35.0
        eccentricity = hellwig_eccentricity_factor(hue_degrees)
        opponent_radius = colorfulness / (
            43.0 * self.config.surround_n_c * eccentricity
        )
        hue_radians = np.radians(hue_degrees)
        opponent_a = opponent_radius * np.cos(hue_radians)
        opponent_b = opponent_radius * np.sin(hue_radians)
        achromatic_response = self.cam_a_w * np.power(
            lightness / 100.0, 1.0 / (self.config.surround_c * self.cam_z)
        )
        opponent_vector = np.stack(
            (achromatic_response + 0.305, opponent_a, opponent_b), axis=-1
        )
        compressed_rgb = (
            colorimetry.apply_matrix(
                colorimetry.OPPONENT_TO_COMPRESSED_RGB_MATRIX, opponent_vector
            )
            / 1403.0
        )
        adapted_rgb = response_compression_inverse(compressed_rgb, self.cam_f_l)
        sharpened_rgb = adapted_rgb / self.cam_adaptation_factors
        xyz_100 = colorimetry.apply_matrix(
            colorimetry.CAT16_INVERSE_MATRIX, sharpened_rgb
        )
        xyz_d65 = xyz_100 / 100.0
        return np.where(valid[..., None], xyz_d65, np.nan)

    def chroma_hue_to_xyz_d65(
        self, chroma: np.ndarray, hue_degrees: np.ndarray
    ) -> np.ndarray:
        return self.modcam16_hk_to_xyz_d65(self.target_j_hk, chroma, hue_degrees)
