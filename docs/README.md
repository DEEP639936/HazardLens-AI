# HazardLensAI — Documentation Hub

**Road Hazard Mapping using Vision, Geospatial Clustering and Maintenance Prioritization**

HazardLensAI turns citizen photos and dashcam clips into an actionable, explainable maintenance plan for city roads. A computer-vision pipeline detects and classifies seven road-hazard types (pothole, crack, surface erosion, waterlogging, broken road marking, debris, road-edge damage), the platform geolocates each report, groups nearby reports into clusters with DBSCAN (60 m / 3 points over a 90-day window), and scores every hazard on an explainable 0–100 maintenance-priority scale — a weighted blend of detection severity, cluster density, road criticality, recurrence, and unresolved age. Moderators approve, correct, merge, or flag AI triage in a human-in-the-loop review queue; every accepted hazard flows onto a public map and a work-order board that tracks repairs from `REPORTED` to `RESOLVED`. The shipped demo runs as a Next.js fullstack app on port 3000 seeded with a realistic Bengaluru scenario (31 hazards, 3 clusters, 6 work orders); the production blueprint pairs a FastAPI + PostGIS backend with a YOLO inference service, Celery/Redis workers, MLflow model governance, and MinIO object storage.

All documentation lives in this folder. Every document is self-contained and cross-linked; numbers (weights, thresholds, limits, demo accounts) are consistent across the set.

## Document Index

| Document | What it covers | Primary audience |
|---|---|---|
| [SYSTEM_CARD.md](SYSTEM_CARD.md) | System scope, demo vs production architecture, data-flow diagram, security & privacy controls, known limitations, monitoring, rollback strategy | Engineers, reviewers, security assessors |
| [MODEL_CARD.md](MODEL_CARD.md) | Vision model details, training-data licenses, intended vs out-of-scope use, evaluation metrics, bias & fairness, failure cases, model maintenance plan | ML engineers, evaluators, ethics reviewers |
| [ADMIN_GUIDE.md](ADMIN_GUIDE.md) | Step-by-step moderator/admin workflows: review queue, merge, priority overrides, cluster console, work-order board, analytics, exports, audit log, settings, troubleshooting | Municipal moderators, operators |
| [USER_GUIDE.md](USER_GUIDE.md) | Citizen onboarding, the 3-step report wizard, media constraints, AI preview, location & privacy controls, tracking, notifications, FAQ | Citizens, field staff |
| [FINAL_REPORT.md](FINAL_REPORT.md) | Full academic report: abstract, problem statement, methodology, architecture, evaluation, results, limitations, future work, references | Academic evaluators, project mentors |
| [PRESENTATION_OUTLINE.md](PRESENTATION_OUTLINE.md) | 14-slide deck outline with talking points, speaker notes, and recommended visuals | Presenters, demo day |
| [DEMO_VIDEO_SCRIPT.md](DEMO_VIDEO_SCRIPT.md) | 6-minute screencast script with exact URLs, clicks, narration, and lower-thirds | Video editor, presenters |
| [CONTRIBUTION_EVIDENCE_TEMPLATE.md](CONTRIBUTION_EVIDENCE_TEMPLATE.md) | Reusable template for documenting individual contributions with commit/PR/test evidence, plus a filled example | All team members |
| [API_GUIDE.md](API_GUIDE.md) | Authentication flow and 10 representative REST calls with curl examples and expected JSON, OpenAPI pointer | Integrators, frontend/backend devs |
| [GITHUB_SETUP.md](GITHUB_SETUP.md) | Publishing to GitHub: repo creation, first push, CI verification, secrets, branch protection, release tags, post-push checklist | Maintainers |

## Quick Facts

| Item | Value |
|---|---|
| Live demo | Next.js fullstack app, `bun run dev` → http://localhost:3000 |
| Demo accounts | `admin@roadguardatlas.dev` / `Atlas@Admin2024` (admin) · `citizen@roadguardatlas.dev` / `Atlas@User2024` (citizen) |
| Production stack | docker compose: `frontend` · `api` (FastAPI) · `postgres+postgis` · `redis` · `worker` (Celery) · `mlflow` · `minio` |
| Priority weights | severity 0.32 · density 0.24 · road criticality 0.18 · recurrence 0.14 · age 0.12 (admin-configurable, must sum to 1.00) |
| Priority bands | ≥ 80 CRITICAL · ≥ 60 HIGH · ≥ 35 MEDIUM · else LOW |
| Clustering defaults | DBSCAN, eps 60 m, minPts 3, 90-day window, Haversine metric |
| API contract | http://localhost:3000/api/openapi.json · interactive Swagger UI at `http://localhost:3000/#/docs` |
| Brand | Strict light theme — Ultra Violet `#6A00F4`, Soft Apricot `#FFD6A5`, Porcelain `#FCFBF8` |

## Suggested Reading Order

1. **Evaluating the project academically** → FINAL_REPORT.md, then MODEL_CARD.md.
2. **Running or operating the demo** → SYSTEM_CARD.md, then ADMIN_GUIDE.md.
3. **Integrating with the API** → API_GUIDE.md, with the live OpenAPI spec open alongside.
4. **Presenting the project** → PRESENTATION_OUTLINE.md and DEMO_VIDEO_SCRIPT.md.
