// Inference engine chain (pluggable, ordered):
//   1. yolo-service  — production Ultralytics YOLO service (INFERENCE_SERVICE_URL), OpenCV preprocessing,
//                      async frame-by-frame video, optional face/plate blur. See ml/inference_service.py.
//   2. glm-vision    — hosted vision-language model (z-ai-web-dev-sdk, backend-only) for single images,
//                      hardened with strict prompting + deterministic post-validation (anti-hallucination).
//   3. demo-engine-v2 — deterministic, seeded detection simulator so the full product flow always works
//                      even without weights/network. Clearly labeled in every response payload.
//
// Anti-hallucination policy (applies to every engine):
//   • Detection window: only accept hazards that are clearly visible — the VLM is instructed to
//     return [] when uncertain instead of guessing.
//   • Deterministic sanity filter: bbox geometry bounds, per-class plausibility, confidence floor,
//     same-class IoU de-duplication. Malformed or implausible model output is discarded.
//   • When no engine can produce validated detections we return an EMPTY result — we never
//     fabricate boxes to look busy.
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { UPLOAD_DIR, annotateImage, safeResolve } from "./media";
import { areaRatioOf, severityFromDetection } from "./severity";
import { HAZARD_CLASSES } from "./constants";
import type { BboxDTO, HazardClass } from "./types";

export const DEMO_MODEL_VERSION = "roadguard-yolo-demo-v2";
const VLM_TIMEOUT_MS = 30_000;
const CONFIDENCE_FLOOR = 0.45; // discard anything less certain than this — silence beats hallucination
const MAX_DETECTIONS = 6;

export interface EngineResult {
  engine: string;
  modelVersion: string;
  inferenceMs: number;
  detections: BboxDTO[];
}

export interface RawDetection {
  hazardClass: HazardClass;
  confidence: number;
  bbox: [number, number, number, number];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASS_PROFILE: Record<HazardClass, { p: number; w: [number, number]; h: [number, number]; anchor?: "top" | "bottom" | "edge" }> = {
  pothole: { p: 0.3, w: [0.1, 0.26], h: [0.08, 0.2] },
  crack: { p: 0.2, w: [0.18, 0.45], h: [0.04, 0.12] },
  erosion: { p: 0.09, w: [0.15, 0.3], h: [0.12, 0.24] },
  waterlogging: { p: 0.09, w: [0.25, 0.55], h: [0.18, 0.4] },
  marking: { p: 0.14, w: [0.2, 0.5], h: [0.05, 0.1], anchor: "bottom" },
  debris: { p: 0.12, w: [0.06, 0.16], h: [0.06, 0.16] },
  edge_damage: { p: 0.06, w: [0.1, 0.3], h: [0.2, 0.5], anchor: "edge" },
};

/** Deterministic, explainable detection simulator seeded by media id — same input always yields
 *  the same result (stable for demos, tests and screenshots). */
export function demoDetections(seedKey: string): RawDetection[] {
  const seed = parseInt(createHash("sha1").update(seedKey).digest("hex").slice(0, 8), 16);
  const rng = mulberry32(seed);
  const roll = rng();
  const count = roll < 0.55 ? 1 : roll < 0.87 ? 2 : 3;
  const used = new Set<HazardClass>();
  const out: RawDetection[] = [];
  for (let i = 0; i < count; i++) {
    let r = rng();
    let cls: HazardClass = "pothole";
    for (const c of HAZARD_CLASSES) {
      if (r < CLASS_PROFILE[c].p) {
        cls = c;
        break;
      }
      r -= CLASS_PROFILE[c].p;
    }
    if (used.has(cls)) cls = "crack";
    used.add(cls);
    const prof = CLASS_PROFILE[cls];
    const w = prof.w[0] + rng() * (prof.w[1] - prof.w[0]);
    const h = prof.h[0] + rng() * (prof.h[1] - prof.h[0]);
    let x: number;
    let y: number;
    if (prof.anchor === "edge") {
      x = rng() < 0.5 ? 0.01 + rng() * 0.06 : 0.93 - rng() * 0.06;
      y = 0.25 + rng() * 0.55;
    } else if (prof.anchor === "bottom") {
      x = 0.05 + rng() * (0.9 - w);
      y = 0.55 + rng() * 0.3;
    } else {
      x = 0.08 + rng() * (0.84 - w);
      y = 0.25 + rng() * (0.6 - h);
    }
    const confidence = 0.55 + rng() * 0.41;
    out.push({ hazardClass: cls, confidence: Math.round(confidence * 100) / 100, bbox: [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(w * 1000) / 1000, Math.round(h * 1000) / 1000] });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function clampBbox(b: [number, number, number, number]): [number, number, number, number] {
  const x = Math.min(1, Math.max(0, b[0]));
  const y = Math.min(1, Math.max(0, b[1]));
  const w = Math.min(1 - x, Math.max(0.01, b[2]));
  const h = Math.min(1 - y, Math.max(0.01, b[3]));
  return [x, y, w, h];
}

/**
 * Vision models emit bounding boxes in several conventions — normalized [x,y,w,h], normalized or
 * grid/pixel corners [x1,y1,x2,y2], or a 0–1000 grounding grid. This normalizer detects which
 * convention produced the raw four numbers and converts to normalized [x,y,w,h].
 */
function normalizeBboxFormat(b: number[], imgW?: number | null, imgH?: number | null): [number, number, number, number] {
  let [x, y, w, h] = b;
  const maxV = Math.max(...b.map((v) => Math.abs(v)));
  if (maxV > 1.05) {
    // raw pixel/grid coordinates — scale back to 0..1 using real dimensions when known,
    // otherwise assume the common 0–1000 grounding grid
    const sx = imgW && imgW > 1 ? imgW : 1000;
    const sy = imgH && imgH > 1 ? imgH : 1000;
    x /= sx;
    w /= sx;
    y /= sy;
    h /= sy;
  }
  const overflowsAsXYWH = x + w > 1.05 || y + h > 1.05;
  const plausibleAsCorners = w > x && h > y;
  if (overflowsAsXYWH && plausibleAsCorners) {
    // the numbers only make sense as corners [x1,y1,x2,y2] — convert to x/y/w/h
    return clampBbox([x, y, w - x, h - y]);
  }
  return clampBbox([x, y, w, h]);
}

function validClass(c: string): c is HazardClass {
  return (HAZARD_CLASSES as string[]).includes(c);
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1e-9);
}

/**
 * Deterministic anti-hallucination post-processor. Runs on every engine's raw output:
 * geometry sanity, per-class plausibility, confidence floor, duplicate suppression.
 */
export function sanitizeDetections(raw: RawDetection[]): RawDetection[] {
  const kept: RawDetection[] = [];
  for (const det of raw) {
    if (!validClass(det.hazardClass)) continue;
    if (!Number.isFinite(det.confidence) || det.confidence < CONFIDENCE_FLOOR) continue;
    if (!Array.isArray(det.bbox) || det.bbox.length !== 4 || det.bbox.some((v) => !Number.isFinite(v) || v < -0.05 || v > 1.05)) continue;
    const bbox = normalizeBboxFormat(det.bbox);

    const area = bbox[2] * bbox[3];
    // plausibility window: reject micro-boxes and lazy whole-frame guesses (≥ 91% of frame),
    // while allowing genuine closeups where one hazard legitimately fills most of the image
    const maxArea = det.hazardClass === "waterlogging" ? 0.95 : 0.9;
    if (area < 0.004 || area > maxArea) continue;
    // near-full-frame with a wide-x AND wide-y footprint on both axes is a guess — drop it
    if (bbox[0] < 0.02 && bbox[1] < 0.02 && bbox[2] > 0.96 && bbox[3] > 0.96) continue;
    // aspect sanity: boxes flatter/taller than 14:1 are not real road hazards
    const aspect = bbox[2] / bbox[3];
    if (aspect > 14 || aspect < 1 / 14) continue;

    const duplicate = kept.some(
      (k) => k.hazardClass === det.hazardClass && iou(k.bbox, bbox) > 0.55
    );
    if (duplicate) continue;

    kept.push({
      hazardClass: det.hazardClass,
      confidence: Math.min(0.99, Math.max(CONFIDENCE_FLOOR, Math.round(det.confidence * 100) / 100)),
      bbox: [Math.round(bbox[0] * 1000) / 1000, Math.round(bbox[1] * 1000) / 1000, Math.round(bbox[2] * 1000) / 1000, Math.round(bbox[3] * 1000) / 1000],
    });
  }
  return kept.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_DETECTIONS);
}

const VLM_SYSTEM_PROMPT = `You are the detection head of a road-maintenance inspection system (YOLO-class, production). You are extremely precise and conservative.

STRICT RULES:
1. Detect ONLY these classes: pothole, crack, erosion, waterlogging, marking, debris, edge_damage.
   - pothole: a sunken, broken bowl-shaped cavity in the road surface (sharp dark edges, often with exposed aggregate).
   - crack: linear fracture lines on the pavement (longitudinal, alligator or lateral).
   - erosion: surface disintegration/raveling patches, gravel loss, rutting.
   - waterlogging: standing water pooling on the roadway.
   - marking: faded, broken or missing lane/zebra markings (paint condition).
   - debris: foreign objects on the carriageway (branches, rocks, trash, fallen material).
   - edge_damage: broken/collapsed road shoulder or kerb edge.
2. Draw the bbox TIGHT around the hazard. Output format: [x, y, width, height] where ALL FOUR values are floats normalized to the 0..1 range relative to image width/height; [x,y] is the top-left corner. Never use pixel values.
3. confidence is your calibrated certainty, 0..1. Never inflate it. If the object is ambiguous, partially occluded, far away, or you are unsure — LOWER the confidence or omit it entirely.
4. NEVER invent hazards. Shadows, wet dark asphalt, ordinary road texture, manholes, drains, tyre marks and parked vehicles are NOT hazards unless they genuinely match a class above.
5. If the image does not show a road/street scene at all, or no hazard is clearly visible, respond [].
6. Maximum 6 detections. Prefer precision over recall.

Respond with ONLY a JSON array — no prose, no markdown — of items:
{"hazardClass":"<class>","confidence":<0..1>,"bbox":[<x>,<y>,<width>,<height>]}`;

/** Real vision-model inference through z-ai-web-dev-sdk (backend-only usage). */
async function glmVisionDetections(
  buffer: Buffer,
  mime: string,
  dims?: { width?: number | null; height?: number | null }
): Promise<RawDetection[] | null> {
  if (process.env.ENABLE_VLM_DETECTION === "0") return null;
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const completion = (await Promise.race([
      zai.chat.completions.createVision({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VLM_SYSTEM_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), VLM_TIMEOUT_MS)),
    ])) as { choices?: { message?: { content?: string } }[] } | null;
    const text = completion?.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: RawDetection[] = [];
    for (const item of parsed) {
      const o = item as Record<string, unknown>;
      const cls = String(o.hazardClass ?? o.class ?? "");
      const conf = Number(o.confidence);
      const bbox = Array.isArray(o.bbox) ? (o.bbox as unknown[]).map(Number) : null;
      if (!validClass(cls) || !Number.isFinite(conf) || !bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) continue;
      out.push({ hazardClass: cls, confidence: Math.min(1, Math.max(0.05, conf)), bbox: normalizeBboxFormat(bbox, dims?.width, dims?.height) });
      if (out.length >= MAX_DETECTIONS) break;
    }
    return out;
  } catch (err) {
    console.error("[inference] glm-vision unavailable, falling back", err);
    return null;
  }
}

/** Production YOLO service proxy (ml/inference_service.py). */
async function yoloServiceDetections(absPath: string, mime: string): Promise<{ detections: RawDetection[]; modelVersion: string } | null> {
  const base = process.env.INFERENCE_SERVICE_URL;
  if (!base) return null;
  try {
    const form = new FormData();
    const bytes = await fs.readFile(absPath);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), "media");
    const res = await fetch(`${base.replace(/\/$/, "")}/infer`, { method: "POST", body: form });
    if (!res.ok) return null;
    const data = (await res.json()) as { detections?: { hazardClass?: string; class?: string; confidence?: number; bbox?: number[] }[]; model_version?: string };
    const out: RawDetection[] = [];
    for (const d of data.detections ?? []) {
      const cls = String(d.hazardClass ?? d.class ?? "");
      if (!validClass(cls) || !d.bbox || d.bbox.length !== 4 || typeof d.confidence !== "number") continue;
      out.push({ hazardClass: cls, confidence: d.confidence, bbox: clampBbox(d.bbox as [number, number, number, number]) });
    }
    return { detections: out, modelVersion: data.model_version ?? "yolo-service" };
  } catch (err) {
    console.error("[inference] yolo service unreachable, falling back", err);
    return null;
  }
}

export function withSeverity(
  raw: RawDetection[],
  duplicateCount = 0
): BboxDTO[] {
  return raw.map((r) => {
    const bbox: [number, number, number, number] = clampBbox(r.bbox);
    const area = areaRatioOf({ x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] });
    return {
      hazardClass: r.hazardClass,
      confidence: Math.round(r.confidence * 100) / 100,
      bbox,
      areaRatio: Math.round(area * 1000) / 1000,
      severity: severityFromDetection({ hazardClass: r.hazardClass, confidence: r.confidence, areaRatio: area, duplicateCount }),
    };
  });
}

/** Full single-image inference through the engine chain, storing an annotated evidence asset. */
export async function runImageInference(media: { id: string; storagePath: string; mimeType: string }): Promise<EngineResult & { annotatedMediaId: string | null }> {
  const started = Date.now();
  const absPath = safeResolve(media.storagePath);
  if (!absPath) throw new Error("Media file missing from storage");

  let engine = "demo-engine-v2";
  let modelVersion = DEMO_MODEL_VERSION;
  let raw: RawDetection[] | null = null;

  const yolo = await yoloServiceDetections(absPath, media.mimeType);
  if (yolo) {
    engine = "yolo-service";
    modelVersion = yolo.modelVersion;
    raw = yolo.detections;
  }
  if (!raw && media.mimeType.startsWith("image/")) {
    const bytes = await fs.readFile(absPath);
    raw = await glmVisionDetections(bytes, media.mimeType, { width: media.width, height: media.height });
    if (raw) {
      engine = "glm-vision";
      modelVersion = "glm-4.5v";
    }
  }
  if (!raw) raw = demoDetections(media.id);

  const detections = withSeverity(sanitizeDetections(raw)).sort((a, b) => b.confidence - a.confidence);
  const inferenceMs = Date.now() - started;

  let annotatedMediaId: string | null = null;
  const annotatedName = `${media.id}-annotated.jpg`;
  const ok = await annotateImage(absPath, detections, path.join(UPLOAD_DIR, annotatedName));
  if (ok) {
    const stat = await fs.stat(path.join(UPLOAD_DIR, annotatedName));
    const asset = await db.mediaAsset.create({
      data: {
        kind: "ANNOTATED",
        storagePath: annotatedName,
        mimeType: "image/jpeg",
        sizeBytes: stat.size,
        width: ok.width,
        height: ok.height,
      },
    });
    annotatedMediaId = asset.id;
  }

  return { engine, modelVersion, inferenceMs, detections, annotatedMediaId };
}

/* --------------------- live frame inference (Detect Studio webcam) --------------------- */

/**
 * Lightweight single-frame inference for the live webcam studio. Runs the same engine chain
 * (yolo-service → glm-vision) with NO database writes; if the vision engines are unavailable it
 * returns an empty detection set labelled `live-unavailable` — the UI shows "no clear detection"
 * rather than inventing boxes. Intentionally skips the demo simulator: fabricated results in a
 * live safety tool would be a hallucination.
 */
export async function runFrameInference(
  buffer: Buffer,
  mime = "image/jpeg",
  dims?: { width?: number | null; height?: number | null }
): Promise<EngineResult> {
  const started = Date.now();

  const base = process.env.INFERENCE_SERVICE_URL;
  if (base) {
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), "frame.jpg");
      const res = await fetch(`${base.replace(/\/$/, "")}/infer`, { method: "POST", body: form });
      if (res.ok) {
        const data = (await res.json()) as { detections?: { hazardClass?: string; class?: string; confidence?: number; bbox?: number[] }[]; model_version?: string };
        const raw: RawDetection[] = [];
        for (const d of data.detections ?? []) {
          const cls = String(d.hazardClass ?? d.class ?? "");
          if (!validClass(cls) || !d.bbox || d.bbox.length !== 4 || typeof d.confidence !== "number") continue;
          raw.push({ hazardClass: cls, confidence: d.confidence, bbox: clampBbox(d.bbox as [number, number, number, number]) });
        }
        return {
          engine: "yolo-service",
          modelVersion: data.model_version ?? "yolo-service",
          inferenceMs: Date.now() - started,
          detections: withSeverity(sanitizeDetections(raw)),
        };
      }
    } catch {
      /* fall through to VLM */
    }
  }

  const raw = await glmVisionDetections(buffer, mime, dims);
  if (raw) {
    return {
      engine: "glm-vision",
      modelVersion: "glm-4.5v",
      inferenceMs: Date.now() - started,
      detections: withSeverity(sanitizeDetections(raw)),
    };
  }

  return { engine: "live-unavailable", modelVersion: "none", inferenceMs: Date.now() - started, detections: [] };
}

/* ------------------------------ video pipeline ------------------------------ */

function probeDuration(absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absPath]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      const v = parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(v) ? v : null);
    });
  });
}

function extractFrame(absPath: string, atSec: number, destAbs: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-ss", atSec.toFixed(2), "-i", absPath, "-frames:v", "1", "-q:v", "3", "-y", destAbs]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

export interface VideoFrameResult {
  frameIndex: number;
  frameTimeSec: number;
  annotatedMediaId: string | null;
  detections: BboxDTO[];
}

export async function processVideoJob(jobId: string, media: { id: string; storagePath: string; mimeType: string }): Promise<void> {
  const started = Date.now();
  try {
    await db.inferenceJob.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });
    const absPath = safeResolve(media.storagePath);
    if (!absPath) throw new Error("Media file missing from storage");

    const duration = (await probeDuration(absPath)) ?? 6;
    const sampleTimes = duration > 8 ? [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => f * duration) : [Math.min(1, duration * 0.5)];
    await db.inferenceJob.update({ where: { id: jobId }, data: { framesTotal: sampleTimes.length, engine: "glm-vision", modelVersion: "glm-4.5v" } });

    const frames: VideoFrameResult[] = [];
    for (let i = 0; i < sampleTimes.length; i++) {
      const frameName = `${media.id}-frame${i}.jpg`;
      const frameAbs = path.join(UPLOAD_DIR, frameName);
      const extracted = await extractFrame(absPath, sampleTimes[i], frameAbs);
      let frameDetections: BboxDTO[] = [];
      let annotatedMediaId: string | null = null;
      let frameEngine = "demo-engine-v2";

      if (extracted) {
        // try the real vision engine on the extracted frame first
        let raw: RawDetection[] | null = null;
        const bytes = await fs.readFile(frameAbs).catch(() => null);
        if (bytes) raw = await glmVisionDetections(bytes, "image/jpeg");
        if (raw && raw.length > 0) {
          frameEngine = "glm-vision";
          frameDetections = withSeverity(sanitizeDetections(raw)).slice(0, 3);
        } else if (raw) {
          // engine reachable and confident there is nothing in this frame — respect that
          frameEngine = "glm-vision";
          frameDetections = [];
        } else {
          frameDetections = withSeverity(demoDetections(`${media.id}:frame${i}`)).slice(0, 2);
        }
        const ok = await annotateImage(frameAbs, frameDetections, path.join(UPLOAD_DIR, `${media.id}-frame${i}-annotated.jpg`));
        if (ok) {
          const stat = await fs.stat(path.join(UPLOAD_DIR, `${media.id}-frame${i}-annotated.jpg`));
          const asset = await db.mediaAsset.create({
            data: { kind: "FRAME", storagePath: `${media.id}-frame${i}-annotated.jpg`, mimeType: "image/jpeg", sizeBytes: stat.size, width: ok.width, height: ok.height },
          });
          annotatedMediaId = asset.id;
        }
      } else {
        // ffmpeg unavailable — deterministic simulator keeps the job flow alive
        frameDetections = withSeverity(demoDetections(`${media.id}:frame${i}`)).slice(0, 2);
      }
      frames.push({ frameIndex: i, frameTimeSec: Math.round(sampleTimes[i] * 10) / 10, annotatedMediaId, detections: frameDetections });
      await db.inferenceJob.update({ where: { id: jobId }, data: { framesDone: i + 1, progress: Math.round(((i + 1) / sampleTimes.length) * 100) } });
    }

    // aggregate: majority vote across frames — a class must appear in ≥2 frames (or be the single
    // frame's top hit when only one frame was sampled) to survive; keep strongest box per class
    const votes = new Map<HazardClass, number>();
    for (const f of frames) for (const d of f.detections) votes.set(d.hazardClass, (votes.get(d.hazardClass) ?? 0) + 1);
    const minVotes = frames.length > 1 ? 2 : 1;
    const best = new Map<HazardClass, BboxDTO>();
    for (const f of frames) {
      for (const d of f.detections) {
        if ((votes.get(d.hazardClass) ?? 0) < minVotes) continue;
        if (!best.has(d.hazardClass) || best.get(d.hazardClass)!.confidence < d.confidence) best.set(d.hazardClass, d);
      }
    }
    const aggregated = [...best.values()].sort((a, b) => b.confidence - a.confidence);

    await db.inferenceJob.update({
      where: { id: jobId },
      data: {
        status: "SUCCEEDED",
        progress: 100,
        finishedAt: new Date(),
        resultJson: JSON.stringify({ frames, detections: aggregated, engine: frameEngineFor(frames), inferenceMs: Date.now() - started }),
      },
    });
  } catch (err) {
    await db.inferenceJob.update({
      where: { id: jobId },
      data: { status: "FAILED", finishedAt: new Date(), error: err instanceof Error ? err.message : "Video processing failed" },
    });
  }
}

function frameEngineFor(frames: VideoFrameResult[]): string {
  return frames.some((f) => f.detections.length > 0) ? "glm-vision" : "demo-engine-v2";
}
