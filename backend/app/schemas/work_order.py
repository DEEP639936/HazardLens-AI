"""Work-order + notification schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import PriorityBand, WorkOrderStatus


class WorkOrderCreateIn(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "hazardReportId": "h-1",
                "title": "Patch pothole cluster on 80 Feet Road",
                "description": "Crew visit scheduled with hot-mix; coordinate with BBMP ward office.",
                "assignedTo": "BBMP Crew 7",
                "scheduledFor": "2024-05-06T09:00:00",
            }
        }
    )

    hazardReportId: str | None = None
    clusterId: str | None = None
    title: str = Field(min_length=4, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    assignedTo: str | None = Field(default=None, max_length=120)
    scheduledFor: datetime | None = None


class WorkOrderPatchIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"status": "IN_REPAIR", "note": "Crew on site."}})

    status: WorkOrderStatus | None = None
    note: str | None = Field(default=None, max_length=2000)
    assignedTo: str | None = Field(default=None, max_length=120)
    scheduledFor: datetime | None = None


class WorkOrderUpdateOut(BaseModel):
    id: str
    fromStatus: str | None = None
    toStatus: str | None = None
    note: str | None = None
    author: str | None = None
    createdAt: str


class WorkOrderOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "wo-1",
                "code": "WO-0001",
                "title": "Patch pothole cluster on 80 Feet Road",
                "description": None,
                "status": "SCHEDULED",
                "priority": 68.4,
                "band": "HIGH",
                "hazardReportId": "h-1",
                "hazard": {"referenceCode": "RG-PX6NMM", "hazardClass": "pothole", "address": "80 Feet Road"},
                "clusterId": None,
                "assignedTo": "BBMP Crew 7",
                "scheduledFor": "2024-05-06T09:00:00",
                "createdAt": "2024-05-01T10:00:00",
                "updates": [],
            }
        }
    )

    id: str
    code: str
    title: str
    description: str | None = None
    status: WorkOrderStatus
    priority: float
    band: PriorityBand
    hazardReportId: str | None = None
    hazard: dict | None = None  # {referenceCode, hazardClass, address}
    clusterId: str | None = None
    assignedTo: str | None = None
    scheduledFor: str | None = None
    createdAt: str
    updates: list[WorkOrderUpdateOut] = Field(default_factory=list)


class WorkOrderListOut(BaseModel):
    items: list[WorkOrderOut]
    count: int


class NotificationOut(BaseModel):
    id: str
    type: str
    title: str
    body: str
    read: bool
    link: str | None = None
    createdAt: str


class NotificationListOut(BaseModel):
    items: list[NotificationOut]
    count: int
    unread: int


class MarkReadIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"ids": ["n-1", "n-2"], "all": False}})

    ids: list[str] = Field(default_factory=list)
    all: bool = False
