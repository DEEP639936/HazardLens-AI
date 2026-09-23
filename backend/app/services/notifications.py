"""In-app notification writer (used by review, work-order and report flows).

Email/push channels are intentionally out of scope for the reference deployment;
this service is the single hook where they would be added.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import Notification, utcnow


def notify(
    db: Session,
    *,
    user_id: str,
    type: str,  # noqa: A002 — column name
    title: str,
    body: str,
    link: str | None = None,
) -> None:
    db.add(
        Notification(
            user_id=user_id,
            type=type,
            title=title[:200],
            body=body,
            link=link,
            created_at=utcnow(),
        )
    )
    db.flush()
