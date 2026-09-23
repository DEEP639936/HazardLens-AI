"""Rate limiting (slowapi) — report POST 5/hour/IP, login 10/15min/IP, uploads 20/hour/IP.

Limits are enforced per remote IP (X-Forwarded-For aware). Storage is in-memory
by default; set RATELIMIT_STORAGE_URI=redis://... for multi-worker deployments.
A custom exception handler in app.main renders RateLimitExceeded into the shared
`{"error": ..., "detail": ...}` envelope with HTTP 429.
"""
from __future__ import annotations

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import settings


def _key_func(request: Request) -> str:
    return get_remote_address(request) or "anonymous"


limiter = Limiter(
    key_func=_key_func,
    storage_uri=settings.RATELIMIT_STORAGE_URI,
    enabled=settings.RATELIMIT_ENABLED,
)


def limit_reports() -> str:
    return f"{settings.RATELIMIT_REPORT_PER_HOUR}/hour"


def limit_login() -> str:
    return f"{settings.RATELIMIT_LOGIN_PER_15MIN}/15minutes"


def limit_uploads() -> str:
    return f"{settings.RATELIMIT_UPLOAD_PER_HOUR}/hour"


def reset_all() -> None:
    """Test/dev helper: clear every counter."""
    try:
        limiter.reset()
    except Exception:  # pragma: no cover — storage-specific
        pass
