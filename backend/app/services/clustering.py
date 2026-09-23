"""DBSCAN over geographic points (Haversine metric) — parity with src/lib/rg/dbscan.ts.

- `dbscan(points, eps_m, min_pts)` returns cluster labels; -1 = noise (no cluster).
- Border points are absorbed by the first core cluster that reaches them
  (identical traversal order to the TypeScript reference: BFS with a FIFO queue).
- `summarize_clusters` builds per-cluster summaries: centroid = mean of member
  coordinates, radius = max distance from centroid.

Performance: a uniform lat/lng grid buckets points so neighbor search is
O(n·k) instead of O(n²); the *semantics* (haversine ≤ eps) are unchanged, which
matters for city-scale workloads (tens of thousands of points). For very large
datasets the Celery worker can prefilter candidates with PostGIS ST_DWithin —
see worker/tasks.py.
"""
from __future__ import annotations

import math
from collections import deque

from app.services.geo import haversine_m

UNVISITED = -2
NOISE = -1

def dbscan(points: list[tuple[float, float]], eps_m: float = 60.0, min_pts: int = 3) -> list[int]:
    """Cluster geographic (lat, lng) points. Returns one label per point (NOISE = -1)."""
    n = len(points)
    labels = [UNVISITED] * n
    if n == 0:
        return labels

    # --- grid bucketing (cell ≥ eps so neighbors can only be ±1 cell away)
    lat_rad = math.radians(max(abs(p[0]) for p in points)) or 0.0
    meters_per_deg_lng = 111320 * max(0.1, math.cos(lat_rad))
    cell_lat = eps_m / 111320
    cell_lng = eps_m / max(1e-9, meters_per_deg_lng)
    cells: dict[tuple[int, int], list[int]] = {}
    for i, (lat, lng) in enumerate(points):
        key = (int(math.floor(lat / max(cell_lat, 1e-9))), int(math.floor(lng / max(cell_lng, 1e-9))))
        cells.setdefault(key, []).append(i)

    def neighbor_indexes(i: int) -> list[int]:
        lat, lng = points[i]
        cx = int(math.floor(lat / max(cell_lat, 1e-9)))
        cy = int(math.floor(lng / max(cell_lng, 1e-9)))
        out: list[int] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in cells.get((cx + dx, cy + dy), ()):
                    if j != i and haversine_m(lat, lng, *points[j]) <= eps_m:
                        out.append(j)
        return out

    neighbors: list[list[int]] = [neighbor_indexes(i) for i in range(n)]

    c = 0
    for i in range(n):
        if labels[i] != UNVISITED:
            continue
        if len(neighbors[i]) + 1 < min_pts:
            labels[i] = NOISE
            continue
        labels[i] = c
        queue: deque[int] = deque(neighbors[i])
        seen = set(neighbors[i])
        while queue:
            j = queue.popleft()
            if labels[j] == NOISE:
                labels[j] = c  # noise → border point
            if labels[j] != UNVISITED:
                continue
            labels[j] = c
            if len(neighbors[j]) + 1 >= min_pts:  # core point → expand
                for k in neighbors[j]:
                    if k not in seen:
                        seen.add(k)
                        queue.append(k)
        c += 1
    return labels


def summarize_clusters(points: list[tuple[float, float]], labels: list[int]) -> list[dict]:
    """Per-cluster summary: members, centroid, radius (meters). Cluster order = label order."""
    by_cluster: dict[int, list[int]] = {}
    for i, label in enumerate(labels):
        if label >= 0:
            by_cluster.setdefault(label, []).append(i)

    out: list[dict] = []
    for _label, idxs in by_cluster.items():
        center_lat = sum(points[i][0] for i in idxs) / len(idxs)
        center_lng = sum(points[i][1] for i in idxs) / len(idxs)
        radius_m = max(haversine_m(center_lat, center_lng, *points[i]) for i in idxs)
        out.append(
            {
                "memberIndexes": idxs,
                "centerLat": center_lat,
                "centerLng": center_lng,
                "radiusM": radius_m,
            }
        )
    return out
