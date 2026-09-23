"""Analytics router — aggregate dashboard payload (admin)."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Detection, HazardCluster, HazardReport, PriorityScore, WorkOrder, utcnow
from app.schemas.admin import AnalyticsOut
from app.services.hazards import ACTIONABLE_STATUSES, VALID_BANDS
from app.services.severity import HAZARD_CLASSES as HAZARD_CLASSES_ALL
from app.services.security import AdminUser

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _median(values: list[float]) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def _round(n: float, digits: int = 2) -> float:
    return round(float(n), digits)


@router.get("", response_model=AnalyticsOut, summary="Aggregate analytics (admin)")
def analytics(admin: AdminUser, db: Session = Depends(get_db)) -> AnalyticsOut:
    all_reports = db.execute(
        select(HazardReport).where(
            HazardReport.status.in_(ACTIONABLE_STATUSES), HazardReport.duplicate_of_id.is_(None)
        )
    ).scalars().all()
    scores = db.execute(select(PriorityScore)).scalars().all()
    cluster_count = db.execute(select(func.count()).select_from(HazardCluster)).scalar_one()
    detections = db.execute(
        select(Detection.hazard_class, Detection.confidence, Detection.engine, Detection.model_version, Detection.inference_ms)
    ).all()
    resolved_count = db.execute(
        select(func.count()).select_from(WorkOrder).where(WorkOrder.status == "RESOLVED")
    ).scalar_one()

    report_by_id = {r.id: r for r in all_reports}
    approved_scores = [
        s for s in scores if s.report_id in report_by_id and report_by_id[s.report_id].status == "APPROVED"
    ]
    pending = sum(1 for r in all_reports if r.status == "PENDING_REVIEW")
    critical = sum(1 for s in approved_scores if s.band == "CRITICAL")
    avg_priority = _round(sum(s.score for s in approved_scores) / len(approved_scores), 1) if approved_scores else 0.0

    by_class = []
    for hc in HAZARD_CLASSES_ALL:
        items = [r for r in all_reports if r.hazard_class == hc]
        by_class.append(
            {
                "hazardClass": hc,
                "count": len(items),
                "avgSeverity": _round(sum(i.severity for i in items) / len(items)) if items else 0.0,
            }
        )
    by_class.sort(key=lambda x: x["count"], reverse=True)

    by_severity = [{"severity": sev, "count": sum(1 for r in all_reports if r.severity == sev)} for sev in range(1, 6)]

    # weekly buckets over the last 12 weeks
    now = utcnow()
    weeks = []
    for i in range(11, -1, -1):
        end = now - timedelta(days=7 * i)
        start = end - timedelta(days=7)
        items = [r for r in all_reports if start <= r.created_at < end]
        weeks.append(
            {
                "week": start.date().isoformat(),
                "avgSeverity": _round(sum(r.severity for r in items) / len(items)) if items else 0.0,
                "count": len(items),
            }
        )

    score_by_report = {s.report_id: s for s in scores}
    ward_map: dict[str, dict] = {}
    for r in all_reports:
        ward = r.ward or "Unassigned"
        entry = ward_map.setdefault(ward, {"count": 0, "prioritySum": 0.0, "critical": 0})
        entry["count"] += 1
        s = score_by_report.get(r.id)
        if s is not None:
            entry["prioritySum"] += s.score
            if s.band == "CRITICAL":
                entry["critical"] += 1
    wards = sorted(
        (
            {
                "ward": ward,
                "count": v["count"],
                "avgPriority": _round(v["prioritySum"] / v["count"], 1) if v["count"] else 0.0,
                "critical": v["critical"],
            }
            for ward, v in ward_map.items()
        ),
        key=lambda x: x["count"],
        reverse=True,
    )[:8]

    priority_bands = [
        {"band": band, "count": sum(1 for s in approved_scores if s.band == band)} for band in VALID_BANDS
    ]

    confidences = [d[1] for d in detections]
    latencies = sorted(d[4] for d in detections if d[4] and d[4] > 0)
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else 0
    by_class_conf = []
    for hc in HAZARD_CLASSES_ALL:
        items = [d for d in detections if d[0] == hc]
        if items:
            by_class_conf.append(
                {
                    "hazardClass": hc,
                    "meanConfidence": _round(sum(d[1] for d in items) / len(items), 3),
                    "count": len(items),
                }
            )

    return AnalyticsOut(
        totals={
            "hazards": len(all_reports),
            "pendingReview": pending,
            "critical": critical,
            "clusters": int(cluster_count or 0),
            "avgPriority": avg_priority,
            "resolved": int(resolved_count or 0),
            "approvalRate": _round(100 * sum(1 for r in all_reports if r.status == "APPROVED") / len(all_reports), 1) if all_reports else 0.0,
        },
        byClass=by_class,
        bySeverity=by_severity,
        severityOverTime=weeks,
        wards=wards,
        priorityBands=priority_bands,
        confidence={
            "overallMean": _round(sum(confidences) / len(confidences), 3) if confidences else 0.0,
            "overallMedian": _round(_median(confidences), 3),
            "p95LatencyMs": int(p95 or 0),
            "byClass": by_class_conf,
            "engine": detections[0][2] if detections else "demo-engine-v2",
            "modelVersion": detections[0][3] if detections else "roadguard-yolo-v11n-v2",
        },
    )
