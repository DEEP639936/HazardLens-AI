# HazardLensAI — Presentation Outline (14 Slides)

**Deck:** "HazardLensAI — Road Hazard Mapping using Vision, Geospatial Clustering and Maintenance Prioritization"
**Time:** ~20 minutes + demo cue at slide 6. **Tone:** editorial, light theme (Ultra Violet `#6A00F4` primary, Soft Apricot `#FFD6A5` highlight, Porcelain `#FCFBF8` background). Every slide pairs with the live app or the docs — cite [FINAL_REPORT.md](FINAL_REPORT.md) sections for depth.

---

## Slide 1 — Title

**Content**
- HazardLensAI — Road Hazard Mapping using Vision, Geospatial Clustering and Maintenance Prioritization
- One-line promise: *From citizen photos to an auditable repair plan.*
- Team, course, date; live-demo QR (http://localhost:3000 during local presentation)
- Brand lockup: Ultra Violet wordmark on Porcelain, Bodoni Moda headline

**Speaker notes:** Open with the project name and the one-line promise, then immediately promise a live demo — it anchors attention for the problem slides. Mention that everything shown runs on real working software, not mockups. Hold technical details for slide 12.

**Recommended visual:** Hero landing screenshot with an animated bounding-box scan sweeping a pothole photo (the app's landing animation) and the count-up KPI row beneath.

## Slide 2 — The Problem

**Content**
- MoRTH 2022: ~**1,856 deaths** attributed to potholes — more than five a day [FINAL_REPORT §1]
- Municipal reality: reactive complaint-driven repair; same pothole reported 10×, fixed 0×
- No shared, location-precise evidence; no transparent way to rank what gets fixed first
- Framing: citizens already carry the sensor network — the gap is *evidence engineering*

**Speaker notes:** Lead with the human number, then pivot from blame to systems failure — detection, evidence, prioritization. Emphasize that the problem is not image collection but converting noisy media into accountable action. This sets up the four-stage pipeline shown later.

**Recommended visual:** Split layout — left: news headline collage about pothole fatalities; right: a screenshot of a complaint register (fake, editorial) contrasted with the Atlas map.

## Slide 3 — Solution Overview

**Content**
- One platform: detect → verify → cluster → prioritize → dispatch → track
- Explainable 0–100 priority score on every hazard (bands: CRITICAL ≥80, HIGH ≥60, MEDIUM ≥35, LOW <35)
- Human-in-the-loop by design: AI proposes, moderators decide, audit trail remembers
- Shipped: working demo (Bengaluru scenario) + production blueprint (FastAPI/PostGIS/Celery/MLflow)

**Speaker notes:** Walk the six verbs in order and promise that slides 4–9 unpack each one. Stress "explainable" and "human-in-the-loop" as the design philosophy, not compliance afterthoughts. Name the deliverables so the audience knows there is runnable software behind the claims.

**Recommended visual:** Horizontal pipeline diagram with five icons (camera, shield-check, map pin, gauge, wrench) flowing into a work-order card labeled `WO-0001`.

## Slide 4 — How It Works (4 Stages)

**Content**
- 1 · Report: photo/video (images ≤12 MB, video ≤60 MB), EXIF stripped, GPS only with consent
- 2 · Detect: AI preview with bounding boxes + confidence; citizen corrects class/severity in one tap
- 3 · Verify & cluster: moderator approves/merges/flags; DBSCAN groups hazards within 60 m
- 4 · Prioritize & dispatch: 5-factor score → work-order board (REPORTED → RESOLVED) → citizen notified

**Speaker notes:** Narrate one report's lifecycle end-to-end in under a minute — use the Hosur Road pothole example that appears in the demo data. Highlight the privacy defaults at stage 1 and the deduplication at stage 3 as differentiators. Every stage maps to a screen you will show live at slide 6.

**Recommended visual:** Four-step numbered storyboard, each cell a cropped real screenshot: upload sheet → bbox preview → map cluster → kanban card.

## Slide 5 — Vision Model

**Content**
- YOLOv8s baseline, 7 classes: pothole, crack, erosion, waterlogging, broken marking, debris, road-edge damage
- Registered demo metrics (illustrative): mAP@50 **0.847** · mAP@50-95 **0.571** · P **0.862** · R **0.794** · 41 ms
- Resilient engine chain: YOLO service → GLM-4.5V fallback → deterministic demo engine
- Transparent severity heuristic: confidence 45% + defect extent 35% + class weight 20%

**Speaker notes:** State clearly that registry numbers are demo values and real runs come from the ml/ pipeline — honesty here builds credibility. Explain the engine chain as "graceful degradation: an outage costs capability, not availability." Show the severity formula to prove there is no black box downstream of detection.

**Recommended visual:** Annotated evidence image with two bounding boxes and confidence labels, plus a small table of the metric registry; footnote "demo-registry values — see MODEL_CARD.md".

## Slide 6 — Live Demo Cue ★

**Content**
- Sign in as admin `admin@roadguardatlas.dev` → map → Silk Board cluster pulsing
- Open RG report: bbox evidence + priority explanation, factor by factor
- Approve one pending report; watch the audit log and notification fire
- (Fallback: scripted screencast, docs/DEMO_VIDEO_SCRIPT.md)

**Speaker notes:** Pause the deck; run the demo exactly as scripted in the video script to stay in time. If the network or server misbehaves, switch to the pre-recorded fallback without apology — say "backup plan, same content." Return to the deck at slide 7.

**Recommended visual:** A single "LIVE" cue slide — dark Ultra Violet word "Demo" on Porcelain with the URL in a monospace pill; keep it on screen behind you.

## Slide 7 — Clustering

**Content**
- DBSCAN over Haversine distance: ε = 60 m, minPts = 3, window 90 days [FINAL_REPORT §7]
- Seeded Bengaluru result: 3 clusters — Silk Board potholes · ORR Marathahalli waterlogging · MG Road markings
- 9 reports clustered, 19 correct noise points; merged duplicates strengthen the primary instead of double-counting
- Idempotent recompute with tunable ε/minPts/window (admin console)

**Speaker notes:** Explain DBSCAN in one sentence — density-connected neighborhoods, no need to guess cluster count. Use the Silk Board example: three separate reports of one physical defect become one cluster whose recurrence raises urgency. Mention the 409 guard for concurrent recomputes as an operational detail.

**Recommended visual:** Map close-up of the Silk Board cluster pulsing (screenshot from the live map), with inset showing member pins ~30–40 m apart and a 60 m radius circle overlay.

## Slide 8 — Priority Engine

**Content**
- `Priority = 0.32·severity + 0.24·density + 0.18·road criticality + 0.14·recurrence + 0.12·age` → 0–100
- Worked example: Silk Board highway pothole = 66.6 → **HIGH** (severity 32.0 + density 4.0 + criticality 18.0 + recurrence 7.0 + age 5.6)
- Resolved work orders dampen age ×0.2 — repaired hazards sink
- Admin-tunable weights (must sum to 1.00); overrides snapshotted + audited, never silent

**Speaker notes:** Walk the worked example slowly — this is the intellectual core of the project. Point out that CRITICAL (≥80) is deliberately hard to reach by formula alone, which is why documented overrides exist. Show the weights summing to exactly 1.00.

**Recommended visual:** Horizontal stacked bar decomposing 66.6 into five colored segments (each factor in its brand color), with the formula beneath and the band gauge needle at HIGH.

## Slide 9 — Human-in-the-Loop & Audit

**Content**
- Review queue: approve / reject / flag / **merge by reference**; edits before decision (class, severity, pin, road class)
- Manual priority override: snapshotted with reviewer identity + original factors kept inspectable
- Every action → audit log (actor, action, entity, metadata, IP): `review.approve`, `cluster.recompute`, `settings.update`…
- Reviewer corrections become training data — the queue is the labeling pipeline [MODEL_CARD §8]

**Speaker notes:** Tell the override story from the seed data: the Outer Ring Road waterlogging raised to 82 during a monsoon emergency, with the reason stored forever. Emphasize that transparency survives disagreement — the algorithmic score is never silently overwritten. This slide answers the "who is accountable?" question before it is asked.

**Recommended visual:** Review-queue screenshot with the bbox evidence panel open, beside an audit-log table row showing `review.approve` with actor and timestamp.

## Slide 10 — Admin Command Center

**Content**
- KPI tiles: 28 actionable hazards · 8 pending · 3 clusters · 2 active work orders · avg priority mid-50s
- Cluster console: recompute with bbox/ε/minPts/window; work-order kanban across 6 statuses
- Analytics: by class, severity over time, wards, priority bands, confidence histogram
- One-click exports: CSV, GeoJSON (straight into QGIS), PDF briefing

**Speaker notes:** Frame this as the municipal operator's morning screen — five numbers before coffee. Call out the ward chart caveat verbally: reporting density ≠ road quality, which is why ward ranking is out of scope. Mention that exports are how GIS teams consume Atlas without changing tools.

**Recommended visual:** Full-bleed screenshot of the admin command center with the six KPI tiles, and a small inset of the kanban board showing cards in IN_REPAIR and SCHEDULED.

## Slide 11 — Privacy & Ethics

**Content**
- EXIF always stripped at ingest; GPS read only with explicit, revocable consent
- Media served via unlisted ids; no public galleries; JWT 15 min + rotating refresh 30 d; bcrypt; RBAC; 5 reports/h/IP
- Out-of-scope commitments (model card): no safety certification, no accident attribution, no punitive ward ranking
- Reporting-density bias acknowledged; analytics designed for resource allocation, not blame

**Speaker notes:** This slide is for the ethics of a civic AI system: state the controls as engineering facts, not promises. Explain why "punitive ward ranking" is explicitly out of scope — it distorts reporting incentives. Invite scrutiny: the model card and system card are public documents in the repo.

**Recommended visual:** Shield motif over a photo flow diagram: camera → "EXIF stripped" stamp → consent toggle → server; a small "OUT OF SCOPE" stamp list at right.

## Slide 12 — Tech Architecture

**Content**
- Demo topology: Next.js fullstack on :3000 — 29 REST endpoints, SQLite + app-layer Haversine (PostGIS-parity formulas), 14 domain entities
- Production topology: docker-compose — FastAPI + PostGIS(GiST) · Celery/Redis worker · YOLO GPU service · MLflow registry · MinIO
- Engine chain + idempotent clustering + snapshot-based explainability as the three load-bearing decisions
- Observability: /health, Prometheus /metrics, OpenAPI 3.1 at /api/openapi.json

**Speaker notes:** Keep this fast — the audience needs the shape, not the wire diagram. Highlight the parity trick: the demo and production compute distances with identical formulas, so demo behavior predicts production behavior. Point integrators to the API guide and live OpenAPI spec.

**Recommended visual:** Two-column architecture map: left "Demo (one process)", right "Production (compose)" with PostGIS, Redis, worker, MLflow, MinIO icons; an arrow labeled "same REST contract" bridging them.

## Slide 13 — Results & Metrics

**Content**
- Browser-verified end-to-end: citizen journey (submit RG-PX6NMM with 99%-confidence detection) + admin journey (review → audit → kanban → export); mobile 390 px
- Seeded dataset: **31 hazards · 3 clusters · 28 scored · 6 work orders · 3 documented overrides (82/80/64)**
- Explainability verified: priority-explanation API returns the exact factor table used on slide 8
- Platform hygiene: lint clean, health + Prometheus metrics live, OpenAPI served, Swagger UI embedded

**Speaker notes:** Summarize what is *demonstrated* versus *designed* — the demo loop is verified; production metrics await city-specific training. The override numbers prove the governance path was exercised, not just built. Close with the honest limit: these are demo-scale results, which is exactly what the next slide's roadmap addresses.

**Recommended visual:** Dashboard-style grid of four stat cards (31 / 3 / 28 / 6) with a verification checklist strip beneath (citizen journey ✓ admin journey ✓ mobile ✓ lint ✓).

## Slide 14 — Roadmap + Ask

**Content**
- Next: federated ward dashboards · active learning from reviewer corrections · ride-quality sensor fusion (accelerometer + vision) · offline mobile reporting
- Ask 1: pilot partnership with one municipal ward (data agreement + moderation staffing)
- Ask 2: GPU credits + labeled monsoon/night imagery to close the image-condition gap
- Everything open: docs, model card, system card, API spec — take one, it's yours

**Speaker notes:** End on the two concrete asks — a pilot ward and compute/imagery support — and repeat the one-line promise from slide 1: citizen photos to auditable repair plans. Point to the documentation hub for anyone who wants depth. Thank the audience and open for questions with the map still visible if time allows.

**Recommended visual:** Timeline arrow across four quarters with the roadmap items as milestones, and two "ask" cards (ward pilot · GPU credits) highlighted in Soft Apricot.
