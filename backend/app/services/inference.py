"""Inference engine chain (parity with src/lib/rg/inference.ts semantics).

Image path (synchronous):
  1. YOLO micro-service at INFERENCE_SERVICE_URL (POST /predict, multipart image)
     — the production engine trained in ml/ (see ml/README.md).
  2. Deterministic demo engine fallback — byte-hash-derived but stable
     detections, so the flow never hard-fails while the service is offline.

Video path (asynchronous): an InferenceJob row is created by the router; the
Celery task `worker.tasks.process_video_inference` samples frames with ffmpeg
and runs the same engine chain per frame, storing detections + annotated frames.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import httpx

from app.config import settings
from app.services.severity import area_ratio_of, severity_from_detection

logger = logging.getLogger("roadguard.inference")

HAZARD_CLASSES: tuple[str, ...] = (
    "pothole",
    "crack",
    "erosion",
    "waterlogging",
    "marking",
    "debris",
    "edge_damage",
)

DEMO_MODEL_VERSION = "roadguard-yolo-v11n-v2"


def _clamp01(v: float) -> float:
    return min(1.0, max(0.0, v))


def run_demo_engine(data: bytes, mime: str) -> dict[str, Any]:
    """Deterministic fallback: derives pseudo-detections from a SHA-256 of the bytes.

    Stable for identical inputs (same bytes → same detections), varied across
    files — good enough to exercise the full report → review → prioritize flow.
    """
    digest = hashlib.sha256(data).digest()
    seed = int.from_bytes(digest[:8], "big")
    count = 1 + (seed % 3)  # 1..3 detections
    detections: list[dict[str, Any]] = []
    for i in range(count):
        chunk = digest[(i * 8 + 8) % 56 : (i * 8 + 16) % 56] or digest[:8]
        s = int.from_bytes(chunk, "big")
        confidence = round(_clamp01(0.55 + (s % 4000) / 10000), 4)  # 0.55..0.94
        w = round(0.10 + (s >> 3) % 2200 / 10000, 4)  # 0.10..0.32
        h = round(0.08 + (s >> 5) % 1800 / 10000, 4)  # 0.08..0.26
        x = round(_clamp01(0.05 + (s >> 7) % 6000 / 10000 * (1 - w)), 4)
        y = round(_clamp01(0.05 + (s >> 9) % 6000 / 10000 * (1 - h)), 4)
        hazard_class = HAZARD_CLASSES[(s >> 2) % len(HAZARD_CLASSES)]
        area = area_ratio_of((x, y, w, h))
        detections.append(
            {
                "hazardClass": hazard_class,
                "confidence": confidence,
                "bbox": [x, y, w, h],
                "areaRatio": area,
                "severity": severity_from_detection(hazard_class, confidence, area),
            }
        )
    return {
        "engine": "demo-engine-v2",
        "modelVersion": DEMO_MODEL_VERSION,
        "detections": detections,
        "annotatedMediaId": None,
    }


def run_yolo_service(data: bytes, mime: str) -> dict[str, Any] | None:
    """Call the YOLO inference micro-service. Returns None when unavailable."""
    url = settings.INFERENCE_SERVICE_URL.rstrip("/")
    try:
        with httpx.Client(timeout=settings.INFERENCE_TIMEOUT_SECONDS) as client:
            resp = client.post(
                f"{url}/predict",
                files={"file": ("upload.bin", data, mime)},
                data={"model_version": settings.INFERENCE_MODEL_VERSION},
            )
            resp.raise_for_status()
            payload = resp.json()
    except Exception as exc:  # noqa: BLE001 — any failure falls through to demo engine
        logger.info("YOLO service unavailable (%s) — falling back to demo engine", exc)
        return None

    detections: list[dict[str, Any]] = []
    for det in payload.get("detections", []):
        try:
            bbox = det.get("bbox") or det.get("bbox_xywh") or [0, 0, 0, 0]
            hazard_class = det.get("hazardClass") or det.get("class") or "pothole"
            if hazard_class not in HAZARD_CLASSES:  # tolerate open-set labels
                hazard_class = HAZARD_CLASSES[int(hashlib.sha256(str(hazard_class).encode()).hexdigest(), 16) % len(HAZARD_CLASSES)]
            confidence = _clamp01(float(det.get("confidence", 0.5)))
            x, y, w, h = (min(1.0, max(0.0, float(v))) for v in bbox[:4])
            area = area_ratio_of((x, y, w, h))
            detections.append(
                {
                    "hazardClass": hazard_class,
                    "confidence": confidence,
                    "bbox": [x, y, w, h],
                    "areaRatio": area,
                    "severity": severity_from_detection(hazard_class, confidence, area),
                }
            )
        except (TypeError, ValueError, KeyError):
            continue
    if not detections:
        return None
    return {
        "engine": payload.get("engine", "yolo-service"),
        "modelVersion": payload.get("modelVersion", settings.INFERENCE_MODEL_VERSION),
        "detections": detections,
        "annotatedMediaId": payload.get("annotatedMediaId"),
    }


def run_image_inference(data: bytes, mime: str) -> dict[str, Any]:
    """Engine chain for a single image; always returns engine metadata + detections."""
    started = time.perf_counter()
    result = run_yolo_service(data, mime) or run_demo_engine(data, mime)
    result["inferenceMs"] = int((time.perf_counter() - started) * 1000)
    return result
