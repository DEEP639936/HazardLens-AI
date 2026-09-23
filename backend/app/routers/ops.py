"""Ops endpoints — /health (liveness/readiness) and /metrics (Prometheus text)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db

router = APIRouter(tags=["ops"])

# Dedicated registry so uvicorn's default process metrics are not duplicated.
REGISTRY = CollectorRegistry(auto_describe=True)

REPORTS_SUBMITTED = Counter(
    "roadguard_reports_submitted_total", "Hazard reports submitted", ["hazard_class"], registry=REGISTRY
)
REVIEWS = Counter(
    "roadguard_reviews_total", "Review actions", ["action"], registry=REGISTRY
)
INFERENCE_LATENCY = Histogram(
    "roadguard_inference_seconds", "Image inference latency (seconds)", registry=REGISTRY
)
INFERENCE_DETECTIONS = Counter(
    "roadguard_inference_detections_total", "Detections persisted", ["engine"], registry=REGISTRY
)
ACTIVE_JOBS = Gauge(
    "roadguard_inference_jobs_active", "Inference jobs currently queued/running", registry=REGISTRY
)
DB_UP = Gauge("roadguard_db_up", "Database reachable", registry=REGISTRY)

OPERATIONS_INFO = Gauge("roadguard_build_info", "Build metadata", ["version", "env"], registry=REGISTRY)
OPERATIONS_INFO.labels(version=settings.APP_VERSION, env=settings.ENV).set(1)


@router.get("/health", summary="Liveness + DB readiness probe")
def health(db: Session = Depends(get_db)) -> dict:
    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False
    DB_UP.set(1 if db_ok else 0)
    return {
        "status": "ok" if db_ok else "degraded",
        "service": "roadguard-atlas-api",
        "version": settings.APP_VERSION,
        "env": settings.ENV,
        "database": "up" if db_ok else "down",
        "mediaBackend": settings.MEDIA_BACKEND,
        "inferenceService": settings.INFERENCE_SERVICE_URL,
    }


@router.get("/metrics", summary="Prometheus metrics (text/plain)", response_class=Response)
def metrics() -> Response:
    payload = generate_latest(REGISTRY)
    return Response(content=payload, media_type=CONTENT_TYPE_LATEST)
