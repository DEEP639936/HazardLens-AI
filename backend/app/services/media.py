"""Media pipeline: validation (magic bytes), EXIF handling, storage backends.

Privacy guarantees (identical to the live app):
- EXIF/metadata is ALWAYS stripped — the stored copy is a clean re-encode
  (images) or a byte-identical container copy (video, whose metadata box is
  left to the inference worker's ffmpeg re-encode of sampled frames).
- GPS is extracted ONLY when the uploader explicitly passes geoConsent=true,
  and is returned as a *suggested* pin, never persisted onto the report.

Storage backends:
- local (default): files under MEDIA_ROOT, streamed by GET /media/{id}.
- s3: MinIO/S3 via boto3 (optional dependency; MEDIA_BACKEND=s3).
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Protocol

from PIL import Image, ImageOps

from app.config import settings

logger = logging.getLogger("roadguard.media")

IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}


class MediaValidationError(Exception):
    def __init__(self, error: str, status_code: int = 415) -> None:
        super().__init__(error)
        self.error = error
        self.status_code = status_code


def validate_upload(declared_mime: str, size_bytes: int) -> None:
    """Declared-type + size validation (AGENT_BRIEF §4). Raises MediaValidationError."""
    max_bytes = (
        settings.MEDIA_MAX_IMAGE_BYTES
        if declared_mime in IMAGE_TYPES
        else settings.MEDIA_MAX_VIDEO_BYTES
        if declared_mime in VIDEO_TYPES
        else None
    )
    if max_bytes is None:
        raise MediaValidationError(
            "Unsupported media type — use image/jpeg, image/png, image/webp, video/mp4, video/webm or video/quicktime"
        )
    if size_bytes <= 0:
        raise MediaValidationError("Empty file")
    if size_bytes > max_bytes:
        limit_mb = max_bytes // (1024 * 1024)
        raise MediaValidationError(f"File too large — the limit for {declared_mime} is {limit_mb} MB")


# ------------------------------------------------------------------ magic bytes
def sniff_mime(data: bytes) -> str | None:
    """Content-based MIME detection. Never trust the client-declared type."""
    if len(data) < 12:
        return None
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    if data[4:8] == b"ftyp":
        brand = data[8:12].decode("ascii", errors="ignore").lower()
        if brand.startswith("qt"):
            return "video/quicktime"
        return "video/mp4"
    return None


# --------------------------------------------------------------- EXIF / privacy
def extract_gps(data: bytes, mime: str) -> dict[str, float] | None:
    """GPS EXIF → {"lat": …, "lng": …}. Only called with explicit consent."""
    if mime not in IMAGE_TYPES:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        gps_ifd = exif.get_ifd(0x8825)  # GPSInfo IFD
        if not gps_ifd:
            return None

        def _dms_to_deg(dms: tuple, ref: str) -> float | None:
            try:
                deg, minutes, seconds = (float(v) for v in dms)
            except (TypeError, ValueError):
                return None
            value = deg + minutes / 60 + seconds / 3600
            return -value if ref in ("S", "W") else value

        lat_ref = gps_ifd.get(1)  # GPSLatitudeRef: N|S
        lat_dms = gps_ifd.get(2)
        lng_ref = gps_ifd.get(3)  # GPSLongitudeRef: E|W
        lng_dms = gps_ifd.get(4)
        if not (lat_ref and lat_dms and lng_ref and lng_dms):
            return None
        lat = _dms_to_deg(lat_dms, str(lat_ref))
        lng = _dms_to_deg(lng_dms, str(lng_ref))
        if lat is None or lng is None:
            return None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return None
        return {"lat": round(lat, 7), "lng": round(lng, 7)}
    except Exception:  # noqa: BLE001 — EXIF parsing must never break an upload
        logger.debug("GPS extraction failed", exc_info=True)
        return None


def strip_metadata_image(data: bytes, mime: str) -> tuple[bytes, str, int | None, int | None]:
    """Re-encode an image with ALL metadata dropped. Returns (bytes, mime, w, h)."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # normalize rotation; drops EXIF
    width, height = img.size
    out = io.BytesIO()
    if mime == "image/png":
        clean = Image.new(img.mode, img.size)
        clean.putdata(list(img.getdata()))
        clean.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png", width, height
    if mime == "image/webp":
        clean = Image.new(img.mode, img.size)
        clean.putdata(list(img.getdata()))
        clean.save(out, format="WEBP", quality=88)
        return out.getvalue(), "image/webp", width, height
    # default: JPEG (handles JPEG sources + EXIF-heavy uploads declared as jpeg)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    clean = Image.new(img.mode, img.size)
    clean.putdata(list(img.getdata()))
    clean.save(out, format="JPEG", quality=88, optimize=True)
    return out.getvalue(), "image/jpeg", width, height


# ------------------------------------------------------------------- storage
@dataclass(slots=True)
class StoredMedia:
    storage_path: str
    mime_type: str
    size_bytes: int
    width: int | None = None
    height: int | None = None
    sha256: str | None = None
    backend: str = "local"
    gps: dict[str, float] | None = field(default=None)


class StorageBackend(Protocol):
    def save(self, data: bytes, ext: str) -> str: ...
    def open(self, storage_path: str) -> bytes: ...
    def exists(self, storage_path: str) -> bool: ...


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = root
        os.makedirs(root, exist_ok=True)

    def _path(self, storage_path: str) -> str:
        # storage_path is always generated server-side (uuid + safe ext)
        safe = re.sub(r"[^a-zA-Z0-9._/-]", "_", storage_path)
        return os.path.join(self.root, safe)

    def save(self, data: bytes, ext: str) -> str:
        name = f"{uuid.uuid4().hex}.{ext}"
        path = os.path.join(self.root, name)
        with open(path, "wb") as fh:
            fh.write(data)
        return name

    def open(self, storage_path: str) -> bytes:
        with open(self._path(storage_path), "rb") as fh:
            return fh.read()

    def exists(self, storage_path: str) -> bool:
        return os.path.isfile(self._path(storage_path))


class S3Storage:
    """MinIO / AWS S3 backend (requires `boto3` — optional dependency)."""

    def __init__(self) -> None:
        try:
            import boto3  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "MEDIA_BACKEND=s3 requires the optional dependency boto3 (pip install boto3)"
            ) from exc
        self.bucket = settings.MEDIA_S3_BUCKET
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.MEDIA_S3_ENDPOINT_URL,
            aws_access_key_id=settings.MEDIA_S3_ACCESS_KEY,
            aws_secret_access_key=settings.MEDIA_S3_SECRET_KEY,
        )

    def save(self, data: bytes, ext: str) -> str:
        key = f"media/{uuid.uuid4().hex}.{ext}"
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=_ext_to_mime(ext))
        return key

    def open(self, storage_path: str) -> bytes:
        obj = self.client.get_object(Bucket=self.bucket, Key=storage_path)
        return obj["Body"].read()

    def exists(self, storage_path: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=storage_path)
            return True
        except Exception:  # noqa: BLE001
            return False


def _ext_to_mime(ext: str) -> str:
    return {
        "jpg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "bin": "application/octet-stream",
    }.get(ext, "application/octet-stream")


def get_storage() -> LocalStorage | S3Storage:
    if settings.MEDIA_BACKEND == "s3":
        return S3Storage()
    return LocalStorage(settings.MEDIA_ROOT)


_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov"}


def store_upload(data: bytes, declared_mime: str, *, extract_gps: bool) -> StoredMedia:
    """Full ingest pipeline: validate → sniff → strip/verify → persist.

    Images are re-encoded (metadata stripped). Videos are stored byte-identical
    (container metadata is minimal and frames get re-encoded by the worker).
    """
    sniffed = sniff_mime(data)
    if sniffed is None:
        raise MediaValidationError(
            "File content could not be verified — the upload does not match any supported media signature"
        )
    if sniffed != declared_mime:
        # Accept honest mismatch families (e.g. browser sends image/jpg), reject spoofing.
        if not (declared_mime == "image/jpg" and sniffed == "image/jpeg"):
            raise MediaValidationError("Declared type does not match the actual file content")

    gps = extract_gps(data, sniffed) if extract_gps else None

    if sniffed in IMAGE_TYPES:
        clean, mime, width, height = strip_metadata_image(data, sniffed)
    else:
        clean, mime, width, height = data, sniffed, None, None

    storage = get_storage()
    path = storage.save(clean, _EXT[mime])
    return StoredMedia(
        storage_path=path,
        mime_type=mime,
        size_bytes=len(clean),
        width=width,
        height=height,
        sha256=hashlib.sha256(clean).hexdigest(),
        backend=settings.MEDIA_BACKEND,
        gps=gps,
    )
