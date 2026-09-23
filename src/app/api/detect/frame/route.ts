// /api/detect/frame — stateless single-frame inference for the live webcam studio.
// Accepts a base64 JPEG frame, runs the engine chain (yolo-service → glm-vision) with strict
// anti-hallucination validation, and returns detections WITHOUT touching the database.
// When no engine is reachable the response is an empty detection set (never fabricated boxes).
import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/rg/audit";
import { rateLimit } from "@/lib/rg/ratelimit";
import { runFrameInference } from "@/lib/rg/inference";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  const rl = rateLimit(`detect-frame:${clientIp(req)}`, 120, 60 * 1000); // 120 frames / min / IP
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Live detection rate limit reached (120 frames/min).", detail: `Retry after ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  const body = (await req.json().catch(() => null)) as { frame?: string; width?: number; height?: number } | null;
  if (!body?.frame || typeof body.frame !== "string") {
    return NextResponse.json({ error: "`frame` (base64 data URL or raw base64 JPEG) is required." }, { status: 400 });
  }

  const match = body.frame.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  const mime = match ? match[1] : "image/jpeg";
  const b64 = match ? match[2] : body.frame;
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length < 1024) {
    return NextResponse.json({ error: "Frame too small or corrupted." }, { status: 400 });
  }
  if (buffer.length > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "Frame exceeds 8 MB — reduce capture resolution." }, { status: 413 });
  }

  try {
    const dims = {
      width: Number.isFinite(body.width) ? Number(body.width) : null,
      height: Number.isFinite(body.height) ? Number(body.height) : null,
    };
    const result = await runFrameInference(buffer, mime, dims);
    return NextResponse.json({
      engine: result.engine,
      modelVersion: result.modelVersion,
      inferenceMs: result.inferenceMs,
      detections: result.detections,
    });
  } catch (err) {
    console.error("[detect/frame] failed", err);
    return NextResponse.json({ error: "Frame inference failed", detail: err instanceof Error ? err.message : undefined }, { status: 500 });
  }
}
