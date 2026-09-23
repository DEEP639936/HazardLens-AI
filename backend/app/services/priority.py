"""Explainable maintenance-priority engine — EXACT parity with src/lib/rg/priority.ts.

    Priority = 0.32·sevNorm + 0.24·densNorm + 0.18·critNorm + 0.14·recNorm + 0.12·ageNorm,
    scaled 0..100 and rounded to 2 decimals.

    sevNorm = clamp((severity − 1)/4, 0, 1)
    densNorm = min(neighborCount/12, 1)          # same-class, ≤120 m, last 60 d
    critNorm = clamp(roadCriticality, 0, 1)      # highway 1.0 · arterial 0.8 · collector 0.6 · residential 0.4
    recNorm  = min(recurrenceCount/4, 1)         # same-class, ≤75 m, last 30 d
    ageNorm  = min(ageDays/90, 1); if the linked work order is RESOLVED → ageNorm × 0.2

Bands: ≥80 CRITICAL, ≥60 HIGH, ≥35 MEDIUM, else LOW.
Weights are admin-configurable via system_settings["priority.weights"] and are
snapshotted into every computed row. IMPORTANT (documented product stance): the
score is a prioritization aid for maintenance crews — it is NOT an
engineering-grade road-safety assessment and never replaces human review.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.services.geo import ROAD_CLASS_CRITICALITY

DEFAULT_WEIGHTS: dict[str, float] = {
    "severity": 0.32,
    "density": 0.24,
    "criticality": 0.18,
    "recurrence": 0.14,
    "age": 0.12,
}


def band_of(score: float) -> str:
    if score >= 80:
        return "CRITICAL"
    if score >= 60:
        return "HIGH"
    if score >= 35:
        return "MEDIUM"
    return "LOW"


def round2(n: float) -> float:
    return round(n * 100) / 100


@dataclass(slots=True)
class PriorityInput:
    severity: int  # 1..5
    neighbor_count: int  # same-class reports within 120 m over last 60 days
    road_criticality: float  # 0..1
    recurrence_count: int  # same-class reports within 75 m over last 30 days
    age_days: float
    resolved: bool = False  # linked work order RESOLVED dampens urgency
    weights: dict[str, float] | None = None
    overridden: bool = False
    manual_score: float | None = None


@dataclass(slots=True)
class PriorityFactor:
    key: str
    label: str
    raw: str
    normalized: float
    weight: float
    contribution: float
    note: str

    def as_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "label": self.label,
            "raw": self.raw,
            "normalized": self.normalized,
            "weight": self.weight,
            "contribution": self.contribution,
            "note": self.note,
        }


@dataclass(slots=True)
class PriorityResult:
    score: float
    band: str
    factors: list[PriorityFactor] = field(default_factory=list)
    weights: dict[str, float] = field(default_factory=dict)
    overridden: bool = False
    manual_score: float | None = None
    norms: dict[str, float] = field(default_factory=dict)
    computed_at: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "score": self.score,
            "band": self.band,
            "factors": [f.as_dict() for f in self.factors],
            "weights": self.weights,
            "overridden": self.overridden,
            "manualScore": self.manual_score,
            "computedAt": self.computed_at,
        }


def compute_priority(inp: PriorityInput | dict[str, object], now: datetime | None = None) -> PriorityResult:
    """Accepts a PriorityInput dataclass or a camelCase dict (mirrors the TS input shape)."""
    if isinstance(inp, dict):
        inp = PriorityInput(
            severity=int(inp.get("severity", 3)),
            neighbor_count=int(inp.get("neighborCount", 0)),
            road_criticality=float(inp.get("roadCriticality", 0.5)),
            recurrence_count=int(inp.get("recurrenceCount", 0)),
            age_days=float(inp.get("ageDays", 0)),
            resolved=bool(inp.get("resolved", False)),
            weights=inp.get("weights"),  # type: ignore[arg-type]
            overridden=bool(inp.get("overridden", False)),
            manual_score=inp.get("manualScore"),  # type: ignore[arg-type]
        )
    w = {**DEFAULT_WEIGHTS, **(inp.weights or {})}
    sev_norm = min(1.0, max(0.0, (inp.severity - 1) / 4))
    dens_norm = min(1.0, inp.neighbor_count / 12)
    crit_norm = min(1.0, max(0.0, inp.road_criticality))
    rec_norm = min(1.0, inp.recurrence_count / 4)
    raw_age = min(1.0, max(0.0, inp.age_days) / 90)
    age_norm = raw_age * 0.2 if inp.resolved else raw_age

    score_raw = (
        w["severity"] * sev_norm
        + w["density"] * dens_norm
        + w["criticality"] * crit_norm
        + w["recurrence"] * rec_norm
        + w["age"] * age_norm
    )
    score = (
        min(100.0, max(0.0, float(inp.manual_score)))
        if inp.overridden and inp.manual_score is not None
        else round2(score_raw * 100)
    )

    factors = [
        PriorityFactor(
            key="severity",
            label="Detection severity",
            raw=f"{inp.severity}/5",
            normalized=round2(sev_norm),
            weight=w["severity"],
            contribution=round2(w["severity"] * sev_norm * 100),
            note="AI confidence + bounding-box extent + hazard class, with admin override.",
        ),
        PriorityFactor(
            key="density",
            label="Cluster density",
            raw=f"{inp.neighbor_count} nearby hazards",
            normalized=round2(dens_norm),
            weight=w["density"],
            contribution=round2(w["density"] * dens_norm * 100),
            note="Same-class reports within 120 m over the last 60 days.",
        ),
        PriorityFactor(
            key="criticality",
            label="Road criticality",
            raw=f"{round(crit_norm * 100)}%",
            normalized=round2(crit_norm),
            weight=w["criticality"],
            contribution=round2(w["criticality"] * crit_norm * 100),
            note="Highways 1.0 · arterials 0.8 · collectors 0.6 · residential 0.4.",
        ),
        PriorityFactor(
            key="recurrence",
            label="Recurrence",
            raw=f"{inp.recurrence_count} repeats",
            normalized=round2(rec_norm),
            weight=w["recurrence"],
            contribution=round2(w["recurrence"] * rec_norm * 100),
            note="Repeat reports of the same class within 75 m over 30 days.",
        ),
        PriorityFactor(
            key="age",
            label="Unresolved age",
            raw=f"{round(inp.age_days)} days",
            normalized=round2(age_norm),
            weight=w["age"],
            contribution=round2(w["age"] * age_norm * 100),
            note=(
                "Work order resolved — urgency dampened by 80%."
                if inp.resolved
                else "Days unresolved, saturating at 90 days."
            ),
        ),
    ]

    return PriorityResult(
        score=score,
        band=band_of(score),
        factors=factors,
        weights=w,
        overridden=bool(inp.overridden),
        manual_score=inp.manual_score,
        norms={
            "severity": round2(sev_norm),
            "density": round2(dens_norm),
            "criticality": round2(crit_norm),
            "recurrence": round2(rec_norm),
            "age": round2(age_norm),
        },
        computed_at=(now or datetime.utcnow()).isoformat(),
    )


__all__ = [
    "DEFAULT_WEIGHTS",
    "PriorityInput",
    "PriorityResult",
    "ROAD_CLASS_CRITICALITY",
    "band_of",
    "compute_priority",
    "round2",
]
