"""Uploads router — validated multipart ingest + media streaming."""
from __future__ import annotations

import io

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import MediaAsset, utcnow
from app.schemas.inference import UploadOut
from app.services.audit import client_ip, write_audit
from app.services.media import (
    MediaValidationError,
    validate_upload,
    get_storage,
    store_upload,
)
from app.services.ratelimit import limit_uploads, limiter
from app.services.security import get_optional_user, OptionalUser

router = APIRouter(tags=["uploads"])


@router.post(
    "/uploads",
    response_model=UploadOut,
    status_code=status.HTTP_201_CREATED,
    summary="Upload media (image ≤12MB / video ≤60MB). EXIF stripped always; GPS only with consent.",
    responses={
        415: {"model": dict, "description": "Unsupported type / content mismatch / too large"},
        429: {"model": dict, "description": "Upload rate limit"},
    },
)
@limiter.limit(limit_uploads())
def upload_media(
    request: Request,
    file: UploadFile = File(..., description="image/jpeg | image/png | image/webp | video/mp4 | video/webm | video/quicktime"),
    geoConsent: bool = Form(default=False, description="Extract GPS EXIF as a suggested pin (never persisted on the report)"),
    db: Session = Depends(get_db),
    user: OptionalUser = None,
) -> UploadOut:
    declared = file.content_type or "application/octet-stream"
    data = file.file.read()

    try:
        validate_upload(declared, len(data))
        stored = store_upload(data, declared, extract_gps=geoConsent)
    except MediaValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail={"error": exc.error}) from exc

    asset = MediaAsset(
        kind="ORIGINAL",
        storage_path=stored.storage_path,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        width=stored.width,
        height=stored.height,
        created_at=utcnow(),
    )
    db.add(asset)
    db.flush()
    write_audit(
        db,
        action="upload.create",
        entity_type="media_asset",
        entity_id=asset.id,
        actor_id=user.id if user else None,
        metadata={"mimeType": stored.mime_type, "sizeBytes": stored.size_bytes, "gpsExtracted": stored.gps is not None},
        ip=client_ip(request),
    )
    db.commit()
    return UploadOut(
        mediaId=asset.id,
        mimeType=stored.mime_type,
        width=stored.width,
        height=stored.height,
        suggestedLocation=stored.gps,
        note="Metadata and EXIF have been stripped from the stored copy.",
    )


@router.get("/media/{media_id}", summary="Stream a stored media asset")
def stream_media(media_id: str, db: Session = Depends(get_db)) -> StreamingResponse:
    asset = db.get(MediaAsset, media_id)
    if asset is None:
        raise HTTPException(status_code=404, detail={"error": "Media not found"})
    storage = get_storage()
    try:
        payload = storage.open(asset.storage_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"error": "Media file missing from storage"}) from exc
    return StreamingResponse(
        io.BytesIO(payload),
        media_type=asset.mime_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable", "Content-Length": str(len(payload))},
    )
