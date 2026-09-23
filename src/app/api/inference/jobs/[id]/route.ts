// /api/inference/jobs/[id] — poll async video inference jobs
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.inferenceJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({
    id: job.id,
    status: job.status,
    engine: job.engine,
    modelVersion: job.modelVersion,
    progress: job.progress,
    framesTotal: job.framesTotal,
    framesDone: job.framesDone,
    error: job.error,
    result: job.resultJson ? JSON.parse(job.resultJson) : null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  });
}
