# Contributing to HazardLensAI

Thanks for helping build the road-hazard atlas. This guide covers branching, commits, code style, tests, migrations and how to log your contribution evidence.

## 1. Project layout (who owns what)

| Path | Owner / scope |
|---|---|
| `src/`, `prisma/`, `scripts/`, `package.json` | Live Next.js app (frontend + built-in API + engines) |
| `backend/` | FastAPI + PostGIS production backend (owns its `Dockerfile`) |
| `ml/` | YOLO training / ONNX inference service (owns its `Dockerfile`) |
| `infrastructure/`, `deploy/`, `.github/`, `docker-compose.yml` | Deployment, CI/CD, repo governance |
| `docs/` | Architecture, API and contribution documentation |

Read `AGENT_BRIEF.md` before your first change — it is the shared contract (domain model, engine math, API surface, brand tokens).

## 2. Branching model

- `main` — production-ready. Protected: PRs only, CI green required.
- `dev` — integration branch for the next release.
- Feature branches off `dev` (or `main` for hotfixes):
  - `feat/<scope>-<thing>` — e.g. `feat/api-cluster-recompute`
  - `fix/<scope>-<thing>` — e.g. `fix/upload-exif-strip`
  - `infra/<thing>` — e.g. `infra/fly-blueprint`
  - `docs/<thing>`
- Keep branches small and single-purpose; rebase onto the target branch before opening the PR.

## 3. Commit convention (Conventional Commits)

```
<type>(<scope>): <imperative summary>

[optional body: what & why]
[optional footer(s): BREAKING CHANGE:, Refs #123]
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore`.

Examples:

```
feat(api): add cluster recompute endpoint with bbox scoping
fix(engines): clamp recurrence norm to same-class 75 m window
ci(frontend): cache bun install via setup-bun
docs(readme): document postgis enable step for Neon
```

`feat` and `fix` on `main` drive the changelog; releases are tagged `vMAJOR.MINOR.PATCH`.

## 4. Pull request checklist

- [ ] Branch is up to date with the target branch (rebased, no merge commits).
- [ ] Conventional-commit title; description explains what/why + screenshots for UI.
- [ ] `bun run lint` and `bunx tsc --noEmit` pass (frontend changes).
- [ ] `ruff check` and `pytest` pass for backend/ml changes.
- [ ] `docker compose -f docker-compose.yml config -q` passes if compose/infra changed.
- [ ] New env vars added to `.env.example` (with comments) — never hardcode secrets.
- [ ] Migrations included & tested both directions (`upgrade head`, documented `downgrade`) when schema changes.
- [ ] Docs updated (README / module docs / AGENT_BRIEF only via lead approval).
- [ ] No new `TODO` placeholders in key flows; no `console.log`/`print` debug leftovers.
- [ ] Concurrency-safe & N+1 check for new DB access; rate limits respected for public endpoints.

## 5. Code style

- **TypeScript/Next.js**: eslint (`bun run lint`, flat config), strict types, no `any` unless justified; components kebab-case files, hooks `use-*.ts`.
- **Python**: `ruff check` (lint) with default line length 100; type hints on public functions; pytest-style tests.
- **Docker/Compose**: keep images multi-stage, non-root, with healthchecks; hadolint-clean where practical.
- Commits, IDs and file names kebab-case; env vars `UPPER_SNAKE`.

## 6. Running things locally

```bash
# Live Next.js demo (frontend + built-in API, Prisma/SQLite)
bun install && bun run db:push && bun run scripts/seed.ts && bun run dev   # :3000

# Full production stack (FastAPI + PostGIS + Redis + Celery + ML + MLflow + MinIO)
cp .env.example .env   # then fill secrets
docker compose up --build
# services: frontend :3000 · api :8000 (/health) · ml-inference :8100 · mlflow :5000
#           minio :9000/:9001 · db :5432 · redis :6379 · pgadmin (profile "tools") :5050
```

## 7. Tests

| Suite | Command | Notes |
|---|---|---|
| Frontend | `bun run lint && bunx tsc --noEmit` | plus `bun run build` as the integration gate |
| Backend | `docker compose exec api pytest backend/tests -q` or host: `pytest backend/tests -q` | `DATABASE_URL=sqlite:///./ci.db` enables the SQLite fallback (no PostGIS needed) |
| ML | `pytest ml/tests -q` | heavy deps (torch/onnxruntime) use `pytest.importorskip`; `ML_CI_LIGHT=1` skips model downloads |
| Infra | `docker compose -f docker-compose.yml config -q` | CI also runs optional hadolint |

Run the affected suites before pushing; CI runs them all on every PR.

## 8. Migrations

**Backend (FastAPI / Postgres — production schema):**
```bash
cd backend
alembic revision --autogenerate -m "add wards to hazard_reports"
alembic upgrade head                 # apply
alembic downgrade -1                 # revert one step (test before shipping)
```
Rules: one logical change per revision; always verify `downgrade`; never edit an applied revision — add a new one; take `pg_dump -Fc` before deploying schema changes (rollback runbook: `infrastructure/README.md §9`).

**Live app (Prisma/SQLite — sandbox demo):**
```bash
bun run db:push        # sync schema (dev only)
bun run db:generate    # regenerate client after schema edits
```

## 9. Contribution evidence

Every material contribution must be logged for project evaluation. Use the template at
**[`docs/CONTRIBUTION_EVIDENCE_TEMPLATE.md`](docs/CONTRIBUTION_EVIDENCE_TEMPLATE.md)** and append it to `worklog.md` (shared agent log) or your PR description, including: task ID, scope, artifacts produced, verification commands + outputs, and follow-ups.

## 10. Reporting issues

Open a PR or file an issue with: expected vs actual, minimal reproduction (curl command / screenshot), environment (compose service or platform), and relevant logs (`docker compose logs api worker`). For security-sensitive findings (auth, uploads, EXIF handling), do not post exploits publicly — contact the maintainers via the project lead first.
