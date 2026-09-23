"""Hazard domain service — parity with src/lib/rg/hazards.ts.

Covers: serialization (HazardDTO shape), geospatial context stats (density /
recurrence), priority recompute (upsert with override preservation) and the
DBSCAN cluster recompute (delete + recreate in scope, idempotent).
"""
from __future__ import annotations

import json
import threading
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    ClusterMembership,
    HazardCluster,
    HazardReport,
    PriorityScore,
    WorkOrder,
    utcnow,
)
from app.services.geo import (
    haversine_m,
    infer_road_criticality,
    nearest_ward,
)
from app.services.priority import PriorityInput, compute_priority
from app.services.severity import HAZARD_CLASSES as HAZARD_CLASSES_ALL
from app.services.severity import area_ratio_of, severity_from_detection
from app.services.settings import get_settings

ACTIONABLE_STATUSES = ("PENDING_REVIEW", "APPROVED", "FLAGGED")
VALID_STATUSES = ("PENDING_REVIEW", "APPROVED", "REJECTED", "MERGED", "FLAGGED")
VALID_BANDS = ("CRITICAL", "HIGH", "MEDIUM", "LOW")

REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def make_reference() -> str:
    """`RG-XXXXXX` — ambiguity-free alphabet (no I/L/O/0/1)."""
    import secrets

    code = "".join(secrets.choice(REFERENCE_ALPHABET) for _ in range(6))
    return f"RG-{code}"


# ------------------------------------------------------------------ serialization
def serialize_hazard(r: HazardReport, work_order_status: str | None = None) -> dict[str, Any]:
    priority: dict[str, Any] | None = None
    ps = r.priority_score
    if ps is not None:
        try:
            priority = {
                "score": ps.score,
                "band": ps.band,
                "factors": json.loads(ps.explanation_json),
                "weights": json.loads(ps.weights_json),
                "overridden": ps.overridden,
                "manualScore": ps.manual_score,
                "computedAt": ps.computed_at.isoformat(),
            }
        except (TypeError, ValueError):
            priority = None

    return {
        "id": r.id,
        "referenceCode": r.reference_code,
        "hazardClass": r.hazard_class,
        "severity": r.severity,
        "status": r.status,
        "lat": r.lat,
        "lng": r.lng,
        "address": r.address,
        "ward": r.ward,
        "roadName": r.road_name,
        "roadClass": r.road_class,
        "notes": r.notes,
        "source": r.source,
        "duplicateOfId": r.duplicate_of_id,
        "createdAt": r.created_at.isoformat(),
        "reviewedAt": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "reviewNote": r.review_note,
        "userId": r.user_id,
        "media": [
            {
                "id": m.id,
                "kind": m.kind,
                "mimeType": m.mime_type,
                "width": m.width,
                "height": m.height,
                "durationSec": m.duration_sec,
            }
            for m in r.media
        ],
        "detections": [
            {
                "id": d.id,
                "hazardClass": d.hazard_class,
                "confidence": d.confidence,
                "bbox": (d.bbox_x, d.bbox_y, d.bbox_w, d.bbox_h),
                "areaRatio": d.area_ratio,
                "severity": d.severity,
                "engine": d.engine,
                "modelVersion": d.model_version,
            }
            for d in r.detections
        ],
        "priority": priority,
        "clusterId": r.cluster_id,
        "workOrderStatus": work_order_status,
    }


def load_report(db: Session, report_id: str) -> HazardReport | None:
    stmt = (
        select(HazardReport)
        .where(HazardReport.id == report_id)
        .options(
            selectinload(HazardReport.media),
            selectinload(HazardReport.detections),
            selectinload(HazardReport.priority_score),
        )
    )
    return db.execute(stmt).scalar_one_or_none()


def work_order_status_for(db: Session, report_id: str) -> str | None:
    row = db.execute(select(WorkOrder.status).where(WorkOrder.hazard_report_id == report_id)).scalar_one_or_none()
    return row


# ----------------------------------------------------------- context statistics
def compute_context_stats(
    db: Session,
    *,
    lat: float,
    lng: float,
    hazard_class: str,
    exclude_report_id: str | None = None,
) -> dict[str, int]:
    """Same-class actionable reports within 120 m / 60 d (density) and 75 m / 30 d (recurrence)."""
    from app.services.geo import neighbors_within

    base = [
        HazardReport.status.in_(ACTIONABLE_STATUSES),
        HazardReport.duplicate_of_id.is_(None),
        HazardReport.hazard_class == hazard_class,
    ]
    if exclude_report_id:
        base.append(HazardReport.id != exclude_report_id)

    near60 = neighbors_within(
        db, HazardReport, lat, lng, 120, (*base, HazardReport.created_at >= utcnow() - timedelta(days=60))
    )
    near30 = neighbors_within(
        db, HazardReport, lat, lng, 75, (*base, HazardReport.created_at >= utcnow() - timedelta(days=30))
    )
    return {"neighborCount": len(near60), "recurrenceCount": len(near30)}


# ------------------------------------------------------------ priority recompute
def recompute_priority_for_report(db: Session, report_id: str, settings_bundle: dict | None = None) -> None:
    bundle = settings_bundle or get_settings(db)
    report = load_report(db, report_id)
    if report is None:
        return
    if report.status in ("REJECTED", "MERGED"):
        return

    stats = compute_context_stats(
        db, lat=report.lat, lng=report.lng, hazard_class=report.hazard_class, exclude_report_id=report.id
    )
    criticality = report.road_criticality
    if criticality is None:
        criticality = infer_road_criticality(report.road_name, report.road_class)
    age_days = max(0.0, (utcnow() - report.created_at.replace(tzinfo=None)).total_seconds() / 86400)

    wo_status = work_order_status_for(db, report.id)
    prev = report.priority_score

    result = compute_priority(
        PriorityInput(
            severity=report.severity,
            neighbor_count=stats["neighborCount"],
            road_criticality=float(criticality),
            recurrence_count=stats["recurrenceCount"],
            age_days=age_days,
            resolved=wo_status == "RESOLVED",
            weights=bundle["weights"],
            overridden=bool(prev and prev.overridden),
            manual_score=prev.manual_score if prev else None,
        ),
        now=utcnow(),
    )

    norms = result.norms
    if prev is None:
        db.add(
            PriorityScore(
                report_id=report.id,
                score=result.score,
                band=result.band,
                severity_norm=norms["severity"],
                density_norm=norms["density"],
                criticality_norm=norms["criticality"],
                recurrence_norm=norms["recurrence"],
                age_norm=norms["age"],
                weights_json=json.dumps(result.weights),
                explanation_json=json.dumps([f.as_dict() for f in result.factors]),
                overridden=result.overridden,
                overridden_by=None,
                manual_score=result.manual_score,
                computed_at=utcnow(),
            )
        )
    else:
        prev.score = result.score
        prev.band = result.band
        prev.severity_norm = norms["severity"]
        prev.density_norm = norms["density"]
        prev.criticality_norm = norms["criticality"]
        prev.recurrence_norm = norms["recurrence"]
        prev.age_norm = norms["age"]
        prev.weights_json = json.dumps(result.weights)
        prev.explanation_json = json.dumps([f.as_dict() for f in result.factors])
        prev.computed_at = utcnow()
    db.flush()


# --------------------------------------------------------------- cluster recompute
def cluster_label(index: int, ward: str) -> str:
    return f"C-{index + 1} · {ward}"


_recompute_lock = threading.Lock()


class RecomputeInProgress(RuntimeError):
    pass


def recompute_clusters(
    db: Session,
    *,
    bbox: dict[str, float] | None = None,
    since_days: int | None = None,
    eps_m: float | None = None,
    min_pts: int | None = None,
) -> dict[str, Any]:
    """Full clustering recompute — idempotent (delete + recreate in scope).

    Scope: actionable (PENDING_REVIEW/APPROVED/FLAGGED), non-duplicate reports
    within `since_days` and optionally inside a bbox. After re-clustering, every
    in-scope report's priority is refreshed (density may have changed).
    """
    from app.services.clustering import dbscan, summarize_clusters

    if not _recompute_lock.acquire(blocking=False):
        raise RecomputeInProgress("Cluster recompute already in progress")
    try:
        bundle = get_settings(db)
        eps = float(eps_m if eps_m is not None else bundle["cluster"]["epsM"])
        min_pts_v = int(min_pts if min_pts is not None else bundle["cluster"]["minPts"])
        window_days = int(since_days if since_days is not None else bundle["cluster"]["sinceDays"])

        stmt = select(HazardReport).where(
            HazardReport.status.in_(ACTIONABLE_STATUSES),
            HazardReport.duplicate_of_id.is_(None),
            HazardReport.created_at >= utcnow() - timedelta(days=window_days),
        )
        if bbox:
            stmt = stmt.where(
                HazardReport.lat >= bbox["minLat"],
                HazardReport.lat <= bbox["maxLat"],
                HazardReport.lng >= bbox["minLng"],
                HazardReport.lng <= bbox["maxLng"],
            )
        reports = list(db.execute(stmt).scalars().all())
        points = [(r.lat, r.lng) for r in reports]
        labels = dbscan(points, eps_m=eps, min_pts=min_pts_v)
        summaries = summarize_clusters(points, labels)

        # --- idempotent delete: memberships + clusters touching the scope
        scoped_ids = [r.id for r in reports]
        if scoped_ids:
            old_memberships = db.execute(
                select(ClusterMembership).where(ClusterMembership.report_id.in_(scoped_ids))
            ).scalars().all()
            touched_cluster_ids = {m.cluster_id for m in old_memberships}
            for m in old_memberships:
                db.delete(m)
            # clear stale pointers
            db.execute(
                HazardReport.__table__.update()
                .where(HazardReport.id.in_(scoped_ids), HazardReport.cluster_id.isnot(None))
                .values(cluster_id=None)
            )
            # drop clusters that no longer have any member
            for cluster_id in touched_cluster_ids:
                remaining = db.execute(
                    select(ClusterMembership.id).where(ClusterMembership.cluster_id == cluster_id).limit(1)
                ).scalar_one_or_none()
                if remaining is None:
                    cluster = db.get(HazardCluster, cluster_id)
                    if cluster is not None:
                        db.delete(cluster)
        db.flush()

        # --- recreate
        by_id = {r.id: r for r in reports}
        assigned = 0
        for ci, summary in enumerate(summaries):
            members = [by_id[scoped_ids[i]] for i in summary["memberIndexes"]]
            class_tally: dict[str, int] = {}
            for m in members:
                class_tally[m.hazard_class] = class_tally.get(m.hazard_class, 0) + 1
            dominant = max(class_tally.items(), key=lambda kv: kv[1])[0] if class_tally else "pothole"
            avg_severity = sum(m.severity for m in members) / max(1, len(members))
            max_severity = max(m.severity for m in members) if members else 0
            ward = nearest_ward(summary["centerLat"], summary["centerLng"])

            cluster = HazardCluster(
                label=cluster_label(ci, ward),
                center_lat=summary["centerLat"],
                center_lng=summary["centerLng"],
                center=f"{summary['centerLat']:.7f},{summary['centerLng']:.7f}",  # "lat,lng" → WKT via GeographyPoint
                radius_m=round(summary["radiusM"]),
                hazard_count=len(members),
                dominant_class=dominant,
                avg_severity=round(avg_severity * 100) / 100,
                max_severity=max_severity,
                params_json=json.dumps({"epsM": eps, "minPts": min_pts_v, "sinceDays": window_days}),
                computed_at=utcnow(),
            )
            db.add(cluster)
            db.flush()
            for m in members:
                dist = haversine_m(m.lat, m.lng, summary["centerLat"], summary["centerLng"])
                db.add(ClusterMembership(cluster_id=cluster.id, report_id=m.id, distance_m=round(dist)))
                m.cluster_id = cluster.id
                assigned += 1
        db.flush()

        # refresh priorities for the whole scope (density may have changed)
        for r in reports:
            recompute_priority_for_report(db, r.id, bundle)
        db.commit()

        return {
            "scopedReports": len(reports),
            "clusters": len(summaries),
            "assignedReports": assigned,
            "epsM": eps,
            "minPts": min_pts_v,
            "computedAt": utcnow().isoformat(),
        }
    finally:
        _recompute_lock.release()


# --------------------------------------------------------------------- auto mode
_last_auto_recompute = 0.0
AUTO_RECOMPUTE_MIN_INTERVAL = 10 * 60  # bounded to once per 10 minutes


def auto_recompute_if_stale(db: Session) -> None:
    """Lazily refresh clusters before serving map data (map.autoRecompute=true)."""
    global _last_auto_recompute
    import time

    bundle = get_settings(db)
    if not bundle["autoRecompute"]:
        return
    if time.monotonic() - _last_auto_recompute < AUTO_RECOMPUTE_MIN_INTERVAL:
        return
    _last_auto_recompute = time.monotonic()
    try:
        recompute_clusters(db)
    except RecomputeInProgress:
        pass
    except Exception:  # noqa: BLE001 — auto mode must never break map serving
        import logging

        logging.getLogger("roadguard.clusters").exception("auto-recompute failed")


# ------------------------------------------------------------------ review utils
def ai_severity_for_report(db: Session, report: HazardReport, hazard_class: str) -> int:
    """AI-derived severity refined by duplicate context (used when user severity absent)."""
    detections = sorted(report.detections, key=lambda d: d.confidence, reverse=True)
    if not detections:
        return report.severity
    primary = detections[0]
    area = primary.area_ratio or area_ratio_of((primary.bbox_x, primary.bbox_y, primary.bbox_w, primary.bbox_h))
    stats = compute_context_stats(db, lat=report.lat, lng=report.lng, hazard_class=hazard_class)
    return severity_from_detection(
        hazard_class=hazard_class,
        confidence=primary.confidence,
        area_ratio=area,
        duplicate_count=stats["recurrenceCount"],
    )


__all__ = [
    "ACTIONABLE_STATUSES",
    "VALID_BANDS",
    "VALID_STATUSES",
    "RecomputeInProgress",
    "ai_severity_for_report",
    "cluster_label",
    "compute_context_stats",
    "load_report",
    "make_reference",
    "recompute_clusters",
    "recompute_priority_for_report",
    "serialize_hazard",
    "work_order_status_for",
]
