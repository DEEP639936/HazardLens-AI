# HazardLensAI — Contribution Evidence Template

**Purpose:** one filled copy of this template per contributor, attached to the final submission (PDF or markdown) as verifiable evidence of individual contribution. Rules: cite only artifacts you actually touched; every claim needs a commit hash, PR link, screenshot, or test transcript; the percentage table must sum to **exactly 100%** across the team (i.e., each member's row is their share of the whole project); a peer confirms the row.

> Copy the block below once per contributor. Keep section headings; delete nothing (write "None" where applicable).
> The filled **EXAMPLE** at the bottom shows the expected level of specificity — including how to cite engine source code, an API route, and browser verification for the priority engine.

---

## Contributor Entry — `<TEMPLATE — copy per person>`

### 1. Contributor
- **Name:**
- **Role / responsibility (one line):** e.g., "Backend lead — auth, review workflow, audit trail"
- **Agent/task IDs worked under (if applicable):**

### 2. Feature / Module Ownership
- **Module(s) owned (end-to-end):**
- **Modules contributed to:**
- **Documentation authored (files under docs/):**

### 3. Commits
| Hash (short) | Link | One-line description |
|---|---|---|
| `<abc1234>` | `<https://github.com/<org>/<repo>/commit/abc1234>` | |
| `<def5678>` | `<https://github.com/<org>/<repo>/commit/def5678>` | |

*(Add rows as needed. No commit without a description a reviewer can verify against the diff.)*

### 4. Pull Requests
| PR # | Link | Scope | Reviewers | Status |
|---|---|---|---|---|
| `<#12>` | `<https://github.com/<org>/<repo>/pull/12>` | | `@peer` | merged/open |

### 5. Screenshots / Artifacts
| Artifact | What it demonstrates | Path / link placeholder |
|---|---|---|
| Screenshot | | `<docs/evidence/<name>-screen-1.png>` |
| Diagram | | `<docs/evidence/<name>-diagram.png>` |
| Recording | | `<docs/evidence/<name>-clip.mp4>` |

### 6. Test Evidence
| Command run | Expected output | Actual result |
|---|---|---|
| `<bun run lint>` | `0 errors` | |
| `<curl -s http://localhost:3000/api/health>` | `{"status":"ok",…}` | |
| `<bun run scripts/seed.ts>` | `31 hazard reports … 3 clusters … 6 work orders` | |

*(Include a terminal transcript or screenshot per row in docs/evidence/.)*

### 7. Contribution Split

| Contributor | Areas | % |
|---|---|---|
| `<Name A>` | `<areas>` | `<xx>` |
| `<Name B>` | `<areas>` | `<xx>` |
| `<Name C>` | `<areas>` | `<xx>` |
| `<Name D>` | `<areas>` | `<xx>` |
| **Total** | | **100** |

### 8. Peer Confirmation
> *"<Contributor> delivered <modules> as described; commit and test evidence verified by <Peer name> on <date>."*
> Signature / issue link: `<link>`

---

## FILLED EXAMPLE — Priority engine + explain-priority API

*(Example row demonstrating the expected rigor — contributed under Task 1–6/8–11, live-app build.)*

### 1. Contributor
- **Name:** Agent D (example)
- **Role / responsibility:** Explainability engines — priority scoring, severity heuristic, and their API surface
- **Agent/task IDs worked under:** Task 1–6, 8–11 (live app)

### 2. Feature / Module Ownership
- **Module(s) owned (end-to-end):** `src/lib/rg/priority.ts` (5-factor priority engine, bands, factor DTOs), `src/lib/rg/severity.ts` (operational severity heuristic), API route `src/app/api/hazards/[id]/priority-explanation/route.ts`, priority wiring in `src/lib/rg/hazards.ts`
- **Modules contributed to:** `scripts/seed.ts` (priority computation for the seeded scenario, incl. the three admin overrides 82/80/64), `src/components/rg/admin/review.tsx` (override UI semantics)
- **Documentation authored:** [FINAL_REPORT.md](FINAL_REPORT.md) §3.4 & §8 (worked example 66.6 → HIGH), [MODEL_CARD.md](MODEL_CARD.md) §2

### 3. Commits
| Hash (short) | Link | One-line description |
|---|---|---|
| `<a1b2c3d>` | `<https://github.com/<org>/<repo>/commit/a1b2c3d>` | feat(rg): 5-factor priority engine with configurable weights, bands (≥80/≥60/≥35), and per-factor contribution DTOs in src/lib/rg/priority.ts |
| `<e4f5a6b>` | `<https://github.com/<org>/<repo>/commit/e4f5a6b>` | feat(api): GET /api/hazards/[id]/priority-explanation exposing score, band, weights snapshot and five factor breakdowns |
| `<c7d8e9f>` | `<https://github.com/<org>/<repo>/commit/c7d8e9f>` | feat(rg): severity heuristic (0.45·conf + 0.35·area + 0.20·classWeight, duplicate boost ≤ +0.5) in src/lib/rg/severity.ts |

### 4. Pull Requests
| PR # | Link | Scope | Reviewers | Status |
|---|---|---|---|---|
| `<#21>` | `<https://github.com/<org>/<repo>/pull/21>` | Priority engine + explanation API + seed wiring | `@lead` | merged |

### 5. Screenshots / Artifacts
| Artifact | What it demonstrates | Path / link placeholder |
|---|---|---|
| Screenshot | Admin review panel showing the factor table for a HIGH-band pothole (66.6) | `<docs/evidence/priority-factors-admin.png>` |
| Screenshot | `GET /api/hazards/{id}/priority-explanation` JSON in Swagger UI (`#/docs`) | `<docs/evidence/priority-api-swagger.png>` |
| Diagram | Factor decomposition bar for the Silk Board worked example (FINAL_REPORT §8) | `<docs/evidence/priority-waterfall.png>` |

### 6. Test Evidence
| Command run | Expected output | Actual result |
|---|---|---|
| `curl -s http://localhost:3000/api/hazards/<silk-board-id>/priority-explanation` | JSON with `score: 66.6`, `band: "HIGH"`, 5 factors, contributions summing to 66.6, weights `0.32/0.24/0.18/0.14/0.12` | matches |
| `curl -s http://localhost:3000/api/hazards/<orr-id>/priority-explanation` | `overridden: true`, `manualScore: 82`, band CRITICAL, original factors retained | matches |
| `bun run scripts/seed.ts` | seed log ends `… 3 clusters (DBSCAN 60 m / 3 pts)` and `priority scores computed` for 28 actionable reports | matches |
| Browser verification (agent-browser) | Submit Hosur Road pothole → priority computed at submission; admin override UI snapshots `overriddenBy` and keeps factor table visible | verified |

### 7. Contribution Split (team example)

| Contributor | Areas | % |
|---|---|---|
| Agent A | FastAPI/PostGIS backend, auth, migrations | 25 |
| Agent B | ML pipeline (train/eval/MLflow), sample data | 25 |
| Agent C | Infrastructure, docker-compose, CI, monitoring | 20 |
| Agent D (example row) | Priority/severity engines, explanation API, docs set | 30 |
| **Total** | | **100** |

### 8. Peer Confirmation
> *"Agent D delivered the priority engine, severity heuristic and the priority-explanation API as described; the 66.6-point worked example reproduces in-browser and via curl; overrides snapshot correctly. Verified by `<Lead>` on `<2025-09-22>`."*
> Signature / issue link: `<https://github.com/<org>/<repo>/issues/34#comment>`
