"""SQLAlchemy engine/session management.

Async-style dependency (`get_db`) is exposed as a plain generator so it works
uniformly with FastAPI's `Depends` and Alembic's sync migrations.
"""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine: Engine = create_engine(
    settings.sync_database_url,
    echo=settings.SQL_ECHO,
    pool_pre_ping=True,
    future=True,
    connect_args={"check_same_thread": False}  # SQLite only; ignored by psycopg
    if settings.sync_database_url.startswith("sqlite")
    else {},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


@event.listens_for(Engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, connection_record) -> None:  # noqa: ANN001
    """WAL-ish pragmas for the SQLite test fallback; no-op for PostgreSQL."""
    import sqlalchemy

    if sqlalchemy.__version__ and dbapi_connection.__class__.__module__.startswith("sqlite3"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
