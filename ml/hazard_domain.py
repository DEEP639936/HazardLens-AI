"""RoadGuard Atlas — canonical hazard domain + parity engines (Python mirror).

This module is the single source of truth inside ``ml/`` for:

* the 7 canonical hazard classes and their order (class ids in YOLO datasets),
* per-class severity weights,
* the operational **severity** heuristic (mirror of ``src/lib/rg/severity.ts``),
* the explainable **maintenance-priority** engine (mirror of ``src/lib/rg/priority.ts``).

Everything here MUST stay byte-for-byte semantically identical to the TypeScript
implementation in ``src/lib/rg/`` (see AGENT_BRIEF.md §3). ``ml/tests/`` asserts
this parity with example vectors; do not change one side without the other.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Canonical classes — order defines YOLO class ids (dataset/road_hazards.yaml).
# Mirrors src/lib/rg/constants.ts -> HAZARD_CLASSES.
# ---------------------------------------------------------------------------
HAZARD_CLASSES: Tuple[str, ...] = (
    "pothole",
    "crack",
    "erosion",
    "waterlogging",
    "marking",
    "debris",
    "edge_damage",
)
CLASS_TO_ID: Dict[str, int] = {name: idx for idx, name in enumerate(HAZARD_CLASSES)}
ID_TO_CLASS: Dict[int, str] = {idx: name for name, idx in CLASS_TO_ID.items()}
NUM_CLASSES: int = len(HAZARD_CLASSES)

# Mirrors src/lib/rg/constants.ts -> CLASS_META[*].weight
CLASS_WEIGHTS: Dict[str, float] = {
    "pothole": 0.62,
    "crack": 0.45,
    "erosion": 0.55,
    "waterlogging": 0.70,
    "marking": 0.40,
    "debris": 0.50,
    "edge_damage": 0.60,
}
DEFAULT_CLASS_WEIGHT: float = 0.5  # CLASS_META[hazardClass]?.weight ?? 0.5


def class_weight(hazard_class: str) -> float:
    """Class weight used by the severity heuristic (falls back to 0.5)."""
    return CLASS_WEIGHTS.get(hazard_class, DEFAULT_CLASS_WEIGHT)


# ---------------------------------------------------------------------------
# Severity heuristic — mirror of src/lib/rg/severity.ts::severityFromDetection
# severity = clamp(ceil( 100*(0.45*conf + 0.35*min(areaRatio/0.25, 1)
#                          + 0.20*classWeight) / 20 + dupBoost ), 1, 5)
# dupBoost = min(duplicateCount, 4) * 0.125   (up to +0.5)
# Operational heuristic only — NOT an engineering-grade safety assessment.
# ---------------------------------------------------------------------------
def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def severity_from_detection(
    hazard_class: str,
    confidence: float,
    area_ratio: float,
    duplicate_count: int = 0,
) -> int:
    """Operational severity 1..5 for one detection (parity with severity.ts)."""
    base = (
        0.45 * _clamp01(confidence)
        + 0.35 * min(1.0, area_ratio / 0.25)
        + 0.20 * class_weight(hazard_class)
    )
    dup_boost = min(max(0, duplicate_count), 4) * 0.125  # up to +0.5
    raw = math.ceil((base * 100) / 20 + dup_boost)
    return int(min(5, max(1, raw)))


def area_ratio_of(bbox_w: float, bbox_h: float) -> float:
    """Mirror of severity.ts::areaRatioOf — clamp(w*h, 0, 1)."""
    return min(1.0, max(0.0, bbox_w * bbox_h))


def detections_severity(
    detections: List[dict],
    duplicate_counts: Optional[Dict[str, int]] = None,
) -> List[dict]:
    """Attach ``severity`` (and ``areaRatio``) to a list of detection dicts.

    Each detection must carry ``hazardClass``, ``confidence`` and a normalized
    bbox ``{"x": .., "y": .., "w": .., "h": ..}``. Mutates and returns the list.
    ``duplicate_counts`` maps hazardClass -> number of duplicate reports within
    75 m over the last 30 days (same basis as the backend engine).
    """
    dup = duplicate_counts or {}
    for det in detections:
        area = area_ratio_of(det["bbox"]["w"], det["bbox"]["h"])
        det["areaRatio"] = area
        det["severity"] = severity_from_detection(
            det["hazardClass"], det["confidence"], area, dup.get(det["hazardClass"], 0)
        )
    return detections


# ---------------------------------------------------------------------------
# Priority engine — mirror of src/lib/rg/priority.ts
# Priority = 0.32*sevNorm + 0.24*densNorm + 0.18*critNorm + 0.14*recNorm
#          + 0.12*ageNorm, scaled 0..100 (weights admin-configurable).
# ---------------------------------------------------------------------------
DEFAULT_PRIORITY_WEIGHTS: Dict[str, float] = {
    "severity": 0.32,
    "density": 0.24,
    "criticality": 0.18,
    "recurrence": 0.14,
    "age": 0.12,
}

ROAD_CLASS_CRITICALITY: Dict[str, float] = {
    "highway": 1.0,
    "arterial": 0.8,
    "collector": 0.6,
    "residential": 0.4,
}
DEFAULT_ROAD_CRITICALITY: float = 0.5


def _round2(n: float) -> float:
    """JS Math.round(n*100)/100 semantics (half away-from-zero on positives)."""
    return math.floor(n * 100 + 0.5) / 100


def band_of(score: float) -> str:
    """Priority band thresholds — parity with priority.ts::bandOf."""
    if score >= 80:
        return "CRITICAL"
    if score >= 60:
        return "HIGH"
    if score >= 35:
        return "MEDIUM"
    return "LOW"


def compute_priority(
    severity: int,
    neighbor_count: int,
    road_criticality: float,
    recurrence_count: int,
    age_days: float,
    resolved: bool = False,
    weights: Optional[Dict[str, float]] = None,
    overridden: bool = False,
    manual_score: Optional[float] = None,
) -> dict:
    """Explainable 0..100 maintenance priority (parity with priority.ts).

    Normalizations (AGENT_BRIEF §3):
      sevNorm  = clamp((severity-1)/4, 0, 1)
      densNorm = min(neighborCount/12, 1)      — same-class reports ≤120 m, 60 d
      critNorm = clamp(roadCriticality, 0, 1)  — road-class table, default 0.5
      recNorm  = min(recurrenceCount/4, 1)     — same-class reports ≤75 m, 30 d
      ageNorm  = min(max(ageDays,0)/90, 1); if a linked work order is RESOLVED
                 the age factor is multiplied by 0.2.
    """
    w = {**DEFAULT_PRIORITY_WEIGHTS, **(weights or {})}
    sev_norm = min(1.0, max(0.0, (severity - 1) / 4))
    dens_norm = min(1.0, neighbor_count / 12)
    crit_norm = min(1.0, max(0.0, road_criticality))
    rec_norm = min(1.0, recurrence_count / 4)
    raw_age = min(1.0, max(0.0, age_days) / 90)
    age_norm = raw_age * 0.2 if resolved else raw_age

    score_raw = (
        w["severity"] * sev_norm
        + w["density"] * dens_norm
        + w["criticality"] * crit_norm
        + w["recurrence"] * rec_norm
        + w["age"] * age_norm
    )
    score = (
        min(100.0, max(0.0, manual_score))
        if overridden and manual_score is not None
        else _round2(score_raw * 100)
    )
    return {
        "score": score,
        "band": band_of(score),
        "normalized": {
            "severity": _round2(sev_norm),
            "density": _round2(dens_norm),
            "criticality": _round2(crit_norm),
            "recurrence": _round2(rec_norm),
            "age": _round2(age_norm),
        },
        "weights": w,
        "overridden": bool(overridden),
    }


def road_criticality_of(road_class: Optional[str]) -> float:
    """Criticality from road_class table; unknown/missing defaults to 0.5."""
    if not road_class:
        return DEFAULT_ROAD_CRITICALITY
    return ROAD_CLASS_CRITICALITY.get(road_class, DEFAULT_ROAD_CRITICALITY)


__all__ = [
    "HAZARD_CLASSES",
    "CLASS_TO_ID",
    "ID_TO_CLASS",
    "NUM_CLASSES",
    "CLASS_WEIGHTS",
    "class_weight",
    "severity_from_detection",
    "area_ratio_of",
    "detections_severity",
    "DEFAULT_PRIORITY_WEIGHTS",
    "ROAD_CLASS_CRITICALITY",
    "road_criticality_of",
    "band_of",
    "compute_priority",
]
