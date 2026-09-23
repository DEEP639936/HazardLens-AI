# RoadGuard Atlas — Production Backend (FastAPI + PostgreSQL/PostGIS)

Reference backend implementing the full domain of RoadGuard Atlas: hazard reports with
`geography(Point,4326)` storage, DBSCAN clustering over PostGIS distance prefiltering, the
explainable 0–100 maintenance-priority engine, JWT auth with rotating refresh tokens, RBAC,
rate limiting, audit logging, Celery video-inference workers, and Prometheus metrics.

> Path convention: routes are mounted **without** an `/api` prefix (e.g. `POST /hazards/{id}/review`).
> Behind the gateway / docker-compose the service maps at the API root — mirror of the live
> Next.js deployment which serves the identical contract under `/api/*`.

## Quick start (local)

```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export DATABASE_URL="postgresql+psycopg://roadguard:roadguard@localhost:5432/roadguard"
export JWT_SECRET="change-me-in-production"
export CORS_ORIGINS="http://localhost:3000"

# Postgres must have the PostGIS extension available (postgis/postgis:16-3.4 image works)
alembic upgrade head           # creates postgis ext + all tables + GiST indexes
uvicorn app.main:app --reload --port 8000
```

Interactive docs: `http://localhost:8000/docs` (OpenAPI 3.1, same schemas as `/api/openapi.json`
in the live app).

## Docker

```bash
# from the repository root — brings up db, redis, api, worker, ml-inference, mlflow, minio
docker compose up --build api worker
```

The API image runs migrations separately in deployment pipelines:

```bash
docker compose run --rm api alembic upgrade head
```

## Tests

```bash
pytest app/tests -q
```

`conftest.py` selects the test database from `DATABASE_URL` (a disposable Postgres+PostGIS is
recommended; the suite skips spatial-specific assertions when spatial types are unavailable).

| Suite | Covers |
|---|---|
| `test_auth.py` | register/login/refresh rotation/logout, RBAC 401/403 |
| `test_reports.py` | submission validation, rate limiting, geometry persistence |
| `test_priority.py` | formula vectors vs. expected score/band, weights-sum-to-1 rejection |
| `test_clustering.py` | DBSCAN grouping at 60 m, noise singletons, idempotent recompute |
| (work orders) | status transitions + audit + notifications |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | `postgresql+psycopg://user:pass@host:5432/db` |
| `JWT_SECRET` | dev fallback (warns) | HS256 signing key — **set in production** |
| `ACCESS_TTL_MIN` | `15` | access-token lifetime |
| `REFRESH_TTL_DAYS` | `30` | refresh-token lifetime (rotated on every refresh) |
| `CORS_ORIGINS` | `http://localhost:3000` | comma-separated allow-list |
| `REDIS_URL` | `redis://localhost:6379/0` | Celery broker/result backend |
| `INFERENCE_SERVICE_URL` | — | YOLO service base (`ml/inference_service.py`) |
| `MEDIA_BACKEND` | `local` | `local` or `s3` (MinIO/R2/S3) |
| `S3_ENDPOINT/BUCKET/KEY/SECRET` | — | object-storage credentials when `MEDIA_BACKEND=s3` |
| `RATELIMIT_ENABLED` | `true` | public-endpoint limiters (5 report/h/IP, 10 login/15 min/IP) |

## Demo accounts (after seeding)

`backend/app/seed.py` is not bundled; use the API to register, then flip `role` to `ADMIN`
(`UPDATE users SET role='ADMIN' WHERE email='...'`) — the live demo deployment ships
`admin@roadguardatlas.dev / Atlas@Admin2024`.

## Parity

Priority, severity and clustering semantics mirror the live TypeScript engines
(`src/lib/rg/priority.ts`, `severity.ts`, `dbscan.ts`) — see `app/services/priority.py`,
`app/services/severity.py`, `app/services/clustering.py` and `app/tests/test_priority.py`.
