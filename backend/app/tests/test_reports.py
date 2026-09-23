"""Report submission tests: validation, rate limiting, geospatial persistence, priority."""
from __future__ import annotations

import io

from fastapi.testclient import TestClient

BASE = {"lat": 12.9352, "lng": 77.6245}  # Koramangala, Bengaluru


def test_submit_report_minimal(client: TestClient) -> None:
    resp = client.post("/reports", json={**BASE, "hazardClass": "pothole", "geoConsent": True})
    assert resp.status_code == 201, resp.text
    report = resp.json()
    assert report["referenceCode"].startswith("RG-")
    assert report["status"] == "PENDING_REVIEW"
    assert report["ward"]  # auto-warded from the Bengaluru atlas
    assert report["priority"] is not None
    assert 0 <= report["priority"]["score"] <= 100
    assert report["priority"]["band"] in ("CRITICAL", "HIGH", "MEDIUM", "LOW")
    assert len(report["priority"]["factors"]) == 5  # explainable breakdown


def test_submit_report_requires_consent(client: TestClient) -> None:
    resp = client.post("/reports", json={**BASE, "geoConsent": False})
    assert resp.status_code == 400
    assert "consent" in resp.json()["error"].lower()


def test_submit_report_validates_location(client: TestClient) -> None:
    resp = client.post("/reports", json={"lat": 0, "lng": 0, "geoConsent": True})
    assert resp.status_code == 400
    resp = client.post("/reports", json={"lat": 120, "lng": 77, "geoConsent": True})
    assert resp.status_code == 422  # pydantic range validation


def test_report_rate_limit_5_per_hour(client: TestClient) -> None:
    for i in range(5):
        resp = client.post("/reports", json={**BASE, "hazardClass": "crack", "geoConsent": True})
        assert resp.status_code == 201, f"report #{i + 1}: {resp.text}"
    sixth = client.post("/reports", json={**BASE, "hazardClass": "crack", "geoConsent": True})
    assert sixth.status_code == 429
    assert "rate limit" in sixth.json()["error"].lower()


def test_report_own_listing_and_detail(client: TestClient, citizen_headers, admin_headers) -> None:
    created = client.post(
        "/reports", json={**BASE, "hazardClass": "erosion", "geoConsent": True, "notes": "edge washing away"}
    ).json()

    mine = client.get("/reports", headers=citizen_headers)
    assert mine.status_code == 200
    assert any(item["id"] == created["id"] for item in mine.json()["items"])

    detail = client.get(f"/reports/{created['id']}", headers=citizen_headers)
    assert detail.status_code == 200
    assert detail.json()["notes"] == "edge washing away"

    # another citizen cannot see someone else's report detail
    other = client.post(
        "/auth/register", json={"email": "other@example.com", "password": "Str0ngPass!2024", "name": "Other"}
    )
    other_headers = {"Authorization": f"Bearer {other.json()['accessToken']}"}
    assert client.get(f"/reports/{created['id']}", headers=other_headers).status_code == 403
    # admins can
    assert client.get(f"/reports/{created['id']}", headers=admin_headers).status_code == 200


def test_report_persists_geospatial_context(client: TestClient, db, citizen_headers) -> None:
    """Reports near each other raise density/recurrence norms on the priority explanation."""
    first = client.post("/reports", json={**BASE, "hazardClass": "pothole", "geoConsent": True}).json()
    # 12 more same-class reports within 120 m → density saturates at 1.0
    for i in range(12):
        client.post(
            "/reports",
            json={**BASE, "lat": BASE["lat"] + 0.0002 * (i + 1), "lng": BASE["lng"], "hazardClass": "pothole", "geoConsent": True},
        )
    detail = client.get(f"/hazards/{first['id']}").json()
    factors = detail["priority"]["factors"]
    density = next(f for f in factors if f["key"] == "density")
    assert density["normalized"] == 1.0  # ≥ 12 neighbors → saturated
    assert detail["lat"] == BASE["lat"]
    # row-level geometry: WKT text on the fallback dialect, WKB on PostGIS
    from sqlalchemy import text as sql_text

    row = db.execute(
        sql_text("SELECT lat, lng FROM hazard_reports WHERE reference_code = :ref"),
        {"ref": detail["referenceCode"]},
    ).fetchone()
    assert row is not None
    assert abs(row[0] - BASE["lat"]) < 1e-6


def test_upload_and_inference_then_report_link(client: TestClient, citizen_headers, png_bytes) -> None:
    """Full happy path: upload → inference → attach detections to a report."""
    upload = client.post(
        "/uploads",
        files={"file": ("pothole.png", io.BytesIO(png_bytes), "image/png")},
        data={"geoConsent": "false"},
    )
    assert upload.status_code == 201, upload.text
    media_id = upload.json()["mediaId"]

    inference = client.post("/inference", json={"mediaId": media_id}, headers=citizen_headers)
    assert inference.status_code == 200, inference.text
    payload = inference.json()
    assert payload["engine"]
    assert len(payload["detections"]) >= 1
    det = payload["detections"][0]
    x, y, w, h = det["bbox"]
    assert all(0 <= v <= 1 for v in (x, y, w, h))
    assert det["severity"] in (1, 2, 3, 4, 5)

    report = client.post(
        "/reports",
        json={
            **BASE,
            "hazardClass": det["hazardClass"],
            "geoConsent": True,
            "mediaIds": [media_id],
            "detectionIds": [det["id"]],
        },
        headers=citizen_headers,
    ).json()
    assert len(report["detections"]) == 1
    assert report["detections"][0]["id"] == det["id"]
    assert len(report["media"]) == 1
