# GitHub Setup & Push Guide

Step-by-step instructions for publishing **HazardLensAI** to GitHub from a clean
copy of this project (or from the unzipped `HazardLensAI-github-ready.zip`).
Everything the repository needs to look professional on day one is already
included:

| Already wired up | Where |
|---|---|
| README with architecture diagram, quick starts, API table | `README.md` |
| Full documentation suite (10 documents) | `docs/` |
| Real product screenshots | `docs/screenshots/` |
| CI: lint + typecheck + build (frontend), ruff + pytest (backend, ml), compose validation | `.github/workflows/ci.yml` |
| Tag-driven release: GHCR images + deploy hook + rollback runbook | `.github/workflows/deploy.yml` |
| Environment contract (placeholders only, no secrets) | `.env.example`, `ml/.env.example` |
| Ignore rules for dependencies, databases, env files, local artifacts | `.gitignore` |
| License | `LICENSE` (MIT) |
| Contribution guide | `CONTRIBUTING.md` |
| Version history | `CHANGELOG.md` |

---

## 1. Prerequisites

```bash
git --version          # ≥ 2.40
bun --version          # ≥ 1.1  (frontend; or use Node ≥ 20 + npm)
python3 --version      # ≥ 3.11 (backend), 3.10 (ml) — optional for first push
```

A GitHub account with permission to create repositories.

## 2. Create the repository on GitHub

1. Sign in → **New repository**.
2. Repository name: `hazardlensai` (or your preference).
3. Description: `AI-powered road hazard intelligence, verification & resolution platform — vision detection, DBSCAN clustering, explainable 0–100 priority, work orders.` *(copy-paste ready)*
4. Visibility: **Public** or **Private** — both work; CI is self-contained.
5. **Do not** initialize with README / .gitignore / license — this repo already ships them (avoids merge conflicts on first push).
6. Create repository → keep the suggested remote URL handy, e.g.
   `https://github.com/<your-org>/hazardlensai.git`

Suggested topics (Repository → About → ⚙️ → Topics):
`computer-vision` · `yolo` · `fastapi` · `nextjs` · `postgis` · `dbscan` ·
`civic-tech` · `road-safety` · `geospatial` · `mlflow` · `docker-compose`

## 3. Push from the unzipped project

```bash
cd HazardLensAI                      # the folder you unzipped

git init -b main
git add .

# sanity check: none of these should appear
git status --short | grep -E '\.env$|\.next|node_modules|\.db|tool-results' || echo "clean ✔"

git commit -m "HazardLensAI v0.2.1 — initial public release"
git remote add origin https://github.com/<your-org>/hazardlensai.git
git push -u origin main
```

> **SSH instead of HTTPS?** Use `git@github.com:<your-org>/hazardlensai.git`
> and make sure your key is registered under GitHub → Settings → SSH keys.

Pushing `main` automatically triggers **CI** (`.github/workflows/ci.yml`):
frontend lint/typecheck/build, backend ruff+pytest, ml ruff+pytest,
docker-compose config validation. Watch it under the **Actions** tab.

## 4. Verify CI is green

| Job | What proves |
|---|---|
| `Frontend (bun · lint · typecheck · build)` | `bun run lint`, `tsc --noEmit`, `next build` pass |
| `Backend (python 3.11 · ruff · pytest)` | FastAPI service tests pass (SQLite CI mode) |
| `ML (python 3.10 · ruff · pytest)` | pipeline tests pass (heavy deps importorskipped) |
| `Docker (compose config · hadolint)` | compose + deploy manifests are valid |

If the backend/ml jobs show as *skipped*, confirm `backend/requirements.txt`
and `ml/requirements.txt` were committed (they are in this package).

## 5. Secrets & repo settings

**Repository secrets** (Settings → Secrets and variables → Actions) — only
needed when you want automated deploys:

| Secret | Used by | Purpose |
|---|---|---|
| `DEPLOY_HOOK_URL` | `deploy.yml` | POST endpoint (Render/Vercel/Railway webhook) triggered on `v*` tags |

`GITHUB_TOKEN` is provided automatically for GHCR image pushes — nothing to configure.

**Branch protection** (Settings → Branches → Add rule for `main`):
- Require pull request before merging *(team projects)*
- Require status checks: `Frontend (bun · lint · typecheck · build)`, `Docker (compose config · hadolint)`
- Optionally require linear history

**Actions permissions** (Settings → Actions → General): allow
*Read and write permissions* for `packages: write` (release workflow publishes
images to GHCR).

## 6. Tag a release (optional but recommended)

```bash
git tag -a v0.2.1 -m "HazardLensAI v0.2.1"
git push origin v0.2.1
```

A `v*` tag triggers `.github/workflows/deploy.yml`, which builds and pushes
versioned images to GHCR:

```
ghcr.io/<owner>/<repo>/frontend:v0.2.1
ghcr.io/<owner>/<repo>/backend :v0.2.1
ghcr.io/<owner>/<repo>/worker  :v0.2.1
ghcr.io/<owner>/<repo>/ml      :v0.2.1
```

…and calls `DEPLOY_HOOK_URL` when configured. Rollback steps live in
`infrastructure/README.md` and the header of `deploy.yml`.

## 7. What must never be committed

The included `.gitignore` already blocks these — double-check before force-adding:

| Never commit | Why | Instead |
|---|---|---|
| `.env`, `.env.local` | real secrets | copy `.env.example`, fill per environment |
| `node_modules/`, `.next/` | build artifacts | `bun install && bun run build` |
| `db/*.db` | local SQLite data | `bun run db:push && bun run scripts/seed.ts` |
| `uploads/`, `datasets/` | user media / training data | object storage (S3/MinIO), `ml/` pipeline |
| `tool-results/`, `*.zip` | local artifacts | n/a |

## 8. Post-push checklist

- [ ] README renders with the architecture diagram and screenshot gallery
- [ ] `docs/README.md` opens and links all ten documents
- [ ] Actions tab: CI green on the first push
- [ ] About panel: description + topics + website (if deployed)
- [ ] License detected as MIT (repo footer shows it)
- [ ] `.env.example` present at root and in `ml/`
- [ ] No `.db`, `.env`, or build output files in the file listing

---

*Questions about the architecture before pushing? Start with
[SYSTEM_CARD.md](SYSTEM_CARD.md) and the repository layout table in the root
[README](../README.md).*
