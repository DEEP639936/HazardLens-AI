// /api/inference — run the detection engine chain on a stored media asset.
// Images: synchronous (engine chain: yolo-service → glm-vision → demo-engine-v2).
// Video: async job with frame-by-frame processing (ffmpeg sampling), polled via /api/inference/jobs/[id].
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuth } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { runImageInference } from "@/lib/rg/inference";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { mediaId?: string; mode?: string } | null;
  if (!body?.mediaId) return NextResponse.json({ error: "mediaId is required" }, { status: 400 });

  const media = await db.mediaAsset.findUnique({ where: { id: body.mediaId } });
  if (!media) return NextResponse.json({ error: "Media not found — upload first via /api/uploads" }, { status: 404 });
  if (media.reportId) return NextResponse.json({ error: "Media is already attached to a report" }, { status: 409 });

  if (media.mimeType.startsWith("video/")) {
    const job = await db.inferenceJob.create({
      data: { mediaId: media.id, status: "QUEUED", engine: "demo-engine-v2" },
    });
    // Fire-and-forget background processing (in-process worker; production uses Celery + Redis — see backend/).
    void import("@/lib/rg/inference").then(({ processVideoJob }) =>
      processVideoJob(job.id, { id: media.id, storagePath: media.storagePath, mimeType: media.mimeType })
    );
    await writeAudit({
      actorId: (await getAuth(req))?.userId ?? null,
      action: "inference.video_job",
      entityType: "inference_job",
      entityId: job.id,
      metadata: { mediaId: media.id },
      ip: clientIp(req),
    });
    return NextResponse.json({ jobId: job.id, status: "QUEUED" }, { status: 202 });
  }

  try {
    const result = await runImageInference({ id: media.id, storagePath: media.storagePath, mimeType: media.mimeType });
    // persist detections (unattached; linked to a report at submission time)
    const created = [];
    for (const det of result.detections) {
      const row = await db.detection.create({
        data: {
          modelVersion: result.modelVersion,
          engine: result.engine,
          hazardClass: det.hazardClass,
          confidence: det.confidence,
          bboxX: det.bbox[0],
          bboxY: det.bbox[1],
          bboxW: det.bbox[2],
          bboxH: det.bbox[3],
          areaRatio: det.areaRatio,
          severity: det.severity,
          annotatedMediaId: result.annotatedMediaId,
          inferenceMs: result.inferenceMs,
        },
      });
      created.push({ id: row.id, hazardClass: det.hazardClass, confidence: det.confidence, bbox: det.bbox, areaRatio: det.areaRatio, severity: det.severity });
    }
    await writeAudit({
      actorId: (await getAuth(req))?.userId ?? null,
      action: "inference.image",
      entityType: "media_asset",
      entityId: media.id,
      metadata: { engine: result.engine, detections: created.length, inferenceMs: result.inferenceMs },
      ip: clientIp(req),
    });
    return NextResponse.json({
      mediaId: media.id,
      engine: result.engine,
      modelVersion: result.modelVersion,
      inferenceMs: result.inferenceMs,
      detections: created,
      annotatedMediaId: result.annotatedMediaId,
    });
  } catch (err) {
    console.error("[inference] failed", err);
    return NextResponse.json({ error: "Inference failed", detail: err instanceof Error ? err.message : undefined }, { status: 500 });
  }
}
