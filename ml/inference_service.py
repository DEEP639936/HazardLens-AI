#!/usr/bin/env python3
"""RoadGuard Atlas — FastAPI inference service (YOLO .pt or ONNX).

Endpoints (no /api prefix — the live Next.js app and the production backend
proxy these under `/api/inference` and `/api/inference/jobs`; document any
custom mount in your gateway):

* ``POST /infer``       — multipart image (jpeg/png/webp) → detections
* ``POST /infer_video`` — multipart video (mp4/webm/mov) → ffmpeg frame
  sampling → per-frame detections + aggregate summary
* ``GET  /health``      — liveness + engine/model metadata

Both POST endpoints accept ``?blur=true`` to apply privacy blur before
inference: OpenCV Haar-cascade face blur + Haar-cascade number-plate blur
(models shipped with opencv-python; regions are Gaussian-blurred, images are
never persisted by this service).

Engine selection: ``MODEL_PATH`` (Ultralytics .pt) wins; otherwise
``ONNX_PATH`` is served through an ONNXRuntime session. Geometry (letterbox,
color 114, xyxy↔normalized xywh mapping) is shared with ``export_onnx.py`` via
``vision_utils`` so .pt and .onnx produce aligned boxes.

Environment (see ml/.env.example):
    MODEL_PATH, ONNX_PATH, DEVICE, CONF_THRESHOLD=0.25, IOU_NMS=0.45,
    IMG_SIZE=640, MAX_IMAGE_SIDE=1280, VIDEO_SAMPLE_FPS=2, VIDEO_MAX_FRAMES=300,
    MODEL_VERSION (optional explicit tag, else weights sha256[:12])

Run:  python3 inference_service.py --host 0.0.0.0 --port 8000
      (Dockerfile ships the same entry; `make serve` wraps it)
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hazard_domain import (  # noqa: E402
    HAZARD_CLASSES,
    NUM_CLASSES,
    detections_severity,
)
from vision_utils import (  # noqa: E402
    boxes_to_normalized_xywh,
    decode_onnx_detections,
    letterbox,
    scale_boxes_back,
)

ML_DIR = Path(__file__).resolve().parent

try:  # optional .env loading for local runs
    from dotenv import load_dotenv

    load_dotenv(ML_DIR / ".env")
    load_dotenv(ML_DIR.parent / ".env")
except Exception:  # noqa: BLE001 — dotenv is optional
    pass

from fastapi import FastAPI, File, HTTPException, Query, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------
MODEL_PATH = os.environ.get("MODEL_PATH", str(ML_DIR / "models" / "best.pt"))
ONNX_PATH = os.environ.get("ONNX_PATH", "")
DEVICE = os.environ.get("DEVICE", "cpu")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.25"))
IOU_NMS = float(os.environ.get("IOU_NMS", "0.45"))
IMG_SIZE = int(os.environ.get("IMG_SIZE", "640"))
MAX_IMAGE_SIDE = int(os.environ.get("MAX_IMAGE_SIDE", "1280"))
VIDEO_SAMPLE_FPS = float(os.environ.get("VIDEO_SAMPLE_FPS", "2"))
VIDEO_MAX_FRAMES = int(os.environ.get("VIDEO_MAX_FRAMES", "300"))
MODEL_VERSION_ENV = os.environ.get("MODEL_VERSION", "")

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime", "video/x-m4v"}
IMAGE_BYTES_LIMIT = 12 * 1024 * 1024   # mirrors src/lib/rg/constants.ts MEDIA_LIMITS
VIDEO_BYTES_LIMIT = 60 * 1024 * 1024


# ---------------------------------------------------------------------------
# Detector engines
# ---------------------------------------------------------------------------
def _file_sha256_short(path: Path, n: int = 12) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:n]


class HazardDetector:
    """Uniform detection interface over Ultralytics .pt and ONNXRuntime .onnx."""

    def __init__(self, model_path: str, onnx_path: str, device: str,
                 conf: float, iou: float, imgsz: int):
        self.device = device
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        self._pt = None
        self._ort = None
        self._ort_input = None
        self._ort_imgsz = imgsz
        self.model_version = MODEL_VERSION_ENV or "dev"

        weights = Path(model_path) if model_path else None
        if weights and weights.exists():
            from ultralytics import YOLO

            self._pt = YOLO(str(weights))
            self.engine = "yolo"
            self.model_version = MODEL_VERSION_ENV or _file_sha256_short(weights)
            print(f"[service] engine=yolo weights={weights}")
        elif onnx_path and Path(onnx_path).exists():
            import onnxruntime as ort

            self._ort = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            self._ort_input = self._ort.get_inputs()[0].name
            shape = self._ort.get_inputs()[0].shape  # e.g. [1, 3, 640, 640] or dynamic
            if isinstance(shape, list) and len(shape) == 4 and isinstance(shape[2], int):
                self._ort_imgsz = int(shape[2])
            self.engine = "onnx"
            self.model_version = MODEL_VERSION_ENV or _file_sha256_short(Path(onnx_path))
            print(f"[service] engine=onnx model={onnx_path} imgsz={self._ort_imgsz}")
        else:
            raise RuntimeError(
                f"No model available: MODEL_PATH={model_path!r} ONNX_PATH={onnx_path!r} — "
                "run `make train`/`make export` or set env vars (see ml/.env.example)."
            )

    def detect(self, img_bgr: np.ndarray) -> List[dict]:
        """Return normalized detections: {class, hazardClass, confidence, bbox{x,y,w,h}}."""
        h, w = img_bgr.shape[:2]
        if max(h, w) > MAX_IMAGE_SIDE:  # guard against huge inputs
            scale = MAX_IMAGE_SIDE / max(h, w)
            img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)))
            h, w = img_bgr.shape[:2]

        if self._pt is not None:
            res = self._pt.predict(img_bgr, imgsz=self.imgsz, conf=self.conf,
                                   iou=self.iou, device=self.device,
                                   verbose=False, save=False)[0]
            boxes_xyxy = res.boxes.xyxy.cpu().numpy() if len(res.boxes) else np.zeros((0, 4))
            scores = res.boxes.conf.cpu().numpy() if len(res.boxes) else np.zeros((0,))
            class_ids = res.boxes.cls.cpu().numpy().astype(np.int64) if len(res.boxes) else np.zeros((0,), np.int64)
        else:
            lb, scale, pad = letterbox(img_bgr, self._ort_imgsz)
            blob = lb[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
            blob = np.ascontiguousarray(blob[None])
            raw = self._ort.run(None, {self._ort_input: blob})[0]
            boxes_xyxy, scores, class_ids = decode_onnx_detections(
                raw, NUM_CLASSES, self.conf, self.iou, max_side=self._ort_imgsz)
            boxes_xyxy = scale_boxes_back(boxes_xyxy, scale, pad, img_bgr.shape[:2])

        norm = boxes_to_normalized_xywh(boxes_xyxy, (h, w))
        detections = []
        for box, score, cid in zip(norm, scores, class_ids):
            detections.append({
                "class": int(cid),
                "hazardClass": HAZARD_CLASSES[int(cid)] if 0 <= int(cid) < NUM_CLASSES else str(int(cid)),
                "confidence": round(float(score), 4),
                "bbox": {
                    "x": round(float(box[0]), 6),
                    "y": round(float(box[1]), 6),
                    "w": round(float(box[2]), 6),
                    "h": round(float(box[3]), 6),
                },
            })
        return detections


# ---------------------------------------------------------------------------
# Privacy blur (best-effort, Haar cascades shipped with OpenCV)
# ---------------------------------------------------------------------------
class PrivacyBlurrer:
    def __init__(self):
        self.face = None
        self.plate = None
        try:
            cascade_dir = cv2.data.haarcascades
            face_xml = Path(cascade_dir) / "haarcascade_frontalface_default.xml"
            plate_xml = Path(cascade_dir) / "haarcascade_russian_plate_number.xml"
            if face_xml.exists():
                self.face = cv2.CascadeClassifier(str(face_xml))
            if plate_xml.exists():
                self.plate = cv2.CascadeClassifier(str(plate_xml))
        except Exception:  # noqa: BLE001 — cv2.data may be absent
            pass
        self.enabled = (self.face is not None and not self.face.empty()) or \
                       (self.plate is not None and not self.plate.empty())

    def blur(self, img: np.ndarray) -> np.ndarray:
        out = img
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        for cascade, scale in ((self.face, 1.1), (self.plate, 1.05)):
            if cascade is None or cascade.empty():
                continue
            regions = cascade.detectMultiScale(gray, scaleFactor=scale, minNeighbors=5, minSize=(24, 24))
            for (x, y, w, h) in regions:
                x, y = max(0, x), max(0, y)
                roi = out[y : y + h, x : x + w]
                if roi.size:
                    out[y : y + h, x : x + w] = cv2.GaussianBlur(roi, (51, 51), 30)
        return out


# ---------------------------------------------------------------------------
# App + singletons (lazy so /health works even before weights exist)
# ---------------------------------------------------------------------------
app = FastAPI(
    title="RoadGuard Atlas — inference service",
    version="1.0.0",
    description="YOLOv8/ONNX road-hazard detection for hazard reports (images/video).",
)

_state: Dict[str, object] = {"detector": None, "blurrer": None, "error": None}


def get_detector() -> HazardDetector:
    if _state["detector"] is None:
        try:
            _state["detector"] = HazardDetector(
                MODEL_PATH, ONNX_PATH, DEVICE, CONF_THRESHOLD, IOU_NMS, IMG_SIZE
            )
            _state["error"] = None
        except Exception as exc:  # noqa: BLE001
            _state["error"] = str(exc)
            raise HTTPException(status_code=503, detail=f"model unavailable: {exc}")
    return _state["detector"]  # type: ignore[return-value]


def get_blurrer() -> PrivacyBlurrer:
    if _state["blurrer"] is None:
        _state["blurrer"] = PrivacyBlurrer()
    return _state["blurrer"]  # type: ignore[return-value]


def _decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=415, detail="unsupported or corrupt image")
    return img


def _infer_image_bytes(data: bytes, blur: bool) -> dict:
    t0 = time.perf_counter()
    img = _decode_image(data)
    h, w = img.shape[:2]
    if blur and get_blurrer().enabled:
        img = get_blurrer().blur(img)
    detector = get_detector()
    detections = detector.detect(img)
    detections_severity(detections)  # attaches severity + areaRatio (parity with the app)
    inference_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "model_version": detector.model_version,
        "engine": detector.engine,
        "device": detector.device,
        "inference_ms": round(inference_ms, 2),
        "image": {"width": w, "height": h},
        "detections": detections,
    }


@app.get("/health")
def health() -> JSONResponse:
    detector = _state.get("detector")
    body = {
        "status": "ok" if _state.get("error") is None or detector is not None else "degraded",
        "engine": getattr(detector, "engine", None),
        "model_version": getattr(detector, "model_version", None),
        "model_loaded": detector is not None,
        "device": DEVICE,
        "conf_threshold": CONF_THRESHOLD,
        "iou_nms": IOU_NMS,
        "imgsz": IMG_SIZE,
        "classes": list(HAZARD_CLASSES),
        "blur_available": bool(_state.get("blurrer") and _state["blurrer"].enabled) or None,
        "load_error": _state.get("error"),
    }
    return JSONResponse(status_code=200, content=body)


@app.post("/infer")
async def infer(
    file: UploadFile = File(..., description="image: jpeg/png/webp, <= 12 MB"),
    blur: bool = Query(False, description="apply face + plate privacy blur before inference"),
):
    if (file.content_type or "") not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail=f"content_type must be one of {sorted(ALLOWED_IMAGE_TYPES)}")
    data = await file.read()
    if len(data) > IMAGE_BYTES_LIMIT:
        raise HTTPException(status_code=413, detail="image exceeds 12 MB limit")
    return _infer_image_bytes(data, blur)


def _video_duration_sec(video_path: Path) -> Optional[float]:
    """Duration via ffprobe (used to estimate total frames); None on failure."""
    if shutil.which("ffprobe") is None:
        return None
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
            capture_output=True, text=True,
        )
        return float(proc.stdout.strip())
    except (ValueError, subprocess.SubprocessError):
        return None


def _ffmpeg_sample_frames(video_path: Path, out_dir: Path, fps: float, max_frames: int) -> List[Path]:
    """Extract up to `max_frames` JPEG frames at `fps` via ffmpeg."""
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(video_path),
        "-vf", f"fps={fps}", "-frames:v", str(max_frames), "-q:v", "3",
        str(out_dir / "frame_%05d.jpg"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(status_code=422, detail=f"ffmpeg failed: {proc.stderr.strip()[:400]}")
    return sorted(out_dir.glob("frame_*.jpg"))


@app.post("/infer_video")
async def infer_video(
    file: UploadFile = File(..., description="video: mp4/webm/mov, <= 60 MB"),
    blur: bool = Query(False, description="apply face + plate privacy blur to each frame"),
    fps: Optional[float] = Query(None, ge=0.1, le=30, description="sampling fps (default env VIDEO_SAMPLE_FPS)"),
):
    if (file.content_type or "") not in ALLOWED_VIDEO_TYPES:
        raise HTTPException(status_code=415, detail=f"content_type must be one of {sorted(ALLOWED_VIDEO_TYPES)}")
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=503, detail="ffmpeg not available in this environment")

    with tempfile.TemporaryDirectory(prefix="rg_video_") as tmp:
        tmp_path = Path(tmp)
        video_path = tmp_path / (Path(file.filename or "upload").name or "upload.mp4")
        total_bytes = 0
        with video_path.open("wb") as f:
            while chunk := await file.read(1 << 20):
                total_bytes += len(chunk)
                if total_bytes > VIDEO_BYTES_LIMIT:
                    raise HTTPException(status_code=413, detail="video exceeds 60 MB limit")
                f.write(chunk)

        t0 = time.perf_counter()
        duration = _video_duration_sec(video_path)
        sample_fps = fps or VIDEO_SAMPLE_FPS
        frames = _ffmpeg_sample_frames(video_path, tmp_path, sample_fps, VIDEO_MAX_FRAMES)
        detector = get_detector()
        per_frame = []
        counts: Dict[str, int] = {}
        max_sev: Dict[str, int] = {}
        total_inference_ms = 0.0
        for idx, frame_path in enumerate(frames):
            img = cv2.imread(str(frame_path))
            if img is None:
                continue
            if blur and get_blurrer().enabled:
                img = get_blurrer().blur(img)
            t_frame = time.perf_counter()
            dets = detector.detect(img)
            frame_ms = (time.perf_counter() - t_frame) * 1000.0
            total_inference_ms += frame_ms
            detections_severity(dets)
            for d in dets:
                counts[d["hazardClass"]] = counts.get(d["hazardClass"], 0) + 1
                max_sev[d["hazardClass"]] = max(max_sev.get(d["hazardClass"], 0), d["severity"])
            per_frame.append({
                "frame": idx + 1,
                "timestamp_sec": round(idx / sample_fps, 3),
                "inference_ms": round(frame_ms, 2),
                "detections": dets,
            })

        wall_ms = (time.perf_counter() - t0) * 1000.0
        body = {
            "model_version": detector.model_version,
            "engine": detector.engine,
            "device": detector.device,
            "sampling_fps": sample_fps,
            "frames_total": len(per_frame),
            "frames_total_est": int(duration * sample_fps) if duration else len(per_frame),
            "video_bytes": total_bytes,
            "wall_ms": round(wall_ms, 2),
            "avg_frame_inference_ms": round(total_inference_ms / len(per_frame), 2) if per_frame else 0.0,
            "detections_total": sum(counts.values()),
            "counts_by_class": dict(sorted(counts.items())),
            "max_severity_by_class": dict(sorted(max_sev.items())),
            "frames": per_frame,
        }
        return body


# ---------------------------------------------------------------------------
# CLI entry (uvicorn)
# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="RoadGuard inference service")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    ap.add_argument("--workers", type=int, default=1)
    args = ap.parse_args()
    import uvicorn

    uvicorn.run("inference_service:app", host=args.host, port=args.port, workers=args.workers)


if __name__ == "__main__":
    main()
