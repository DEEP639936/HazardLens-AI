"""Shared Pydantic schemas + reusable JSON examples (OpenAPI polish)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Role = Literal["USER", "ADMIN"]
HazardClass = Literal["pothole", "crack", "erosion", "waterlogging", "marking", "debris", "edge_damage"]
ReportStatus = Literal["PENDING_REVIEW", "APPROVED", "REJECTED", "MERGED", "FLAGGED"]
PriorityBand = Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
WorkOrderStatus = Literal["REPORTED", "UNDER_REVIEW", "APPROVED", "SCHEDULED", "IN_REPAIR", "RESOLVED"]
RoadClass = Literal["highway", "arterial", "collector", "residential"]
MediaKind = Literal["ORIGINAL", "ANNOTATED", "FRAME", "THUMBNAIL"]


class ApiError(BaseModel):
    """Canonical error envelope (matches the live Next.js API)."""

    model_config = ConfigDict(json_schema_extra={"example": {"error": "Not found", "detail": "Hazard RG-XXXXXX does not exist"}})

    error: str
    detail: str | None = None


class Page(BaseModel):
    items: list[Any]
    count: int


class BboxOut(BaseModel):
    """Normalized detection bounding box (x, y, w, h in 0..1) + engine metadata."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "9f1c2b64-8e0a-4b8e-9c1d-2f5a6b7c8d9e",
                "hazardClass": "pothole",
                "confidence": 0.91,
                "bbox": [0.21, 0.44, 0.18, 0.12],
                "areaRatio": 0.0216,
                "severity": 3,
                "engine": "demo-engine-v2",
                "modelVersion": "roadguard-yolo-v11n-v1",
            }
        }
    )

    id: str | None = None
    hazardClass: HazardClass
    confidence: float = Field(ge=0, le=1)
    bbox: tuple[float, float, float, float]  # x, y, w, h normalized
    areaRatio: float = 0.0
    severity: int = Field(default=3, ge=1, le=5)
    engine: str | None = None
    modelVersion: str | None = None


class PriorityFactorOut(BaseModel):
    key: Literal["severity", "density", "criticality", "recurrence", "age"]
    label: str
    raw: str
    normalized: float
    weight: float
    contribution: float
    note: str


class PriorityWeights(BaseModel):
    severity: float = 0.32
    density: float = 0.24
    criticality: float = 0.18
    recurrence: float = 0.14
    age: float = 0.12

    def as_dict(self) -> dict[str, float]:
        return self.model_dump()


class PriorityOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "score": 64.1,
                "band": "HIGH",
                "factors": [
                    {"key": "severity", "label": "Detection severity", "raw": "4/5", "normalized": 0.75, "weight": 0.32, "contribution": 24.0, "note": "AI confidence + bounding-box extent + hazard class."}
                ],
                "weights": {"severity": 0.32, "density": 0.24, "criticality": 0.18, "recurrence": 0.14, "age": 0.12},
                "overridden": False,
                "manualScore": None,
                "computedAt": "2024-05-01T10:00:00Z",
            }
        }
    )

    score: float
    band: PriorityBand
    factors: list[PriorityFactorOut]
    weights: PriorityWeights
    overridden: bool = False
    manualScore: float | None = None
    computedAt: str


class MediaOut(BaseModel):
    id: str
    kind: MediaKind
    mimeType: str
    width: int | None = None
    height: int | None = None
    durationSec: float | None = None


class ClusterOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "c1a2...",
                "label": "C-1 · Koramangala",
                "centerLat": 12.9352,
                "centerLng": 77.6245,
                "radiusM": 42,
                "hazardCount": 6,
                "dominantClass": "pothole",
                "avgSeverity": 3.4,
                "maxSeverity": 5,
                "computedAt": "2024-05-01T10:00:00Z",
            }
        }
    )

    id: str
    label: str
    centerLat: float
    centerLng: float
    radiusM: int
    hazardCount: int
    dominantClass: HazardClass
    avgSeverity: float
    maxSeverity: int
    computedAt: str
