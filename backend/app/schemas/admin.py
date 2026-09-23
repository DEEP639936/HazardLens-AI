"""Analytics + admin schemas."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import HazardClass, PriorityBand


class AnalyticsOut(BaseModel):
    """Aggregate dashboard payload — mirrors AnalyticsDTO in the live app."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "totals": {"hazards": 31, "pendingReview": 8, "critical": 3, "clusters": 3, "avgPriority": 52.3, "resolved": 1, "approvalRate": 48.4},
                "byClass": [{"hazardClass": "pothole", "count": 14, "avgSeverity": 3.2}],
                "bySeverity": [{"severity": 1, "count": 1}],
                "severityOverTime": [{"week": "2024-02-12", "avgSeverity": 3.1, "count": 4}],
                "wards": [{"ward": "Koramangala", "count": 6, "avgPriority": 61.2, "critical": 2}],
                "priorityBands": [{"band": "CRITICAL", "count": 3}],
                "confidence": {
                    "overallMean": 0.84,
                    "overallMedian": 0.87,
                    "p95LatencyMs": 220,
                    "byClass": [{"hazardClass": "pothole", "meanConfidence": 0.88, "count": 12}],
                    "engine": "demo-engine-v2",
                    "modelVersion": "roadguard-yolo-v11n-v1",
                },
            }
        }
    )

    totals: "TotalsOut"
    byClass: list["ByClassOut"]
    bySeverity: list["BySeverityOut"]
    severityOverTime: list["WeekOut"]
    wards: list["WardOut"]
    priorityBands: list["BandCountOut"]
    confidence: "ConfidenceOut"


class TotalsOut(BaseModel):
    hazards: int
    pendingReview: int
    critical: int
    clusters: int
    avgPriority: float
    resolved: int
    approvalRate: float


class ByClassOut(BaseModel):
    hazardClass: HazardClass
    count: int
    avgSeverity: float


class BySeverityOut(BaseModel):
    severity: int
    count: int


class WeekOut(BaseModel):
    week: str
    avgSeverity: float
    count: int


class WardOut(BaseModel):
    ward: str
    count: int
    avgPriority: float
    critical: int


class BandCountOut(BaseModel):
    band: PriorityBand
    count: int


class ConfidenceOut(BaseModel):
    overallMean: float
    overallMedian: float
    p95LatencyMs: int
    byClass: list[ByClassOut]
    engine: str
    modelVersion: str


class AdminOverviewOut(BaseModel):
    """Admin command-center KPIs."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "users": 3,
                "reports": {"total": 31, "pending": 8, "approved": 15, "rejected": 2, "merged": 4, "flagged": 2},
                "clusters": 3,
                "workOrders": {"total": 6, "open": 5, "resolved": 1},
                "auditEvents": 42,
                "topWards": [{"ward": "Koramangala", "count": 6}],
                "queue": {"criticalPending": 2, "oldestPendingDays": 12.5},
            }
        }
    )

    users: int
    reports: dict
    clusters: int
    workOrders: dict
    auditEvents: int
    topWards: list[dict]
    queue: dict


class AuditLogOut(BaseModel):
    id: str
    actorEmail: str | None = None
    actorRole: str | None = None
    action: str
    entityType: str
    entityId: str | None = None
    metadataJson: str | None = None
    ip: str | None = None
    createdAt: str


class AuditLogListOut(BaseModel):
    items: list[AuditLogOut]
    count: int


class ModelVersionIn(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "version": "roadguard-yolo-v11n-v1",
                "framework": "yolo-onnx",
                "weightsRef": "s3://roadguard-ml/weights/v1/best.onnx",
                "map50": 0.71,
                "map5095": 0.46,
                "precision": 0.78,
                "recall": 0.66,
                "latencyMs": 38,
                "datasetRef": "ml/data/roadguard-v1",
                "mlflowRunId": "abc123",
                "notes": "First registered production candidate.",
            }
        }
    )

    version: str = Field(max_length=80)
    framework: str = Field(default="yolo-onnx", max_length=40)
    weightsRef: str | None = None
    map50: float | None = Field(default=None, ge=0, le=1)
    map5095: float | None = Field(default=None, ge=0, le=1)
    precision: float | None = Field(default=None, ge=0, le=1)
    recall: float | None = Field(default=None, ge=0, le=1)
    latencyMs: int | None = None
    datasetRef: str | None = None
    mlflowRunId: str | None = None
    notes: str | None = None


class ModelVersionOut(ModelVersionIn):
    id: str
    registeredAt: str


class ClusterParams(BaseModel):
    epsM: float = Field(default=60, gt=0, le=2000)
    minPts: int = Field(default=3, ge=1, le=50)
    sinceDays: int = Field(default=90, ge=1, le=3650)


class SettingsOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "weights": {"severity": 0.32, "density": 0.24, "criticality": 0.18, "recurrence": 0.14, "age": 0.12},
                "cluster": {"epsM": 60, "minPts": 3, "sinceDays": 90},
                "autoRecompute": True,
            }
        }
    )

    weights: "PriorityWeightsIn"
    cluster: ClusterParams
    autoRecompute: bool


class PriorityWeightsIn(BaseModel):
    severity: float = Field(ge=0, le=1)
    density: float = Field(ge=0, le=1)
    criticality: float = Field(ge=0, le=1)
    recurrence: float = Field(ge=0, le=1)
    age: float = Field(ge=0, le=1)

    def as_dict(self) -> dict[str, float]:
        return self.model_dump()


class SettingsPatchIn(BaseModel):
    weights: PriorityWeightsIn | None = None
    cluster: ClusterParams | None = None
    autoRecompute: bool | None = None


class RecomputeIn(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {"bbox": {"minLat": 12.9, "minLng": 77.55, "maxLat": 13.0, "maxLng": 77.7}, "sinceDays": 90, "epsM": 60, "minPts": 3}
        }
    )

    bbox: "BboxIn | None" = None
    sinceDays: int | None = Field(default=None, ge=1, le=3650)
    epsM: float | None = Field(default=None, gt=0, le=2000)
    minPts: int | None = Field(default=None, ge=1, le=50)


class BboxIn(BaseModel):
    minLat: float = Field(ge=-90, le=90)
    minLng: float = Field(ge=-180, le=180)
    maxLat: float = Field(ge=-90, le=90)
    maxLng: float = Field(ge=-180, le=180)


class RecomputeOut(BaseModel):
    scopedReports: int
    clusters: int
    assignedReports: int
    epsM: float
    minPts: int
    computedAt: str


AnalyticsOut.model_rebuild()
SettingsOut.model_rebuild()
RecomputeIn.model_rebuild()
