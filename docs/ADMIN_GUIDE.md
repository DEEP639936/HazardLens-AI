# HazardLensAI — Admin Guide

**Audience:** municipal moderators and platform operators (role `ADMIN`).
**Live demo:** http://localhost:3000 · sign in at `http://localhost:3000/#/signin` with **admin@roadguardatlas.dev / Atlas@Admin2024**.
Companion docs: [USER_GUIDE.md](USER_GUIDE.md) (citizen side), [API_GUIDE.md](API_GUIDE.md) (raw endpoints), [SYSTEM_CARD.md](SYSTEM_CARD.md) (architecture), [MODEL_CARD.md](MODEL_CARD.md) (AI behavior).

---

## 1. Sign In

1. Open `http://localhost:3000` and choose **Sign in** (or go directly to `#/signin`).
2. Enter `admin@roadguardatlas.dev` / `Atlas@Admin2024` and submit.
3. You land on the citizen-visible map with an **Admin** entry point in the header. Your session is a 15-minute JWT access token plus a rotating 30-day refresh cookie — the SPA refreshes transparently; signing out revokes the refresh token server-side.
4. Every subsequent admin action (review, override, recompute, export, settings) is written to the audit log with your identity and IP.

## 2. Command Center KPIs

Open **Admin → Overview** (`#/admin`). Six KPI tiles summarize operations (served by `GET /api/admin/overview`):

| Tile | Meaning | Seeded demo value (approx.) |
|---|---|---|
| Actionable hazards | Reports in `PENDING_REVIEW`/`APPROVED`/`FLAGGED`, excluding merged duplicates — the working set that drives clustering and priorities | 28 |
| Pending review | Queue awaiting your decision | 8 |
| Critical (approved) | Approved hazards whose priority band is **CRITICAL** (score ≥ 80) | includes the overridden Outer Ring Road waterlogging case (82) |
| Clusters | Current DBSCAN clusters | 3 (Silk Board potholes, ORR Marathahalli waterlogging, MG Road markings) |
| Active work orders | Work orders in `SCHEDULED` or `IN_REPAIR` | 2 |
| Avg priority | Mean score over approved hazards | mid-50s |

Below the tiles, **Recent queue** lists the five newest pending reports with class, severity, priority and band — click through to open them in the review workspace.

**How to read it:** a rising *Pending review* with flat *Active work orders* means moderation (not repair) is your bottleneck. *Critical = 0* during monsoon weeks usually means overrides haven't been applied — the algorithm alone rarely crosses 80 unless severity, density and criticality all max out.

## 3. Review Queue (human-in-the-loop)

Open **Admin → Review** (`#/admin`, Review tab). Each pending report shows the evidence image with **AI bounding boxes**, detection class/confidence/engine, the suggested severity, reporter notes, map pin, and the current priority breakdown.

### 3.1 Decide: approve / reject / flag

- **Approve** — the report becomes public on the map (`APPROVED`), joins clustering, and the reporter is notified.
- **Reject** — for unconfirmable or non-hazard media (e.g., the seeded Banashankari "patched utility trench" case). The report leaves clustering; the reporter is notified with your note.
- **Flag** — for "needs eyes on site" (`FLAGGED`); flagged reports stay in the clustering scope but carry a manual-inspection badge (e.g., the seeded 27th Main Road water-vs-drain photo).

**Edit before deciding.** Before pressing a decision button you can correct the AI's suggestions in the edit panel: class, severity (1–5), pin coordinates (drag or re-geocode), address/ward, road name, road class (drives the criticality factor), and road criticality (0–1). Corrections recalculate the priority score immediately and are recorded in the audit metadata — this is the active-learning loop that feeds future retraining (see [MODEL_CARD.md](MODEL_CARD.md) §8).

**Merge duplicates (merge-by-reference).** Two citizens reported the same Silk Board pothole? Decide which report is *primary* (best photo, earliest date), then on the duplicate press **Merge** and enter the primary's reference code (`RG-XXXXXX`) in `mergeIntoId`. Semantics:

- The duplicate becomes `MERGED`, stores `duplicateOfId`, and is **excluded from clustering and scoring** (it no longer double-counts density).
- The **primary keeps the evidence**: the merge strengthens the primary's recurrence/severity context — duplicates are a signal, not noise, and the reporter is told exactly that ("duplicates raise the cluster's priority").
- You cannot merge into a rejected or already-merged hazard; the API rejects self-merge.
- Both the merge and the recompute of the primary's priority are audited.

**Manual priority override semantics.** For cases where field knowledge beats the formula (the seeded monsoon-emergency on Outer Ring Road, overridden to **82 CRITICAL**), set a **manual score 0–100** in the review panel. Semantics:

- The score is **snapshotted**: `priority_scores` stores `overridden = true`, your email as `overriddenBy`, the manual score, and the original factor breakdown stays inspectable in `explanation_json`.
- The band follows the manual score (≥80 CRITICAL, ≥60 HIGH, ≥35 MEDIUM, else LOW).
- Overrides are audited (`review.*` metadata includes `manualScore`) and visible in the UI with an "overridden" badge — algorithmic transparency is never silently lost.
- Override sparingly: consistent, documented overrides are legitimate operational judgment; undocumented mass-override erodes the model's meaning.

Every decision supports an optional **review note** (recommended — it is shown to the reporter and mined for retraining).

## 4. Cluster Console

Open **Admin → Clusters** (`#/admin`, Clusters tab). You see current clusters (`C-1 · <ward>` labels, center, radius, member count, dominant class, average/max severity) and the members list per cluster.

**Recompute.** The console posts to `POST /api/clusters/recompute` with optional parameters:

| Parameter | Range | Default | Meaning |
|---|---|---|---|
| `bbox` | `[minLng, minLat, maxLng, maxLat]` (GeoJSON order) | whole city | Scope the recompute to an area |
| `sinceDays` | 1–365 | 90 | Time window of reports considered |
| `epsM` | 10–2000 m | 60 | DBSCAN neighborhood radius |
| `minPts` | 1–50 | 3 | DBSCAN core-point threshold |

**Idempotency note:** recompute is **delete + recreate within scope** — clusters and memberships for the selected bbox/window are rebuilt from the current non-merged, non-rejected reports, so running it twice with the same parameters yields the same result. It never touches reports themselves. Because it's destructive within scope, a **recompute that is already running returns `409 Conflict`** (see troubleshooting). Every recompute is audited with its parameters and resulting counts.

Practical guidance: tighten `epsM` (e.g., 40 m) when map markers merge visually distinct defects on fast roads; raise `minPts` (e.g., 5) to demand stronger community signal before forming a cluster; shrink `sinceDays` before monsoon retrospectives.

## 5. Work-Order Board

Open **Admin → Work Orders** (`#/admin`, Board tab) — a six-column kanban:

```
REPORTED → UNDER_REVIEW → APPROVED → SCHEDULED → IN_REPAIR → RESOLVED
```

- **Create** a work order from a hazard report or cluster: the card carries the code (`WO-0001`…), title, the source reference (`RG-…`), priority score and band, and optional assignee (`assigned_to`, e.g., "Ward crew B — hotmix team") and `scheduled_for` date.
- **Move cards** by dragging (or the card menu) between columns; forward/backward transitions are allowed with a **status note** ("Crew on site; lane closed 10:00–13:00"), and every transition appends to `work_order_updates` (from → to, author, note, timestamp) — the card's history tab shows the full chain.
- **Notifications sent:** moving a card that is linked to a citizen's report notifies the reporter (e.g., "Repair crew assigned — the Hosur Road pothole cluster moved to In Repair"). Resolving a work order notifies the reporter and **dampens the hazard's age factor to 20%** in the priority engine so resolved hazards sink in rankings.
- Seeded board state: one order in each of `IN_REPAIR`, `SCHEDULED`, `APPROVED`, `RESOLVED`, `UNDER_REVIEW`, `REPORTED` — six orders across the top-priority hazards.

## 6. Analytics Interpretation

Open **Admin → Analytics** (`#/admin`, Analytics tab). Charts (recharts):

| Chart | Read it as | Watch out for |
|---|---|---|
| Totals & by-class | Composition of the actionable set; potholes usually dominate | A class spike often follows a weather event, not a road-quality change |
| By severity | The AI's severity distribution (1–5) | Reviewer edits drift this over time — that's active learning, not error |
| Severity over time | Monsoon seasonality (waterlogging spikes Jun–Sep in Bengaluru) | Compare year-over-year, not week-over-week |
| By ward | Reporting volume per ward | **Reporting-density bias**: high counts mean high reporting, not worse roads — never use this to rank wards punitively ([MODEL_CARD.md](MODEL_CARD.md) §7) |
| Priority bands | Distribution across CRITICAL/HIGH/MEDIUM/LOW | A healthy set has few CRITICALs; many = either monsoon surge or missing resolution work |
| Confidence histogram | Detection engine health | Mass near 0.5–0.6 suggests image-quality problems or model/city mismatch → check [MODEL_CARD.md](MODEL_CARD.md) §8 retrain triggers |

## 7. Exports (CSV / GeoJSON / PDF)

- **CSV** — `GET /api/export/hazards.csv` (or the Analytics "Export CSV" button): one row per hazard with reference code, class, severity, status, coordinates, ward, road class, priority score/band, timestamps. Use for spreadsheets and GIS attribute joins.
- **GeoJSON** — `GET /api/export/hazards.geojson`: FeatureCollection of point features; drops straight into QGIS/ArcGIS for ward-level choropleths.
- **PDF** — the admin board's **Export PDF** button renders a client-side summary report (jsPDF) for meeting handouts.
- Exports are **admin-only**, reflect current filters where the UI provides them, and are audited (`export.csv` with row counts).

## 8. Audit Log

Open **Admin → Audit** (`#/admin`, Audit tab) or call `GET /api/admin/audit-logs?action=review.approve`. Each row: timestamp, actor (name/email/role), **action**, entity type/id, metadata snapshot, and IP. Seeded trail includes `auth.login`, `report.create`, `review.approve`, `cluster.recompute`, `review.merge`, `work_order.create`, `work_order.update`, `settings.update`, `export.csv`.

**Action filter:** the action dropdown (and `?action=` query param) filters to a prefix — use it to answer "who changed the weights?" (`settings.update`), "what did this moderator approve?" (`review.*`), or "when was the last recompute?" (`cluster.recompute`).

## 9. Settings

Open **Admin → Settings** (`#/admin`, Settings tab) — backed by `system_settings` keys:

| Key | Contents | Rules |
|---|---|---|
| `priority.weights` | severity / density / criticality / recurrence / age weights (defaults 0.32 / 0.24 / 0.18 / 0.14 / 0.12) | **Must sum to 1.00** (±0.001); the UI sliders normalize preview and the API rejects otherwise ("weights must sum to 1") |
| `cluster.params` | `epsM` 60, `minPts` 3, `sinceDays` 90 | Ranges as in §4 |
| `map.autoRecompute` | `true`/`false` | When true, approves trigger automatic in-scope cluster refresh |

Changed weights apply to **new** computations; existing `priority_scores` keep their snapshotted `weights_json`, so history stays explainable. Recompute clusters after changing `cluster.params` (§4). Model registry: `Admin → Model versions` lists registered versions (`roadguard-yolo-v1.2.0` seeded with the demo metrics, MLflow run id and dataset ref — see [MODEL_CARD.md](MODEL_CARD.md)).

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Map tiles slow or blank | Upstream OSM tile throttling / network | Reload; the demo uses public OSM tiles — production can self-host tiles behind the same origin ([SYSTEM_CARD.md](SYSTEM_CARD.md) §5) |
| Cluster recompute returns **409 "already-running"** | A previous recompute is still in progress (or was orphaned) | Wait for it to finish and retry; if orphaned after a restart, re-run — the operation is idempotent (§4) |
| New priority weights **rejected** | Weights don't sum to 1.00 | Adjust sliders until the sum indicator reads 1.00 (§9) |
| Media image shows **410 Gone** | The media id is unknown/expired-unlisted, or the file was removed from disk | Re-upload via the report wizard; media is addressed by unlisted ids, not guessable URLs ([SYSTEM_CARD.md](SYSTEM_CARD.md) §4) |
| Report submit returns 429 | Rate limit: 5 reports/hour/IP | Wait for the window to reset; for load tests use a staging IP allow-list |
| Inference returns the demo engine | yolo-service unreachable and GLM key absent | Check `YOLO_SERVICE_URL`, then the vision key; the chain degrades gracefully by design ([MODEL_CARD.md](MODEL_CARD.md) §1) |
| Login 401 but password is right | Refresh rotation raced / clock skew | Sign out fully (revokes refresh) and sign in again; verify server time (NTP) |


## Intelligence, Verification & Resolution upgrade (v2.1)

### Hazard lifecycle (centralized, do not scatter strings)
REPORTED -> AI_VERIFIED -> PENDING_REVIEW -> VERIFIED -> ASSIGNED -> IN_PROGRESS -> RESOLVED -> CLOSED
Terminal/auxiliary: REJECTED, MERGED, FLAGGED. Statuses live in src/lib/rg/constants.ts (STATUS_META).

### Risk & severity engine
- 0-100 risk score (severity 32% + density 24% + road criticality 18% + recurrence 14% + age 12%).
- Bands: 0-25 Low, 26-50 Moderate, 51-75 High, 76-100 Critical (BAND_META).
- Four-level severity: 1->LOW 2->MODERATE 3->HIGH 4-5->CRITICAL (severityBandOf).
- AI confidence is displayed separately from the risk score and severity - never conflate them.
- "Why this risk score?" flags are computed from stored signals only (src/lib/rg/risk.ts).
- Recommended actions are admin-configurable: Administration -> Risk rules (system_settings risk.actions).

### Duplicate detection & verification
- Candidates compared on location (45%) + class (25%) + image perceptual hash (20%) + time (10%).
- Parameters (radius/window/threshold) configurable in Administration -> Duplicates.
- Reports at/above threshold get the "Possible existing hazard" flow: Merge / View / Create new.
- Merged reports raise the canonical hazard reportCount / uniqueReporters - 12 reports != 12 potholes.

### Work orders
- Status machine: OPEN -> ASSIGNED -> IN_PROGRESS -> COMPLETED -> VERIFICATION_PENDING -> VERIFIED -> CLOSED.
  Transitions are enforced server-side (WORK_ORDER_TRANSITIONS); VERIFICATION_PENDING may be rejected back
  to IN_PROGRESS with a mandatory reason. Field workers may only start work / submit evidence on their own orders.
- Evidence: before/after images + resolution notes. Submitting the after photo auto-advances to verification.
- Departments & teams are managed in Administration -> Departments; field workers are users with the FIELD_WORKER role.

### Roles
CITIZEN (report/track) - FIELD_WORKER (execute repairs, upload evidence) - AUTHORITY (verify, merge, work orders, analytics) - ADMIN (everything + Administration console). Authorization is enforced on every API route (requireRole / requireManagement), never only in the UI.

### Audit
Every report, verification, merge, work-order transition, evidence upload, resolution decision, role change and settings edit writes an AuditLog row - surfaced in Administration -> Audit log and per-hazard via GET /api/hazards/{id}/timeline.
