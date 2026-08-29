"""The achromatic ``J`` component used by the ACES 2.0 output transform.

ACES 2.0 does not use the project's modCAM16-HK lightness as its tone-scale
coordinate.  The output transform uses a compact Hellwig-derived ``JMh``
model (the implementation is in ``Lib.Academy.OutputTransform.ctl``).  This
module contains the part of that model needed by the compensation fitter:
conversion of display-reference XYZ values to ACES output ``J``.

The formulas intentionally mirror the ACES CTL implementation.  In
particular, ACES' matrix convention stores primary vectors in rows and uses
row-vector multiplication; the public functions below use the more usual
``matrix @ vector`` convention and transpose the CTL matrices where needed.
Only the J/achromatic path is evaluated, so no output gamut-compression or
display encoding is performed here.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Primaries used by the ACES 2.0 output-transform wrappers.  The values are
# copied from the official Rec.709 and Rec.2100 CTL wrappers rather than from
# an encoding/display transfer function.
REC709_D65_PRIMARIES_XY = np.array(
    [[0.6400, 0.3300], [0.3000, 0.6000], [0.1500, 0.0600]], dtype=np.float64
)
REC2020_D65_PRIMARIES_XY = np.array(
    [[0.7080, 0.2920], [0.1700, 0.7970], [0.1310, 0.0460]], dtype=np.float64
)

# The sharpened CAM16 primaries in the ACES CTL have negative y coordinates.
# ``colorimetry.normalized_primary_matrix`` quite correctly rejects those for
# ordinary RGB gamuts, therefore the small CTL-compatible matrix constructor
# lives locally.
_CAM16_PRI_XY = np.array(
    [[0.8336, 0.1735], [2.3854, -1.4659], [0.0870, -0.1250]], dtype=np.float64
)
_CAM16_WHITE_XY = np.array([0.3330, 0.3330], dtype=np.float64)
_D65_WHITE_XY = np.array([0.3127, 0.3290], dtype=np.float64)


def _xy_to_xyz_allow_negative_y(xy: np.ndarray) -> np.ndarray:
    """CTL's xy-to-XYZ formula, including its negative-y CAM16 primaries."""

    values = np.asarray(xy, dtype=np.float64)
    x = values[..., 0]
    y = values[..., 1]
    return np.stack((x / y, np.ones_like(x), (1.0 - x - y) / y), axis=-1)


def _ctl_rgb_to_xyz_matrix(
    primaries_xy: np.ndarray, white_xy: np.ndarray, white_y: float = 1.0
) -> np.ndarray:
    """Return the conventional (column-vector) RGB-to-XYZ matrix.

    This is algebraically identical to ``RGBtoXYZ_f33`` in the ACES utility
    library, whose returned matrix is laid out for row-vector multiplication.
    """

    primaries = np.asarray(primaries_xy, dtype=np.float64)
    white = _xy_to_xyz_allow_negative_y(white_xy) * float(white_y)
    primary_xyz = np.stack(
        [_xy_to_xyz_allow_negative_y(primary) for primary in primaries], axis=1
    )
    scale = np.linalg.solve(primary_xyz, white)
    return primary_xyz @ np.diag(scale)


@dataclass(frozen=True)
class ACESJMhParams:
    """Precomputed constants for the ACES 2.0 achromatic J calculation."""

    limiting_primaries_xy: np.ndarray
    rgb_to_xyz: np.ndarray
    xyz_to_rgb: np.ndarray
    xyz_to_cam16: np.ndarray
    rgb_to_cam16: np.ndarray
    adaptation_factors: np.ndarray
    cone_response_to_aab: np.ndarray
    f_l_n: float
    cz: float
    achromatic_white: float
    reference_luminance: float = 100.0

    def rgb_to_jmh(self, rgb: np.ndarray) -> np.ndarray:
        """Convert linear limiting-gamut RGB values to ACES ``J, M, h``.

        RGB values are relative to ``100`` cd/m², exactly as in the ACES CTL
        output-transform implementation.  The returned array has a final
        dimension of three.  Values with a non-positive achromatic response
        follow ACES' ``Aab_to_JMh`` behavior and return all-zero JMh values.
        """

        values = np.asarray(rgb, dtype=np.float64)
        if values.ndim == 0 or values.shape[-1] != 3:
            raise ValueError("RGB arrays must have a final dimension of three.")
        # ACES represents display-reference RGB relative to 100 cd/m².  The
        # CTL path first converts limiting-gamut RGB to XYZ, then multiplies
        # by ``ref_luminance`` before the CAM16 sharpened-RGB conversion.
        xyz_n = np.einsum("ij,...j->...i", self.rgb_to_xyz, values)
        xyz_nits = xyz_n * self.reference_luminance
        sharpened = np.einsum("ij,...j->...i", self.xyz_to_cam16, xyz_nits)
        adapted = sharpened * self.adaptation_factors
        compressed = _post_adaptation_compression(adapted)
        aab = np.einsum("ij,...j->...i", self.cone_response_to_aab, compressed)
        achromatic = aab[..., 0]
        j = np.zeros_like(achromatic)
        positive = achromatic > 0.0
        j[positive] = 100.0 * np.power(achromatic[positive], self.cz)
        opponent_a = aab[..., 1]
        opponent_b = aab[..., 2]
        m = np.hypot(opponent_a, opponent_b)
        h = np.mod(np.degrees(np.arctan2(opponent_b, opponent_a)), 360.0)
        # ``Aab_to_JMh`` in the ACES CTL returns an all-zero triplet when the
        # achromatic response is non-positive.  Apply the same branch to M/h,
        # rather than exposing an apparently chromatic J=0 value.
        m = np.where(positive, m, 0.0)
        h = np.where(positive, h, 0.0)
        return np.stack((j, m, h), axis=-1)

    def xyz_to_jmh(self, xyz: np.ndarray) -> np.ndarray:
        """Convert CIE XYZ-D65 display-reference values to ACES ``J, M, h``."""

        values = np.asarray(xyz, dtype=np.float64)
        if values.ndim == 0 or values.shape[-1] != 3:
            raise ValueError("XYZ arrays must have a final dimension of three.")
        rgb = np.einsum("ij,...j->...i", self.xyz_to_rgb, values)
        return self.rgb_to_jmh(rgb)

    def rgb_to_j(self, rgb: np.ndarray) -> np.ndarray:
        return self.rgb_to_jmh(rgb)[..., 0]

    def xyz_to_j(self, xyz: np.ndarray) -> np.ndarray:
        return self.xyz_to_jmh(xyz)[..., 0]


def _post_adaptation_compression(value: np.ndarray) -> np.ndarray:
    """ACES ``post_adaptation_cone_response_compression_fwd``."""

    values = np.asarray(value, dtype=np.float64)
    # The output transform's input and display reference paths are normally
    # non-negative.  Retaining the CTL signed extension makes diagnostics
    # well-defined for tiny negative round-off values as well.
    magnitude = np.abs(values)
    power_term = np.power(magnitude, 0.42)
    compressed = power_term / (27.13 + power_term)
    return np.copysign(compressed, values)


def init_jmh_params(
    limiting_primaries_xy: np.ndarray = REC709_D65_PRIMARIES_XY,
) -> ACESJMhParams:
    """Initialize ACES 2.0 JMh parameters for a limiting RGB gamut.

    ``limiting_primaries_xy`` should be the output transform's *limiting*
    primaries (Rec.709 for the SDR profile, Rec.2020 for the HDR profile).
    """

    primaries = np.asarray(limiting_primaries_xy, dtype=np.float64)
    if primaries.shape != (3, 2) or not np.all(np.isfinite(primaries)):
        raise ValueError("limiting_primaries_xy must be a finite 3x2 array.")
    rgb_to_xyz = _ctl_rgb_to_xyz_matrix(primaries, _D65_WHITE_XY, 1.0)
    cam16_rgb_to_xyz = _ctl_rgb_to_xyz_matrix(_CAM16_PRI_XY, _CAM16_WHITE_XY, 1.0)
    xyz_to_cam16 = np.linalg.inv(cam16_rgb_to_xyz)

    # Constants from Lib.Academy.OutputTransform.ctl.
    ref_luminance = 100.0
    adapting_luminance = 100.0
    background_y = 20.0
    surround_c = 0.59
    k = 1.0 / (5.0 * adapting_luminance + 1.0)
    k4 = k**4
    f_l = 0.2 * k4 * (5.0 * adapting_luminance) + 0.1 * (1.0 - k4) ** 2 * np.power(
        5.0 * adapting_luminance, 1.0 / 3.0
    )
    f_l_n = f_l / ref_luminance
    cz = surround_c * (1.48 + np.sqrt(background_y / ref_luminance))

    xyz_white = _xy_to_xyz_allow_negative_y(_D65_WHITE_XY) * ref_luminance
    rgb_white_in_cam16 = np.einsum("ij,j->i", xyz_to_cam16, xyz_white)
    adaptation_factors = f_l_n * ref_luminance / rgb_white_in_cam16

    # ACES' ``base_cone_response_to_Aab`` matrix is used with row vectors.
    # Store its transpose so the conventional matrix-vector expression below
    # has the same result.
    base_cone = np.array(
        [
            [2.0, 1.0, 1.0 / 9.0],
            [1.0, -12.0 / 11.0, 1.0 / 9.0],
            [1.0 / 20.0, 1.0 / 11.0, -2.0 / 9.0],
        ],
        dtype=np.float64,
    )
    cam_nl_scale = 4.0 * 100.0
    # ``cone_response_to_Aab`` in CTL is cam_nl_scale * base and is applied as
    # row-vector * matrix.  Its transpose therefore belongs in a column-vector
    # implementation.
    cone_unscaled = cam_nl_scale * base_cone.T
    compressed_white = _post_adaptation_compression(
        rgb_white_in_cam16 * adaptation_factors
    )
    achromatic_white = float(np.dot(compressed_white, cone_unscaled[0, :]))
    if not np.isfinite(achromatic_white) or achromatic_white <= 0.0:
        raise RuntimeError("ACES JMh achromatic white is invalid.")
    cone_response_to_aab = cone_unscaled.copy()
    # After transposing the CTL row-vector matrix, rows correspond to the
    # output A, a, and b components.  Normalize/scale those rows respectively.
    cone_response_to_aab[0, :] /= achromatic_white
    cone_response_to_aab[1:, :] *= 43.0 * 0.9

    return ACESJMhParams(
        limiting_primaries_xy=primaries.copy(),
        rgb_to_xyz=rgb_to_xyz,
        xyz_to_rgb=np.linalg.inv(rgb_to_xyz),
        xyz_to_cam16=xyz_to_cam16,
        rgb_to_cam16=np.einsum("ij,jk->ik", xyz_to_cam16, rgb_to_xyz),
        adaptation_factors=adaptation_factors,
        cone_response_to_aab=cone_response_to_aab,
        f_l_n=float(f_l_n),
        cz=float(cz),
        achromatic_white=achromatic_white,
        reference_luminance=ref_luminance,
    )


_REC709_PARAMS = init_jmh_params(REC709_D65_PRIMARIES_XY)
_REC2020_PARAMS = init_jmh_params(REC2020_D65_PRIMARIES_XY)


def params_for_profile(profile_name: str) -> ACESJMhParams:
    """Return cached JMh parameters for a compensation profile or alias."""

    normalized = str(profile_name).lower()
    if "2020" in normalized or "pq" in normalized or "p3_rec2020" in normalized:
        return _REC2020_PARAMS
    if "709" in normalized or "srgb" in normalized or "rec709" in normalized:
        return _REC709_PARAMS
    raise ValueError(f"No ACES JMh limiting gamut is known for {profile_name!r}.")


def xyz_to_aces_j(
    xyz_display_reference: np.ndarray,
    limiting_primaries_xy: np.ndarray = REC709_D65_PRIMARIES_XY,
) -> np.ndarray:
    """Evaluate ACES 2.0 output ``J`` from display-reference XYZ-D65."""

    primaries = np.asarray(limiting_primaries_xy, dtype=np.float64)
    if np.array_equal(primaries, REC709_D65_PRIMARIES_XY):
        params = _REC709_PARAMS
    elif np.array_equal(primaries, REC2020_D65_PRIMARIES_XY):
        params = _REC2020_PARAMS
    else:
        params = init_jmh_params(primaries)
    return params.xyz_to_j(xyz_display_reference)


def jmh_to_cartesian(jmh: np.ndarray) -> np.ndarray:
    """Map ACES ``J, M, h`` values to normalized Cartesian coordinates.

    The normalization keeps the achromatic and chromatic components on the
    same 0..1 scale before Euclidean comparison.  Hue is interpreted in
    degrees, as returned by :meth:`ACESJMhParams.xyz_to_jmh`.
    """

    values = np.asarray(jmh, dtype=np.float64)
    if values.ndim == 0 or values.shape[-1] != 3:
        raise ValueError("JMh arrays must have a final dimension of three.")
    hue_radians = np.radians(values[..., 2])
    return np.stack(
        (
            values[..., 0] / 100.0,
            (values[..., 1] / 100.0) * np.cos(hue_radians),
            (values[..., 1] / 100.0) * np.sin(hue_radians),
        ),
        axis=-1,
    )


# Descriptive aliases used by callers and by older exploratory notebooks.
ACESJ = ACESJMhParams
init_JMhParams = init_jmh_params
xyz_to_J = xyz_to_aces_j
output_j_from_xyz = xyz_to_aces_j


__all__ = [
    "ACESJ",
    "REC709_D65_PRIMARIES_XY",
    "REC2020_D65_PRIMARIES_XY",
    "ACESJMhParams",
    "init_JMhParams",
    "init_jmh_params",
    "jmh_to_cartesian",
    "output_j_from_xyz",
    "params_for_profile",
    "xyz_to_J",
    "xyz_to_aces_j",
]
