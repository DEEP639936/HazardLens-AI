# RoadGuard Atlas — Infrastructure & Deployment Guide

Production topology for the **FastAPI + PostGIS** backend, the **Next.js** frontend, the **YOLO/ONNX ML inference** service, Celery workers, MLflow and object storage.

> Local full-stack bring-up lives in [`/docker-compose.yml`](../docker-compose.yml) (`docker compose up --build`).
> The interactive sandbox demo runs the Next.js app only (`bun run dev`, port 3000, Prisma/SQLite).

```
                        ┌───────────────┐
   Browser ──HTTPS────► │ Reverse proxy │ (Caddy/nginx or platform edge)
                        └───┬───────┬───┘
                 /          │       │  /api, /media
                    ┌───────▼──┐ ┌──▼─────┐        ┌──────────────┐
                    │ frontend │ │   api  │──────► │ ml-inference │ :8100
                    │ (Next.js)│ │ FastAPI│        └──────────────┘
                    └──────────┘ └──┬──┬──┘        ┌──────────────┐
                                    │  └─────────► │   mlflow     │ :5000
                        ┌───────────▼──┐           └──────────────┘
                        │ postgres 16  │ + PostGIS 3.4      ┌──────────────┐
                        └──────────────┘                    │    minio     │ S3
                        ┌───────────┐   ┌───────────┐       └──────────────┘
                        │   redis   │◄──│  worker   │ (Celery: video jobs,
                        └───────────┘   └───────────┘  cluster recompute, …)
```

## 1. Environments at a glance

| Tier | Recommended | Alternatives | Notes |
|---|---|---|---|
| Frontend | **Vercel** | Netlify, Cloudflare Pages, Docker on a VPS | `deploy/vercel.json` included |
| API | **Railway / Render** | Fly.io, AWS ECS Fargate | blueprints: `deploy/render.yaml`, `deploy/fly.toml` |
| Database | **Neon** (branching, PostGIS) | Supabase, Render Postgres, AWS RDS | enable the `postgis` extension |
| Object storage | **S3 / Cloudflare R2** | Cloudinary, Supabase Storage, self-host MinIO | media assets + MLflow artifacts |
| Workers | Same host as API (container) | Render worker, Fly process group | celery image: `infrastructure/docker/worker.Dockerfile` |
| MLflow | **Self-host** (compose service) | Any managed container host | SQLite backend is fine to start; switch to Postgres + S3 later |
| Monitoring | **Sentry** (`SENTRY_DSN`) | Prometheus `/metrics` + Grafana | DSN is a placeholder env var — no data leaves until set |

### Env-var contract

Every variable is documented in [`/.env.example`](../.env.example). Compose service names map to the URLs the API expects:

| Var | Compose value | Where else |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://roadguard:roadguard@db:5432/roadguard` | Neon/Render/RDS connection string |
| `REDIS_URL` | `redis://redis:6379/0` | managed Redis URL |
| `JWT_SECRET` | set in `.env` | platform secrets |
| `INFERENCE_SERVICE_URL` | `http://ml-inference:8100` | `https://<ml-app>.fly.dev` etc. |
| `MLFLOW_TRACKING_URI` | `http://mlflow:5000` | managed MLflow URL |
| `S3_ENDPOINT`/`S3_BUCKET`/`S3_*` | MinIO `http://minio:9000` | R2/S3/Supabase endpoints |
| `SENTRY_DSN` | *(empty)* | Sentry project DSN |

## 2. Frontend (Next.js)

### Vercel (recommended)
1. Import the repo; Vercel auto-detects Next.js 16 (`deploy/vercel.json` pins `bun install --frozen-lockfile` + `bun run build`, region `bom1`).
2. Environment variables (Production + Preview):
   - `NEXT_PUBLIC_API_BASE_URL=https://api.roadguard.example` (the FastAPI base URL)
   - `NEXT_PUBLIC_APP_NAME=RoadGuard Atlas`
   - `NEXT_PUBLIC_MAP_TILES_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png`
   - `NEXT_PUBLIC_SENTRY_DSN=` *(optional, placeholder)*
3. Deploy. Rollback: **Deployments → previous → Promote to Production** (or `vercel rollback <url>`).

### Netlify
- Build command `bun run build`, publish `.next` via `@netlify/plugin-nextjs`; same `NEXT_PUBLIC_*` env vars as above.

### Docker (self-host)
```bash
docker build -f infrastructure/docker/frontend.Dockerfile -t rg-frontend .
docker run -p 3000:3000 -e NEXT_PUBLIC_API_BASE_URL=http://api.internal:8000 rg-frontend
```

> `next.config.ts` uses `output: "standalone"`; the runner stage is a non-root `node:20-alpine` process with a built-in `HEALTHCHECK` on `GET /`. A bun-based build (`oven/bun:1-alpine`) works too — see the Dockerfile header.

## 3. Backend API (FastAPI)

The backend owns its own image (`backend/Dockerfile`, built from `backend/`). Choose one:

### Railway
- New service → **Deploy from repo**, root directory `backend/`, Railway picks up `backend/Dockerfile`.
- Add plugins: Postgres (enable `CREATE EXTENSION postgis;` via the query console) and Redis.
- Set the env contract above; start command comes from the Dockerfile (`uvicorn … --port $PORT`).
- Health check path: `/health`.

### Render (blueprint)
```bash
# deploy/render.yaml provisions api + worker + ml-inference + postgres + redis
# Render → New → Blueprint → select repo (point the blueprint at the repo root)
```
PostGIS on Render: run `CREATE EXTENSION IF NOT EXISTS postgis;` once after first boot. `DATABASE_URL` is injected from the database resource; the code normalizes `postgresql://` → `postgresql+psycopg://`.

### Fly.io
```bash
fly launch --no-deploy --dockerfile backend/Dockerfile --name roadguard-api --region bom
fly postgres create --name roadguard-db --region bom          # Flex supports postgis
fly postgres attach roadguard-db --app roadguard-api           # sets DATABASE_URL secret
fly postgres connect roadguard-db -c "CREATE EXTENSION IF NOT EXISTS postgis;"
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
fly deploy        # uses deploy/fly.toml (health check /health, bom region)
```

### AWS ECS Fargate (outline)
1. ECR repos: `rg/api`, `rg/worker`, `rg/frontend`, `rg/ml` (CI pushes these on `v*` tags).
2. Task definitions: API (2 vCPU/4 GB), worker (1 vCPU/2 GB, same image, celery entrypoint), ml-inference (2 GB+ for weights).
3. Networking: private subnets + RDS (Postgres 16, `postgis` via parameter group/`CREATE EXTENSION`), ElastiCache Redis, S3 bucket with SSE, ALB with health check `GET /health → 200`.
4. Secrets in AWS Secrets Manager → task definition `secrets:` mapping (`DATABASE_URL`, `JWT_SECRET`, `S3_*`, `SENTRY_DSN`).
5. Migrations: one-off ECS task running `alembic upgrade head` before the API service update (CodeDeploy hook or CI step).

## 4. Managed PostgreSQL + PostGIS

| Provider | How to enable PostGIS |
|---|---|
| **Neon** | `CREATE EXTENSION postgis;` in the SQL editor (supported on all plans) |
| **Supabase** | Database → Extensions → `postgis` (GUI toggle) |
| **Render** | ships with PostGIS → `CREATE EXTENSION IF NOT EXISTS postgis;` |
| **AWS RDS** | `CREATE EXTENSION postgis;` (postgis is available on RDS Postgres; add to `shared_preload_libraries` not required) |

After the database exists, run migrations (in `backend/`):

```bash
export DATABASE_URL="postgresql+psycopg://roadguard:<pw>@<host>:5432/roadguard?sslmode=require"
alembic upgrade head          # create/evolve the schema
alembic current               # verify revision
```

Backups: provider PITR (Neon/RDS/Render) **plus** a pre-deploy dump in CI/deploy scripts:

```bash
pg_dump -Fc "$DATABASE_URL" > "backups/pre-upgrade-$(date +%F-%H%M).dump"
# restore: pg_restore -d "$DATABASE_URL" --clean --if-exists backups/<file>.dump
```

## 5. Object storage

- **S3 / Cloudflare R2** — `STORAGE_BACKEND=s3`, set `S3_ENDPOINT` (R2: `https://<account>.r2.cloudflarestorage.com`), `S3_BUCKET=roadguard-media`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION=auto` (R2) / `us-east-1` (AWS), `S3_FORCE_PATH_STYLE=false` (true for MinIO).
- **Cloudinary** — `STORAGE_BACKEND=cloudinary`, `CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud>`.
- **Supabase Storage** — use its S3-compatible endpoint (Project → Storage → S3 connection) with the same `S3_*` vars.
- **Local / MinIO (compose default)** — `STORAGE_BACKEND=local`, `UPLOAD_DIR=/app/uploads`, or `STORAGE_BACKEND=s3` with `S3_ENDPOINT=http://minio:9000` + `S3_FORCE_PATH_STYLE=true`; the `minio-init` one-shot creates the `roadguard-media` bucket.

Upload rules enforced by the API (mirror in CDN config): images jpeg/png/webp ≤ 12 MB, video mp4/webm/quicktime ≤ 60 MB; EXIF is always stripped, GPS honored only with user consent. Serve media through authenticated `/media/{id}` or short-lived signed URLs — keep the bucket private.

## 6. MLflow

- **Compose (default)**: service `mlflow` on `:5000`, SQLite backend + `/mlflow/artifacts` volume; `MLFLOW_TRACKING_URI=http://mlflow:5000`.
- **Self-host elsewhere**: same `ghcr.io/mlflow/mlflow` image; for durability switch to
  `--backend-store-uri postgresql+psycopg://…` and `--artifacts-destination s3://roadguard-mlflow` (set `AWS_*`/`MLFLOW_S3_ENDPOINT_URL`).
- **Managed**: Databricks-hosted tracking server or any container PaaS; point `MLFLOW_TRACKING_URI` at it and add auth token envs as needed.
- Model versions are registered in `model_versions` (`weights_ref`, `mlflow_run_id`) — promotion to production = update `MODEL_PATH`/weights ref + restart `ml-inference`.

## 7. Error monitoring & metrics

- **Sentry (placeholder)**: every service accepts `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`; empty DSN = fully local, no telemetry. Create a Sentry project per tier and paste the DSNs into platform secrets.
- **Prometheus**: the API exposes `/metrics` (text format) — scrape from Grafana Agent/Prometheus; alert on `http_5xx`, queue depth (celery), `pg` connections.
- **Health checks**: `GET /health` on api (:8000) and ml-inference (:8100); `GET /` for the frontend; compose adds container-level `HEALTHCHECK`s for every service (see `docker-compose.yml`).

## 8. Reverse proxy (production)

Documented-only snippets — drop into your own Caddy/nginx config (the repo-root `Caddyfile` belongs to the sandbox dev proxy; don't ship it).

**Caddy** — automatic TLS, tiny config:

```caddy
api.roadguard.example {
    reverse_proxy api:8000            # FastAPI (docker network or host:port)
}
roadguard.example {
    handle /api/*  { uri strip_prefix /api; reverse_proxy api:8000 }
    handle /media/* { reverse_proxy api:8000 }
    handle          { reverse_proxy frontend:3000 }   # Next.js standalone
}
```

**nginx** — equivalent:

```nginx
upstream rg_api      { server api:8000; }
upstream rg_frontend { server frontend:3000; }

server {
    listen 443 ssl http2;
    server_name roadguard.example;
    # ssl_certificate … (or run behind Caddy/Traefik for ACME)

    client_max_body_size 64m;            # 60 MB video uploads + overhead

    location /api/  { proxy_pass http://rg_api/;  include /etc/nginx/proxy_params; }
    location /media/ { proxy_pass http://rg_api;  include /etc/nginx/proxy_params; }
    location /      { proxy_pass http://rg_frontend; include /etc/nginx/proxy_params; }
    location /health { proxy_pass http://rg_api/health; access_log off; }
}
```

## 9. Rollout & rollback

### Blue/green (compose hosts)
1. Keep the current stack running as **blue** (project `roadguard-blue`, API on `:8000`).
2. Bring up **green** with the new tag: `TAG=v1.2.0 docker compose -p roadguard-green up -d` (override `image:` tags via `.env`), API port mapped to `:8001`.
3. Smoke test green (`/health`, login, submit report, map load), then flip the proxy upstream to `:8001`.
4. Drain blue (`docker compose -p roadguard-blue down`) after the observation window.

On platforms: deploys are atomic (Render/Fly create a new release and shift traffic); pin **image tags per release** (`ghcr.io/<repo>/api:v1.2.0`, pushed by `.github/workflows/deploy.yml` on `v*` tags) so any deployment can be pinned back instantly.

### Database rollback
- Migrations are alembic-managed and forward-only by default.
- **Before every upgrade**: take the `pg_dump -Fc` snapshot (§4).
- Schema rollback: `alembic downgrade -1` (or to a known revision) — only when the new code is also rolled back; never downgrade a schema the running code depends on.
- Data corruption: restore `pg_restore -d "$DATABASE_URL" --clean --if-exists backups/pre-upgrade-<tag>.dump`, then re-run `alembic upgrade head` to the target revision.
- Order of operations for a full rollback: proxy → previous app tag → verify `/health` → `alembic downgrade` only if the previous app version requires the older schema.

### Release flow (CI/CD)
- Push `v1.2.3` → `.github/workflows/deploy.yml` builds `frontend|backend|worker|ml` → GHCR (`:1.2.3`, `:1.2`, `:latest`) → POSTs `DEPLOY_HOOK_URL` (repo secret) with the tag.
- Configure the hook on Render (Deploy hook), Railway (Webhook), Vercel (Deploy hook) or your SSH/Ansible runner.
- CI (`.github/workflows/ci.yml`) gates every PR: frontend (bun lint/tsc/build), backend (ruff+pytest, SQLite fallback), ml (ruff+pytest, light mode), compose-config validation + optional hadolint.

## 10. File map

```
infrastructure/
├── README.md                    ← this guide
└── docker/
    ├── frontend.Dockerfile      Next.js standalone image (node:20-alpine, bun alternative documented)
    └── worker.Dockerfile        Celery image (python:3.11-slim, packages backend/requirements.txt)
deploy/
├── vercel.json                  frontend blueprint (Vercel)
├── render.yaml                  api+worker+ml+postgres+redis blueprint (Render)
└── fly.toml                     api (+ commented ml companion) on Fly.io
docker-compose.yml               full local/prod stack (8 services + optional pgadmin)
.github/workflows/ci.yml         PR/push CI (4 jobs)
.github/workflows/deploy.yml     tag-driven GHCR publish + deploy hook
.env.example                     canonical env contract (never commit real secrets)
```
