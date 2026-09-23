"""Auth flow tests: register / login / refresh rotation / logout / RBAC 403s."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def test_register_login_me(client: TestClient) -> None:
    resp = client.post(
        "/auth/register",
        json={"email": "asha@example.com", "password": "Str0ngPass!2024", "name": "Asha Rao"},
    )
    assert resp.status_code == 201, resp.text
    pair = resp.json()
    assert pair["tokenType"] == "bearer"
    assert pair["user"]["email"] == "asha@example.com"
    assert pair["user"]["role"] == "USER"

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {pair['accessToken']}"})
    assert me.status_code == 200
    assert me.json()["name"] == "Asha Rao"


def test_register_duplicate_email_conflict(client: TestClient, citizen_user) -> None:
    resp = client.post(
        "/auth/register",
        json={"email": "citizen@roadguardatlas.dev", "password": "Whatever123", "name": "Dup"},
    )
    assert resp.status_code == 409


def test_login_wrong_password_401(client: TestClient, citizen_user) -> None:
    resp = client.post("/auth/login", json={"email": "citizen@roadguardatlas.dev", "password": "nope-nope"})
    assert resp.status_code == 401


def test_refresh_rotation_and_reuse(client: TestClient, citizen_user) -> None:
    login_resp = client.post(
        "/auth/login", json={"email": "citizen@roadguardatlas.dev", "password": "Atlas@User2024"}
    )
    assert login_resp.status_code == 200
    refresh_token = login_resp.json()["refreshToken"]

    # rotate once — works
    r1 = client.post("/auth/refresh", json={"refreshToken": refresh_token})
    assert r1.status_code == 200
    new_refresh = r1.json()["refreshToken"]
    assert new_refresh != refresh_token

    # reuse of the old token must fail (rotate-on-use)
    r2 = client.post("/auth/refresh", json={"refreshToken": refresh_token})
    assert r2.status_code == 401

    # the fresh token still works
    r3 = client.post("/auth/refresh", json={"refreshToken": new_refresh})
    assert r3.status_code == 200


def test_logout_revokes_refresh(client: TestClient, citizen_user) -> None:
    login_resp = client.post(
        "/auth/login", json={"email": "citizen@roadguardatlas.dev", "password": "Atlas@User2024"}
    )
    refresh_token = login_resp.json()["refreshToken"]
    out = client.post("/auth/logout", json={"refreshToken": refresh_token})
    assert out.status_code == 200
    reuse = client.post("/auth/refresh", json={"refreshToken": refresh_token})
    assert reuse.status_code == 401


def test_access_token_required(client: TestClient) -> None:
    assert client.get("/auth/me").status_code == 401
    assert client.get("/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_rbac_admin_endpoints_forbidden_for_citizen(client: TestClient, citizen_headers) -> None:
    assert client.get("/admin/overview", headers=citizen_headers).status_code == 403
    assert client.post("/clusters/recompute", json={}, headers=citizen_headers).status_code == 403
    assert client.get("/export/hazards.csv", headers=citizen_headers).status_code == 403
    assert client.get("/analytics", headers=citizen_headers).status_code == 403
    assert client.get("/admin/audit-logs", headers=citizen_headers).status_code == 403


def test_rbac_admin_ok_for_admin(client: TestClient, admin_headers) -> None:
    assert client.get("/admin/overview", headers=admin_headers).status_code == 200
    assert client.get("/analytics", headers=admin_headers).status_code == 200
    assert client.get("/admin/settings", headers=admin_headers).status_code == 200


def test_password_reset_flow(client: TestClient, citizen_user, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.routers.auth as auth_router
    from app.config import settings as cfg

    monkeypatch.setattr(cfg, "DEBUG", True)
    forgot = client.post("/auth/forgot-password", json={"email": "citizen@roadguardatlas.dev"})
    assert forgot.status_code == 200
    token = forgot.json()["resetToken"]
    assert token

    reset = client.post("/auth/reset-password", json={"token": token, "password": "BrandNew!2024"})
    assert reset.status_code == 200

    old_login = client.post("/auth/login", json={"email": "citizen@roadguardatlas.dev", "password": "Atlas@User2024"})
    assert old_login.status_code == 401
    new_login = client.post("/auth/login", json={"email": "citizen@roadguardatlas.dev", "password": "BrandNew!2024"})
    assert new_login.status_code == 200
