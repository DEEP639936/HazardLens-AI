"""SQLAlchemy 2.0 models — canonical domain model (AGENT_BRIEF §2).

Spatial column: `hazard_reports.location` is `geography(Point,4326)` on
PostgreSQL (GeoAlchemy2 `Geography`, GiST-indexed in the Alembic migration) and
degrades to plain WKT text on other dialects (SQLite test fallback), where all
spatial predicates are evaluated in Python — see `app/services/geo.py`.

Timestamps are stored as naive **UTC** datetimes for cross-dialect parity
(`utcnow()` helper below); every writer must use `utcnow()`.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from geoalchemy2 import Geography, WKBElement
from geoalchemy2.shape import to_shape
from shapely.geometry import Point as ShapelyPoint
from sqlalchemy import DateTime, ForeignKey, Index, String, Text, TypeDecorator
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def uid() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    """Naive UTC timestamp (single source of truth for every model)."""
    return datetime.utcnow()


class GeographyPoint(TypeDecorator):
    """`geography(Point, 4326)` on PostgreSQL; WKT text elsewhere.

    Accepts on bind (in order): None, shapely Point, ("lat", "lng") tuple,
    {"lat": ..., "lng": ...} dict, "lat,lng" string or WKT/EWKT string.
    Returns on fetch: shapely Point (or None).
    """

    impl = Geography(geometry_type="POINT", srid=4326, spatial_index=False, management=False)
    cache_ok = True
    SRID = 4326

    def load_dialect_impl(self, dialect):  # type: ignore[no-untyped-def]
        if dialect.name == "postgresql":
            return dialect.type_descriptor(
                Geography(geometry_type="POINT", srid=self.SRID, spatial_index=False, management=False)
            )
        return dialect.type_descriptor(Text())

    @staticmethod
    def to_wkt(value: Any) -> str | None:
        """Normalize any accepted input to `POINT(lng lat)` WKT (None-safe)."""
        if value is None:
            return None
        if isinstance(value, ShapelyPoint):
            return f"POINT({value.x:.7f} {value.y:.7f})"
        if isinstance(value, WKBElement):
            return GeographyPoint.to_wkt(to_shape(value))
        if isinstance(value, dict):
            lat, lng = float(value["lat"]), float(value["lng"])
            return f"POINT({lng:.7f} {lat:.7f})"
        if isinstance(value, (tuple, list)):
            lat, lng = float(value[0]), float(value[1])
            return f"POINT({lng:.7f} {lat:.7f})"
        if isinstance(value, str):
            text = value.strip()
            if text.upper().startswith("SRID="):
                text = text.split(";", 1)[1]
            if text.upper().startswith("POINT"):
                return text
            lat_s, _, lng_s = text.partition(",")
            return f"POINT({float(lng_s):.7f} {float(lat_s):.7f})"
        raise ValueError(f"Unsupported geometry bind value: {value!r}")

    def process_bind_param(self, value: Any, dialect):  # type: ignore[no-untyped-def]
        wkt = self.to_wkt(value)
        if wkt is None:
            return None
        if dialect.name == "postgresql":
            return f"SRID={self.SRID};{wkt}"  # EWKT → ST_GeogFromText
        return wkt

    def process_result_value(self, value: Any, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        if isinstance(value, WKBElement):
            return to_shape(value)
        if isinstance(value, bytes):  # WKB bytes (rare drivers)
            return to_shape(WKBElement(value))
        text = str(value).strip()
        if text.upper().startswith("SRID="):
            text = text.split(";", 1)[1]
        if text.upper().startswith("POINT"):
            coords = text[text.index("(") + 1 : text.index(")")].split()
            return ShapelyPoint(float(coords[0]), float(coords[1]))
        return None  # pragma: no cover


class Base(DeclarativeBase):
    pass


NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}
Base.metadata.naming_convention = NAMING_CONVENTION  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- users
class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16), default="USER")  # USER | ADMIN
    notify_in_app: Mapped[bool] = mapped_column(default=True)
    geo_consent: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    notifications: Mapped[list["Notification"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # sha256 hex
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    user: Mapped[User] = relationship(back_populates="refresh_tokens")


# --------------------------------------------------------------------------- media
class MediaAsset(Base):
    __tablename__ = "media_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    kind: Mapped[str] = mapped_column(String(16), default="ORIGINAL")  # ORIGINAL|ANNOTATED|FRAME|THUMBNAIL
    storage_path: Mapped[str] = mapped_column(String(512))
    mime_type: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(default=0)
    width: Mapped[int | None] = mapped_column(nullable=True)
    height: Mapped[int | None] = mapped_column(nullable=True)
    duration_sec: Mapped[float | None] = mapped_column(sa.Float, nullable=True)
    report_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazard_reports.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ------------------------------------------------------------------ hazard reports
class HazardReport(Base):
    __tablename__ = "hazard_reports"
    __table_args__ = (
        Index("ix_hazard_reports_status_created", "status", "created_at"),
        Index("ix_hazard_reports_hazard_class", "hazard_class"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    reference_code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    submitter_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    submitter_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    hazard_class: Mapped[str] = mapped_column(String(24))  # pothole | crack | ...
    hazard_class_ai: Mapped[str | None] = mapped_column(String(24), nullable=True)
    severity: Mapped[int] = mapped_column(default=3)  # 1..5
    severity_ai: Mapped[int | None] = mapped_column(nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="PENDING_REVIEW", index=True)

    lat: Mapped[float] = mapped_column(sa.Float)
    lng: Mapped[float] = mapped_column(sa.Float)
    location = mapped_column(GeographyPoint(), nullable=True)  # geography(Point,4326) on PG
    address: Mapped[str | None] = mapped_column(String(300), nullable=True)
    ward: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    road_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    road_class: Mapped[str | None] = mapped_column(String(16), nullable=True)  # highway|arterial|collector|residential
    road_criticality: Mapped[float | None] = mapped_column(sa.Float, nullable=True)  # 0..1

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="WEB_UPLOAD")
    geo_consent: Mapped[bool] = mapped_column(default=True)
    blur_requested: Mapped[bool] = mapped_column(default=False)

    duplicate_of_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazard_reports.id", ondelete="SET NULL"), nullable=True
    )
    cluster_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazard_clusters.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)  # reviewer email
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    media: Mapped[list[MediaAsset]] = relationship(primaryjoin="MediaAsset.report_id == HazardReport.id")
    detections: Mapped[list["Detection"]] = relationship(
        back_populates="report", cascade="all, delete-orphan", order_by="Detection.confidence.desc()"
    )
    priority_score: Mapped["PriorityScore | None"] = relationship(back_populates="report", uselist=False)
    cluster: Mapped["HazardCluster | None"] = relationship(foreign_keys=[cluster_id])
    work_order: Mapped["WorkOrder | None"] = relationship(back_populates="hazard_report", uselist=False, viewonly=True)


class Detection(Base):
    __tablename__ = "detections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    report_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazard_reports.id", ondelete="CASCADE"), nullable=True, index=True
    )
    annotated_media_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    model_version: Mapped[str] = mapped_column(String(80), default="roadguard-yolo-v11n-v1")
    engine: Mapped[str] = mapped_column(String(40), default="demo-engine-v2")
    hazard_class: Mapped[str] = mapped_column(String(24))
    confidence: Mapped[float] = mapped_column(sa.Float)  # 0..1
    bbox_x: Mapped[float] = mapped_column(sa.Float)  # normalized 0..1
    bbox_y: Mapped[float] = mapped_column(sa.Float)
    bbox_w: Mapped[float] = mapped_column(sa.Float)
    bbox_h: Mapped[float] = mapped_column(sa.Float)
    area_ratio: Mapped[float] = mapped_column(sa.Float, default=0.0)
    severity: Mapped[int | None] = mapped_column(nullable=True)  # 1..5
    inference_ms: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    report: Mapped[HazardReport | None] = relationship(back_populates="detections")


# ---------------------------------------------------------------------- clustering
class HazardCluster(Base):
    __tablename__ = "hazard_clusters"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    label: Mapped[str] = mapped_column(String(120))
    center_lat: Mapped[float] = mapped_column(sa.Float)
    center_lng: Mapped[float] = mapped_column(sa.Float)
    center = mapped_column(GeographyPoint(), nullable=True)
    radius_m: Mapped[int] = mapped_column(default=0)
    hazard_count: Mapped[int] = mapped_column(default=0)
    dominant_class: Mapped[str] = mapped_column(String(24), default="pothole")
    avg_severity: Mapped[float] = mapped_column(sa.Float, default=0.0)
    max_severity: Mapped[int] = mapped_column(default=0)
    params_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    memberships: Mapped[list["ClusterMembership"]] = relationship(back_populates="cluster", cascade="all, delete-orphan")


class ClusterMembership(Base):
    __tablename__ = "cluster_memberships"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    cluster_id: Mapped[str] = mapped_column(
        ForeignKey("hazard_clusters.id", ondelete="CASCADE"), index=True
    )
    report_id: Mapped[str] = mapped_column(
        ForeignKey("hazard_reports.id", ondelete="CASCADE"), unique=True, index=True
    )
    distance_m: Mapped[int] = mapped_column(default=0)

    cluster: Mapped[HazardCluster] = relationship(back_populates="memberships")


# ------------------------------------------------------------------------ priority
class PriorityScore(Base):
    __tablename__ = "priority_scores"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    report_id: Mapped[str] = mapped_column(
        ForeignKey("hazard_reports.id", ondelete="CASCADE"), unique=True, index=True
    )
    score: Mapped[float] = mapped_column(sa.Float, default=0.0)  # 0..100
    band: Mapped[str] = mapped_column(String(12), default="LOW", index=True)  # CRITICAL|HIGH|MEDIUM|LOW
    severity_norm: Mapped[float] = mapped_column(sa.Float, default=0.0)
    density_norm: Mapped[float] = mapped_column(sa.Float, default=0.0)
    criticality_norm: Mapped[float] = mapped_column(sa.Float, default=0.0)
    recurrence_norm: Mapped[float] = mapped_column(sa.Float, default=0.0)
    age_norm: Mapped[float] = mapped_column(sa.Float, default=0.0)
    weights_json: Mapped[str] = mapped_column(Text, default="{}")
    explanation_json: Mapped[str] = mapped_column(Text, default="[]")
    overridden: Mapped[bool] = mapped_column(default=False)
    overridden_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manual_score: Mapped[float | None] = mapped_column(sa.Float, nullable=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    report: Mapped[HazardReport] = relationship(back_populates="priority_score")


# --------------------------------------------------------------------- work orders
class WorkOrder(Base):
    __tablename__ = "work_orders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="REPORTED", index=True)
    priority: Mapped[float] = mapped_column(sa.Float, default=0.0)
    band: Mapped[str] = mapped_column(String(12), default="MEDIUM")
    hazard_report_id: Mapped[str | None] = mapped_column(
        ForeignKey("hazard_reports.id", ondelete="SET NULL"), nullable=True, index=True
    )
    cluster_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    assigned_to: Mapped[str | None] = mapped_column(String(120), nullable=True)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    hazard_report: Mapped[HazardReport | None] = relationship(back_populates="work_order", foreign_keys=[hazard_report_id])
    updates: Mapped[list["WorkOrderUpdate"]] = relationship(
        back_populates="work_order", cascade="all, delete-orphan", order_by="WorkOrderUpdate.created_at.desc()"
    )


class WorkOrderUpdate(Base):
    __tablename__ = "work_order_updates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    work_order_id: Mapped[str] = mapped_column(
        ForeignKey("work_orders.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    from_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    to_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    work_order: Mapped[WorkOrder] = relationship(back_populates="updates")


# ------------------------------------------------------- audit / notifications / ml
class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    actor_role: Mapped[str | None] = mapped_column(String(16), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_read", "user_id", "read"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(200), nullable=True)
    read: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    user: Mapped[User] = relationship(back_populates="notifications")


class ModelVersion(Base):
    __tablename__ = "model_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    version: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    framework: Mapped[str] = mapped_column(String(40), default="yolo-onnx")
    weights_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    map50: Mapped[float | None] = mapped_column(sa.Float, nullable=True)
    map50_95: Mapped[float | None] = mapped_column(sa.Float, nullable=True)
    precision: Mapped[float | None] = mapped_column(sa.Float, nullable=True)
    recall: Mapped[float | None] = mapped_column(sa.Float, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(nullable=True)
    dataset_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    registered_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class InferenceJob(Base):
    __tablename__ = "inference_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    media_id: Mapped[str] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(12), default="QUEUED", index=True)  # QUEUED|RUNNING|SUCCEEDED|FAILED
    engine: Mapped[str] = mapped_column(String(40), default="demo-engine-v2")
    progress: Mapped[float] = mapped_column(sa.Float, default=0.0)  # 0..1
    frames_total: Mapped[int] = mapped_column(default=0)
    frames_done: Mapped[int] = mapped_column(default=0)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
