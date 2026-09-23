"""Auth router — register / login / refresh / logout / me / password reset.

JWT: HS256, access 15 min + refresh 30 d (rotate-on-use), bcrypt cost 10.
Rate limits: login 10 / 15 min / IP.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import RefreshToken, User, utcnow
from app.schemas.auth import (
    ForgotPasswordIn,
    ForgotPasswordOut,
    LoginIn,
    LogoutIn,
    RefreshIn,
    RegisterIn,
    ResetPasswordIn,
    TokenPairOut,
    UserOut,
)
from app.services.audit import client_ip, write_audit
from app.services.ratelimit import limit_login, limiter
from app.services.security import (
    CurrentUser,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    revoke_refresh_token,
    rotate_refresh_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _token_pair(db: Session, user: User) -> TokenPairOut:
    access = create_access_token(user)
    refresh = create_refresh_token(db, user)
    db.commit()
    return TokenPairOut(
        accessToken=access,
        refreshToken=refresh,
        expiresIn=settings.ACCESS_TTL_SECONDS,
        user=UserOut(
            id=user.id,
            email=user.email,
            name=user.name,
            role=user.role,  # type: ignore[arg-type]
            notifyInApp=user.notify_in_app,
            geoConsent=user.geo_consent,
            createdAt=user.created_at.isoformat(),
        ),
    )


@router.post(
    "/register",
    response_model=TokenPairOut,
    status_code=status.HTTP_201_CREATED,
    summary="Register a citizen account",
    responses={409: {"model": dict, "description": "Email already registered"}},
)
def register(payload: RegisterIn, request: Request, db: Session = Depends(get_db)) -> TokenPairOut:
    email = payload.email.lower().strip()
    existing = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error": "Email already registered"})

    user = User(
        id=str(uuid.uuid4()),
        email=email,
        password_hash=hash_password(payload.password),
        name=payload.name.strip(),
        role="USER",
        created_at=utcnow(),
    )
    db.add(user)
    db.flush()
    write_audit(
        db,
        action="auth.register",
        entity_type="user",
        entity_id=user.id,
        actor_email=email,
        actor_role="USER",
        ip=client_ip(request),
    )
    pair = _token_pair(db, user)
    db.commit()
    return pair


@router.post(
    "/login",
    response_model=TokenPairOut,
    summary="Login with email + password",
    responses={401: {"model": dict, "description": "Invalid credentials"}},
)
@limiter.limit(limit_login())
def login(payload: LoginIn, request: Request, db: Session = Depends(get_db)) -> TokenPairOut:
    email = payload.email.lower().strip()
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "Invalid email or password"})
    write_audit(
        db,
        action="auth.login",
        entity_type="user",
        entity_id=user.id,
        actor_id=user.id,
        actor_email=user.email,
        actor_role=user.role,
        ip=client_ip(request),
    )
    pair = _token_pair(db, user)
    db.commit()
    return pair


@router.post(
    "/refresh",
    response_model=TokenPairOut,
    summary="Exchange a refresh token for a fresh pair (rotate-on-use)",
    responses={401: {"model": dict, "description": "Invalid / reused / expired refresh token"}},
)
def refresh(payload: RefreshIn, request: Request, db: Session = Depends(get_db)) -> TokenPairOut:
    user, access, new_refresh = rotate_refresh_token(db, payload.refreshToken)
    write_audit(
        db,
        action="auth.refresh",
        entity_type="user",
        entity_id=user.id,
        actor_id=user.id,
        actor_email=user.email,
        actor_role=user.role,
        ip=client_ip(request),
    )
    db.commit()
    return TokenPairOut(
        accessToken=access,
        refreshToken=new_refresh,
        expiresIn=settings.ACCESS_TTL_SECONDS,
        user=UserOut(
            id=user.id,
            email=user.email,
            name=user.name,
            role=user.role,  # type: ignore[arg-type]
            notifyInApp=user.notify_in_app,
            geoConsent=user.geo_consent,
            createdAt=user.created_at.isoformat(),
        ),
    )


@router.post("/logout", summary="Revoke a refresh token (server-side)", response_model=dict)
def logout(payload: LogoutIn, request: Request, db: Session = Depends(get_db)) -> dict:
    if payload.refreshToken:
        try:
            revoke_refresh_token(db, payload.refreshToken)
        except HTTPException:
            # Expired/invalid refresh tokens are "already logged out" from the client's POV.
            return {"ok": True}
    return {"ok": True}


@router.get("/me", response_model=UserOut, summary="Current user profile")
def me(user: CurrentUser) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        name=user.name,
        role=user.role,  # type: ignore[arg-type]
        notifyInApp=user.notify_in_app,
        geoConsent=user.geo_consent,
        createdAt=user.created_at.isoformat(),
    )


@router.post(
    "/forgot-password",
    response_model=ForgotPasswordOut,
    summary="Request a password-reset token",
)
def forgot_password(payload: ForgotPasswordIn, db: Session = Depends(get_db)) -> ForgotPasswordOut:
    user = db.execute(select(User).where(User.email == payload.email.lower().strip())).scalar_one_or_none()
    # Always answer identically (no account enumeration).
    if user is None:
        return ForgotPasswordOut()
    reset = pyjwt.encode(
        {"sub": user.id, "typ": "pwreset", "exp": utcnow() + timedelta(seconds=settings.RESET_TTL_SECONDS)},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    # Production: email this token via SMTP/SQS. Reference deployment: expose in DEBUG only.
    return ForgotPasswordOut(resetToken=reset if settings.DEBUG else None)


@router.post("/reset-password", response_model=dict, summary="Reset password with a token")
def reset_password(payload: ResetPasswordIn, db: Session = Depends(get_db)) -> dict:
    try:
        claims = decode_token(payload.token, expected_type="pwreset")
    except HTTPException:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "Invalid or expired reset token"}) from None
    user = db.get(User, claims.get("sub", ""))
    if user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "Invalid or expired reset token"})
    user.password_hash = hash_password(payload.password)
    # revoke every existing refresh token (session hygiene)
    for row in db.execute(select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))).scalars():
        row.revoked_at = utcnow()
    db.commit()
    return {"ok": True}
