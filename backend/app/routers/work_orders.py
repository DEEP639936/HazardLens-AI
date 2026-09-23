"""Work-orders router — maintenance kanban (GET/POST list+create, GET/PATCH detail)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.models import HazardReport, PriorityScore, WorkOrder, WorkOrderUpdate, utcnow
from app.schemas.work_order import WorkOrderCreateIn, WorkOrderListOut, WorkOrderOut, WorkOrderPatchIn
from app.services.audit import client_ip, write_audit
from app.services.hazards import load_report, recompute_priority_for_report
from app.services.notifications import notify
from app.services.security import AdminUser, CurrentUser

WO_STATUSES = ("REPORTED", "UNDER_REVIEW", "APPROVED", "SCHEDULED", "IN_REPAIR", "RESOLVED")

router = APIRouter(prefix="/work-orders", tags=["work-orders"])


def _serialize(order: WorkOrder) -> WorkOrderOut:
    hazard = None
    if order.hazard_report is not None:
        hazard = {
            "referenceCode": order.hazard_report.reference_code,
            "hazardClass": order.hazard_report.hazard_class,
            "address": order.hazard_report.address,
        }
    return WorkOrderOut(
        id=order.id,
        code=order.code,
        title=order.title,
        description=order.description,
        status=order.status,  # type: ignore[arg-type]
        priority=order.priority,
        band=order.band,  # type: ignore[arg-type]
        hazardReportId=order.hazard_report_id,
        hazard=hazard,
        clusterId=order.cluster_id,
        assignedTo=order.assigned_to,
        scheduledFor=order.scheduled_for.isoformat() if order.scheduled_for else None,
        createdAt=order.created_at.isoformat(),
        updates=[
            {
                "id": u.id,
                "fromStatus": u.from_status,
                "toStatus": u.to_status,
                "note": u.note,
                "author": u.author_id,
                "createdAt": u.created_at.isoformat(),
            }
            for u in order.updates
        ],
    )


def _load_order(db: Session, order_id: str) -> WorkOrder | None:
    stmt = (
        select(WorkOrder)
        .where(WorkOrder.id == order_id)
        .options(selectinload(WorkOrder.updates), selectinload(WorkOrder.hazard_report))
    )
    return db.execute(stmt).scalar_one_or_none()


@router.get("", response_model=WorkOrderListOut, summary="List work orders (priority desc)")
def list_orders(
    _user: CurrentUser,
    db: Session = Depends(get_db),
    statusFilter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=300, ge=1, le=1000),
) -> WorkOrderListOut:
    stmt = (
        select(WorkOrder)
        .options(selectinload(WorkOrder.updates), selectinload(WorkOrder.hazard_report))
        .order_by(WorkOrder.priority.desc(), WorkOrder.created_at.desc())
        .limit(limit)
    )
    if statusFilter:
        if statusFilter not in WO_STATUSES:
            raise HTTPException(status_code=400, detail={"error": f"status must be one of: {', '.join(WO_STATUSES)}"})
        stmt = stmt.where(WorkOrder.status == statusFilter)
    orders = db.execute(stmt).scalars().unique().all()
    return WorkOrderListOut(items=[_serialize(o) for o in orders], count=len(orders))


@router.post(
    "",
    response_model=dict,
    status_code=status.HTTP_201_CREATED,
    summary="Admin: open a work order (optionally linked to a hazard)",
    responses={
        400: {"model": dict, "description": "Title validation"},
        403: {"model": dict, "description": "Admin only"},
        404: {"model": dict, "description": "Hazard not found"},
        409: {"model": dict, "description": "Merged/rejected hazard or duplicate work order"},
    },
)
def create_order(payload: WorkOrderCreateIn, request: Request, admin: AdminUser, db: Session = Depends(get_db)) -> dict:
    if not payload.title or len(payload.title.strip()) < 4:
        raise HTTPException(status_code=400, detail={"error": "A descriptive title (min 4 characters) is required"})

    hazard: HazardReport | None = None
    if payload.hazardReportId:
        hazard = load_report(db, payload.hazardReportId)
        if hazard is None:
            raise HTTPException(status_code=404, detail={"error": "Hazard not found"})
        if hazard.status in ("MERGED", "REJECTED"):
            raise HTTPException(status_code=409, detail={"error": "Cannot open a work order against a merged or rejected hazard"})
        existing = db.execute(select(WorkOrder.id).where(WorkOrder.hazard_report_id == hazard.id)).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail={"error": "A work order already exists for this hazard"})

    count = db.execute(select(func.count()).select_from(WorkOrder)).scalar_one()
    code = f"WO-{int(count or 0) + 1:04d}"
    ps: PriorityScore | None = hazard.priority_score if hazard else None
    priority = ps.score if ps is not None else 0.0
    band = ps.band if ps is not None else "MEDIUM"

    order = WorkOrder(
        code=code,
        title=payload.title.strip()[:160],
        description=payload.description,
        status="REPORTED",
        priority=priority,
        band=band,
        hazard_report_id=hazard.id if hazard else None,
        cluster_id=payload.clusterId or (hazard.cluster_id if hazard else None),
        assigned_to=payload.assignedTo,
        scheduled_for=payload.scheduledFor,
        created_by=admin.id,
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(order)
    db.flush()
    db.add(
        WorkOrderUpdate(
            work_order_id=order.id,
            author_id=admin.id,
            from_status=None,
            to_status="REPORTED",
            note="Work order created",
            created_at=utcnow(),
        )
    )
    if hazard and hazard.user_id:
        notify(
            db,
            user_id=hazard.user_id,
            type="WORK_ORDER",
            title=f"Repair work order {code} opened",
            body=f"Your report {hazard.reference_code} moved into the maintenance pipeline.",
            link="#/dashboard",
        )
    write_audit(
        db,
        action="work_order.create",
        entity_type="work_order",
        entity_id=order.id,
        actor_id=admin.id,
        actor_email=admin.email,
        actor_role=admin.role,
        metadata={"code": code, "hazardReportId": hazard.id if hazard else None},
        ip=client_ip(request),
    )
    db.commit()
    return {"id": order.id, "code": order.code}


@router.get("/{order_id}", response_model=WorkOrderOut, summary="Work order detail")
def get_order(order_id: str, _user: CurrentUser, db: Session = Depends(get_db)) -> WorkOrderOut:
    order = _load_order(db, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail={"error": "Work order not found"})
    return _serialize(order)


@router.patch(
    "/{order_id}",
    response_model=dict,
    summary="Admin: transition status (+note/assignee/schedule) — writes update row + notification",
    responses={
        400: {"model": dict, "description": "Invalid status"},
        403: {"model": dict, "description": "Admin only"},
        404: {"model": dict, "description": "Work order not found"},
    },
)
def patch_order(
    order_id: str,
    payload: WorkOrderPatchIn,
    request: Request,
    admin: AdminUser,
    db: Session = Depends(get_db),
) -> dict:
    order = _load_order(db, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail={"error": "Work order not found"})
    if payload.status is not None and payload.status not in WO_STATUSES:
        raise HTTPException(status_code=400, detail={"error": f"status must be one of: {', '.join(WO_STATUSES)}"})

    from_status = order.status
    if payload.status is not None:
        order.status = payload.status
    if payload.assignedTo is not None:
        order.assigned_to = payload.assignedTo
    if payload.scheduledFor is not None:
        order.scheduled_for = payload.scheduledFor
    order.updated_at = utcnow()
    db.flush()

    db.add(
        WorkOrderUpdate(
            work_order_id=order.id,
            author_id=admin.id,
            from_status=from_status,
            to_status=order.status,
            note=payload.note,
            created_at=utcnow(),
        )
    )

    hazard = order.hazard_report
    if hazard is not None and hazard.user_id:
        notify(
            db,
            user_id=hazard.user_id,
            type="WORK_ORDER",
            title=f"{order.code} → {(order.status or '').replace('_', ' ').lower()}",
            body=payload.note or f"Maintenance status updated for report {hazard.reference_code}.",
            link="#/dashboard",
        )
    if order.hazard_report_id:
        recompute_priority_for_report(db, order.hazard_report_id)

    write_audit(
        db,
        action="work_order.update",
        entity_type="work_order",
        entity_id=order.id,
        actor_id=admin.id,
        actor_email=admin.email,
        actor_role=admin.role,
        metadata={"code": order.code, "from": from_status, "to": order.status, "note": payload.note},
        ip=client_ip(request),
    )
    db.commit()
    return {"ok": True, "status": order.status}
