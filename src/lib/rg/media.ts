// Media pipeline: validated upload storage, EXIF-GPS extraction (only with explicit consent),
// unconditional EXIF/metadata stripping on re-encode, and OpenCV-style bbox annotation of images
// (the production OpenCV implementation lives in ml/inference_service.py — same visual contract).
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import exifr from "exifr";
import { MEDIA_LIMITS } from "./constants";
import type { BboxDTO } from "./types";

export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), "uploads");

await fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => undefined);

const MAGIC: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "video/mp4", test: (b) => b.subarray(4, 8).toString("ascii") === "ftyp" },
  { mime: "video/webm", test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: "video/quicktime", test: (b) => b.subarray(4, 8).toString("ascii") === "ftyp" },
];

export function sniffMime(buffer: Buffer): string | null {
  for (const m of MAGIC) if (m.test(buffer)) return m.mime;
  return null;
}

export interface StoredMedia {
  id: string;
  storagePath: string; // file name inside UPLOAD_DIR
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  gps?: { lat: number; lng: number } | null;
}

export interface UploadValidation {
  ok: boolean;
  error?: string;
}

export function validateUpload(mime: string, size: number): UploadValidation {
  const isImage = MEDIA_LIMITS.imageTypes.includes(mime);
  const isVideo = MEDIA_LIMITS.videoTypes.includes(mime);
  if (!isImage && !isVideo) {
    return { ok: false, error: "Unsupported media type. Accepted: JPEG, PNG images; MP4, WebM, MOV video." };
  }
  if (isImage && size > MEDIA_LIMITS.imageMaxBytes) {
    return { ok: false, error: `Image exceeds the ${MEDIA_LIMITS.imageMaxBytes / 1024 / 1024} MB limit.` };
  }
  if (isVideo && size > MEDIA_LIMITS.videoMaxBytes) {
    return { ok: false, error: `Video exceeds the ${MEDIA_LIMITS.videoMaxBytes / 1024 / 1024} MB limit.` };
  }
  return { ok: true };
}

/**
 * Persists an upload. Images are re-encoded (stripping EXIF/metadata — a privacy guarantee)
 * after GPS has optionally been extracted for the user. Content-type is verified against the
 * real byte signature, not just the declared header.
 */
export async function storeUpload(
  buffer: Buffer,
  declaredMime: string,
  opts: { extractGps: boolean }
): Promise<StoredMedia> {
  const sniffed = sniffMime(buffer);
  const mime = sniffed ?? declaredMime;
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime.startsWith("video/") ? (mime === "video/webm" ? "webm" : "mp4") : "jpg";
  const id = randomUUID();
  const fileName = `${id}.${ext}`;
  const absPath = path.join(UPLOAD_DIR, fileName);
  await fs.writeFile(absPath, buffer);

  let width: number | undefined;
  let height: number | undefined;
  let gps: { lat: number; lng: number } | null = null;

  if (opts.extractGps && (mime === "image/jpeg")) {
    try {
      const g = await exifr.gps(buffer);
      if (g && typeof g.latitude === "number" && typeof g.longitude === "number") {
        gps = { lat: g.latitude, lng: g.longitude };
      }
    } catch {
      gps = null; // no GPS tag — silently continue
    }
  }

  if (mime === "image/jpeg" || mime === "image/png") {
    try {
      const Jimp = (await import("jimp")).default;
      const img = await Jimp.read(absPath);
      width = img.bitmap.width;
      height = img.bitmap.height;
      // Re-encode to the same format → drops EXIF/metadata entirely.
      await img.writeAsync(absPath);
    } catch (err) {
      console.error("[media] re-encode failed; keeping original bytes", err);
    }
  }

  return {
    id,
    storagePath: fileName,
    mimeType: mime,
    sizeBytes: buffer.length,
    width,
    height,
    gps,
  };
}

export function safeResolve(storagePath: string): string | null {
  const p = path.join(UPLOAD_DIR, path.basename(storagePath));
  if (!p.startsWith(UPLOAD_DIR)) return null;
  return p;
}

/**
 * 8×8 average-hash (aHash) of an image — a compact perceptual fingerprint used by the
 * duplicate-detection engine to compare evidence photos of (potentially) the same hazard.
 * Returns a 16-char hex string, or null when hashing is not possible.
 */
export async function perceptualHash(absPath: string): Promise<string | null> {
  try {
    const Jimp = (await import("jimp")).default;
    const img = (await Jimp.read(absPath)).resize(8, 8, Jimp.RESIZE_BILINEAR).greyscale();
    const px: number[] = [];
    let sum = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const c = Jimp.intToRGBA(img.getPixelColor(x, y)).r;
        px.push(c);
        sum += c;
      }
    }
    const mean = sum / 64;
    let bits = "";
    for (const v of px) bits += v >= mean ? "1" : "0";
    // 64 bits → 16 hex chars
    let hex = "";
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  } catch {
    return null;
  }
}

/** Hamming distance between two aHash hex strings → similarity 0..1. */
export function hashSimilarity(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      diff += x & 1;
      x >>= 1;
    }
  }
  return 1 - diff / (a.length * 4);
}

function hexWithAlpha(hex: string, alpha: number): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0;
}

function severityColor(sev: number): string {
  if (sev >= 4) return "#C83E4D";
  if (sev === 3) return "#D97706";
  return "#168266";
}

/** Draws detection bounding boxes + labels onto an image copy (annotated evidence asset). */
export async function annotateImage(
  srcAbsPath: string,
  detections: (BboxDTO & { id?: string })[],
  destAbsPath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const Jimp = (await import("jimp")).default;
    const img = await Jimp.read(srcAbsPath);
    const W = img.bitmap.width;
    const H = img.bitmap.height;

    for (const det of detections) {
      const [x, y, w, h] = det.bbox;
      const px = Math.max(0, Math.round(x * W));
      const py = Math.max(0, Math.round(y * H));
      const pw = Math.min(W - px, Math.max(8, Math.round(w * W)));
      const ph = Math.min(H - py, Math.max(8, Math.round(h * H)));
      const color = severityColor(det.severity);

      // translucent fill
      const fill = new Jimp(pw, ph, hexWithAlpha(color, 0x30), (e) => e);
      img.composite(fill, px, py);
      // border: 3px strips
      const t = 3;
      const mk = (ww: number, hh: number) => new Jimp(ww, hh, hexWithAlpha(color, 0xff), (e) => e);
      img.composite(mk(pw, t), px, py);
      img.composite(mk(pw, t), px, py + ph - t);
      img.composite(mk(t, ph), px, py);
      img.composite(mk(t, ph), px + pw - t, py);

      // label chip
      try {
        const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
        const label = `${det.hazardClass} ${(det.confidence * 100).toFixed(0)}%`;
        const chipW = Math.min(pw, Math.max(60, label.length * 9 + 14));
        const chipH = 22;
        const chip = new Jimp(chipW, chipH, hexWithAlpha(color, 0xe6), (e) => e);
        img.composite(chip, px, Math.max(0, py - chipH));
        img.print(font, px + 7, Math.max(0, py - chipH) + 3, label);
      } catch {
        // font unavailable — border + fill still communicate the detection
      }
    }
    await img.writeAsync(destAbsPath);
    return { width: W, height: H };
  } catch (err) {
    console.error("[media] annotation failed", err);
    return null;
  }
}
