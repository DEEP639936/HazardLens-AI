"""Security: bcrypt password hashing, HS256 JWTs, refresh rotation, RBAC deps.

- Access token: 15 min (settings.ACCESS_TTL_SECONDS), claims: sub, role, typ=access.
- Refresh token: 30 days, claims: sub, jti, typ=refresh. Persisted by SHA-256 hash
  in refresh_tokens; rotate-on-use (old row revoked, new row issued).
- RBAC: `get_current_user` (required), `get_optional_user` (anonymous OK),
  `require_admin` (ADMIN role or 403).
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import RefreshToken, User, utcnow

pwd_context = CryptContext(schemes=["bcrypt"], bcrypt__rounds=settings.BCRYPT_ROUNDS, deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


# ------------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return pwd_context.verify(password, password_hash)
    except ValueError:
        return False


# ----------------------------------------------------------------------- JWTs
def _create_token(sub: str, role: str, token_type: str, ttl_seconds: int, jti: str | None = None) -> str:
    now = datetime.utcnow()
    payload: dict[str, Any] = {
        "sub": sub,
        "role": role,
        "typ": token_type,
        "iat": now,
        "exp": now + timedelta(seconds=ttl_seconds),
        "jti": jti or uuid.uuid4(),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_access_token(user: User) -> str:
    return _create_token(user.id, user.role, "access", settings.ACCESS_TTL_SECONDS)


def create_refresh_token(db: Session, user: User) -> str:
    jti = str(uuid.uuid4())
    token = _create_token(user.id, user.role, "refresh", settings.REFRESH_TTL_SECONDS, jti=jti)
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=_hash_token(token),
            expires_at=utcnow() + timedelta(seconds=settings.REFRESH_TTL_SECONDS),
        )
    )
    db.flush()
    return token


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def decode_token(token: str, expected_type: str = "access") -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "Token expired"}) from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "Invalid token"}) from exc
    if payload.get("typ") != expected_type:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": f"Expected a {expected_type} token"},
        )
    return payload


# ------------------------------------------------------------- refresh handling
def rotate_refresh_token(db: Session, presented: str) -> tuple[User, str, str]:
    """Validate a refresh token, revoke it and issue a fresh pair (rotate-on-use).

    Returns (user, new_access, new_refresh). Reuse of a revoked token is rejected.
    """
    payload = decode_token(presented, expected_type="refresh")
    row = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == _hash_token(presented))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "Refresh token not recognized"})
    if row.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "Refresh token already used or revoked"})
    if row.expires_at.replace(tzinfo=None) < utcnow():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "Refresh token expired"})

    user = db.get(User, payload["sub"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "User no longer exists"})

    row.revoked_at = utcnow()
    new_refresh = create_refresh_token(db, user)
    db.commit()
    return user, create_access_token(user), new_refresh


def revoke_refresh_token(db: Session, presented: str) -> bool:
    payload = decode_token(presented, expected_type="refresh")
    row = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == _hash_token(presented))
    ).scalar_one_or_none()
    if row is None or row.user_id != payload.get("sub"):
        return False
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        db.commit()
    return True


# ------------------------------------------------------------------ RBAC deps
def _user_from_credentials(
    credentials: HTTPAuthorizationCredentials | None, db: Session
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "Not authenticated"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_token(credentials.credentials, expected_type="access")
    user = db.get(User, payload.get("sub", ""))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"error": "User no longer exists"})
    return user


def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return _user_from_credentials(credentials, db)


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_optional_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User | None:
    """Anonymous-tolerant auth (public report POST attaches a user when present)."""
    if credentials is None:
        return None
    try:
        return _user_from_credentials(credentials, db)
    except HTTPException:
        return None


OptionalUser = Annotated[User | None, Depends(get_optional_user)]


def require_admin(user: CurrentUser) -> User:
    if user.role != "ADMIN":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "Admin privileges required"},
        )
    return user


AdminUser = Annotated[User, Depends(require_admin)]
