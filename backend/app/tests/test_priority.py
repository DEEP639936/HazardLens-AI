"""Priority engine + settings validation tests — known vectors → expected score/band."""
from __future__ import annotations

import pytest

from app.services.geo import infer_road_criticality
from app.services.priority import DEFAULT_WEIGHTS, band_of, compute_priority
from app.services.settings import WeightsDoNotSumToOne, get_settings, put_settings


def test_formula_vector_severity_only() -> None:
    """severity=5, everything else zero → 0.32 * 1 * 100 = 32 → LOW (< 35)."""
    result = compute_priority(
        {
            "severity": 5,
            "neighborCount": 0,
            "roadCriticality": 0,
            "recurrenceCount": 0,
            "ageDays": 0,
        }
    )
    assert result.score == 32.0
    assert result.band == "LOW"


def test_formula_vector_perfect_day() -> None:
    """All norms = 1 → weighted sum = 1.0 → score 100 CRITICAL."""
    result = compute_priority(
        {
            "severity": 5,
            "neighborCount": 12,
            "roadCriticality": 1.0,
            "recurrenceCount": 4,
            "ageDays": 90,
        }
    )
    assert result.score == 100.0
    assert result.band == "CRITICAL"
    assert result.band == band_of(100)


def test_formula_vector_band_boundaries() -> None:
    assert band_of(80) == "CRITICAL"
    assert band_of(79.99) == "HIGH"
    assert band_of(60) == "HIGH"
    assert band_of(59.99) == "MEDIUM"
    assert band_of(35) == "MEDIUM"
    assert band_of(34.9) == "LOW"


def test_formula_vector_resolved_age_dampening() -> None:
    """ageDays=90 normally saturates (1.0); RESOLVED dampens by 0.2 → age contribution 12 → 1.2... wait, 0.12*0.2=0.024 → 2.4 pts."""
    unresolved = compute_priority(
        {"severity": 1, "neighborCount": 0, "roadCriticality": 0, "recurrenceCount": 0, "ageDays": 90, "resolved": False}
    )
    resolved = compute_priority(
        {"severity": 1, "neighborCount": 0, "roadCriticality": 0, "recurrenceCount": 0, "ageDays": 90, "resolved": True}
    )
    assert unresolved.score == 12.0  # 0.12 * 1.0 * 100
    assert resolved.score == 2.4  # 0.12 * 0.2 * 100


def test_formula_vector_manual_override() -> None:
    result = compute_priority(
        {
            "severity": 1,
            "neighborCount": 0,
            "roadCriticality": 0,
            "recurrenceCount": 0,
            "ageDays": 0,
            "overridden": True,
            "manualScore": 87.5,
        }
    )
    assert result.score == 87.5
    assert result.band == "CRITICAL"
    assert result.overridden is True


def test_weights_custom_snapshot() -> None:
    result = compute_priority(
        {
            "severity": 5,
            "neighborCount": 0,
            "roadCriticality": 0,
            "recurrenceCount": 0,
            "ageDays": 0,
            "weights": {"severity": 0.5, "density": 0.2, "criticality": 0.1, "recurrence": 0.1, "age": 0.1},
        }
    )
    assert result.score == 50.0
    assert result.weights["severity"] == 0.5
    assert result.factors[0].weight == 0.5


def test_road_class_criticality_mapping() -> None:
    assert infer_road_criticality(None, "highway") == 1.0
    assert infer_road_criticality(None, "arterial") == 0.8
    assert infer_road_criticality(None, "collector") == 0.6
    assert infer_road_criticality(None, "residential") == 0.4
    assert infer_road_criticality("Outer Ring Road", None) == 1.0
    assert infer_road_criticality("100 Feet Road", None) == 0.8
    assert infer_road_criticality(None, None) == 0.5


def test_default_weights_sum_to_one() -> None:
    assert abs(sum(DEFAULT_WEIGHTS.values()) - 1.0) < 1e-9


def test_settings_weights_must_sum_to_one(db) -> None:
    base = get_settings(db)
    assert abs(sum(base["weights"].values()) - 1.0) < 1e-9

    with pytest.raises(WeightsDoNotSumToOne):
        put_settings(db, {"weights": {"severity": 0.9, "density": 0.2, "criticality": 0.1, "recurrence": 0.1, "age": 0.1}})

    # valid patch is persisted and re-read
    merged = put_settings(
        db,
        {"weights": {"severity": 0.40, "density": 0.20, "criticality": 0.20, "recurrence": 0.10, "age": 0.10}},
    )
    assert merged["weights"]["severity"] == 0.40
    assert get_settings(db)["weights"]["severity"] == 0.40


def test_severity_heuristic_vectors() -> None:
    from app.services.severity import severity_from_detection

    # high confidence + large area + waterlogging → 5 (0.9175 → ceil(4.59) = 5)
    assert severity_from_detection("waterlogging", 0.95, 0.30, 0) == 5
    # minimal detection → 1..2
    assert severity_from_detection("marking", 0.05, 0.001, 0) == 1
    # duplicates boost: base 3 with 4 duplicates +0.5 crosses to next band
    base = severity_from_detection("pothole", 0.60, 0.05, 0)
    boosted = severity_from_detection("pothole", 0.60, 0.05, 4)
    assert boosted in (base, base + 1)
    assert severity_from_detection("pothole", 0.99, 1.0, 4) == 5
