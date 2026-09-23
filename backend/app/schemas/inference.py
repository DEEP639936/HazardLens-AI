"""Upload / media / inference schemas."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from app.schemas.common import BboxOut, HazardClass


class UploadOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "mediaId": "m-9f1c2b64",
                "mimeType": "image/jpeg",
                "width": 4032,
                "height": 3024,
                "suggestedLocation": {"lat": 12.9352, "lng": 77.6245},
                "note": "Metadata and EXIF have been stripped from the stored copy.",
            }
        }
    )

    mediaId: str
    mimeType: str
    width: int | None = None
    height: int | None = None
    suggestedLocation: dict | None = None  # {lat, lng} — only when geoConsent=true and GPS EXIF present
    note: str


class InferenceIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"mediaId": "m-9f1c2b64"}})

    mediaId: str


class InferenceOut(BaseModel):
    """Synchronous image inference result (video → 202 + jobId)."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "mediaId": "m-9f1c2b64",
                "engine": "demo-engine-v2",
                "modelVersion": "roadguard-yolo-v11n-v1",
                "inferenceMs": 142,
                "detections": [
                    {"id": "d-1", "hazardClass": "pothole", "confidence": 0.91, "bbox": [0.21, 0.44, 0.18, 0.12], "areaRatio": 0.0216, "severity": 3}
                ],
                "annotatedMediaId": None,
                "jobId": None,
            }
        }
    )

    mediaId: str
    engine: str
    modelVersion: str
    inferenceMs: int = 0
    detections: list[BboxOut] = []
    annotatedMediaId: str | None = None
    jobId: str | None = None


class InferenceJobOut(BaseModel):
    id: str
    mediaId: str
    status: str  # QUEUED | RUNNING | SUCCEEDED | FAILED
    engine: str
    progress: float
    framesTotal: int
    framesDone: int
    result: dict | None = None
    error: str | None = None
    createdAt: str


class DetectionOut(BaseModel):
    id: str
    hazardClass: HazardClass
    confidence: float
    bbox: tuple[float, float, float, float]
    areaRatio: float
    severity: int | None = None
