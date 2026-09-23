"""User profile + notifications endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Notification, User, utcnow
from app.schemas.auth import UserOut, UserPatchIn
from app.schemas.work_order import MarkReadIn, NotificationListOut, NotificationOut
from app.services.security import CurrentUser

router = APIRouter(prefix="/users", tags=["users"])


def _to_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        name=user.name,
        role=user.role,  # type: ignore[arg-type]
        notifyInApp=user.notify_in_app,
        geoConsent=user.geo_consent,
        createdAt=user.created_at.isoformat(),
    )


@router.get("/me", response_model=UserOut, summary="Own profile")
def get_me(user: CurrentUser) -> UserOut:
    return _to_out(user)


@router.patch("/me", response_model=UserOut, summary="Update own profile")
def patch_me(payload: UserPatchIn, user: CurrentUser, db: Session = Depends(get_db)) -> UserOut:
    if payload.name is not None:
        user.name = payload.name.strip()
    if payload.notifyInApp is not None:
        user.notify_in_app = payload.notifyInApp
    if payload.geoConsent is not None:
        user.geo_consent = payload.geoConsent
    db.commit()
    return _to_out(user)


@router.get("/me/notifications", response_model=NotificationListOut, summary="Own notifications")
def my_notifications(user: CurrentUser, db: Session = Depends(get_db)) -> NotificationListOut:
    rows = db.execute(
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.created_at.desc())
        .limit(100)
    ).scalars().all()
    unread = db.execute(
        select(func.count()).select_from(Notification).where(Notification.user_id == user.id, Notification.read.is_(False))
    ).scalar_one()
    return NotificationListOut(
        items=[
            NotificationOut(
                id=n.id,
                type=n.type,
                title=n.title,
                body=n.body,
                read=n.read,
                link=n.link,
                createdAt=n.created_at.isoformat(),
            )
            for n in rows
        ],
        count=len(rows),
        unread=int(unread or 0),
    )


@router.post(
    "/me/notifications",
    response_model=NotificationListOut,
    summary="Mark notifications read (ids or all)",
    responses={400: {"model": dict, "description": "Nothing to mark"}},
)
def mark_notifications_read(
    payload: MarkReadIn, user: CurrentUser, db: Session = Depends(get_db)
) -> NotificationListOut:
    stmt = select(Notification).where(Notification.user_id == user.id, Notification.read.is_(False))
    if not payload.all:
        if not payload.ids:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "Provide ids or all=true"})
        stmt = stmt.where(Notification.id.in_(payload.ids))
    rows = db.execute(stmt).scalars().all()
    for row in rows:
        row.read = True
    db.commit()
    return my_notifications(user, db)
