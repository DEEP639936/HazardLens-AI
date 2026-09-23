"""Clusters router — list + admin recompute."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import HazardCluster
from app.schemas.admin import RecomputeIn, RecomputeOut
from app.schemas.common import ClusterOut
from app.services.audit import client_ip, write_audit
from app.services.geo import Bbox
from app.services.hazards import RecomputeInProgress, recompute_clusters
from app.services.security import AdminUser

router = APIRouter(prefix="/clusters", tags=["clusters"])


@router.get("", response_model=list[ClusterOut], summary="Computed hazard clusters")
def list_clusters(
    db: Session = Depends(get_db),
    minCount: int = Query(default=0, ge=0, description="Only clusters with ≥ this many hazards"),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[ClusterOut]:
    stmt = select(HazardCluster).order_by(HazardCluster.hazard_count.desc()).limit(limit)
    rows = db.execute(stmt).scalars().all()
    return [
        ClusterOut(
            id=c.id,
            label=c.label,
            centerLat=c.center_lat,
            centerLng=c.center_lng,
            radiusM=c.radius_m,
            hazardCount=c.hazard_count,
            dominantClass=c.dominant_class,  # type: ignore[arg-type]
            avgSeverity=c.avg_severity,
            maxSeverity=c.max_severity,
            computedAt=c.computed_at.isoformat(),
        )
        for c in rows
        if c.hazard_count >= minCount
    ]


@router.post(
    "/recompute",
    response_model=RecomputeOut,
    summary="Admin: recompute clusters (DBSCAN) — bbox?/sinceDays?/epsM?/minPts?",
    responses={
        403: {"model": dict, "description": "Admin only"},
        409: {"model": dict, "description": "Recompute already in progress"},
    },
)
def recompute(
    payload: RecomputeIn | None = None,
    request: Request | None = None,
    admin: AdminUser = None,  # type: ignore[assignment]
    db: Session = Depends(get_db),
) -> RecomputeOut:
    body = payload or RecomputeIn()
    bbox = body.bbox.model_dump() if body.bbox else None
    try:
        summary = recompute_clusters(
            db,
            bbox=bbox,
            since_days=body.sinceDays,
            eps_m=body.epsM,
            min_pts=body.minPts,
        )
    except RecomputeInProgress as exc:
        raise HTTPException(status_code=409, detail={"error": str(exc)}) from exc
    write_audit(
        db,
        action="clusters.recompute",
        entity_type="hazard_cluster",
        actor_id=admin.id,
        actor_email=admin.email,
        actor_role=admin.role,
        metadata={
            "scopedReports": summary["scopedReports"],
            "clusters": summary["clusters"],
            "epsM": summary["epsM"],
            "minPts": summary["minPts"],
            "bbox": bbox,
        },
        ip=client_ip(request),
    )
    db.commit()
    return RecomputeOut(**summary)
