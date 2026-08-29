"""Colorimetric primitives and the RGB/XYZ matrices used by the generator."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

D65_WHITE_XY = np.array([0.3127, 0.3290], dtype=np.float64)
D50_WHITE_XY = np.array([0.34567, 0.35850], dtype=np.float64)
ILLUMINANT_C_WHITE_XY = np.array([0.3101, 0.3163], dtype=np.float64)
ACES_D60_WHITE_XY = np.array([0.32168, 0.33767], dtype=np.float64)

SRGB_D65_PRIMARIES_XY = np.array(
    [[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]], dtype=np.float64
)
P3_D65_PRIMARIES_XY = np.array(
    [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]], dtype=np.float64
)
AP1_PRIMARIES_XY = np.array(
    [[0.713, 0.293], [0.165, 0.830], [0.128, 0.044]], dtype=np.float64
)

BRADFORD_MATRIX = np.array(
    [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]],
    dtype=np.float64,
)
CAT02_MATRIX = np.array(
    [[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.0030, 0.0136, 0.9834]],
    dtype=np.float64,
)
CAT16_MATRIX = np.array(
    [
        [0.401288, 0.650173, -0.051461],
        [-0.250268, 1.204414, 0.045854],
        [-0.002079, 0.048952, 0.953127],
    ],
    dtype=np.float64,
)
CAT16_INVERSE_MATRIX = np.linalg.inv(CAT16_MATRIX)
OPPONENT_TO_COMPRESSED_RGB_MATRIX = np.array(
    [[460.0, 451.0, 288.0], [460.0, -891.0, -261.0], [460.0, -220.0, -6300.0]],
    dtype=np.float64,
)


def apply_matrix(matrix: np.ndarray, vectors: np.ndarray) -> np.ndarray:
    """Apply a 3x3 matrix to vectors whose final dimension is three."""

    return np.einsum("ij,...j->...i", matrix, np.asarray(vectors, dtype=np.float64))


def xy_to_xyz(xy: np.ndarray) -> np.ndarray:
    """Convert xy to XYZ with Y normalized to one."""

    x = float(xy[0])
    y = float(xy[1])
    if y <= 0.0:
        raise ValueError(f"Invalid xy chromaticity with y <= 0: {xy}")
    return np.array([x / y, 1.0, (1.0 - x - y) / y], dtype=np.float64)


def xyy_to_xyz(xyy: np.ndarray) -> np.ndarray:
    """Convert one or more xyY triplets to XYZ."""

    values = np.asarray(xyy, dtype=np.float64)
    x = values[..., 0]
    y = values[..., 1]
    luminance = values[..., 2]
    if np.any(y <= 0.0):
        raise ValueError("xyY data contains y <= 0.")
    return np.stack(
        (x * luminance / y, luminance, (1.0 - x - y) * luminance / y), axis=-1
    )


def lab_to_xyz(lab: np.ndarray, white_xy: np.ndarray) -> np.ndarray:
    """Convert CIE Lab to XYZ normalized so the reference white has Y=1."""

    values = np.asarray(lab, dtype=np.float64)
    lightness = values[..., 0]
    a_star = values[..., 1]
    b_star = values[..., 2]
    f_y = (lightness + 16.0) / 116.0
    f_x = f_y + a_star / 500.0
    f_z = f_y - b_star / 200.0
    delta = 6.0 / 29.0

    def inverse_f(value: np.ndarray) -> np.ndarray:
        return np.where(
            value > delta,
            value**3,
            3.0 * delta**2 * (value - 4.0 / 29.0),
        )

    relative_xyz = np.stack((inverse_f(f_x), inverse_f(f_y), inverse_f(f_z)), axis=-1)
    return relative_xyz * xy_to_xyz(white_xy)


def normalized_primary_matrix(
    primaries_xy: np.ndarray, white_xy: np.ndarray
) -> np.ndarray:
    """Construct a normalized linear RGB-to-XYZ matrix."""

    primary_matrix = np.column_stack(
        [
            xy_to_xyz(primaries_xy[0]),
            xy_to_xyz(primaries_xy[1]),
            xy_to_xyz(primaries_xy[2]),
        ]
    )
    scale_factors = np.linalg.solve(primary_matrix, xy_to_xyz(white_xy))
    return primary_matrix @ np.diag(scale_factors)


def von_kries_adaptation_matrix(
    source_white_xy: np.ndarray,
    destination_white_xy: np.ndarray,
    cone_matrix: np.ndarray,
) -> np.ndarray:
    """Construct a Von Kries chromatic-adaptation matrix."""

    source_lms = cone_matrix @ xy_to_xyz(source_white_xy)
    destination_lms = cone_matrix @ xy_to_xyz(destination_white_xy)
    return (
        np.linalg.inv(cone_matrix) @ np.diag(destination_lms / source_lms) @ cone_matrix
    )


def chromatic_adaptation_matrix(
    source_white_xy: np.ndarray,
    destination_white_xy: np.ndarray,
    method: str = "Bradford",
) -> np.ndarray:
    """Construct a Bradford or CAT02 chromatic-adaptation matrix."""

    if method == "Bradford":
        cone_matrix = BRADFORD_MATRIX
    elif method == "CAT02":
        cone_matrix = CAT02_MATRIX
    else:
        raise ValueError(f"Unsupported chromatic-adaptation method: {method}")
    return von_kries_adaptation_matrix(
        source_white_xy, destination_white_xy, cone_matrix
    )


LINEAR_SRGB_TO_XYZ_D65 = normalized_primary_matrix(SRGB_D65_PRIMARIES_XY, D65_WHITE_XY)
XYZ_D65_TO_LINEAR_SRGB = np.linalg.inv(LINEAR_SRGB_TO_XYZ_D65)
P3_D65_TO_XYZ_D65 = normalized_primary_matrix(P3_D65_PRIMARIES_XY, D65_WHITE_XY)
XYZ_D65_TO_P3_D65 = np.linalg.inv(P3_D65_TO_XYZ_D65)
ACESCG_TO_XYZ_D60 = normalized_primary_matrix(AP1_PRIMARIES_XY, ACES_D60_WHITE_XY)
XYZ_D60_TO_ACESCG = np.linalg.inv(ACESCG_TO_XYZ_D60)
XYZ_D65_TO_XYZ_D60 = chromatic_adaptation_matrix(
    D65_WHITE_XY, ACES_D60_WHITE_XY, method="Bradford"
)
XYZ_D65_TO_ACESCG = XYZ_D60_TO_ACESCG @ XYZ_D65_TO_XYZ_D60
LINEAR_SRGB_TO_ACESCG = XYZ_D65_TO_ACESCG @ LINEAR_SRGB_TO_XYZ_D65
ACESCG_TO_LINEAR_SRGB = np.linalg.inv(LINEAR_SRGB_TO_ACESCG)
P3_D65_TO_ACESCG = XYZ_D65_TO_ACESCG @ P3_D65_TO_XYZ_D65
ACESCG_TO_P3_D65 = np.linalg.inv(P3_D65_TO_ACESCG)
ACESCG_TO_ACESCG = np.identity(3, dtype=np.float64)


@dataclass(frozen=True)
class GamutMatrices:
    """Matrices needed to build and store one palette gamut."""

    name: str
    xyz_d65_to_gamut_rgb: np.ndarray
    acescg_to_gamut_rgb: np.ndarray
    output_to_acescg: np.ndarray


GAMUT_MATRICES = {
    "sRGB-D65": GamutMatrices(
        "sRGB-D65", XYZ_D65_TO_LINEAR_SRGB, ACESCG_TO_LINEAR_SRGB, LINEAR_SRGB_TO_ACESCG
    ),
    "P3-D65": GamutMatrices(
        "P3-D65", XYZ_D65_TO_P3_D65, ACESCG_TO_P3_D65, P3_D65_TO_ACESCG
    ),
    "ACEScg/AP1-D60": GamutMatrices(
        "ACEScg/AP1-D60", XYZ_D65_TO_ACESCG, ACESCG_TO_ACESCG, XYZ_D65_TO_ACESCG
    ),
}
