"""Celery tasks: video inference pipeline + cluster recomputation.

`process_video_inference(media_id)`:
  ffmpeg samples frames (1 fps, capped) → each frame runs the engine chain →
  detections are persisted (linked to the media's future report), sampled frames
  are stored as FRAME media assets → job progress/result updated at every step.

`recompute_clusters_task(bbox, since_days, eps_m, min_pts)`:
  DBSCAN recompute off the request path (admin console / nightly beat).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from typing import Any

from app.config import settings
from app.models import Detection, HazardReport, InferenceJob, MediaAsset, utcnow
from app.services.inference import run_image_inference
from app.worker.celery_app import celery_app

logger = logging.getLogger("roadguard.worker")

FRAME_FPS = 1.0  # 1 frame per second
MAX_FRAMES = 120  # safety cap for long clips
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


def _session():
    from app.db import SessionLocal

    return SessionLocal()


@celery_app.task(name="process_video_inference", bind=True, max_retries=2, default_retry_delay=30)
def process_video_inference(self, media_id: str) -> dict[str, Any]:  # noqa: ANN001
    """Sample a stored video with ffmpeg and run the engine chain per frame."""
    db = _session()
    tmp_dir: str | None = None
    try:
        job = db.query(InferenceJob).filter(InferenceJob.media_id == media_id).order_by(InferenceJob.created_at.desc()).first()
        media = db.get(MediaAsset, media_id)
        if job is None or media is None:
            raise RuntimeError(f"inference job/media {media_id} not found")

        job.status = "RUNNING"
        job.updated_at = utcnow()
        db.commit()

        from app.services.media import get_storage

        storage = get_storage()
        video_bytes = storage.open(media.storage_path)

        tmp_dir = tempfile.mkdtemp(prefix="rg-video-")
        src = os.path.join(tmp_dir, "input" + (os.path.splitext(media.storage_path)[1] or ".mp4"))
        with open(src, "wb") as fh:
            fh.write(video_bytes)
        frames_dir = os.path.join(tmp_dir, "frames")
        os.makedirs(frames_dir, exist_ok=True)

        # 1. sample frames: -vf fps=1, cap with -frames:v
        cmd = [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-i", src,
            "-vf", f"fps={FRAME_FPS}",
            "-frames:v", str(MAX_FRAMES),
            "-q:v", "3",
            os.path.join(frames_dir, "frame_%04d.jpg"),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=20 * 60)
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg is not installed on the worker image") from exc
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"ffmpeg failed: {exc.stderr.decode(errors='ignore')[:500]}") from exc

        frame_paths = sorted(os.listdir(frames_dir))
        job.frames_total = len(frame_paths)
        job.frames_done = 0
        db.commit()

        # 2. run the engine chain per frame, persist detections + FRAME assets
        all_detections: list[dict[str, Any]] = []
        engine, model_version, total_ms = "demo-engine-v2", settings.INFERENCE_MODEL_VERSION, 0
        for idx, name in enumerate(frame_paths):
            with open(os.path.join(frames_dir, name), "rb") as fh:
                frame_bytes = fh.read()
            result = run_image_inference(frame_bytes, "image/jpeg")
            engine, model_version = result["engine"], result["modelVersion"]
            total_ms += result["inferenceMs"]
            for det in result["detections"]:
                all_detections.append({**det, "frameIndex": idx})
            # store sampled frame (downscaled evidence)
            frame_asset = MediaAsset(
                kind="FRAME",
                storage_path=storage.save(frame_bytes, "jpg"),
                mime_type="image/jpeg",
                size_bytes=len(frame_bytes),
                report_id=None,
                created_at=utcnow(),
            )
            db.add(frame_asset)
            job.frames_done = idx + 1
            job.progress = round((idx + 1) / max(1, len(frame_paths)), 3)
            db.commit()

        # 3. persist detections (unattached — linked to a report at submission)
        for det in all_detections:
            db.add(
                Detection(
                    report_id=None,
                    model_version=model_version,
                    engine=engine,
                    hazard_class=det["hazardClass"],
                    confidence=det["confidence"],
                    bbox_x=det["bbox"][0],
                    bbox_y=det["bbox"][1],
                    bbox_w=det["bbox"][2],
                    bbox_h=det["bbox"][3],
                    area_ratio=det["areaRatio"],
                    severity=det["severity"],
                    inference_ms=total_ms // max(1, len(frame_paths)),
                )
            )

        job.status = "SUCCEEDED"
        job.progress = 1.0
        job.result_json = json.dumps(
            {
                "engine": engine,
                "modelVersion": model_version,
                "frames": len(frame_paths),
                "detections": all_detections,
                "totalInferenceMs": total_ms,
            }
        )
        job.updated_at = utcnow()
        db.commit()
        return {"jobId": job.id, "detections": len(all_detections)}

    except Exception as exc:  # noqa: BLE001 — job must always terminate with a state
        db.rollback()
        job = db.query(InferenceJob).filter(InferenceJob.media_id == media_id).order_by(InferenceJob.created_at.desc()).first()
        if job is not None:
            job.status = "FAILED"
            job.error = str(exc)[:2000]
            job.updated_at = utcnow()
            db.commit()
        logger.exception("process_video_inference failed for media %s", media_id)
        try:
            raise self.retry(exc=exc)
        except self.MaxRetriesExceededError:
            return {"jobId": media_id, "error": str(exc)}
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
    finally:
        db.close()


@celery_app.task(name="recompute_clusters")
def recompute_clusters_task(
    bbox: dict[str, float] | None = None,
    since_days: int | None = None,
    eps_m: float | None = None,
    min_pts: int | None = None,
) -> dict[str, Any]:
    """Off-request-path DBSCAN recompute (admin console / scheduled beat)."""
    db = _session()
    try:
        from app.services.hazards import recompute_clusters

        summary = recompute_clusters(db, bbox=bbox, since_days=since_days, eps_m=eps_m, min_pts=min_pts)
        db.commit()
        return summary
    finally:
        db.close()


@celery_app.task(name="refresh_priorities")
def refresh_priorities_task() -> dict[str, Any]:
    """Recompute priority scores for all actionable reports (nightly beat)."""
    db = _session()
    try:
        from sqlalchemy import select

        from app.services.hazards import recompute_priority_for_report

        reports = db.execute(
            select(HazardReport.id).where(
                HazardReport.status.in_(("PENDING_REVIEW", "APPROVED", "FLAGGED")),
                HazardReport.duplicate_of_id.is_(None),
            )
        ).scalars().all()
        for report_id in reports:
            recompute_priority_for_report(db, report_id)
        db.commit()
        return {"recomputed": len(reports)}
    finally:
        db.close()


__all__ = ["celery_app", "process_video_inference", "recompute_clusters_task", "refresh_priorities_task"]
