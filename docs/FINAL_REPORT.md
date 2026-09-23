# HazardLensAI — Final Report

**Project:** Road Hazard Mapping using Vision, Geospatial Clustering and Maintenance Prioritization
**Brand:** HazardLensAI · Live demo verified on port 3000 · Bengaluru (India) demo scenario
**Companion documents:** [SYSTEM_CARD.md](SYSTEM_CARD.md) · [MODEL_CARD.md](MODEL_CARD.md) · [ADMIN_GUIDE.md](ADMIN_GUIDE.md) · [USER_GUIDE.md](USER_GUIDE.md) · [API_GUIDE.md](API_GUIDE.md)

---

## Abstract

Potholes and related road-surface defects are a persistent, deadly and expensive problem for fast-urbanizing cities, yet most municipalities still learn about them from complaint calls and repair them reactively. This report presents **HazardLensAI**, an end-to-end platform that transforms citizen photographs and videos of road hazards into a continuously updated, explainable maintenance plan. A computer-vision pipeline (YOLOv8s baseline with graceful engine fallbacks) detects seven hazard classes and proposes severity; a human-in-the-loop review queue lets moderators correct, approve, merge, or flag AI triage with a full audit trail; geographically close reports are merged into clusters using DBSCAN (Haversine metric, 60 m ε, 3-point minPts, 90-day window); and an explainable five-factor model — detection severity (0.32), cluster density (0.24), road criticality (0.18), recurrence (0.14), unresolved age (0.12) — scores every hazard 0–100 into CRITICAL/HIGH/MEDIUM/LOW maintenance bands. The delivered system comprises a fully working live demo (Next.js fullstack, 29 REST endpoints, 14 domain entities, seeded Bengaluru scenario of 31 hazards forming 3 clusters and 6 work orders, browser-verified citizen and admin journeys) and a production blueprint (FastAPI + PostGIS + Celery/Redis + dedicated YOLO service + MLflow governance + MinIO, deployed via docker-compose). We describe the methodology, architecture, evaluation protocol, clustering and priority behavior on the seeded scenario, verified results, limitations, and future work.

---

## 1. Introduction

India's Ministry of Road Transport and Highways (MoRTH) attributed approximately **1,856 deaths to potholes in 2022** [1] — more than five every day — alongside tens of thousands of injuries and enormous vehicle-damage costs. Three structural failures make this persist:

1. **Detection is reactive.** Municipal wards learn of hazards from complaint calls, councillor notes, or after an accident. There is no continuous, ground-level sensor network for road surface state.
2. **Evidence is unstructured.** Complaint photos arrive via WhatsApp and phone calls with no location precision, no severity scale, and no deduplication — the same pothole may exist ten times in a complaint register and zero times in a work-order system.
3. **Prioritization is opaque.** Scarce repair budgets are allocated by seniority, contractor availability, or political attention rather than by an explicit, auditable measure of risk and community impact.

Citizen smartphones are, in effect, an existing city-wide imaging network. The research problem is therefore not image acquisition but **evidence engineering**: converting noisy citizen media into deduplicated, verified, geospatially clustered, and transparently ranked maintenance work — with humans accountable at every consequential decision.

## 2. Objectives

1. **Detect** seven road-hazard classes — pothole, crack, erosion, waterlogging, broken road marking, debris, road-edge damage — from citizen images and video, with calibrated confidence and bounding-box evidence.
2. **Consolidate**: deduplicate and cluster nearby reports (DBSCAN over Haversine distance) so that one physical defect is one actionable entity, strengthened rather than multiplied by repeat reports.
3. **Prioritize** with an explainable 0–100 score combining severity, density, road criticality, recurrence and age, with admin-configurable weights and per-factor explanations exposed through the UI and API.
4. **Operationalize** through a human-in-the-loop review queue, a work-order lifecycle (`REPORTED → UNDER_REVIEW → APPROVED → SCHEDULED → IN_REPAIR → RESOLVED`), notifications, analytics, exports (CSV/GeoJSON/PDF), and a complete audit trail.
5. **Engineer for trust**: consent-based location handling, EXIF stripping, RBAC, rate limiting, unlisted media, Prometheus metrics, and model governance via an MLflow-backed registry.

## 3. Methodology

### 3.1 Vision pipeline

Citizen media (images ≤ 12 MB; video ≤ 60 MB, ffmpeg frame sampling) passes an engine chain: **(1)** the dedicated `yolo-service` (YOLOv8s, 7 classes) when available; **(2)** a GLM-4.5V multimodal fallback (backend-only API key) that extracts labels, boxes and confidences zero-shot; **(3)** a deterministic heuristic engine so the demonstration platform never hard-fails. Every detection stores its engine, model version, normalized bbox, `area_ratio`, confidence, derived severity, and inference latency. The severity heuristic is deliberately transparent:

```
score100 = 100 × (0.45·confidence + 0.35·min(areaRatio/0.25, 1) + 0.20·classWeight)
severity = clamp( ceil(score100 / 20) + 0.125·min(duplicates,4), 1, 5 )
classWeight: waterlogging .70, pothole .62, edge_damage .60, erosion .55, debris .50, crack .45, marking .40
```

### 3.2 Human-in-the-loop

Every report enters `PENDING_REVIEW`. Moderators may approve, reject, flag (field-inspection needed), or merge duplicates into a primary report by reference code; they may edit class, severity, pin, address, road class and criticality **before** deciding; and they may set a manual priority override which is snapshotted (`overridden`, `overriddenBy`, `manual_score`) and audited — the algorithmic factor breakdown is never destroyed. Reviewer corrections double as labeled training data for retraining ([MODEL_CARD.md](MODEL_CARD.md) §8).

### 3.3 Geospatial clustering

DBSCAN [2] runs over report coordinates using the Haversine metric, with defaults **ε = 60 m, minPts = 3**, over non-merged, non-rejected reports within a filterable bounding box and time window (**90 days** default). Noise points receive no cluster. Recompute is idempotent (delete + recreate within scope) and parameterizable per run (ε 10–2000 m, minPts 1–50, window 1–365 d). Clusters carry center, radius, member count, dominant class, and average/max severity.

### 3.4 Five-factor priority model

For each actionable report, five normalized factors are combined:

```
Priority = 100 × ( w₁·sevNorm + w₂·densNorm + w₃·critNorm + w₄·recNorm + w₅·ageNorm )
defaults: w₁=0.32 (severity), w₂=0.24 (density), w₃=0.18 (criticality), w₄=0.14 (recurrence), w₅=0.12 (age)
```

| Factor | Normalization | Rationale |
|---|---|---|
| Severity | `(severity − 1) / 4` from the 1–5 scale | Direct harm potential of the defect |
| Density | `min(neighbors / 12, 1)` — same-class reports within **120 m / 60 days** | A stretch with many hazards yields compounding risk |
| Criticality | road class lookup: highway **1.0**, arterial **0.8**, collector **0.6**, residential **0.4** (default 0.5) | Exposure (traffic volume/speed) of the location |
| Recurrence | `min(sameClassWithin75mLast30d / 4, 1)` | A repaired-and-reopened defect signals systemic failure |
| Age | `min(daysSinceCreated / 90, 1)`; if the linked work order is RESOLVED the age factor is multiplied by **0.2** | Unresolved hazards worsen over time; resolved ones must sink |

Bands: **≥ 80 CRITICAL** (immediate action), **≥ 60 HIGH** (schedule urgently), **≥ 35 MEDIUM** (planned maintenance), else **LOW** (monitor). Weights are admin-configurable (`system_settings.priority.weights`, must sum to 1.00) and are snapshotted into every `priority_scores` row (`weights_json`, `explanation_json`) so historical scores remain explainable under later policy changes.

## 4. System Architecture

### 4.1 Live demo topology

A single Next.js (React 19, Tailwind 4) fullstack process on port 3000 serves a hash-routed SPA (`#/map`, `#/report`, `#/dashboard`, `#/admin`, `#/docs`, `#/about`), 29 REST route handlers under `/api`, the engines, JWT auth with rotating refresh tokens, and Prisma over SQLite. Spatial predicates run in the application layer (Haversine, O(n²) DBSCAN) — an explicitly documented emulation of the production PostGIS path. Media lives on local disk, streamed via unlisted ids. This topology exists so the complete product is demonstrable from one command (`bun run dev`) with zero external services.

### 4.2 Production topology

`docker compose up --build` assembles: **frontend** (static SPA), **api** (FastAPI/Uvicorn, Alembic-migrated **PostGIS** with `geography(Point,4326)` + GiST indexes), **redis** + **worker** (Celery for video extraction, batch inference, scheduled recomputes, exports), **yolo-service** (GPU inference container), **mlflow** (experiment tracking + model registry), **minio** (S3-compatible private media store). The FastAPI service mirrors the demo's REST contract path-for-path.

### 4.3 Data model (ERD description)

Fourteen domain entities plus a settings table (Prisma schema; production equivalent in Alembic):

- **users**(id, email, password_hash, name, role USER|ADMIN, ward, consent flags, created_at) — 1:N **refresh_tokens**(token_hash, expires_at, revoked_at) enabling rotation and revocation.
- **hazard_reports** — the central entity: unique `reference_code` (`RG-XXXXXX`), optional user link (guest reporting), `hazard_class`, `severity` 1–5 (+ AI-suggested counterparts), `status` (PENDING_REVIEW|APPROVED|REJECTED|MERGED|FLAGGED), coordinates, address/ward/road_name/road_class/road_criticality, notes, `geo_consent`, `blur_requested`, self-relation `duplicate_of_id` (merge-by-reference), reviewer fields, timestamps.
- **media_assets**(kind ORIGINAL|ANNOTATED|FRAME|THUMBNAIL, storage_path, mime, size, dimensions, duration, report link) — 1:N **detections**(model_version, engine, class, confidence, normalized bbox, area_ratio, severity, inference_ms).
- **hazard_clusters**(label, center, radius_m, counts, dominant class, severity stats, params_json) with **cluster_memberships**(cluster_id, report_id UNIQUE, distance_m) — the join made idempotent by recompute.
- **priority_scores**(report_id UNIQUE, score, band, the five normalized factors, weights_json, explanation_json, overridden, manual_score, overridden_by) — the explainability ledger.
- **work_orders**(code, title, description, status REPORTED→…→RESOLVED, priority, band, optional hazard_report/cluster links, assignee, schedule) with append-only **work_order_updates**(from_status, to_status, note, author).
- Cross-cutting: **audit_logs**(actor, action, entity, metadata_json, ip), **notifications**(user, type, title, body, read), **model_versions**(version, framework, weights_ref, metrics, dataset_ref, mlflow_run_id), **inference_jobs**(media, status QUEUED|RUNNING|SUCCEEDED|FAILED, progress, result_json), **system_settings**(key → value_json).

### 4.4 API groups

| Group | Endpoints | Access |
|---|---|---|
| Auth | `auth/register`, `auth/login`, `auth/refresh`, `auth/logout`, `auth/me`, `auth/forgot-password`, `auth/reset-password` | public / session |
| Profile | `users/me` (GET/PATCH), `users/me/notifications` | USER |
| Reporting | `reports` (GET own / POST public, rate-limited 5/h/IP), `reports/{id}` | USER |
| Public catalog | `hazards` (filterable), `hazards/{id}`, `map`, `clusters` | public |
| Moderation | `hazards/{id}/review` (approve/reject/flag/merge + edits + override), `hazards/{id}/priority-explanation` | ADMIN (explanation public) |
| Intelligence | `uploads`, `media/{id}`, `inference`, `inference/jobs/{id}` | public upload, unlisted media |
| Operations | `clusters/recompute`, `work-orders` (GET/POST), `work-orders/{id}` (GET/PATCH) | ADMIN (writes) |
| Governance | `admin/overview`, `admin/audit-logs`, `admin/settings`, `admin/model-versions`, `export/hazards.csv`, `export/hazards.geojson` | ADMIN |
| Platform | `health`, `metrics`, `openapi.json` | public |

Full contract: [API_GUIDE.md](API_GUIDE.md) and `/api/openapi.json` (OpenAPI 3.1).

## 5. Implementation

**Stack (live demo):** TypeScript, Next.js 16 / React 19, Tailwind 4 + shadcn/ui, Prisma + SQLite, Leaflet + OSM tiles, bcryptjs, jose (JWT), recharts, jsPDF, ffmpeg for video frames, Bun runtime. **Production:** Python/FastAPI, SQLAlchemy + Alembic, PostGIS, Celery/Redis, Ultralytics YOLOv8, MLflow, MinIO, docker-compose, GitHub Actions CI.

**Key engineering decisions:**

1. **Engine chain with graceful degradation.** Detection availability must not equal platform availability: if the GPU service is down, inference falls to the multimodal fallback and then to the deterministic engine, storing which engine served each detection. This converts an outage from a hard failure into a capability degradation ([MODEL_CARD.md](MODEL_CARD.md) §1).
2. **Hash-routed SPA.** Deep links live in `#/…` fragments, making the front end portable to any static host/CDN and independent of server rewrites — a deliberate trade-off accepted for deployment simplicity ([SYSTEM_CARD.md](SYSTEM_CARD.md) §5).
3. **App-layer Haversine vs PostGIS parity.** The demo computes distances/clusters in TypeScript with the same formulas, units and defaults the production PostGIS service uses (`ST_DWithin`/`ST_Distance` on geography). Parity is by construction — identical constants (Earth radius 6,371,000 m), identical ε/minPts — so demo behavior predicts production behavior at city scale, while production gains GiST-indexed scalability.
4. **Snapshot-based explainability.** Scores, weights and factor breakdowns are immutable rows; weight changes never rewrite history; overrides layer on top visibly.
5. **Privacy at ingest.** EXIF stripping happens during upload re-encoding regardless of consent; consent only governs whether GPS is *read* for pin prefill — making the privacy guarantee independent of UI state.
6. **Idempotent recompute.** Clustering is destructive-within-scope and repeatable, simplifying both scheduling (auto-recompute on approval) and failure recovery (409 on concurrent runs; safe to retry).

## 6. Model Evaluation

**Protocol:** fixed test split held out **by corridor** (not random frames) to prevent near-duplicate leakage; confidence threshold 0.25; per-class AP alongside means; p50 single-image latency on the serving container. **Metrics registry (illustrative demo values — registered version `roadguard-yolo-v1.2.0`, MLflow run `d41f0a2c7c1943b8ab52e91d0c3a7f11`; real figures must be produced by the `ml/` pipeline per deployment):**

| Metric | Value |
|---|---|
| mAP@50 | 0.847 |
| mAP@50–95 | 0.571 |
| Precision | 0.862 |
| Recall | 0.794 |
| Latency | 41 ms/image |

**Per-class note:** aggregates mask the expected spread — large high-contrast targets (potholes, waterlogging) lead; thin/faint targets (cracks, faded markings) trail and drive the mAP@50–95 gap. The class-weighted severity heuristic and reviewer corrections are the operational compensations; recall shortfalls are tolerable in a human-in-the-loop system, precision shortfalls are not. Full treatment (training data licenses, bias, failure modes, maintenance plan): [MODEL_CARD.md](MODEL_CARD.md).

## 7. Map Clustering

With defaults (ε 60 m, minPts 3, 90-day window) the seeded Bengaluru scenario (31 reports; clustering scope = non-merged, non-rejected = 28) produces **three clusters**:

| Cluster | Location / corridor | Members | Dominant class | Behavior demonstrated |
|---|---|---|---|---|
| **C-1** | Silk Board Junction, Hosur Road (≈ 12.9172 N, 77.6230 E) | 3 potholes (42 d, 28 d, 19 d old; conf 0.93/0.89/0.86) + 1 citizen report **merged** into the primary | pothole | Highway corridor cluster; merged duplicates excluded from geometry but strengthen recurrence → priority |
| **C-2** | Outer Ring Road, Marathahalli Bridge (≈ 12.9560 N, 77.7014 E) | 3 waterlogging reports (21 d, 15 d, 9 d) | waterlogging | Monsoon cluster; the primary is admin-overridden to 82 (CRITICAL) as a documented field-inspection emergency |
| **C-3** | MG Road metro crossing (≈ 12.9754 N, 77.6063 E) | 3 broken-marking reports (34 d, 26 d, 7 d; mixed APPROVED/PENDING) | marking | School-zone case escalated to 64 via documented override; shows clustering spanning review states |

The remaining 19 reports are **noise points** (no cluster) — correct behavior: isolated defects stay individual work items. Inter-member distances inside clusters are ~30–40 m (C-1, C-2) and ~40–45 m (C-3), comfortably inside ε; the nearest inter-cluster gap exceeds 4 km, so the clustering is stable against modest ε perturbation (e.g., ε = 45 m still recovers all three clusters).

## 8. Priority Model — Worked Example

**Case:** primary Silk Board pothole (highway, Hosur Road, confidence 0.93, bbox area ratio ≈ 0.20, 42 days old, 2 same-class neighbors within 120 m/60 d, 2 recurrence reports within 75 m/30 d).

**Step 1 — severity.** `score100 = 100 × (0.45×0.93 + 0.35×min(0.20/0.25,1) + 0.20×0.62) = 100 × (0.4185 + 0.28 + 0.124) = 82.25` → `ceil(82.25/20) = 5`. Duplicate corroboration would add 0.125 per extra report (≤ +0.5) before clamping.

**Step 2 — factor normalization and contribution:**

| Factor | Raw | Normalized | Weight | Contribution (points) |
|---|---|---|---|---|
| Severity | 5/5 | 1.000 | 0.32 | 32.0 |
| Density | 2 neighbors | 2/12 = 0.167 | 0.24 | 4.0 |
| Criticality | highway | 1.000 | 0.18 | 18.0 |
| Recurrence | 2 repeats | 2/4 = 0.500 | 0.14 | 7.0 |
| Age | 42 days | 42/90 = 0.467 | 0.12 | 5.6 |
| **Total** | | | | **66.6 → HIGH** |

**Step 3 — banding.** 66.6 falls in HIGH (60–79.9): "schedule urgently" — appropriate for a reopened highway pothole short of CRITICAL. The same defect *with* two more corroborating reports (density 4/12 → 8.0 points) and 90 days unresolved (12 points) would reach **75.6**; a CRITICAL verdict therefore generally requires either extreme severity + saturation or a documented **manual override**.

**Override policy.** Overrides exist for field knowledge the camera cannot see (the seeded examples: ORR waterlogging → **82** "monsoon emergency — standing water across both carriageways"; Bellary Road pothole → **80** "airport corridor, repeated tyre damage"; MG Road marking → **64** "school-zone crossing"). Rules: manual score 0–100; band follows the manual score; the override stores `overriddenBy`/`manual_score` and keeps the original factor snapshot; the UI badges overridden scores; every override is written to the audit log. This keeps an auditable chain of custody between algorithm and decision.

## 9. Results

**Verified flows** (browser-verified end-to-end on the live demo, including mobile 390 px):

- Citizen journey: landing → public map (pulsing cluster markers, heat toggle, drawer) → 3-step report wizard → upload with GLM-vision detections at 99% pothole confidence → pin placement → submit (**RG-PX6NMM**) → dashboard timeline.
- Admin journey: sign-in → review queue with bbox evidence → approve (pending count 9 → 8) → audit log entry visible → cluster recompute console → kanban card move → analytics → CSV export.
- Platform checks: lint clean; health + Prometheus metrics endpoints live; OpenAPI 3.1 spec served; Swagger UI embedded in the docs page.

**Seeded demo dataset statistics (Bengaluru scenario):**

| Quantity | Value |
|---|---|
| Hazard reports | **31** (19 APPROVED, 8 PENDING_REVIEW, 1 FLAGGED, 1 MERGED, 2 REJECTED) |
| Clusters (DBSCAN 60 m / 3 pts) | **3** (Silk Board potholes · ORR Marathahalli waterlogging · MG Road markings), 9 members, 19 noise points |
| Priority-scored reports | **28** (all actionable), with 3 documented admin overrides (82 / 80 / 64) |
| Work orders | **6** — one in each state: IN_REPAIR, SCHEDULED, APPROVED, RESOLVED, UNDER_REVIEW, REPORTED |
| Users | 3 (admin Riya Menon; citizen Arjun Rao with consent on; field user Kavya Shetty with consent **off** — demonstrates the privacy path) |
| Detections | 31 (engine `yolo-service` label, model `roadguard-yolo-v1.2.0`, inference 38–68 ms, confidence 0.55–0.93) |
| Notifications / audit rows | 6 citizen notifications; 10-row audit trail spanning `auth.login` → `export.csv` |

**Qualitative results.** The explainability surface works as designed: `GET /hazards/{id}/priority-explanation` returns the five factors with raw values, normalizations, weights, contributions and human-readable notes (§8 table is its literal output); the merged-duplicate path demonstrably excludes the duplicate from clustering while crediting the primary's recurrence; the RESOLVED work order dampens its hazard's age factor (×0.2) as intended.

## 10. Limitations

1. **Demo-registry metrics.** The registered evaluation numbers are illustrative; operational deployment requires city-specific training and evaluation ([MODEL_CARD.md](MODEL_CARD.md)).
2. **Spatial emulation in the demo.** Application-layer Haversine (O(n²)) matches PostGIS semantics but not its scalability; production must use PostGIS prefiltering.
3. **Reporting-density bias.** The map reflects reporting behavior, not road quality; ward-level views must never be used punitively ([MODEL_CARD.md](MODEL_CARD.md) §7).
4. **Image-condition bias.** Night/rain/blur degradation coincides with the most dangerous conditions; mitigated but not eliminated by reviewer fallbacks.
5. **Single-node rate limiting and in-process video worker** in the demo (Redis-backed limiter and Celery required for horizontal production deployments) ([SYSTEM_CARD.md](SYSTEM_CARD.md) §5).
6. **No email delivery in the demo** — password reset completes via a demo header; production requires SMTP.
7. **Ward attribution is approximate** (center-point nearest-ward, not boundary polygons).
8. **Manual overrides are a trust surface** — governed by snapshots + audit, but their quality depends on moderator discipline.

## 11. Future Work

1. **Federated ward dashboards.** Per-ward tenanted views with local moderation, aggregated city-wide — enabling municipal adoption without centralizing sensitive media.
2. **Active learning from reviewer corrections.** Continuous fine-tuning on the moderator-edit stream (class/severity edits, rejection reasons), with drift-triggered retraining already formalized in the model card.
3. **Ride-quality sensor fusion.** Accelerometer/GPS traces from bikes and buses as a complementary, camera-free signal — accelerometry finds "bumpy" segments cheaply, vision explains *why*; cross-modal validation could raise recall in low-reporting wards.
4. **Offline-capable mobile reporting.** Queue-and-sync reporting for low-connectivity areas, with consent state and EXIF stripping enforced on-device.
5. Additional roadmap items: multilingual UI/voice notes, self-hosted tiles, Redis-backed rate limiting, boundary-polygon ward assignment, and a public OpenData export feed.

## 12. Conclusion

HazardLensAI demonstrates that the missing layer between citizen smartphones and municipal repair crews is not more sensing hardware but a disciplined evidence pipeline: detection with calibrated confidence, transparent severity heuristics, geospatial deduplication through DBSCAN, an explainable five-factor priority model whose every score can be audited factor-by-factor, and a human-in-the-loop governance layer that treats moderator judgment as first-class, snapshotted data. The delivered system — a verified live demo of the complete citizen-to-repair loop over a realistic Bengaluru scenario, plus a production-grade blueprint with PostGIS, Celery, MLflow and MinIO — shows each stage operating on real interfaces rather than mock-ups. The platform's posture is deliberately conservative: it aids maintenance prioritization, it does not certify safety, and every consequential decision remains attributable to a person. Within those bounds, the approach offers cities a practical path from reactive complaint handling to transparent, evidence-ranked prevention.

## References

[1] Ministry of Road Transport and Highways, Government of India, *Road Accidents in India 2022*, New Delhi: MoRTH, 2023. (Pothole-related fatality statistics; ≈1,856 deaths attributed to potholes in 2022.)

[2] M. Ester, H.-P. Kriegel, J. Sander, and X. Xu, "A Density-Based Algorithm for Discovering Clusters in Large Spatial Databases with Noise," in *Proc. 2nd International Conference on Knowledge Discovery and Data Mining (KDD-96)*, AAAI Press, 1996, pp. 226–231.

[3] G. Jocher, A. Chaurasia, and J. Qiu, "Ultralytics YOLOv8," Ultralytics, 2023. [Software]. Available: https://github.com/ultralytics/ultralytics

[4] PostGIS Project Steering Committee, *PostGIS 3.4 Manual — Geography Type and Spatial Functions (ST_DWithin, ST_Distance)*, OSGeo, 2023. Available: https://postgis.net/documentation/

[5] M. Zaharia, A. Chen, A. Davidson, A. Ghodsi, S. A. Hong, A. Konwinski, S. Murching, T. Nyambo, A. Oguz, and M. Spann, "Accelerating the Machine Learning Lifecycle with MLflow," *IEEE Data Engineering Bulletin*, vol. 41, no. 4, pp. 39–45, 2018.

[6] M. Everingham, L. Van Gool, C. K. I. Williams, J. Winn, and A. Zisserman, "The PASCAL Visual Object Classes (VOC) Challenge," *International Journal of Computer Vision*, vol. 88, pp. 303–338, 2010. (mAP evaluation convention used for reporting.)

[7] OpenStreetMap Foundation, *OpenStreetMap — User-Generated Street Map*, 2004–. Available: https://www.openstreetmap.org (basemap tiles and city context).
