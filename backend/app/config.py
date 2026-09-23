"""Application configuration (pydantic-settings).

All secrets and deployment-specific knobs come from environment variables (or a
`.env` file placed next to the backend root). See backend/README.md for the full
env-var table.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """RoadGuard Atlas backend settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ------------------------------------------------------------------ app
    APP_NAME: str = "RoadGuard Atlas API"
    APP_VERSION: str = "1.0.0"
    ENV: Literal["development", "staging", "production", "test"] = "development"
    DEBUG: bool = False

    # -------------------------------------------------------------- database
    # PostgreSQL 16 + PostGIS in production, e.g.
    #   postgresql+psycopg://roadguard:secret@localhost:5432/roadguard
    # Tests fall back to SQLite (spatial predicates are computed in Python with
    # the Haversine formula — identical semantics at city scale, see services/geo.py).
    DATABASE_URL: str = "postgresql+psycopg://roadguard:roadguard@localhost:5432/roadguard"
    SQL_ECHO: bool = False

    # ------------------------------------------------------------------ auth
    JWT_SECRET: str = "change-me-in-production"  # HS256 shared secret
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TTL_SECONDS: int = 15 * 60  # 15 minutes
    REFRESH_TTL_SECONDS: int = 30 * 24 * 3600  # 30 days
    RESET_TTL_SECONDS: int = 30 * 60  # password reset links
    BCRYPT_ROUNDS: int = 10

    # ------------------------------------------------------------------ CORS
    CORS_ORIGINS: list[str] = Field(
        default_factory=lambda: ["http://localhost:3000", "http://127.0.0.1:3000"]
    )

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        """Allow CORS_ORIGINS=https://a,https://b as a comma-separated string."""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    # ------------------------------------------------------------- ratelimit
    RATELIMIT_ENABLED: bool = True
    RATELIMIT_STORAGE_URI: str = "memory://"  # e.g. redis://localhost:6379/0
    RATELIMIT_REPORT_PER_HOUR: int = 5  # report POST 5/hour/IP
    RATELIMIT_LOGIN_PER_15MIN: int = 10  # login 10/15min/IP
    RATELIMIT_UPLOAD_PER_HOUR: int = 20

    # ------------------------------------------------------------- inference
    # YOLO inference micro-service (see ml/README.md). When unreachable the API
    # degrades to the deterministic demo engine so the flow never hard-fails.
    INFERENCE_SERVICE_URL: str = "http://localhost:8100"
    INFERENCE_TIMEOUT_SECONDS: float = 20.0
    INFERENCE_MODEL_VERSION: str = "roadguard-yolo-v11n-v1"

    # ----------------------------------------------------------------- media
    MEDIA_BACKEND: Literal["local", "s3"] = "local"
    MEDIA_ROOT: str = "storage/media"  # MEDIA_BACKEND=local
    MEDIA_S3_ENDPOINT_URL: str | None = None  # MinIO, e.g. http://localhost:9000
    MEDIA_S3_BUCKET: str = "roadguard-media"
    MEDIA_S3_ACCESS_KEY: str | None = None
    MEDIA_S3_SECRET_KEY: str | None = None
    MEDIA_MAX_IMAGE_BYTES: int = 12 * 1024 * 1024
    MEDIA_MAX_VIDEO_BYTES: int = 60 * 1024 * 1024

    # ---------------------------------------------------------------- worker
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_TASK_ALWAYS_EAGER: bool = False  # run tasks inline (dev/tests)

    # ------------------------------------------------------------- clustering
    CLUSTER_EPS_M: float = 60.0
    CLUSTER_MIN_PTS: int = 3
    CLUSTER_SINCE_DAYS: int = 90

    # ------------------------------------------------------------- bootstrap
    # Seeded demo admin (AGENT_BRIEF section 6) — used by scripts & first boot.
    SEED_ADMIN_EMAIL: str = "admin@roadguardatlas.dev"
    SEED_ADMIN_PASSWORD: str = "Atlas@Admin2024"
    SEED_CITIZEN_EMAIL: str = "citizen@roadguardatlas.dev"
    SEED_CITIZEN_PASSWORD: str = "Atlas@User2024"

    @property
    def sync_database_url(self) -> str:
        """Return a sync driver URL (Alembic / plain engine)."""
        url = self.DATABASE_URL
        for async_driver in ("+asyncpg", "+aiopg", "+asyncmy"):
            url = url.replace(async_driver, "+psycopg" if async_driver == "+asyncpg" else "")
        return url

    @property
    def is_postgres(self) -> bool:
        return self.DATABASE_URL.startswith("postgresql")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
