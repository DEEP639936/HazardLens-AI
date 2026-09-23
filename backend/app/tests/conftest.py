"""Pytest fixtures — SQLite fallback (default) or PostGIS via TEST_DATABASE_URL.

Environment:
- default: in-file SQLite database (spatial predicates via Haversine in Python —
  the exact semantics of the PostGIS path at city scale);
- `TEST_DATABASE_URL=postgresql+psycopg://…/roadguard_test`: runs against a real
  PostGIS database (spatial_ref_sys bootstrapped via the app metadata + postgis ext).

Fixtures: `db` (fresh schema per test), `client` (FastAPI TestClient with the
session dependency overridden), `admin_user`, `citizen_user`, `sample_report`,
plus `auth_headers` helpers.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db import get_db
from app.main import app
from app.models import Base
from app.services.ratelimit import reset_all
from app.services.security import hash_password

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite://")


@pytest.fixture(scope="session", autouse=True)
def _media_root(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Point MEDIA_ROOT at a temp dir for the whole test run."""
    root = str(tmp_path_factory.mktemp("media"))
    original = settings.MEDIA_ROOT
    settings.MEDIA_ROOT = root
    yield
    settings.MEDIA_ROOT = original
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> Iterator[None]:
    reset_all()
    yield
    reset_all()


@pytest.fixture()
def db() -> Iterator[Session]:
    if TEST_DATABASE_URL.startswith("sqlite"):
        engine = create_engine(
            TEST_DATABASE_URL,
            connect_args={"check_same_thread": False},
        )

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    else:
        engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)

    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(db: Session) -> Iterator[TestClient]:
    def _override_get_db() -> Iterator[Session]:
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


# ----------------------------------------------------------------- user helpers
def _create_user(db: Session, *, email: str, password: str, name: str, role: str):
    from app.models import User, utcnow

    user = User(
        email=email,
        password_hash=hash_password(password),
        name=name,
        role=role,
        created_at=utcnow(),
    )
    db.add(user)
    db.commit()
    return user


@pytest.fixture()
def admin_user(db: Session):
    return _create_user(
        db,
        email="admin@roadguardatlas.dev",
        password="Atlas@Admin2024",
        name="Atlas Admin",
        role="ADMIN",
    )


@pytest.fixture()
def citizen_user(db: Session):
    return _create_user(
        db,
        email="citizen@roadguardatlas.dev",
        password="Atlas@User2024",
        name="Citizen Demo",
        role="USER",
    )


def login(client: TestClient, email: str, password: str) -> dict[str, str]:
    resp = client.post("/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["accessToken"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def admin_headers(client: TestClient, admin_user) -> dict[str, str]:
    return login(client, "admin@roadguardatlas.dev", "Atlas@Admin2024")


@pytest.fixture()
def citizen_headers(client: TestClient, citizen_user) -> dict[str, str]:
    return login(client, "citizen@roadguardatlas.dev", "Atlas@User2024")


# --------------------------------------------------------------- sample report
@pytest.fixture()
def sample_report(db: Session, citizen_user):
    from app.models import HazardReport, utcnow
    from app.services.hazards import recompute_priority_for_report

    report = HazardReport(
        reference_code="RG-TEST01",
        user_id=citizen_user.id,
        hazard_class="pothole",
        severity=4,
        status="PENDING_REVIEW",
        lat=12.9352,
        lng=77.6245,
        location="12.9352,77.6245",
        ward="Koramangala",
        road_name="80 Feet Road",
        road_class="arterial",
        road_criticality=0.8,
        geo_consent=True,
        source="WEB_UPLOAD",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(report)
    db.commit()
    recompute_priority_for_report(db, report.id)
    db.commit()
    return report


@pytest.fixture()
def png_bytes() -> bytes:
    """A minimal valid PNG (1×1 transparent) — magic-byte validated."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082"
    )
