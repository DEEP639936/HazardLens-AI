"""Hazard report + hazard feed schemas (report POST, review POST, GET filters)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import (
    BboxOut,
    HazardClass,
    MediaOut,
    PriorityOut,
    PriorityBand,
    ReportStatus,
    RoadClass,
    WorkOrderStatus,
)


class ReportCreateIn(BaseModel):
    """Public report submission (rate-limited 5/hour/IP). Mirrors the live wizard payload."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "hazardClass": "pothole",
                "severity": 4,
                "lat": 12.9352,
                "lng": 77.6245,
                "notes": "Deep pothole near the bus stop, already damaged two-wheelers.",
                "address": "80 Feet Road, Koramangala 4th Block",
                "ward": "Koramangala",
                "roadName": "80 Feet Road",
                "roadClass": "arterial",
                "mediaIds": ["m-1", "m-2"],
                "detectionIds": ["d-1"],
                "geoConsent": True,
                "blurRequested": False,
                "submitterName": "Asha Rao",
                "submitterEmail": "asha@example.com",
            }
        }
    )

    hazardClass: HazardClass = "pothole"
    severity: int | None = Field(default=None, ge=1, le=5)  # None → AI-derived from detections
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    notes: str | None = Field(default=None, max_length=2000)
    address: str | None = Field(default=None, max_length=300)
    ward: str | None = Field(default=None, max_length=120)
    roadName: str | None = Field(default=None, max_length=200)
    roadClass: RoadClass | None = None
    roadCriticality: float | None = Field(default=None, ge=0, le=1)
    mediaIds: list[str] = Field(default_factory=list, max_length=8)
    detectionIds: list[str] = Field(default_factory=list, max_length=32)
    geoConsent: bool  # required True — location privacy notice
    blurRequested: bool = False
    submitterName: str | None = Field(default=None, max_length=120)
    submitterEmail: str | None = Field(default=None, max_length=255)


class ReviewIn(BaseModel):
    """Admin review action. `merge` requires `mergeIntoId` referencing a different hazard."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "action": "approve",
                "note": "Verified via street-level imagery — pothole confirmed.",
                "edits": {"severity": 4, "roadClass": "arterial"},
                "manualScore": 71.5,
            }
        }
    )

    action: str = Field(description="approve | reject | flag | merge")
    note: str | None = Field(default=None, max_length=2000)
    edits: "ReviewEdits | None" = None
    mergeIntoId: str | None = None
    manualScore: float | None = Field(default=None, ge=0, le=100)


class ReviewEdits(BaseModel):
    hazardClass: HazardClass | None = None
    severity: int | None = Field(default=None, ge=1, le=5)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    address: str | None = Field(default=None, max_length=300)
    ward: str | None = Field(default=None, max_length=120)
    roadName: str | None = Field(default=None, max_length=200)
    roadClass: RoadClass | None = None
    roadCriticality: float | None = Field(default=None, ge=0, le=1)


class HazardOut(BaseModel):
    """Full hazard serialization — mirrors HazardDTO in the live app."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "h-1",
                "referenceCode": "RG-PX6NMM",
                "hazardClass": "pothole",
                "severity": 4,
                "status": "APPROVED",
                "lat": 12.9352,
                "lng": 77.6245,
                "address": "80 Feet Road, Koramangala",
                "ward": "Koramangala",
                "roadName": "80 Feet Road",
                "roadClass": "arterial",
                "notes": "Near bus stop",
                "source": "WEB_UPLOAD",
                "duplicateOfId": None,
                "createdAt": "2024-05-01T10:00:00",
                "reviewedAt": "2024-05-02T09:00:00",
                "reviewNote": "Confirmed",
                "userId": "u-2",
                "media": [{"id": "m-1", "kind": "ORIGINAL", "mimeType": "image/jpeg", "width": 1280, "height": 720, "durationSec": None}],
                "detections": [
                    {"id": "d-1", "hazardClass": "pothole", "confidence": 0.91, "bbox": [0.21, 0.44, 0.18, 0.12], "areaRatio": 0.0216, "severity": 3}
                ],
                "priority": None,
                "clusterId": None,
                "workOrderStatus": None,
            }
        }
    )

    id: str
    referenceCode: str
    hazardClass: HazardClass
    severity: int
    status: ReportStatus
    lat: float
    lng: float
    address: str | None = None
    ward: str | None = None
    roadName: str | None = None
    roadClass: RoadClass | None = None
    notes: str | None = None
    source: str
    duplicateOfId: str | None = None
    createdAt: str
    reviewedAt: str | None = None
    reviewNote: str | None = None
    userId: str | None = None
    media: list[MediaOut] = Field(default_factory=list)
    detections: list[BboxOut] = Field(default_factory=list)
    priority: PriorityOut | None = None
    clusterId: str | None = None
    workOrderStatus: WorkOrderStatus | None = None


class HazardListOut(BaseModel):
    items: list[HazardOut]
    count: int


ReviewIn.model_rebuild()
