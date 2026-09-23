# syntax=docker/dockerfile:1
###############################################################################
# RoadGuard Atlas — Celery worker (python:3.11-slim)
#
# Build context = repository root:
#   docker build -f infrastructure/docker/worker.Dockerfile -t rg-worker .
#
# This is the standalone registry image used by CI (ghcr.io/<repo>/worker).
# NOTE: `docker-compose.yml` instead builds api + worker from ./backend's own
# Dockerfile (context ./backend) with a celery command override — both paths
# stay in sync because this image simply packages backend/requirements.txt.
#
# Celery entry module is overridable at runtime (no rebuild needed):
#   docker run -e CELERY_APP=backend.app.celery_app.celery_app rg-worker
# Defaults assume backend/ exposes `celery_app` in backend/app/celery_app.py;
# adjust CELERY_APP in .env if the backend agent names the module differently.
# Periodic tasks (optional): run a second container with
#   sh -c 'celery -A "$CELERY_APP" beat --loglevel=INFO'
###############################################################################

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install pinned backend dependencies first (better layer caching)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Application code
COPY backend/ ./backend/

# Non-root runtime user
RUN useradd --system --uid 1001 --create-home celery
USER celery

ENV CELERY_APP=backend.app.celery_app.celery_app \
    CELERY_LOG_LEVEL=INFO

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD sh -c 'celery -A "$CELERY_APP" inspect ping -d "celery@$HOSTNAME" | grep -q pong'

CMD ["sh", "-c", "exec celery -A \"$CELERY_APP\" worker --loglevel=\"$CELERY_LOG_LEVEL\" --concurrency=2"]
