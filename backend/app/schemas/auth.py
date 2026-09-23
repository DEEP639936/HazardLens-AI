"""Auth schemas: register / login / refresh / logout / me / password reset."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.schemas.common import Role


class RegisterIn(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "email": "asha@example.com",
                "password": "Str0ngPass!2024",
                "name": "Asha Rao",
            }
        }
    )

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=120)


class LoginIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"email": "admin@roadguardatlas.dev", "password": "Atlas@Admin2024"}})

    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenPairOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                "tokenType": "bearer",
                "expiresIn": 900,
                "user": {"id": "u1", "email": "admin@roadguardatlas.dev", "name": "Atlas Admin", "role": "ADMIN"},
            }
        }
    )

    accessToken: str
    refreshToken: str
    tokenType: str = "bearer"
    expiresIn: int  # access TTL seconds
    user: "UserOut"


class RefreshIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}})

    refreshToken: str


class LogoutIn(BaseModel):
    refreshToken: str | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "u-1f2e3d",
                "email": "citizen@roadguardatlas.dev",
                "name": "Citizen Demo",
                "role": "USER",
                "notifyInApp": True,
                "geoConsent": True,
                "createdAt": "2024-05-01T10:00:00",
            }
        }
    )

    id: str
    email: EmailStr
    name: str
    role: Role
    notifyInApp: bool = True
    geoConsent: bool = False
    createdAt: str | None = None


class UserPatchIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"name": "Asha R.", "notifyInApp": False, "geoConsent": True}})

    name: str | None = Field(default=None, min_length=1, max_length=120)
    notifyInApp: bool | None = None
    geoConsent: bool | None = None


class ForgotPasswordIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"email": "citizen@roadguardatlas.dev"}})

    email: EmailStr


class ForgotPasswordOut(BaseModel):
    ok: bool = True
    message: str = "If the email exists, a reset link has been generated."
    resetToken: str | None = None  # only populated when settings.DEBUG (no SMTP in reference deployment)


class ResetPasswordIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"token": "eyJ...", "password": "NewStr0ngPass!2024"}})

    token: str
    password: str = Field(min_length=8, max_length=128)


TokenPairOut.model_rebuild()
