# HazardLensAI — System Card

**Road Hazard Mapping using Vision, Geospatial Clustering and Maintenance Prioritization**
Version 1.0 · Live demo verified on port 3000 · Production blueprint in `backend/`, `ml/`, `infrastructure/`

The System Card describes what the system is for, how it is deployed, how data moves through it, which guarantees it makes (and does not make), how it is observed in operation, and how to roll it back. Companion documents: [MODEL_CARD.md](MODEL_CARD.md) for the vision model, [ADMIN_GUIDE.md](ADMIN_GUIDE.md) and [USER_GUIDE.md](USER_GUIDE.md) for workflows, [API_GUIDE.md](API_GUIDE.md) for the REST surface.

---

## 1. System Scope

HazardLensAI is a **maintenance-prioritization platform**, not a safety-certification system. In scope:

- Ingesting citizen-submitted photo/video evidence of road hazards (7 classes: pothole, crack, erosion, waterlogging, broken road marking, debris, road-edge damage).
- Automatic detection, class/severity suggestion, and explainable 0–100 priority scoring (weights: severity 0.32, density 0.24, road criticality 0.18, recurrence 0.14, age 0.12; bands ≥80 CRITICAL, ≥60 HIGH, ≥35 MEDIUM, else LOW).
- Geospatial deduplication and clustering of nearby reports (DBSCAN, Haversine metric, defaults 60 m eps / 3 minPts / 90-day window).
- Human-in-the-loop moderation: approve / reject / flag / merge, with field-edit corrections and audited manual priority overrides.
- Public map visualization, citizen report tracking, in-app notifications, CSV/GeoJSON/PDF exports, audit trail, and Prometheus metrics.

Out of scope (see [MODEL_CARD.md](MODEL_CARD.md) §4): engineering-grade structural assessment, accident attribution, punitive ward ranking, or any automated dispatch without human review.

## 2. Architecture

### 2.1 Live demo topology (what runs today)

A single Next.js fullstack process serves the SPA, the REST API, and the engines — deliberately self-contained so the whole product can be demonstrated from one command (`bun run dev`, port 3000).

| Layer | Implementation | Notes |
|---|---|---|
| Frontend | React 19 + Tailwind 4, hash-routed SPA mounted at `/` (`#/map`, `#/report`, `#/dashboard`, `#/admin`, `#/docs`, `#/about`) | Strict light theme (Ultra Violet `#6A00F4` on Porcelain `#FCFBF8`); Leaflet + OSM tiles; hash routing keeps the deep links portable in any static host |
| REST API | 29 Next.js route handlers under `/api/*` mirroring the AGENT_BRIEF surface | JWT HS256 access (15 min) + rotating refresh (30 d), RBAC, rate limiting |
| Database | SQLite via Prisma (`db/custom.db`), 14 entities | Spatial predicates computed in the application layer (Haversine in `src/lib/rg/geo.ts`) — a documented emulation of PostGIS (§5) |
| Vision inference | Engine chain: **yolo-service** proxy (if `YOLO_SERVICE_URL` is set) → **glm-vision** (GLM-4.5V via `z-ai-web-dev-sdk`, backend-only key) → **demo-engine-v2** deterministic fallback | Video goes through an ffmpeg frame-sampling pipeline and returns an async job (`202` + `jobId`) |
| Media | Local disk (`uploads/`), streamed via unlisted `/api/media/{id}` URLs | EXIF stripped on every upload; GPS honored only with consent |
| Auth | Cookie sessions + `Authorization: Bearer` both supported; bcrypt cost 10; refresh rotation with revocation | Password reset uses a demo header (`x-demo-reset-token`) because no SMTP is configured (§5) |

### 2.2 Production topology (docker-compose blueprint)

`docker compose up --build` brings up the full stack (services: `frontend`, `api`, `postgres+postgis`, `redis`, `worker`, `mlflow`, `minio`):

```
            ┌────────────┐   static/API proxy    ┌─────────────────────┐
  Browser ─▶│  frontend  │──────────────────────▶│        api          │
            └────────────┘                       │  FastAPI + Uvicorn  │
                                                 └────┬───────┬────────┘
                                       SQL (Alembic)  │       │ S3 API
                                              ┌───────▼──┐  ┌─▼─────┐
                                              │ PostGIS  │  │ MinIO │
                                              │ (objects │  └───────┘
                                              │ + GiST)  │
                                              └──────────┘
        async jobs (inference, video, clustering)      model registry
   ┌────────────┐   broker    ┌──────────────┐      ┌───────────────┐
   │   worker   │◀───────────▶│    redis     │      │    MLflow     │
   │  (Celery)  │             └──────────────┘      └───────────────┘
   └─────┬──────┘
         │ gRPC/HTTP
   ┌─────▼───────────────┐
   │  yolo-service (GPU) │  Ultralytics YOLOv8s, ONNX/TensorRT export path
   └─────────────────────┘
```

- **api** — FastAPI implementing the same REST contract (paths mirrored, OpenAPI at `/openapi.json`), PostGIS `geography(Point,4326)` with GiST indexes, Alembic migrations.
- **worker** — Celery on Redis for video frame extraction, batch inference, scheduled cluster recomputes, export generation.
- **yolo-service** — dedicated inference container; the live app's engine chain proxies here first.
- **mlflow** — experiment tracking + model registry; `admin/model-versions` registers promoted runs (see [MODEL_CARD.md](MODEL_CARD.md) §8).
- **minio** — S3-compatible media object store; media IDs stay unlisted, buckets are private.

### 2.3 Data-flow diagram

```
 Citizen                   API / Engines                      Moderator                Field crew
 ───────                   ────────────                       ──────────               ──────────
   │  1. upload photo/clip      │                                 │                        │
   ├──────────────────────────▶│  2. validate MIME+size,         │                        │
   │                            │     strip EXIF (GPS only w/     │                        │
   │  3. suggested pin from     │     consent) → media asset      │                        │
   │     EXIF (if consented)    │                                 │                        │
   │                            │  4. inference POST {mediaId}    │                        │
   │  5. AI preview: class,     │     yolo-service → glm-vision   │                        │
   │     confidence, bbox,      │     → demo-engine-v2 (chain)    │                        │
   │     suggested severity     │◀──── detections + bbox ────────▶│                        │
   │                            │                                 │                        │
   │  6. confirm class/severity,├─ 7. POST /reports ─▶ hazard_report (RG-XXXXXX)           │
   │     drag pin, submit ─────▶│     severity heuristic, priority score v1                 │
   │                            │     5/h/IP rate limit                                     │
   │                            │                                 │  8. review queue       │
   │                            │                                 ├─ approve/reject/flag   │
   │                            │◀─ 9. merge duplicates ──────────┤   /merge (by reference)│
   │                            │◀─    edits + manual override ───┤   (snapshotted+audited)│
   │                            │                                 │                        │
   │                            │ 10. DBSCAN recompute (60 m/3) → hazard_clusters          │
   │                            │     + cluster_memberships (idempotent, in-scope)         │
   │                            │                                                          │
   │ 11. public map (GeoJSON)   │ 12. work orders REPORTED→…→RESOLVED ────────────────────▶│
   │ 13. notifications:         │     status transitions with notes                        │
   │     reviewed / merged /    │                                                          │
   │     crew assigned          │ 14. analytics, exports (CSV/GeoJSON/PDF), audit_logs     │
```

## 3. Operational Assumptions

1. **City scale, not national scale.** The demo DBSCAN is O(n²) over in-scope points; production prefilters with PostGIS bounding boxes. Expected volume is thousands of reports per city per quarter, not millions per hour.
2. **One operational region at a time.** Ward assignment uses a ward-atlas table (Bengaluru in the demo); new cities are onboarded with their ward/road-class data (retrain trigger in [MODEL_CARD.md](MODEL_CARD.md) §8).
3. **Reports include at least approximate location.** The report wizard requires a map pin or consented EXIF GPS; reports without any location cannot be clustered.
4. **Human moderation within a working week.** The priority engine and SLA expectations assume review queue latency of days, not seconds; CRITICAL-band items are the only ones expected to be actioned same-day.
5. **Moderators are trusted, accountable actors.** Admin actions (review, overrides, settings, exports, recomputes) are authenticated, RBAC-gated, and written to `audit_logs` with actor, IP, and metadata snapshot.
6. **Single-region deployment.** No cross-region replication; MinIO/Postgres backups are the recovery mechanism (§7).
7. **Clock discipline.** Recurrence/age factors and the 90-day clustering window depend on server time; NTP-synced hosts are assumed.

## 4. Security & Privacy Controls

| Control | Implementation |
|---|---|
| Authentication | JWT HS256 access tokens, **15-minute** expiry; rotating refresh tokens, **30-day** expiry, single-use (old token revoked on refresh, full family revocation on password reset/logout) |
| Password storage | bcrypt, cost 10; minimum length 8 enforced at register/reset |
| Session transport | `HttpOnly` cookies for the SPA plus `Authorization: Bearer` for API clients; `auth/me` accepts either |
| Authorization (RBAC) | `ADMIN`-only: hazard review actions, `clusters/recompute`, work-order writes, `admin/*` (overview, audit logs, settings, model versions), exports. `USER` role: own reports, notifications, profile |
| Rate limiting | Reports **5/hour/IP**; uploads 20/hour/IP; login 10/15 min/IP; register and forgot-password 5/hour/IP (in-memory per node — see §5) |
| Input validation | MIME sniffing (magic bytes) beyond declared `Content-Type`; size caps: images JPEG/PNG/WebP ≤ 12 MB, video MP4/WebM/MOV ≤ 60 MB; coordinate and enum validation on every write |
| EXIF & metadata | **EXIF is always stripped** on ingest (re-encode); GPS is extracted **only** when the user grants geo-consent for that upload, and used solely to prefill the map pin |
| Location consent | Separate, reversible consent flag on the account; withdrawal in the profile stops future EXIF GPS prefill |
| Media access | Stored media is served only through unlisted `/api/media/{id}` URLs; no directory listing, no public bucket; annotated copies are generated server-side |
| Audit trail | `audit_logs` record actor (id/email/role), action (`auth.login`, `report.create`, `review.approve|reject|flag|merge`, `cluster.recompute`, `work_order.*`, `settings.update`, `export.csv`, `upload.create`, `inference.*`), entity, metadata snapshot, IP, timestamp |
| Account enumeration | `forgot-password` responds identically whether or not the account exists |
| CORS | Restricted to the configured frontend origin via environment variable; no wildcard in production |
| Secrets | All keys (JWT secret, database URL, S3 credentials, vision API key) via environment variables; the GLM vision key is used **backend-only** and never shipped to the browser |
| Priority overrides | Manual scores are snapshotted (weights + factors + `overriddenBy`) into `priority_scores` and audited — the algorithmic score is never silently overwritten |

## 5. Known Limitations

1. **SQLite spatial emulation.** The live demo computes distance predicates (density, recurrence, clustering, ward lookup) in the application layer with the Haversine formula instead of PostGIS `ST_DWithin`/`ST_Distance`. Results are equivalent at city scale, but queries are O(n²) and unindexed; production uses PostGIS with GiST indexes and identical semantics (verified parity by construction — both implementations share the same formulas and defaults).
2. **No SMTP — password reset via demo header.** `auth/forgot-password` returns the one-hour reset token in the `x-demo-reset-token` response header for the demo flow only. Production must replace this with email delivery; the token is stored hashed (`reset:<sha256>`) server-side, exactly as an emailed link would consume it.
3. **Single-node, in-memory rate limiter.** Counters (reports 5/h/IP etc.) live in process memory; multiple API replicas would each keep their own counters. Production should front the limiter with Redis (the compose stack already runs Redis) or an edge WAF.
4. **In-process video worker (demo).** Video frame extraction runs as a fire-and-forget in-process task; a pod restart can orphan a job (it stays `RUNNING`). Production moves this to Celery with retry and dead-letter handling.
5. **Hash-routed SPA.** Deep links use `#/…` fragments; server-side analytics per path and some crawlers see only `/`. Accepted trade-off for a portable static deployment.
6. **Ward lookup is approximate.** Nearest-ward assignment uses ward center points (demo resolution), not admin-boundary polygons; production reverse-geocodes against real boundaries.
7. **English-only UI and notes.** Localization is on the roadmap (see FINAL_REPORT §11).
8. **Map tiles are third-party.** OSM tile availability affects map rendering; production can self-host tiles behind the same origin if required.

## 6. Monitoring & Observability

- **Health probe** — `GET /api/health` returns process + database status for load balancers and compose healthchecks.
- **Prometheus metrics** — `GET /api/metrics` exposes text-format counters/gauges: `rg_reports_total{status=…}`, `rg_detections_total`, `rg_inference_jobs{status=…}`, `rg_clusters_current`, `rg_work_orders_total{status=…}`, `rg_users_total`, `rg_build_info`. Scrape interval 15 s is sufficient; alerting suggestions:
  - `rg_inference_jobs{status="FAILED"}` increasing → engine chain degradation (check yolo-service, then GLM key, then demo fallback);
  - `rg_reports_total{status="PENDING_REVIEW"}` sustained growth beyond review SLA → moderation staffing;
  - health probe failures → database or process fault.
- **Structured logs** — inference and auth failures log engine/error detail server-side; per-request audit rows double as a security-relevant event stream.
- **Admin telemetry** — `/api/admin/overview` KPIs (actionable hazards, pending review, critical band count, active work orders, average priority) provide an operational pulse without external tooling.

## 7. Rollback Strategy

| Layer | Mechanism |
|---|---|
| Application containers | Immutable image tags per release; `docker compose` rollback = redeploy previous tag. The frontend and api are stateless, so rollback is a restart |
| Database schema | Forward-only Alembic migrations in production; every migration ships with a documented down-path and is tested against a staging copy. The demo uses Prisma `db push` with an idempotent seed (`bun run scripts/seed.ts` wipes and re-creates operational demo data) |
| Model weights | MLflow model registry is the source of truth; `admin/model-versions` maps the serving version. Rollback = re-pointing the active version to the previous registered run (weights are retained in MLflow/MinIO; never overwritten) |
| Engine chain | Automatic graceful degradation: if yolo-service is unhealthy, the chain falls to glm-vision, then to the deterministic demo engine — an outage degrades capability, not availability |
| Settings misconfiguration | Priority weights and cluster params are validated (weights must sum to 1.00) before save; every change is audited with the previous value in metadata, enabling exact restoration |
| Media | MinIO bucket versioning in production; demo media is reproducible from `sample-data/` + seed |
| Data recovery | Nightly `pg_dump` + MinIO mirror in production; RPO 24 h, RTO target 1 h by redeploying the stack and restoring dumps |
