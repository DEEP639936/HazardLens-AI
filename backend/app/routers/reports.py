"""Reports router — citizen hazard submission (rate-limited) + own-report listing."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Detection, HazardReport, MediaAsset, utcnow
from app.schemas.hazard import HazardListOut, HazardOut, ReportCreateIn
from app.services.audit import client_ip, write_audit
from app.services.geo import infer_road_criticality, is_valid_lat_lng, nearest_ward
from app.services.hazards import (
    HAZARD_CLASSES_ALL,
    compute_context_stats,
    make_reference,
    recompute_priority_for_report,
    serialize_hazard,
    work_order_status_for,
)
from app.services.notifications import notify
from app.services.ratelimit import limit_reports, limiter
from app.services.security import CurrentUser, OptionalUser, get_current_user
from app.services.severity import severity_from_detection

logger = logging.getLogger("roadguard.reports")

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("", response_model=HazardListOut, summary="List own reports (admins see all)")
def list_reports(user: CurrentUser, db: Session = Depends(get_db)) -> HazardListOut:
    stmt = select(HazardReport).order_by(HazardReport.created_at.desc()).limit(200)
    if user.role != "ADMIN":
        stmt = stmt.where(HazardReport.user_id == user.id)
    reports = db.execute(stmt).scalars().all()
    return HazardListOut(
        items=[
            serialize_hazard(r, work_order_status_for(db, r.id)) for r in reports
        ],
        count=len(reports),
    )


@router.post(
    "",
    response_model=HazardOut,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a hazard report (public, 5/hour/IP)",
    responses={
        400: {"model": dict, "description": "Validation error (location / consent)"},
        429: {"model": dict, "description": "Rate limit exceeded"},
    },
)
@limiter.limit(limit_reports())
def create_report(
    request: Request,
    payload: ReportCreateIn,
    db: Session = Depends(get_db),
    user: OptionalUser = None,
) -> HazardOut:
    ip = client_ip(request)
    if not is_valid_lat_lng(payload.lat, payload.lng):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "A valid hazard location is required", "detail": "Place the pin on the map or allow geolocation."},
        )
    if not payload.geoConsent:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "Location consent is required", "detail": "Confirm the location-privacy notice to submit a report."},
        )
    hazard_class = payload.hazardClass if payload.hazardClass in HAZARD_CLASSES_ALL else "pothole"

    # attach pre-uploaded media + detections (must be unclaimed)
    media: list[MediaAsset] = []
    if payload.mediaIds:
        media = list(
            db.execute(
                select(MediaAsset).where(MediaAsset.id.in_(payload.mediaIds), MediaAsset.report_id.is_(None))
            ).scalars().all()
        )
    detections: list[Detection] = []
    if payload.detectionIds:
        detections = list(
            db.execute(
                select(Detection).where(Detection.id.in_(payload.detectionIds), Detection.report_id.is_(None))
            ).scalars().all()
        )

    # AI-derived severity refined by duplicate context; an explicit user-stated severity wins.
    final_severity = payload.severity or 3
    if payload.severity is None and detections:
        primary = max(detections, key=lambda d: d.confidence)
        stats = compute_context_stats(db, lat=payload.lat, lng=payload.lng, hazard_class=hazard_class)
        final_severity = severity_from_detection(
            hazard_class=hazard_class,
            confidence=primary.confidence,
            area_ratio=primary.area_ratio or (primary.bbox_w * primary.bbox_h),
            duplicate_count=stats["recurrenceCount"],
        )
    final_severity = max(1, min(5, int(final_severity)))

    report = HazardReport(
        reference_code=make_reference(),
        user_id=user.id if user else None,
        submitter_name=(payload.submitterName or (user.name if user else None) or None),
        submitter_email=(payload.submitterEmail or (user.email if user else None) or None),
        hazard_class=hazard_class,
        hazard_class_ai=detections[0].hazard_class if detections else None,
        severity=final_severity,
        severity_ai=max(detections, key=lambda d: d.confidence).severity if detections else None,
        notes=(payload.notes or None),
        status="PENDING_REVIEW",
        lat=payload.lat,
        lng=payload.lng,
        location=f"{payload.lat},{payload.lng}",
        address=payload.address,
        ward=payload.ward or nearest_ward(payload.lat, payload.lng),
        road_name=payload.roadName,
        road_class=payload.roadClass,
        road_criticality=(
            payload.roadCriticality
            if payload.roadCriticality is not None
            else infer_road_criticality(payload.roadName, payload.roadClass)
        ),
        geo_consent=True,
        blur_requested=payload.blurRequested,
        source="WEB_UPLOAD",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(report)
    db.flush()

    for m in media:
        m.report_id = report.id
    for det in detections:
        det.report_id = report.id
        det.severity = severity_from_detection(
            hazard_class=hazard_class,
            confidence=det.confidence,
            area_ratio=det.area_ratio or (det.bbox_w * det.bbox_h),
        )

    recompute_priority_for_report(db, report.id)
    if user:
        notify(
            db,
            user_id=user.id,
            type="REPORT_SUBMITTED",
            title=f"Report {report.reference_code} received",
            body="Your report is in the review queue. You will be notified once a moderator reviews it.",
            link="#/dashboard",
        )
    write_audit(
        db,
        action="report.create",
        entity_type="hazard_report",
        entity_id=report.id,
        actor_id=user.id if user else None,
        actor_email=user.email if user else payload.submitterEmail,
        actor_role=user.role if user else "ANONYMOUS",
        metadata={"reference": report.reference_code, "hazardClass": hazard_class, "detections": len(detections), "media": len(media)},
        ip=ip,
    )
    db.commit()

    from app.services.hazards import load_report

    fresh = load_report(db, report.id)
    return HazardOut(**serialize_hazard(fresh, work_order_status_for(db, report.id)))


@router.get("/{report_id}", response_model=HazardOut, summary="Report detail (owner or admin)")
def get_report(report_id: str, user: CurrentUser, db: Session = Depends(get_db)) -> HazardOut:
    from app.services.hazards import load_report

    report = load_report(db, report_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Report not found"})
    if user.role != "ADMIN" and report.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"error": "Not your report"})
    return HazardOut(**serialize_hazard(report, work_order_status_for(db, report.id)))
