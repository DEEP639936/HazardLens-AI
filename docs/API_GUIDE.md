# HazardLensAI — API Guide

**Live base URL:** `http://localhost:3000/api` · **OpenAPI 3.1 spec:** `GET /api/openapi.json` · **Interactive Swagger UI:** open the app's Docs page at `http://localhost:3000/#/docs` (Swagger UI iframe over the same spec).
Companion docs: [SYSTEM_CARD.md](SYSTEM_CARD.md) (architecture & security), [ADMIN_GUIDE.md](ADMIN_GUIDE.md) (operator workflows), [USER_GUIDE.md](USER_GUIDE.md) (citizen flows), [MODEL_CARD.md](MODEL_CARD.md) (AI behavior).

The production FastAPI service mirrors this exact surface (documented with the `/api` prefix for consistency); the contract, payloads and semantics below are identical in both deployments.

---

## 1. Authentication Flow

1. **Login** — `POST /api/auth/login` with email + password. The response body carries a **bearer access token** (JWT HS256, **15-minute** expiry) *and* sets `HttpOnly` cookies (`rg_access`, `rg_refresh`) for browser sessions.
2. **Use it** — send `Authorization: Bearer <access>` on API clients, or rely on cookies in the SPA. RBAC: admin-only surfaces are review, `clusters/recompute`, work-order writes, `admin/*`, and exports.
3. **Refresh** — `POST /api/auth/refresh` rotates the **30-day** refresh token (single-use; the old token is revoked atomically, the new one is set as a cookie / returned as `access`).
4. **Logout** — `POST /api/auth/logout` revokes the refresh token server-side and clears cookies.
5. Failures return `401 {"error": "..."}`; wrong credentials are also audited (`auth.login_failed`).

The examples below use the seeded demo accounts: `admin@roadguardatlas.dev / Atlas@Admin2024` (ADMIN), `citizen@roadguardatlas.dev / Atlas@User2024` (USER).

## 2. Ten Representative Requests

### 2.1 Login

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@roadguardatlas.dev","password":"Atlas@Admin2024"}'
```

```json
{
  "user": { "id": "usr_9f2c…", "email": "admin@roadguardatlas.dev",
            "name": "Riya Menon", "role": "ADMIN" },
  "access": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOi…",
  "tokenType": "bearer"
}
```

Save the token: `TOKEN=$(… | jq -r .access)`. Rate limit: 10 attempts / 15 min / IP.

### 2.2 Submit a hazard report

First upload media (`POST /api/uploads`, multipart, returns `mediaId`; EXIF stripped, GPS only with consent), optionally run `POST /api/inference {"mediaId":"…"}` for an AI preview, then create the report:

```bash
curl -s -X POST http://localhost:3000/api/reports \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "mediaIds": ["med_a1b2c3"],
    "hazardClass": "pothole",
    "severity": 4,
    "lat": 12.91723, "lng": 77.62293,
    "roadName": "Hosur Road", "roadClass": "highway",
    "notes": "Deep pothole in the left lane after the Silk Board junction.",
    "geoConsent": true
  }'
```

```json
{
  "hazard": {
    "id": "hzr_7d31…",
    "referenceCode": "RG-PX6NMM",
    "hazardClass": "pothole",
    "severity": 4,
    "status": "PENDING_REVIEW",
    "ward": "BTM Layout",
    "roadCriticality": 1.0,
    "priority": { "score": 66.6, "band": "HIGH" },
    "createdAt": "2025-09-22T09:14:03.221Z"
  }
}
```

Notes: severity is re-derived from detections when `detectionIds` are supplied; the priority score is computed immediately and explained per-factor. Rate limit: **5 reports/hour/IP** (`429` beyond).

### 2.3 List hazards with filters (public map feed)

```bash
curl -s "http://localhost:3000/api/hazards?hazardClass=pothole&hazardClass=waterlogging&status=APPROVED&band=CRITICAL&band=HIGH&bbox=77.60,12.90,77.72,12.99&limit=50"
```

```json
{
  "count": 5,
  "items": [
    {
      "referenceCode": "RG-K4T2WA",
      "hazardClass": "waterlogging",
      "status": "APPROVED",
      "lat": 12.95602, "lng": 77.70142,
      "roadName": "Outer Ring Road",
      "priority": { "score": 82, "band": "CRITICAL", "overridden": true }
    }
  ]
}
```

Supported filters: `hazardClass` (repeatable), `severityMin`/`severityMax` (1–5), `status` (repeatable), `band` (repeatable), `from`/`to` (ISO dates), `bbox=minLng,minLat,maxLng,maxLat`, free-text `q`, `limit` (≤1000). No auth required — this is the public transparency feed.

### 2.4 Explain a hazard's priority

```bash
curl -s http://localhost:3000/api/hazards/hzr_7d31…/priority-explanation
```

```json
{
  "reportId": "hzr_7d31…",
  "score": 66.6, "band": "HIGH", "overridden": false,
  "weights": { "severity": 0.32, "density": 0.24, "criticality": 0.18, "recurrence": 0.14, "age": 0.12 },
  "factors": [
    { "key": "severity",    "raw": "5/5",              "normalized": 1.0,    "weight": 0.32, "contribution": 32.0, "note": "AI confidence + bounding-box extent + hazard class, with admin override." },
    { "key": "density",     "raw": "2 nearby hazards", "normalized": 0.17,   "weight": 0.24, "contribution": 4.0,  "note": "Same-class reports within 120 m over the last 60 days." },
    { "key": "criticality", "raw": "100%",             "normalized": 1.0,    "weight": 0.18, "contribution": 18.0, "note": "Highways 1.0 · arterials 0.8 · collectors 0.6 · residential 0.4." },
    { "key": "recurrence",  "raw": "2 repeats",        "normalized": 0.5,    "weight": 0.14, "contribution": 7.0,  "note": "Repeat reports of the same class within 75 m over 30 days." },
    { "key": "age",         "raw": "42 days",          "normalized": 0.47,   "weight": 0.12, "contribution": 5.6,  "note": "Days unresolved, saturating at 90 days." }
  ]
}
```

### 2.5 Review: approve (admin)

```bash
curl -s -X POST http://localhost:3000/api/hazards/hzr_7d31…/review \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"approve","note":"Verified against street imagery and field notes."}'
```

```json
{ "hazard": { "id": "hzr_7d31…", "status": "APPROVED",
              "reviewedBy": "admin@roadguardatlas.dev",
              "reviewNote": "Verified against street imagery and field notes." } }
```

Variants: `{"action":"reject","note":"……"}`, `{"action":"flag"}`, and merge-by-reference `{"action":"merge","mergeIntoId":"<primary hazard id>","note":"duplicate"}`. Optional `edits` (class/severity/lat/lng/address/ward/roadName/roadClass/roadCriticality) are applied **before** the decision, and `manualScore` (0–100) snapshots an audited override. The reporter receives a notification; the action is audited with actor + IP.

### 2.6 Recompute clusters (admin)

```bash
curl -s -X POST http://localhost:3000/api/clusters/recompute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"epsM":60,"minPts":3,"sinceDays":90}'
```

```json
{
  "ok": true,
  "summary": {
    "scope": { "sinceDays": 90, "epsM": 60, "minPts": 3 },
    "reportsConsidered": 28,
    "clustersCreated": 3,
    "noisePoints": 19,
    "membersAssigned": 9
  }
}
```

Optional `bbox: [minLng,minLat,maxLng,maxLat]` scopes the run. The operation is idempotent (delete + recreate in scope); a concurrent recompute returns **409**. Seeded result with defaults: 3 clusters — Silk Board potholes, ORR Marathahalli waterlogging, MG Road markings.

### 2.7 Move a work order (admin)

```bash
curl -s -X PATCH http://localhost:3000/api/work-orders/wo_22aa… \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"IN_REPAIR","note":"Crew on site; lane closed 10:00-13:00."}'
```

```json
{ "ok": true, "status": "IN_REPAIR" }
```

Legal statuses: `REPORTED → UNDER_REVIEW → APPROVED → SCHEDULED → IN_REPAIR → RESOLVED`. The transition appends to the order's history, notifies the linked reporter, and recomputes that hazard's priority (a `RESOLVED` order dampens the age factor to 20%). `GET /api/work-orders/{id}` returns the card with its update history.

### 2.8 Analytics aggregate (admin)

```bash
curl -s http://localhost:3000/api/analytics -H "Authorization: Bearer $TOKEN"
```

```json
{
  "totals": { "actionable": 28, "pending": 8, "critical": 1, "resolvedWorkOrders": 1, "avgPriority": 54.3 },
  "byClass":       [ { "hazardClass": "pothole", "count": 10, "avgSeverity": 3.7 },
                     { "hazardClass": "marking", "count": 4,  "avgSeverity": 3.0 } ],
  "bySeverity":    [ { "severity": 4, "count": 9 }, { "severity": 3, "count": 8 } ],
  "severityOverTime": [ { "week": "2025-08-04", "count": 2, "avgSeverity": 3.5 } ],
  "wards":         [ { "ward": "BTM Layout", "count": 4, "avgPriority": 61.2, "critical": 1 } ],
  "priorityBands": [ { "band": "CRITICAL", "count": 1 }, { "band": "HIGH", "count": 7 } ],
  "confidence":    { "median": 0.83, "histogram": [ { "bucket": "0.6-0.7", "count": 3 } ] }
}
```

(Shape abbreviated; exact keys: `totals`, `byClass`, `bySeverity`, `severityOverTime`, `wards`, `priorityBands`, `confidence`.)

### 2.9 Exports (admin)

```bash
# CSV attribute table — one row per hazard
curl -s -o hazards.csv http://localhost:3000/api/export/hazards.csv \
  -H "Authorization: Bearer $TOKEN"
# → text/csv; reference_code,hazard_class,severity,status,lat,lng,ward,priority_score,band,…

# GeoJSON FeatureCollection for QGIS/ArcGIS
curl -s -o hazards.geojson http://localhost:3000/api/export/hazards.geojson \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [77.62293, 12.91723] },
      "properties": { "reference_code": "RG-PX6NMM", "hazard_class": "pothole",
                      "priority_score": 66.6, "band": "HIGH", "status": "APPROVED" } }
  ]
}
```

### 2.10 Prometheus metrics

```bash
curl -s http://localhost:3000/api/metrics
```

```text
# HELP rg_reports_total Total hazard reports by status.
# TYPE rg_reports_total counter
rg_reports_total{status="APPROVED"} 19
rg_reports_total{status="PENDING_REVIEW"} 8
# HELP rg_clusters_current Current hazard cluster count.
# TYPE rg_clusters_current gauge
rg_clusters_current 3
rg_detections_total 31
rg_work_orders_total{status="IN_REPAIR"} 1
rg_work_orders_total{status="RESOLVED"} 1
rg_users_total 3
rg_build_info{version="1.0.0",service="roadguard-atlas-web"} 1
```

Also available: `GET /api/health` (liveness + DB check) and `GET /api/map` (GeoJSON-ready hazards + clusters for the public map).

## 3. Error Semantics

| Status | When |
|---|---|
| 400 | Validation (bad coordinates, severity out of 1–5, weights not summing to 1.00, bad bbox order) |
| 401 | Missing/expired access token — refresh and retry |
| 403 | Role lacks permission (e.g., USER calling an admin route) |
| 404 | Unknown resource (hazard, work order, media) |
| 409 | Conflict — recompute already running, media already attached to a report, duplicate email |
| 410 | Media gone — the unlisted media id has no retrievable content |
| 415 | Unsupported media type / size cap exceeded (images ≤ 12 MB, videos ≤ 60 MB) |
| 429 | Rate limited (reports 5/h/IP, uploads 20/h/IP, login 10/15 min/IP) with `Retry-After` guidance in `detail` |

## 4. Full Reference

The complete, machine-readable contract — every route, schema and enum (`PENDING_REVIEW|APPROVED|REJECTED|MERGED|FLAGGED`, work-order statuses, hazard classes) — lives in the OpenAPI 3.1 document at `http://localhost:3000/api/openapi.json`. Browse it comfortably in the in-app Swagger UI (`#/docs`), or generate a typed client from it. Route groups: `auth/*`, `users/me*`, `reports*`, `hazards*`, `map`, `clusters*`, `work-orders*`, `analytics`, `uploads`, `media/{id}`, `inference*`, `admin/*`, `export/*`, `health`, `metrics`, `openapi.json`.
