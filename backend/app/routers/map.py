"""Map router — hazards + clusters in one GeoJSON-ready payload."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import Select, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.models import HazardCluster, HazardReport
from app.routers.hazards import parse_hazard_filters
from app.schemas.common import ClusterOut
from app.schemas.hazard import HazardOut
from app.services.hazards import (
    auto_recompute_if_stale,
    serialize_hazard,
    work_order_status_for,
)

router = APIRouter(tags=["map"])


class MapOut(BaseModel):
    hazards: list[HazardOut]
    clusters: list[ClusterOut]
    computedAt: str | None = Field(default=None, description="Last cluster computation time")


@router.get(
    "/map",
    response_model=MapOut,
    summary="Map payload: filtered hazards + computed clusters (GeoJSON-ready)",
)
def map_payload(
    db: Session = Depends(get_db),
    classes: str | None = Query(default=None, description="CSV of hazard classes"),
    severityMin: float = Query(default=1, ge=1, le=5),
    severityMax: float = Query(default=5, ge=1, le=5),
    statuses: str | None = Query(default=None, description="CSV of statuses; default = actionable set"),
    band: str | None = Query(default=None, description="CSV of priority bands (also accepts ?bands=)"),
    bands: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from", description="ISO date/datetime lower bound"),
    to: str | None = Query(default=None, description="ISO date/datetime upper bound"),
    bbox: str | None = Query(default=None, description="minLng,minLat,maxLng,maxLat"),
    q: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=1000, ge=1, le=2000),
) -> MapOut:
    # Lazily refresh clusters when map.autoRecompute is on (bounded to once / 10 min).
    auto_recompute_if_stale(db)

    predicates = parse_hazard_filters(classes, severityMin, severityMax, statuses, bands or band, from_, to, bbox, q)
    stmt: Select = (
        select(HazardReport)
        .where(*predicates)
        .options(
            selectinload(HazardReport.media),
            selectinload(HazardReport.detections),
            selectinload(HazardReport.priority_score),
        )
        .order_by(HazardReport.created_at.desc())
        .limit(limit)
    )
    reports = db.execute(stmt).scalars().unique().all()

    clusters = db.execute(select(HazardCluster).order_by(HazardCluster.hazard_count.desc())).scalars().all()

    computed_at = max((c.computed_at for c in clusters), default=None)
    return MapOut(
        hazards=[HazardOut(**serialize_hazard(r, work_order_status_for(db, r.id))) for r in reports],
        clusters=[
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
            for c in clusters
        ],
        computedAt=computed_at.isoformat() if computed_at else None,
    )
