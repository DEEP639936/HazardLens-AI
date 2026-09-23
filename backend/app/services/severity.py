"""Operational severity heuristic (1..5) — EXACT parity with src/lib/rg/severity.ts.

    score100 = 100·(0.45·confidence + 0.35·min(areaRatio/0.25, 1) + 0.20·classWeight)
    severity = clamp(ceil(score100/20 + duplicateBoost), 1, 5)
    duplicateBoost = min(duplicateCount, 4) · 0.125   (up to +0.5)

Labeled as an operational heuristic by design — NOT an engineering-grade
road-safety assessment. Admins may override severity during review.
"""
from __future__ import annotations

import math

# CLASS_WEIGHT — identical to CLASS_META.weight in src/lib/rg/constants.ts
CLASS_WEIGHTS: dict[str, float] = {
    "waterlogging": 0.70,
    "pothole": 0.62,
    "edge_damage": 0.60,
    "erosion": 0.55,
    "debris": 0.50,
    "crack": 0.45,
    "marking": 0.40,
}

HAZARD_CLASSES: tuple[str, ...] = tuple(CLASS_WEIGHTS.keys())

DEFAULT_CLASS_WEIGHT = 0.5


def class_weight(hazard_class: str) -> float:
    return CLASS_WEIGHTS.get(hazard_class, DEFAULT_CLASS_WEIGHT)


def area_ratio_of(bbox: tuple[float, float, float, float]) -> float:
    """Normalized bbox area (w·h), clamped to 0..1."""
    x, _y, w, h = bbox
    return min(1.0, max(0.0, w * h))


def severity_from_detection(
    hazard_class: str,
    confidence: float,
    area_ratio: float,
    duplicate_count: int = 0,
) -> int:
    """Severity 1..5 from a single detection + duplicate context."""
    conf = min(1.0, max(0.0, confidence))
    area = min(1.0, area_ratio / 0.25)
    base = 0.45 * conf + 0.35 * area + 0.20 * class_weight(hazard_class)
    dup_boost = min(duplicate_count, 4) * 0.125  # up to +0.5
    raw = math.ceil((base * 100) / 20 + dup_boost)
    return min(5, max(1, raw))
