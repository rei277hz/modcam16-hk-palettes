from dataclasses import replace

import numpy as np
import pytest

from modcam16_palette.aces_jmh import jmh_to_cartesian
from modcam16_palette.cli import _overrides_from_args, _parser
from modcam16_palette.colorchecker import (
    COMPENSATED_COLORCHECKER_MATCHING_MODE,
    build_compensated_colorchecker_marker_assignments,
    get_colorchecker_targets,
)
from modcam16_palette.config import default_config


class _IdentityXYZProcessor:
    """Test processor whose forward view returns its input as display XYZ."""

    def target_forward_values(self, values):
        return np.asarray(values, dtype=np.float32)


def _matching_inputs(candidate_count=1):
    config = default_config()
    cc = replace(
        config.colorchecker,
        compensated_marker_exposure_min_stops=-1.0,
        compensated_marker_exposure_max_stops=1.0,
        compensated_marker_exposure_step_stops=1.0,
        include_caps_in_matching=False,
    )
    targets = get_colorchecker_targets(cc)
    # Make the first candidate exactly the first fixed D65 target at EV=0.
    stored = np.repeat(targets.xyz_d65[:1].astype(np.float32), candidate_count, axis=0)
    return (
        stored,
        {"h": np.zeros(candidate_count), "s": np.zeros(candidate_count)},
        np.ones(candidate_count),
        np.linspace(0.5, 0.5 + 0.25 * (candidate_count - 1), candidate_count),
        np.arange(candidate_count, dtype=np.int64),
        np.zeros(candidate_count, dtype=np.int64),
        np.zeros(candidate_count, dtype=np.float64),
        _IdentityXYZProcessor(),
        cc,
    )


def test_compensated_marker_grid_is_inclusive_and_configurable():
    config = default_config()
    stops = config.colorchecker.compensated_marker_exposure_stops
    assert len(stops) == 41
    assert stops[0] == -5.0
    assert stops[-1] == 5.0
    assert np.allclose(np.diff(stops), 0.25)

    invalid = replace(
        config,
        colorchecker=replace(
            config.colorchecker,
            compensated_marker_exposure_step_stops=0.3,
        ),
    )
    with pytest.raises(ValueError):
        invalid.validate()


def test_normalized_jmh_cartesian_coordinates():
    values = np.array([[100.0, 0.0, 17.0], [50.0, 100.0, 90.0]])
    coordinates = jmh_to_cartesian(values)
    assert np.allclose(coordinates[0], [1.0, 0.0, 0.0])
    assert np.allclose(coordinates[1], [0.5, 0.0, 1.0])


def test_compensated_matching_selects_candidate_and_ev():
    (
        stored,
        appearance,
        chroma,
        levels,
        ring_indices,
        hue_indices,
        hues,
        processor,
        config,
    ) = _matching_inputs()
    full, caps, assignments, unique, metadata = (
        build_compensated_colorchecker_marker_assignments(
            stored,
            appearance,
            chroma,
            1.0,
            levels,
            ring_indices,
            hue_indices,
            hues,
            processor,
            "srgb_rec709_bt1886",
            config,
        )
    )
    assert assignments[0]["candidate_index"] == 0
    assert assignments[0]["ev_stops"] == 0.0
    assert assignments[0]["distance"] < 1.0e-6
    assert full[0, 0]
    assert not np.any(caps)
    assert unique == int(np.count_nonzero(full))
    assert metadata["colorchecker_exposure_sample_count"] == 3
    assert metadata["colorchecker_evaluation_count"] == 54
    assert (
        assignments[0]["matching_mode"]
        == COMPENSATED_COLORCHECKER_MATCHING_MODE
    )


def test_compensated_matching_ties_preserve_candidate_order():
    values = _matching_inputs(candidate_count=2)
    (
        _full,
        _caps,
        assignments,
        _unique,
        _metadata,
    ) = build_compensated_colorchecker_marker_assignments(
        values[0],
        values[1],
        values[2],
        1.0,
        values[3],
        values[4],
        values[5],
        values[6],
        values[7],
        "srgb_rec709_bt1886",
        values[8],
    )
    assert assignments[0]["candidate_index"] == 0
    assert assignments[0]["ring_index"] == 0


def test_compensated_matching_allows_candidate_reuse_across_patches():
    """Each CC18 patch is independent; matching never consumes a candidate."""

    values = _matching_inputs(candidate_count=2)
    full, caps, assignments, unique, metadata = (
        build_compensated_colorchecker_marker_assignments(
            values[0],
            values[1],
            values[2],
            1.0,
            values[3],
            values[4],
            values[5],
            values[6],
            values[7],
            "srgb_rec709_bt1886",
            values[8],
        )
    )

    # The two logical candidates are identical.  With independent nearest
    # matching, every patch may select candidate zero; a queue/one-to-one
    # implementation would instead consume it after the first patch.
    assert all(assignment["candidate_index"] == 0 for assignment in assignments)
    assert np.count_nonzero(full) == 1
    assert not np.any(caps)
    assert unique == 1
    assert "candidate locations may be reused" in metadata["colorchecker_assignment_policy"]


def test_compensated_targets_remain_fixed_d65_xyz():
    config = default_config().colorchecker
    targets = get_colorchecker_targets(config)
    assert targets.xyz_d65.shape == (18, 3)
    assert targets.appearance == {}
    assert np.all(np.isfinite(targets.xyz_d65))


def test_cli_exposes_compensated_marker_exposure_controls():
    parser = _parser()
    args = parser.parse_args(
        [
            "--colorchecker-compensated-exposure-min",
            "-3",
            "--colorchecker-compensated-exposure-max",
            "3",
            "--colorchecker-compensated-exposure-step",
            "0.5",
        ]
    )
    overrides = _overrides_from_args(args)
    assert overrides["colorchecker"] == {
        "compensated_marker_exposure_min_stops": -3.0,
        "compensated_marker_exposure_max_stops": 3.0,
        "compensated_marker_exposure_step_stops": 0.5,
    }
