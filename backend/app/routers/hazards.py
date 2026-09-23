"""Hazards router — public filterable feed, detail, admin review and priority explanation."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.models import HazardReport, PriorityScore, utcnow
from app.schemas.hazard import HazardListOut, HazardOut, ReviewIn
from app.schemas.common import PriorityOut
from app.services.audit import client_ip, write_audit
from app.services.geo import Bbox, is_valid_lat_lng
from app.services.hazards import (
    ACTIONABLE_STATUSES,
    VALID_BANDS,
    VALID_STATUSES,
    HAZARD_CLASSES_ALL,
    load_report,
    recompute_priority_for_report,
    serialize_hazard,
    work_order_status_for,
)
from app.services.notifications import notify
from app.services.security import AdminUser, get_current_user
from app.services.settings import get_settings

router = APIRouter(prefix="/hazards", tags=["hazards"])


def parse_hazard_filters(
    classes: str | None,
    severity_min: float,
    severity_max: float,
    statuses: str | None,
    bands: str | None,
    from_: str | None,
    to: str | None,
    bbox: str | None,
    q: str | None,
) -> list:
    """Shared filter params for /hazards and /map — parity with parseHazardFilters in rg/hazards.ts."""
    predicates = [HazardReport.duplicate_of_id.is_(None)]

    if classes:
        valid = [c for c in classes.split(",") if c in HAZARD_CLASSES_ALL]
        if valid:
            predicates.append(HazardReport.hazard_class.in_(valid))
    if severity_min > 1 or severity_max < 5:
        predicates.append(HazardReport.severity >= max(1, int(severity_min)))
        predicates.append(HazardReport.severity <= min(5, int(severity_max)))

    if statuses:
        valid_statuses = [s for s in statuses.split(",") if s in VALID_STATUSES]
        predicates.append(
            HazardReport.status.in_(valid_statuses or list(ACTIONABLE_STATUSES))
        )
    else:
        predicates.append(HazardReport.status.in_(ACTIONABLE_STATUSES))

    if from_ or to:
        if from_:
            try:
                predicates.append(HazardReport.created_at >= datetime.fromisoformat(from_.replace("Z", "+00:00")).replace(tzinfo=None))
            except ValueError:
                pass
        if to:
            try:
                day = datetime.fromisoformat(to.replace("Z", "+00:00")).replace(tzinfo=None)
                predicates.append(HazardReport.created_at <= day + timedelta(hours=23, minutes=59, seconds=59))
            except ValueError:
                pass

    parsed = Bbox.parse(bbox)
    if parsed is not None:
        predicates += [
            HazardReport.lat >= parsed.min_lat,
            HazardReport.lat <= parsed.max_lat,
            HazardReport.lng >= parsed.min_lng,
            HazardReport.lng <= parsed.max_lng,
        ]

    if q:
        like = f"%{q}%"
        predicates.append(
            or_(
                HazardReport.reference_code.ilike(like),
                HazardReport.address.ilike(like),
                HazardReport.ward.ilike(like),
                HazardReport.road_name.ilike(like),
            )
        )

    if bands:
        valid_bands = [b for b in bands.split(",") if b in VALID_BANDS]
        if valid_bands:
            predicates.append(HazardReport.id.in_(select(PriorityScore.report_id).where(PriorityScore.band.in_(valid_bands))))

    return predicates


@router.get("", response_model=HazardListOut, summary="Public hazard feed (filterable)")
def list_hazards(
    db: Session = Depends(get_db),
    classes: str | None = Query(default=None, description="CSV of hazard classes, e.g. pothole,crack"),
    severityMin: float = Query(default=1, ge=1, le=5),
    severityMax: float = Query(default=5, ge=1, le=5),
    statuses: str | None = Query(default=None, description="CSV of statuses; default = actionable set"),
    band: str | None = Query(default=None, alias="band", description="CSV of priority bands (also accepts ?bands=)"),
    bands: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from", description="ISO date/datetime lower bound"),
    to: str | None = Query(default=None, description="ISO date/datetime upper bound"),
    bbox: str | None = Query(default=None, description="minLng,minLat,maxLng,maxLat"),
    q: str | None = Query(default=None, max_length=120, description="matches reference/address/ward/road"),
    limit: int = Query(default=300, ge=1, le=1000),
) -> HazardListOut:
    predicates = parse_hazard_filters(classes, severityMin, severityMax, statuses, bands or band, from_, to, bbox, q)
    stmt: Select = (
        select(HazardReport)
        .where(*predicates)
        .options(selectinload(HazardReport.media), selectinload(HazardReport.detections), selectinload(HazardReport.priority_score))
        .order_by(HazardReport.created_at.desc())
        .limit(limit)
    )
    reports = db.execute(stmt).scalars().unique().all()
    return HazardListOut(
        items=[serialize_hazard(r, work_order_status_for(db, r.id)) for r in reports],
        count=len(reports),
    )


@router.get("/{hazard_id}", response_model=HazardOut, summary="Hazard detail")
def get_hazard(hazard_id: str, db: Session = Depends(get_db)) -> HazardOut:
    report = load_report(db, hazard_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Hazard not found"})
    return HazardOut(**serialize_hazard(report, work_order_status_for(db, report.id)))


@router.post(
    "/{hazard_id}/review",
    response_model=HazardOut,
    summary="Admin review: approve | reject | flag | merge (+edits, +manual priority override)",
    responses={
        400: {"model": dict, "description": "Bad action / merge target / severity"},
        403: {"model": dict, "description": "Admin only"},
        404: {"model": dict, "description": "Hazard or merge target not found"},
    },
)
def review_hazard(
    hazard_id: str,
    payload: ReviewIn,
    request: Request,
    admin: AdminUser,
    db: Session = Depends(get_db),
) -> HazardOut:
    action = payload.action
    if action not in ("approve", "reject", "flag", "merge"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "action must be one of: approve, reject, flag, merge"},
        )
    report = load_report(db, hazard_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Hazard not found"})

    # 1. optional edits first
    edits = payload.edits
    edit_keys: list[str] = []
    if edits is not None:
        if edits.hazardClass is not None:
            report.hazard_class = edits.hazardClass
            edit_keys.append("hazardClass")
        if edits.severity is not None:
            report.severity = round(edits.severity)
            edit_keys.append("severity")
        if edits.lat is not None and edits.lng is not None:
            if not is_valid_lat_lng(edits.lat, edits.lng):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "Invalid coordinates"})
            report.lat, report.lng = edits.lat, edits.lng
            report.location = f"{edits.lat},{edits.lng}"
            edit_keys += ["lat", "lng"]
        for field_name in ("address", "ward", "roadName", "roadClass"):
            value = getattr(edits, field_name)
            if value is not None:
                setattr(report, {"roadName": "road_name", "roadClass": "road_class"}.get(field_name, field_name), value)
                edit_keys.append(field_name)
        if edits.roadCriticality is not None:
            report.road_criticality = edits.roadCriticality
            edit_keys.append("roadCriticality")

    # 2. optional explainable manual priority override
    if payload.manualScore is not None:
        ps = report.priority_score
        if ps is None:
            ps = PriorityScore(report_id=report.id, severity_norm=0, density_norm=0, criticality_norm=0, recurrence_norm=0, age_norm=0, weights_json="{}", explanation_json="[]")
            db.add(ps)
            report.priority_score = ps
        ps.overridden = True
        ps.manual_score = payload.manualScore
        ps.overridden_by = admin.email
        ps.score = payload.manualScore
        ps.band = "MEDIUM"
        db.flush()

    # 3. action
    merge_target_id: str | None = None
    if action in ("approve", "reject", "flag"):
        report.status = {"approve": "APPROVED", "reject": "REJECTED", "flag": "FLAGGED"}[action]
        report.reviewed_at = utcnow()
        report.reviewed_by = admin.email
        report.review_note = payload.note
        if report.user_id:
            label = {"APPROVED": "approved", "REJECTED": "rejected", "FLAGGED": "flagged for inspection"}[report.status]
            notify(
                db,
                user_id=report.user_id,
                type="REPORT_REVIEWED",
                title=f"Report {report.reference_code} {label}",
                body=payload.note or f"A moderator has {action}d your report{'. It is now visible on the public map.' if report.status == 'APPROVED' else '.'}",
                link="#/dashboard",
            )
    else:  # merge
        if not payload.mergeIntoId or payload.mergeIntoId == hazard_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "mergeIntoId must reference a different hazard"},
            )
        primary = load_report(db, payload.mergeIntoId)
        if primary is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Primary hazard for merge not found"})
        if primary.status in ("MERGED", "REJECTED"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "Cannot merge into a rejected or already-merged hazard"},
            )
        merge_target_id = payload.mergeIntoId
        report.status = "MERGED"
        report.duplicate_of_id = payload.mergeIntoId
        report.reviewed_at = utcnow()
        report.reviewed_by = admin.email
        report.review_note = payload.note
        report.cluster_id = None
        if report.user_id:
            notify(
                db,
                user_id=report.user_id,
                type="REPORT_REVIEWED",
                title=f"Report {report.reference_code} merged",
                body=f"Your report was confirmed as a duplicate of {primary.reference_code}. Thank you — duplicates raise the cluster's priority.",
                link="#/dashboard",
            )

    recompute_priority_for_report(db, hazard_id)
    if merge_target_id:
        recompute_priority_for_report(db, merge_target_id)

    write_audit(
        db,
        action=f"review.{action}",
        entity_type="hazard_report",
        entity_id=hazard_id,
        actor_id=admin.id,
        actor_email=admin.email,
        actor_role=admin.role,
        metadata={
            "reference": report.reference_code,
            "note": payload.note,
            "edits": edit_keys,
            "manualScore": payload.manualScore,
            "mergeIntoId": merge_target_id,
        },
        ip=client_ip(request),
    )
    db.commit()

    fresh = load_report(db, hazard_id)
    return HazardOut(**serialize_hazard(fresh, work_order_status_for(db, hazard_id)))


@router.get(
    "/{hazard_id}/priority-explanation",
    response_model=PriorityOut,
    summary="Explainable priority breakdown (weights, factors, contributions)",
)
def priority_explanation(hazard_id: str, db: Session = Depends(get_db), _user=Depends(get_current_user)) -> PriorityOut:
    report = load_report(db, hazard_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Hazard not found"})
    ps = report.priority_score
    if ps is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Priority not computed yet"})
    return PriorityOut(
        score=ps.score,
        band=ps.band,  # type: ignore[arg-type]
        factors=json.loads(ps.explanation_json) if ps.explanation_json else [],
        weights=json.loads(ps.weights_json) if ps.weights_json else {},
        overridden=ps.overridden,
        manualScore=ps.manual_score,
        computedAt=ps.computed_at.isoformat(),
    )
