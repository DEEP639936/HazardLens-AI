"""Celery worker configuration (broker + results on REDIS_URL).

Run: `celery -A app.worker.celery_app worker --loglevel=info --pool=solo`
(solo pool is convenient for development; use prefork in production).
"""
from __future__ import annotations

from celery import Celery

from app.config import settings

celery_app = Celery(
    "roadguard",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.worker.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_always_eager=settings.CELERY_TASK_ALWAYS_EAGER,
    task_eager_propagates=False,
    task_track_started=True,
    worker_prefetch_multiplier=1,
    task_time_limit=30 * 60,  # hard kill at 30 min (long videos)
    task_soft_time_limit=25 * 60,
    broker_connection_retry_on_startup=True,
)
