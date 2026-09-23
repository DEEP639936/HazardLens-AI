"""Export router — CSV + GeoJSON hazard exports (admin)."""
from __future__ import annotations

import csv
import io
import json

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import Select, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.models import HazardReport
from app.routers.hazards import parse_hazard_filters
from app.services.security import AdminUser

router = APIRouter(prefix="/export", tags=["export"])

CSV_COLUMNS = [
    "reference_code",
    "hazard_class",
    "severity",
    "status",
    "band",
    "priority_score",
    "lat",
    "lng",
    "ward",
    "road_name",
    "road_class",
    "address",
    "source",
    "created_at",
    "reviewed_at",
    "duplicate_of_id",
]


@router.get(
    "/hazards.csv",
    summary="Admin: export filtered hazards as CSV",
    response_class=StreamingResponse,
)
def export_csv(
    admin: AdminUser,
    db: Session = Depends(get_db),
    classes: str | None = Query(default=None),
    severityMin: float = Query(default=1, ge=1, le=5),
    severityMax: float = Query(default=5, ge=1, le=5),
    statuses: str | None = Query(default=None),
    band: str | None = Query(default=None),
    bands: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    bbox: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=5000, ge=1, le=50000),
) -> StreamingResponse:
    predicates = parse_hazard_filters(classes, severityMin, severityMax, statuses, bands or band, from_, to, bbox, q)
    stmt: Select = (
        select(HazardReport)
        .where(*predicates)
        .options(selectinload(HazardReport.priority_score))
        .order_by(HazardReport.created_at.desc())
        .limit(limit)
    )
    reports = db.execute(stmt).scalars().unique().all()

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for r in reports:
        writer.writerow(
            {
                "reference_code": r.reference_code,
                "hazard_class": r.hazard_class,
                "severity": r.severity,
                "status": r.status,
                "band": r.priority_score.band if r.priority_score else "",
                "priority_score": r.priority_score.score if r.priority_score else "",
                "lat": r.lat,
                "lng": r.lng,
                "ward": r.ward or "",
                "road_name": r.road_name or "",
                "road_class": r.road_class or "",
                "address": r.address or "",
                "source": r.source,
                "created_at": r.created_at.isoformat(),
                "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else "",
                "duplicate_of_id": r.duplicate_of_id or "",
            }
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="roadguard-hazards.csv"'},
    )


@router.get(
    "/hazards.geojson",
    summary="Admin: export filtered hazards as GeoJSON FeatureCollection",
    response_class=StreamingResponse,
)
def export_geojson(
    admin: AdminUser,
    db: Session = Depends(get_db),
    classes: str | None = Query(default=None),
    severityMin: float = Query(default=1, ge=1, le=5),
    severityMax: float = Query(default=5, ge=1, le=5),
    statuses: str | None = Query(default=None),
    band: str | None = Query(default=None),
    bands: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    bbox: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=5000, ge=1, le=50000),
) -> StreamingResponse:
    predicates = parse_hazard_filters(classes, severityMin, severityMax, statuses, bands or band, from_, to, bbox, q)
    stmt: Select = (
        select(HazardReport)
        .where(*predicates)
        .options(selectinload(HazardReport.priority_score))
        .order_by(HazardReport.created_at.desc())
        .limit(limit)
    )
    reports = db.execute(stmt).scalars().unique().all()

    features = []
    for r in reports:
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [r.lng, r.lat]},
                "properties": {
                    "id": r.id,
                    "referenceCode": r.reference_code,
                    "hazardClass": r.hazard_class,
                    "severity": r.severity,
                    "status": r.status,
                    "band": r.priority_score.band if r.priority_score else None,
                    "priorityScore": r.priority_score.score if r.priority_score else None,
                    "ward": r.ward,
                    "roadName": r.road_name,
                    "roadClass": r.road_class,
                    "address": r.address,
                    "source": r.source,
                    "createdAt": r.created_at.isoformat(),
                    "duplicateOfId": r.duplicate_of_id,
                },
            }
        )
    payload = json.dumps({"type": "FeatureCollection", "features": features})
    return StreamingResponse(
        iter([payload]),
        media_type="application/geo+json",
        headers={"Content-Disposition": 'attachment; filename="roadguard-hazards.geojson"'},
    )
