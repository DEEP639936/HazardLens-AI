"""Admin-configurable system settings (system_settings table).

Keys (AGENT_BRIEF §2): priority.weights · cluster.params · map.autoRecompute.
Weights MUST sum to 1.0 (±0.001) — enforced here and in the admin router.
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.models import SystemSetting, utcnow
from app.services.priority import DEFAULT_WEIGHTS

KEY_WEIGHTS = "priority.weights"
KEY_CLUSTER = "cluster.params"
KEY_AUTO_RECOMPUTE = "map.autoRecompute"

DEFAULT_CLUSTER = {"epsM": 60, "minPts": 3, "sinceDays": 90}


class WeightsDoNotSumToOne(ValueError):
    pass


def _read(db: Session, key: str) -> dict | bool | None:
    row = db.get(SystemSetting, key)
    if row is None:
        return None
    try:
        return json.loads(row.value_json)
    except (TypeError, ValueError):
        return None


def get_settings(db: Session) -> dict:
    """Full settings bundle with defaults merged in (never raises on malformed rows)."""
    weights = {**DEFAULT_WEIGHTS}
    stored = _read(db, KEY_WEIGHTS)
    if isinstance(stored, dict):
        for k in weights:
            if isinstance(stored.get(k), (int, float)):
                weights[k] = float(stored[k])

    cluster = {**DEFAULT_CLUSTER}
    stored_cluster = _read(db, KEY_CLUSTER)
    if isinstance(stored_cluster, dict):
        for k in cluster:
            if isinstance(stored_cluster.get(k), (int, float)):
                cluster[k] = stored_cluster[k]

    auto = _read(db, KEY_AUTO_RECOMPUTE)
    return {"weights": weights, "cluster": cluster, "autoRecompute": bool(auto) if auto is not None else True}


def put_settings(db: Session, patch: dict) -> dict:
    """Upsert a partial patch; returns the merged bundle. Raises on weight drift."""
    weights = patch.get("weights")
    if weights is not None:
        merged = {**DEFAULT_WEIGHTS, **{k: float(v) for k, v in weights.items()}}
        total = sum(merged.values())
        if abs(total - 1.0) > 0.001:
            raise WeightsDoNotSumToOne(f"Priority weights must sum to 1.0 (received {total:.3f})")
        _upsert(db, KEY_WEIGHTS, merged)

    cluster = patch.get("cluster")
    if cluster is not None:
        _upsert(db, KEY_CLUSTER, {**DEFAULT_CLUSTER, **cluster})

    if "autoRecompute" in patch and patch["autoRecompute"] is not None:
        _upsert(db, KEY_AUTO_RECOMPUTE, bool(patch["autoRecompute"]))

    db.commit()
    return get_settings(db)


def _upsert(db: Session, key: str, value: object) -> None:
    row = db.get(SystemSetting, key)
    payload = json.dumps(value)
    if row is None:
        db.add(SystemSetting(key=key, value_json=payload, updated_at=utcnow()))
    else:
        row.value_json = payload
        row.updated_at = utcnow()
    db.flush()
