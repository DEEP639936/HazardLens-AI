// /api/admin/model-versions — model registry (mirrors MLflow-registered models)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const items = await db.modelVersion.findMany({ orderBy: { registeredAt: "desc" } });
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const body = (await req.json().catch(() => null)) as {
    version?: string;
    framework?: string;
    weightsRef?: string;
    mAP50?: number;
    mAP5095?: number;
    precision?: number;
    recall?: number;
    latencyMs?: number;
    datasetRef?: string;
    notes?: string;
    mlflowRunId?: string;
  } | null;
  if (!body?.version || body.version.trim().length < 2) {
    return NextResponse.json({ error: "version is required" }, { status: 400 });
  }
  const exists = await db.modelVersion.findUnique({ where: { version: body.version } });
  if (exists) return NextResponse.json({ error: "Model version already registered" }, { status: 409 });
  const created = await db.modelVersion.create({
    data: {
      version: body.version.trim(),
      framework: body.framework ?? "pytorch-ultralytics",
      weightsRef: body.weightsRef ?? null,
      mAP50: body.mAP50 ?? null,
      mAP5095: body.mAP5095 ?? null,
      precision: body.precision ?? null,
      recall: body.recall ?? null,
      latencyMs: body.latencyMs ?? null,
      datasetRef: body.datasetRef ?? null,
      notes: body.notes ?? null,
      mlflowRunId: body.mlflowRunId ?? null,
    },
  });
  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "model_version.register",
    entityType: "model_version",
    entityId: created.id,
    metadata: { version: created.version },
    ip: clientIp(req),
  });
  return NextResponse.json({ modelVersion: created }, { status: 201 });
}
