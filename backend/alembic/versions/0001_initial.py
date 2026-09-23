"""RoadGuard Atlas — initial schema.

Creates the PostGIS extension, all 15 tables (AGENT_BRIEF §2) with
`geography(Point,4326)` columns, a GiST index on hazard_reports.location and
B-tree indexes on status / created_at / user_id / hazard_class / band /
reference_code / work-order code, etc.

Revision ID: 0001
Revises:
Create Date: 2024-01-01 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geography

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

GEOGRAPHY_POINT = Geography(geometry_type="POINT", srid=4326, spatial_index=False, management=False)


def upgrade() -> None:
    # 1. PostGIS extension (autocommit block — CREATE EXTENSION cannot run inside a transaction)
    with op.get_context().autocommit_block():
        op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    bind = op.get_bind()
    from app.models import Base

    # 2. All tables from the declarative metadata (geography columns typed via
    #    app.models.GeographyPoint → geography(Point,4326) on PostgreSQL).
    Base.metadata.create_all(bind=bind)

    # 3. GiST index on the report geometry (radius queries: ST_DWithin / neighbors).
    op.create_index(
        "ix_hazard_reports_location_gist",
        "hazard_reports",
        ["location"],
        postgresql_using="gist",
        if_not_exists=True,
    )
    # Additional hot-path composite indexes.
    op.create_index(
        "ix_hazard_reports_status_created",
        "hazard_reports",
        ["status", "created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("ix_hazard_reports_status_created", table_name="hazard_reports", if_exists=True)
    op.drop_index("ix_hazard_reports_location_gist", table_name="hazard_reports", if_exists=True)
    from app.models import Base

    Base.metadata.drop_all(bind=op.get_bind())
    with op.get_context().autocommit_block():
        op.execute("DROP EXTENSION IF EXISTS postgis")
