"""Geospatial service.

Production path: PostGIS `ST_DWithin` / `ST_Distance` on `geography(Point,4326)`
with a GiST index (see alembic/versions/0001_initial.py). Fallback path (SQLite
tests / dev without PostGIS): identical semantics via the Haversine formula in
Python, matching the live TypeScript engine in `src/lib/rg/geo.ts`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

EARTH_RADIUS_M = 6371000.0


@dataclass(frozen=True, slots=True)
class Bbox:
    min_lat: float
    min_lng: float
    max_lat: float
    max_lng: float

    @classmethod
    def parse(cls, raw: str | None) -> "Bbox | None":
        """Parse `bbox=minLng,minLat,maxLng,maxLat` (Leaflet/GeoJSON order)."""
        if not raw:
            return None
        try:
            min_lng, min_lat, max_lng, max_lat = (float(p) for p in raw.split(","))
        except ValueError:
            return None
        values = (min_lat, min_lng, max_lat, max_lng)
        if not all(math.isfinite(v) for v in values):
            return None
        return cls(
            min_lat=min(min_lat, max_lat),
            max_lat=max(min_lat, max_lat),
            min_lng=min(min_lng, max_lng),
            max_lng=max(min_lng, max_lng),
        )

    def contains(self, lat: float, lng: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lng <= lng <= self.max_lng


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters (identical to src/lib/rg/geo.ts)."""
    to_rad = math.pi / 180
    d_lat = (lat2 - lat1) * to_rad
    d_lng = (lng2 - lng1) * to_rad
    s = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.sin(d_lng / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(s)))


def is_valid_lat_lng(lat: float, lng: float) -> bool:
    return (
        math.isfinite(lat)
        and math.isfinite(lng)
        and -90 <= lat <= 90
        and -180 <= lng <= 180
        and not (lat == 0 and lng == 0)
    )


def bbox_around(lat: float, lng: float, radius_m: float) -> Bbox:
    """Rough bounding box around a point (used as an index-friendly prefilter)."""
    lat_delta = radius_m / 111320
    lng_delta = radius_m / (111320 * max(0.1, math.cos(lat * math.pi / 180)))
    return Bbox(lat - lat_delta, lng - lng_delta, lat + lat_delta, lng + lng_delta)


# --------------------------------------------------------------- Bengaluru wards
WARDS: list[dict[str, Any]] = [
    {"name": "Central Business District", "lat": 12.9757, "lng": 77.6068},
    {"name": "Indiranagar", "lat": 12.9719, "lng": 77.6412},
    {"name": "Koramangala", "lat": 12.9352, "lng": 77.6245},
    {"name": "Marathahalli", "lat": 12.9569, "lng": 77.7011},
    {"name": "Whitefield", "lat": 12.9698, "lng": 77.75},
    {"name": "Hebbal", "lat": 13.0358, "lng": 77.597},
    {"name": "Jayanagar", "lat": 12.9299, "lng": 77.5826},
    {"name": "Yeshwanthpur", "lat": 13.0284, "lng": 77.5546},
    {"name": "BTM Layout", "lat": 12.9166, "lng": 77.6101},
    {"name": "HSR Layout", "lat": 12.9116, "lng": 77.6474},
    {"name": "Rajajinagar", "lat": 12.9917, "lng": 77.5551},
    {"name": "Basavanagudi", "lat": 12.9426, "lng": 77.5744},
    {"name": "Malleshwaram", "lat": 13.0035, "lng": 77.5696},
    {"name": "Electronic City", "lat": 12.8452, "lng": 77.6602},
    {"name": "Banashankari", "lat": 12.925, "lng": 77.5468},
]


def nearest_ward(lat: float, lng: float) -> str:
    best = min(WARDS, key=lambda w: haversine_m(lat, lng, w["lat"], w["lng"]))
    return str(best["name"])


ROAD_CLASS_CRITICALITY = {"highway": 1.0, "arterial": 0.8, "collector": 0.6, "residential": 0.4}
DEFAULT_CRITICALITY = 0.5


def infer_road_criticality(road_name: str | None, road_class: str | None) -> float:
    """Infer criticality from road-class enum or Bengaluru naming conventions (documented heuristic)."""
    if road_class and road_class in ROAD_CLASS_CRITICALITY:
        return ROAD_CLASS_CRITICALITY[road_class]
    name = (road_name or "").lower()
    if any(tok in name for tok in ("ring road", "highway", "nh-", "national", "expressway", "flyover")):
        return 1.0
    if any(tok in name for tok in ("main road", "100 feet", "80 feet", "arterial", "road junction", "hosur", "sarjapur", "airport", "bellary", "old airport")):
        return 0.8
    if any(tok in name for tok in ("street", "cross", "layout", "block")):
        return 0.5
    return DEFAULT_CRITICALITY


# ----------------------------------------------------------------- query helpers
def apply_bbox_filter(
    stmt: Select,
    model: Any,
    bbox: Bbox | None,
) -> Select:
    """Add a lat/lng bounding-box predicate (index-friendly on both dialects)."""
    if bbox is None:
        return stmt
    return stmt.where(
        model.lat >= bbox.min_lat,
        model.lat <= bbox.max_lat,
        model.lng >= bbox.min_lng,
        model.lng <= bbox.max_lng,
    )


def _is_postgres(db: Session) -> bool:
    return db.bind is not None and db.bind.dialect.name == "postgresql"


def _geog_expr(lat: float, lng: float) -> Any:
    """PostGIS geography literal for a WGS84 point (meters everywhere)."""
    return func.ST_GeogFromText(f"POINT({lng!r} {lat!r})", 4326)


def neighbors_within(
    db: Session,
    model: Any,
    lat: float,
    lng: float,
    radius_m: float,
    extra_predicate: Sequence[Any] = (),
) -> list[tuple[Any, float]]:
    """Rows of `model` within `radius_m` (ST_DWithin/Haversine), each as (row, distance_m).

    PostGIS path: ST_DWithin(location, geog, radius) ordered by ST_Distance (GiST-friendly).
    Fallback path: bbox prefilter + exact Haversine in Python (same semantics).
    """
    if _is_postgres(db):
        geog = _geog_expr(lat, lng)
        stmt = (
            select(model, func.ST_Distance(model.location, geog).label("dist"))
            .where(func.ST_DWithin(model.location, geog, radius_m), *extra_predicate)
            .order_by("dist")
        )
        rows = db.execute(stmt).all()
        return [(row[0], float(row[1])) for row in rows]

    # Fallback (SQLite / no PostGIS): bbox prefilter then exact haversine.
    pre = bbox_around(lat, lng, radius_m)
    stmt = select(model).where(
        model.lat >= pre.min_lat,
        model.lat <= pre.max_lat,
        model.lng >= pre.min_lng,
        model.lng <= pre.max_lng,
        *extra_predicate,
    )
    rows = db.execute(stmt).scalars().all()
    out: list[tuple[Any, float]] = []
    for row in rows:
        d = haversine_m(lat, lng, row.lat, row.lng)
        if d <= radius_m:
            out.append((row, d))
    out.sort(key=lambda pair: pair[1])
    return out


def distance_m(db: Session, lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Point-to-point distance (meters) — PostGIS ST_Distance or Haversine."""
    if _is_postgres(db):
        row = db.execute(
            select(func.ST_Distance(_geog_expr(lat1, lng1), _geog_expr(lat2, lng2)))
        ).scalar()
        if row is not None:
            return float(row)
    return haversine_m(lat1, lng1, lat2, lng2)
