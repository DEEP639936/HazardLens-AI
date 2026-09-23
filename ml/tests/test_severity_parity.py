"""Parity tests: ml/hazard_domain.py MUST mirror src/lib/rg/severity.ts and
src/lib/rg/priority.ts (AGENT_BRIEF.md §3) exactly — same class weights, same
formula, same clamping/rounding semantics. These tests assert documented
example vectors so a change on either side breaks CI loudly.

References (do not change these expectations without changing the TS code too):
  * src/lib/rg/severity.ts  — severityFromDetection(), areaRatioOf()
  * src/lib/rg/constants.ts — CLASS_META[*].weight
  * src/lib/rg/priority.ts  — computePriority(), bandOf(), DEFAULT_WEIGHTS
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hazard_domain import (  # noqa: E402
    CLASS_WEIGHTS,
    DEFAULT_PRIORITY_WEIGHTS,
    HAZARD_CLASSES,
    ROAD_CLASS_CRITICALITY,
    area_ratio_of,
    band_of,
    class_weight,
    compute_priority,
    road_criticality_of,
    severity_from_detection,
)

# --------------------------------------------------------------------------
# Class inventory + weights (mirror of constants.ts)
# --------------------------------------------------------------------------


def test_hazard_class_inventory_matches_constants_ts():
    assert HAZARD_CLASSES == (
        "pothole", "crack", "erosion", "waterlogging", "marking", "debris", "edge_damage",
    )


def test_class_weights_match_constants_ts():
    assert CLASS_WEIGHTS == {
        "pothole": 0.62,
        "crack": 0.45,
        "erosion": 0.55,
        "waterlogging": 0.70,
        "marking": 0.40,
        "debris": 0.50,
        "edge_damage": 0.60,
    }


def test_unknown_class_falls_back_to_0_5():
    assert class_weight("meteor_crater") == 0.5


# --------------------------------------------------------------------------
# severityFromDetection — formula: clamp(ceil(5*base + dupBoost), 1, 5)
# --------------------------------------------------------------------------


def test_severity_max_example_waterlogging():
    # base = 0.45*1 + 0.35*(0.25/0.25) + 0.20*0.70 = 0.94 -> 4.7 -> ceil 5
    assert severity_from_detection("waterlogging", 1.0, 0.25) == 5


def test_severity_small_marking():
    # base = 0.45*0.5 + 0 + 0.20*0.40 = 0.305 -> 1.525 -> ceil 2
    assert severity_from_detection("marking", 0.5, 0.0) == 2


def test_severity_typical_pothole():
    # base = 0.45*0.8 + 0.35*(0.10/0.25) + 0.20*0.62 = 0.624 -> 3.12 -> ceil 4
    assert severity_from_detection("pothole", 0.8, 0.10) == 4


def test_severity_duplicate_boost_caps_at_plus_0_5():
    # base = 0.45*0.55 + 0.35*(0.12/0.25) + 0.20*0.50 = 0.5155 -> 2.5775 -> ceil 3
    assert severity_from_detection("debris", 0.55, 0.12, duplicate_count=0) == 3
    # dupBoost = min(4, 4)*0.125 = 0.5 -> 3.0775 -> ceil 4
    assert severity_from_detection("debris", 0.55, 0.12, duplicate_count=4) == 4
    # duplicateCount beyond 4 does not boost further
    assert severity_from_detection("debris", 0.55, 0.12, duplicate_count=10) == 4


def test_severity_clamps_low_and_high():
    # minimal signal still floors at 1: base = 0.20*0.40 = 0.08 -> 0.4 -> ceil 1
    assert severity_from_detection("marking", 0.0, 0.0) == 1
    # over-range inputs clamp first (Math.min/max semantics)
    assert severity_from_detection("crack", -0.7, -1.0) == 1
    assert severity_from_detection("crack", 2.0, 3.0) == 5


def test_severity_confidence_saturation_boundaries():
    # Exactly on an integer boundary: base*5 = 2.0 -> ceil = 2 (no +1)
    # base = 0.45*0.6 + 0.20*0.5 = 0.27+0.10 = 0.37 -> *5 = 1.85 -> 2
    assert severity_from_detection("debris", 0.6, 0.0) == 2


def test_area_ratio_of_mirrors_ts():
    assert area_ratio_of(0.5, 0.5) == 0.25
    assert area_ratio_of(2.0, 2.0) == 1.0  # clamped
    assert area_ratio_of(-1.0, 0.5) == 0.0  # clamped
    assert math.isclose(area_ratio_of(0.2, 0.3), 0.06)


# --------------------------------------------------------------------------
# computePriority / bandOf — mirror of priority.ts
# --------------------------------------------------------------------------


def test_priority_weights_match_brief():
    assert DEFAULT_PRIORITY_WEIGHTS == {
        "severity": 0.32, "density": 0.24, "criticality": 0.18,
        "recurrence": 0.14, "age": 0.12,
    }


def test_priority_all_maxed_is_100_critical():
    out = compute_priority(severity=5, neighbor_count=12, road_criticality=1.0,
                           recurrence_count=4, age_days=90)
    assert out["score"] == 100.0 and out["band"] == "CRITICAL"


def test_priority_minimum_signal_is_low():
    out = compute_priority(severity=1, neighbor_count=0, road_criticality=0.5,
                           recurrence_count=0, age_days=0)
    # 0.18*0.5 = 0.09 -> 9
    assert out["score"] == 9.0 and out["band"] == "LOW"


def test_priority_typical_medium_case():
    out = compute_priority(severity=3, neighbor_count=6, road_criticality=0.4,
                           recurrence_count=1, age_days=45)
    # sev .5*.32=0.16, dens .5*.24=0.12, crit .4*.18=0.072, rec .25*.14=0.035, age .5*.12=0.06
    assert math.isclose(out["score"], 44.7)
    assert out["band"] == "MEDIUM"


def test_priority_resolved_work_order_dampens_age_by_80pct():
    out = compute_priority(severity=5, neighbor_count=0, road_criticality=0.0,
                           recurrence_count=0, age_days=90, resolved=True)
    # 0.32 + 0.12*0.2 = 0.344 -> 34.4
    assert math.isclose(out["score"], 34.4) and out["band"] == "LOW"
    fresh = compute_priority(severity=5, neighbor_count=0, road_criticality=0.0,
                             recurrence_count=0, age_days=90)
    assert math.isclose(fresh["score"], 44.0)  # age saturates at 90 days


def test_priority_bands_thresholds():
    assert band_of(100) == "CRITICAL"
    assert band_of(80) == "CRITICAL"
    assert band_of(79.99) == "HIGH"
    assert band_of(60) == "HIGH"
    assert band_of(59.99) == "MEDIUM"
    assert band_of(35) == "MEDIUM"
    assert band_of(34.99) == "LOW"


def test_priority_admin_override_uses_manual_score_clamped():
    out = compute_priority(severity=1, neighbor_count=0, road_criticality=0,
                           recurrence_count=0, age_days=0,
                           overridden=True, manual_score=77)
    assert out["score"] == 77.0 and out["overridden"] is True
    clamped = compute_priority(severity=1, neighbor_count=0, road_criticality=0,
                               recurrence_count=0, age_days=0,
                               overridden=True, manual_score=150)
    assert clamped["score"] == 100.0


def test_priority_custom_weights_are_configurable():
    out = compute_priority(severity=5, neighbor_count=0, road_criticality=0,
                           recurrence_count=0, age_days=0,
                           weights={"severity": 0.5, "density": 0, "criticality": 0,
                                    "recurrence": 0, "age": 0})
    assert out["score"] == 50.0  # sevNorm(5)=1 * 0.5 * 100
    assert out["weights"]["severity"] == 0.5


def test_road_criticality_table_matches_constants_ts():
    assert ROAD_CLASS_CRITICALITY == {"highway": 1.0, "arterial": 0.8,
                                      "collector": 0.6, "residential": 0.4}
    assert road_criticality_of("highway") == 1.0
    assert road_criticality_of("unknown") == 0.5
    assert road_criticality_of(None) == 0.5
