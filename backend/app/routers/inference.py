"""Inference router — image detection (sync) and video jobs (async, Celery)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import Detection, InferenceJob, MediaAsset, utcnow
from app.schemas.inference import InferenceIn, InferenceJobOut, InferenceOut
from app.services.audit import client_ip, write_audit
from app.services.inference import run_image_inference
from app.services.media import get_storage
from app.services.security import OptionalUser

logger = logging.getLogger("roadguard.inference")

router = APIRouter(prefix="/inference", tags=["inference"])


@router.post(
    "",
    response_model=InferenceOut,
    summary="Run the detection engine chain on a stored media asset",
    responses={
        400: {"model": dict, "description": "mediaId required"},
        404: {"model": dict, "description": "Media not found — upload first via POST /uploads"},
        409: {"model": dict, "description": "Media already attached to a report"},
        202: {"model": dict, "description": "Video accepted → async job (poll GET /inference/jobs/{id})"},
    },
)
def run_inference(
    payload: InferenceIn,
    request: Request,
    db: Session = Depends(get_db),
    user: OptionalUser = None,
) -> InferenceOut:
    media = db.get(MediaAsset, payload.mediaId)
    if media is None:
        raise HTTPException(
            status_code=404, detail={"error": "Media not found — upload first via /uploads"}
        )
    if media.report_id:
        raise HTTPException(status_code=409, detail={"error": "Media is already attached to a report"})

    if media.mime_type.startswith("video/"):
        job = InferenceJob(media_id=media.id, status="QUEUED", engine="demo-engine-v2", created_at=utcnow())
        db.add(job)
        db.flush()
        write_audit(
            db,
            action="inference.video_job",
            entity_type="inference_job",
            entity_id=job.id,
            actor_id=user.id if user else None,
            metadata={"mediaId": media.id},
            ip=client_ip(request),
        )
        db.commit()
        # Celery task — eager mode (tests/dev) runs inline; otherwise the worker picks it up.
        from app.worker.tasks import process_video_inference

        try:
            process_video_inference.delay(media.id)
        except Exception as exc:  # noqa: BLE001 — broker unreachable: job stays QUEUED for the worker
            logger.warning("Celery broker unavailable (%s); job %s remains queued", exc, job.id)
        return InferenceOut(mediaId=media.id, engine=job.engine, modelVersion=settings.INFERENCE_MODEL_VERSION, jobId=job.id)

    # synchronous image path
    storage = get_storage()
    try:
        data = storage.open(media.storage_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"error": "Media file missing from storage"}) from exc

    result = run_image_inference(data, media.mime_type)
    rows: list[Detection] = []
    for det in result["detections"]:
        row = Detection(
            model_version=result["modelVersion"],
            engine=result["engine"],
            hazard_class=det["hazardClass"],
            confidence=det["confidence"],
            bbox_x=det["bbox"][0],
            bbox_y=det["bbox"][1],
            bbox_w=det["bbox"][2],
            bbox_h=det["bbox"][3],
            area_ratio=det["areaRatio"],
            severity=det["severity"],
            inference_ms=result["inferenceMs"],
        )
        db.add(row)
        rows.append(row)
    db.flush()
    write_audit(
        db,
        action="inference.image",
        entity_type="media_asset",
        entity_id=media.id,
        actor_id=user.id if user else None,
        metadata={"engine": result["engine"], "detections": len(rows), "inferenceMs": result["inferenceMs"]},
        ip=client_ip(request),
    )
    db.commit()
    return InferenceOut(
        mediaId=media.id,
        engine=result["engine"],
        modelVersion=result["modelVersion"],
        inferenceMs=result["inferenceMs"],
        detections=[
            {
                "id": row.id,
                "hazardClass": row.hazard_class,
                "confidence": row.confidence,
                "bbox": (row.bbox_x, row.bbox_y, row.bbox_w, row.bbox_h),
                "areaRatio": row.area_ratio,
                "severity": row.severity,
                "engine": row.engine,
                "modelVersion": row.model_version,
            }
            for row in rows
        ],
        annotatedMediaId=result.get("annotatedMediaId"),
    )


@router.get("/jobs/{job_id}", response_model=InferenceJobOut, summary="Poll a video inference job")
def get_job(job_id: str, db: Session = Depends(get_db)) -> InferenceJobOut:
    job = db.get(InferenceJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"error": "Inference job not found"})
    result = None
    if job.result_json:
        import json

        try:
            result = json.loads(job.result_json)
        except ValueError:
            result = None
    return InferenceJobOut(
        id=job.id,
        mediaId=job.media_id,
        status=job.status,
        engine=job.engine,
        progress=job.progress,
        framesTotal=job.frames_total,
        framesDone=job.frames_done,
        result=result,
        error=job.error,
        createdAt=job.created_at.isoformat(),
    )
