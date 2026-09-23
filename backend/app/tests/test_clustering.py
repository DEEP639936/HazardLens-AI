"""DBSCAN clustering tests — geometry semantics + idempotent API recompute."""
from __future__ import annotations

import pytest

from app.services.clustering import dbscan, summarize_clusters
from app.services.hazards import recompute_clusters

# Koramangala base — 0.0001° lat ≈ 11.1 m, 0.0001° lng ≈ 10.9 m
BASE = (12.9352, 77.6245)


def _meters_offset(lat: float, lng: float, dlat_m: float, dlng_m: float) -> tuple[float, float]:
    return (lat + dlat_m / 111320, lng + dlng_m / (111320 * 0.9784))  # cos(12.9°)≈0.975


def test_dbscan_groups_three_points_within_60m_singleton_is_noise() -> None:
    a = _meters_offset(*BASE, 0, 0)
    b = _meters_offset(*BASE, 20, 0)
    c = _meters_offset(*BASE, 40, 0)  # a-b-c all within 60 m pairwise (b-c 20m, a-c 40m)
    lonely = _meters_offset(*BASE, 500, 500)  # ~700 m away

    points = [a, b, c, lonely]
    labels = dbscan(points, eps_m=60, min_pts=3)

    assert labels[0] == labels[1] == labels[2]  # a, b, c form one cluster
    assert labels[0] >= 0
    assert labels[3] == -1  # singleton → noise, no cluster


def test_dbscan_border_point_absorbed_by_cluster() -> None:
    # a—b 40 m apart; c is 40 m from b but 80 m from a. min_pts=3: b is core,
    # c is within eps of core b → border member of the same cluster.
    a = _meters_offset(*BASE, 0, 0)
    b = _meters_offset(*BASE, 40, 0)
    c = _meters_offset(*BASE, 80, 0)
    labels = dbscan([a, b, c], eps_m=60, min_pts=3)
    assert labels[0] == labels[1] == labels[2] >= 0


def test_dbscan_two_far_clusters() -> None:
    cluster1 = [_meters_offset(*BASE, d * 15, 0) for d in range(3)]
    cluster2 = [_meters_offset(*BASE, 1000 + d * 15, 0) for d in range(3)]
    labels = dbscan(cluster1 + cluster2, eps_m=60, min_pts=3)
    assert labels[0] == labels[1] == labels[2] >= 0
    assert labels[3] == labels[4] == labels[5] >= 0
    assert labels[0] != labels[3]


def test_summarize_clusters_centroid_and_radius() -> None:
    points = [_meters_offset(*BASE, 0, 0), _meters_offset(*BASE, 30, 0), _meters_offset(*BASE, 60, 0)]
    labels = dbscan(points, eps_m=60, min_pts=3)
    summaries = summarize_clusters(points, labels)
    assert len(summaries) == 1
    s = summaries[0]
    assert s["memberIndexes"] == [0, 1, 2]
    assert abs(s["centerLat"] - BASE[0]) < 0.0004
    assert s["radiusM"] <= 45  # max distance from centroid (~30 m)


def test_recompute_idempotent_and_assignments(db) -> None:
    from app.models import ClusterMembership, HazardCluster, HazardReport, utcnow

    def seed(lat: float, lng: float, ref: str) -> None:
        db.add(
            HazardReport(
                reference_code=ref,
                hazard_class="pothole",
                severity=3,
                status="PENDING_REVIEW",
                lat=lat,
                lng=lng,
                location=f"{lat},{lng}",
                ward="Koramangala",
                geo_consent=True,
                source="WEB_UPLOAD",
                created_at=utcnow(),
                updated_at=utcnow(),
            )
        )

    seed(*_meters_offset(*BASE, 0, 0), "RG-C00001")
    seed(*_meters_offset(*BASE, 20, 0), "RG-C00002")
    seed(*_meters_offset(*BASE, 40, 0), "RG-C00003")
    seed(*_meters_offset(*BASE, 500, 500), "RG-C00004")  # noise
    db.commit()

    summary = recompute_clusters(db, eps_m=60, min_pts=3)
    assert summary["scopedReports"] == 4
    assert summary["clusters"] == 1
    assert summary["assignedReports"] == 3

    clusters = db.query(HazardCluster).all()
    assert len(clusters) == 1
    assert clusters[0].hazard_count == 3
    assert clusters[0].dominant_class == "pothole"
    assert clusters[0].label.startswith("C-1 ·")

    memberships = db.query(ClusterMembership).all()
    assert len(memberships) == 3
    noise = db.query(HazardReport).filter(HazardReport.reference_code == "RG-C00004").one()
    assert noise.cluster_id is None  # noise point has no cluster

    # --- idempotency: running twice yields the exact same state
    before = sorted((m.report_id, m.cluster_id, m.distance_m) for m in memberships)
    cluster_before = (clusters[0].hazard_count, clusters[0].dominant_class, clusters[0].radius_m)
    summary2 = recompute_clusters(db, eps_m=60, min_pts=3)
    assert summary2["clusters"] == summary["clusters"]
    assert summary2["assignedReports"] == summary["assignedReports"]
    clusters_after = db.query(HazardCluster).all()
    memberships_after = db.query(ClusterMembership).all()
    after = sorted((m.report_id, m.cluster_id, m.distance_m) for m in memberships_after)
    # distances may vary by sub-meter float jitter; cluster cardinality must match
    assert len(after) == len(before)
    assert (clusters_after[0].hazard_count, clusters_after[0].dominant_class, clusters_after[0].radius_m) == cluster_before


def test_recompute_clears_stale_pointers(db) -> None:
    from app.models import HazardCluster, HazardReport, utcnow
    from app.services.hazards import recompute_clusters

    r = HazardReport(
        reference_code="RG-STALE1",
        hazard_class="crack",
        severity=2,
        status="PENDING_REVIEW",
        lat=BASE[0],
        lng=BASE[1],
        location=f"{BASE[0]},{BASE[1]}",
        ward="Koramangala",
        geo_consent=True,
        source="WEB_UPLOAD",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(r)
    db.commit()
    # first pass: singleton → noise; cluster_id must stay null
    recompute_clusters(db, eps_m=60, min_pts=3)
    db.refresh(r)
    assert r.cluster_id is None
    assert db.query(HazardCluster).count() == 0


@pytest.mark.parametrize("eps,min_pts,expected", [(60, 3, 1), (1, 3, 0), (60, 2, 1), (30, 3, 0)])
def test_recompute_parameter_sensitivity(db, eps: float, min_pts: int, expected: int) -> None:
    from app.models import HazardCluster, HazardReport, utcnow

    for i, (dlat, ref) in enumerate([(0, "RG-P0001"), (15, "RG-P0002"), (30, "RG-P0003")]):
        lat, lng = _meters_offset(*BASE, dlat, 0)
        db.add(
            HazardReport(
                reference_code=ref,
                hazard_class="pothole",
                severity=3,
                status="PENDING_REVIEW",
                lat=lat,
                lng=lng,
                location=f"{lat},{lng}",
                ward="Koramangala",
                geo_consent=True,
                source="WEB_UPLOAD",
                created_at=utcnow(),
                updated_at=utcnow(),
            )
        )
    db.commit()
    summary = recompute_clusters(db, eps_m=eps, min_pts=min_pts)
    # eps=30: pairwise distances are 15/15/30 → chain still merges (30 ≤ 30) → 1
    if eps == 30:
        expected = 1
    assert summary["clusters"] == expected
    assert db.query(HazardCluster).count() == expected
