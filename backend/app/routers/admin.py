"""Admin router — overview KPIs, audit logs, settings, model versions.

The whole router is ADMIN-only (router-level dependency)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import (
    AuditLog,
    HazardCluster,
    HazardReport,
    ModelVersion,
    User,
    WorkOrder,
    utcnow,
)
from app.schemas.admin import (
    AdminOverviewOut,
    AuditLogListOut,
    AuditLogOut,
    ModelVersionIn,
    ModelVersionOut,
    SettingsOut,
    SettingsPatchIn,
    PriorityWeightsIn,
    ClusterParams,
)
from app.services.audit import write_audit
from app.services.hazards import ACTIONABLE_STATUSES
from app.services.security import AdminUser, require_admin
from app.services.settings import WeightsDoNotSumToOne, get_settings, put_settings

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/overview", response_model=AdminOverviewOut, summary="Admin command-center KPIs")
def overview(db: Session = Depends(get_db)) -> AdminOverviewOut:
    status_counts: dict[str, int] = {}
    for row in db.execute(
        select(HazardReport.status, func.count()).group_by(HazardReport.status)
    ).all():
        status_counts[row[0]] = int(row[1])
    total_reports = sum(status_counts.values())

    wo_counts: dict[str, int] = {}
    for row in db.execute(select(WorkOrder.status, func.count()).group_by(WorkOrder.status)).all():
        wo_counts[row[0]] = int(row[1])

    users_count = db.execute(select(func.count()).select_from(User)).scalar_one()
    clusters_count = db.execute(select(func.count()).select_from(HazardCluster)).scalar_one()
    audit_count = db.execute(select(func.count()).select_from(AuditLog)).scalar_one()

    # top wards by actionable reports
    ward_rows = db.execute(
        select(HazardReport.ward, func.count())
        .where(HazardReport.status.in_(ACTIONABLE_STATUSES), HazardReport.duplicate_of_id.is_(None))
        .group_by(HazardReport.ward)
        .order_by(func.count().desc())
        .limit(5)
    ).all()

    oldest_pending = db.execute(
        select(func.min(HazardReport.created_at)).where(HazardReport.status == "PENDING_REVIEW")
    ).scalar_one_or_none()
    oldest_days = 0.0
    if oldest_pending is not None:
        oldest_days = round((utcnow() - oldest_pending).total_seconds() / 86400, 1)

    pending_critical = db.execute(
        select(func.count())
        .select_from(PriorityScore)
        .where(
            PriorityScore.band == "CRITICAL",
            PriorityScore.report_id.in_(
                select(HazardReport.id).where(HazardReport.status == "PENDING_REVIEW")
            ),
        )
    ).scalar_one()

    return AdminOverviewOut(
        users=int(users_count or 0),
        reports={
            "total": total_reports,
            "pending": status_counts.get("PENDING_REVIEW", 0),
            "approved": status_counts.get("APPROVED", 0),
            "rejected": status_counts.get("REJECTED", 0),
            "merged": status_counts.get("MERGED", 0),
            "flagged": status_counts.get("FLAGGED", 0),
        },
        clusters=int(clusters_count or 0),
        workOrders={
            "total": sum(wo_counts.values()),
            "open": sum(v for k, v in wo_counts.items() if k != "RESOLVED"),
            "resolved": wo_counts.get("RESOLVED", 0),
        },
        auditEvents=int(audit_count or 0),
        topWards=[{"ward": w or "Unassigned", "count": int(c)} for w, c in ward_rows],
        queue={
            "criticalPending": int(pending_critical or 0),
            "oldestPendingDays": oldest_days,
        },
    )


@router.get("/audit-logs", response_model=AuditLogListOut, summary="Audit trail (newest first)")
def audit_logs(
    db: Session = Depends(get_db),
    action: str | None = Query(default=None, description="Exact action filter, e.g. review.approve"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> AuditLogListOut:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    rows = db.execute(stmt).scalars().all()
    return AuditLogListOut(
        items=[
            AuditLogOut(
                id=row.id,
                actorEmail=row.actor_email,
                actorRole=row.actor_role,
                action=row.action,
                entityType=row.entity_type,
                entityId=row.entity_id,
                metadataJson=row.metadata_json,
                ip=row.ip,
                createdAt=row.created_at.isoformat(),
            )
            for row in rows
        ],
        count=len(rows),
    )


@router.get("/settings", response_model=SettingsOut, summary="System settings (weights, cluster params, autoRecompute)")
def get_system_settings(db: Session = Depends(get_db)) -> SettingsOut:
    bundle = get_settings(db)
    return SettingsOut(
        weights=PriorityWeightsIn(**bundle["weights"]),
        cluster=ClusterParams(**bundle["cluster"]),
        autoRecompute=bundle["autoRecompute"],
    )


@router.put("/settings", response_model=SettingsOut, summary="Update system settings (weights must sum to 1)")
def put_system_settings(payload: SettingsPatchIn, admin: AdminUser, db: Session = Depends(get_db)) -> SettingsOut:
    patch = payload.model_dump(exclude_none=True)
    try:
        bundle = put_settings(db, patch)
    except WeightsDoNotSumToOne as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
    write_audit(
        db,
        action="admin.settings_update",
        entity_type="system_setting",
        actor_id=admin.id,
        actor_email=admin.email,
        actor_role=admin.role,
        metadata={"keys": list(patch.keys()), **{k: v for k, v in patch.items() if k != "weights"}},
    )
    db.commit()
    return SettingsOut(
        weights=PriorityWeightsIn(**bundle["weights"]),
        cluster=ClusterParams(**bundle["cluster"]),
        autoRecompute=bundle["autoRecompute"],
    )


@router.get("/model-versions", response_model=list[ModelVersionOut], summary="Registered model versions")
def list_model_versions(db: Session = Depends(get_db)) -> list[ModelVersionOut]:
    rows = db.execute(select(ModelVersion).order_by(ModelVersion.registered_at.desc())).scalars().all()
    return [
        ModelVersionOut(
            id=m.id,
            version=m.version,
            framework=m.framework,
            weightsRef=m.weights_ref,
            map50=m.map50,
            map5095=m.map50_95,
            precision=m.precision,
            recall=m.recall,
            latencyMs=m.latency_ms,
            datasetRef=m.dataset_ref,
            mlflowRunId=m.mlflow_run_id,
            notes=m.notes,
            registeredAt=m.registered_at.isoformat(),
        )
        for m in rows
    ]


@router.post(
    "/model-versions",
    response_model=ModelVersionOut,
    status_code=201,
    summary="Admin: register a model version (MLflow metadata)",
    responses={409: {"model": dict, "description": "Version already registered"}},
)
def add_model_version(payload: ModelVersionIn, admin: AdminUser, db: Session = Depends(get_db)) -> ModelVersionOut:
    existing = db.execute(select(ModelVersion).where(ModelVersion.version == payload.version)).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail={"error": f"Model version {payload.version} already registered"})
    m = ModelVersion(
        version=payload.version,
        framework=payload.framework,
        weights_ref=payload.weightsRef,
        map50=payload.map50,
        map50_95=payload.map5095,
        precision=payload.precision,
        recall=payload.recall,
        latency_ms=payload.latencyMs,
        dataset_ref=payload.datasetRef,
        mlflow_run_id=payload.mlflowRunId,
        notes=payload.notes,
        registered_at=utcnow(),
    )
    db.add(m)
    db.flush()
    write_audit(
        db,
        action="admin.model_version_register",
        entity_type="model_version",
        entity_id=m.id,
        actor_id=admin.id,
        actor_email=admin.email,
        actor_role=admin.role,
        metadata={"version": m.version, "framework": m.framework, "mlflowRunId": m.mlflow_run_id},
    )
    db.commit()
    return ModelVersionOut(
        id=m.id,
        version=m.version,
        framework=m.framework,
        weightsRef=m.weights_ref,
        map50=m.map50,
        map5095=m.map50_95,
        precision=m.precision,
        recall=m.recall,
        latencyMs=m.latency_ms,
        datasetRef=m.dataset_ref,
        mlflowRunId=m.mlflow_run_id,
        notes=m.notes,
        registeredAt=m.registered_at.isoformat(),
    )
