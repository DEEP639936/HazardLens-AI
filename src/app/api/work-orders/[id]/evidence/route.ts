// POST /api/work-orders/[id]/evidence — field workers attach before/after repair evidence.
// Body: { beforeMediaId?, afterMediaId?, resolutionNotes? }
// Submitting the AFTER photo from IN_PROGRESS auto-advances COMPLETED → VERIFICATION_PENDING
// (the only path by which an order reaches verification), capturing timestamps and the uploader.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireRole } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { TransitionError, assertTransition, executeTransition, noticeFor, notifyReporter, syncHazardLifecycle } from "@/lib/rg/workflow";
import { recomputePriorityForReport } from "@/lib/rg/hazards";
import type { WorkOrderStatus } from "@/lib/rg/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ["AUTHORITY", "ADMIN", "FIELD_WORKER"]);
  if (isResponse(auth)) return auth;
  const { id } = await params;
  const ip = clientIp(req);

  const order = await db.workOrder.findUnique({ where: { id }, include: { hazardReport: true } });
  if (!order) return NextResponse.json({ error: "Work order not found" }, { status: 404 });
  if (auth.role === "FIELD_WORKER" && order.assignedUserId !== auth.userId) {
    return NextResponse.json({ error: "This work order is not assigned to you" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    beforeMediaId?: string;
    afterMediaId?: string;
    resolutionNotes?: string;
  } | null;
  if (!body?.beforeMediaId && !body?.afterMediaId && !body?.resolutionNotes) {
    return NextResponse.json({ error: "Provide beforeMediaId, afterMediaId or resolutionNotes" }, { status: 400 });
  }
  if (order.status === "CLOSED" || order.status === "VERIFIED") {
    return NextResponse.json({ error: "This work order is closed — evidence can no longer be attached" }, { status: 409 });
  }

  // validate media assets exist and are images
  const mediaIds = [body.beforeMediaId, body.afterMediaId].filter(Boolean) as string[];
  for (const mid of mediaIds) {
    const m = await db.mediaAsset.findUnique({ where: { id: mid }, select: { mimeType: true } });
    if (!m) return NextResponse.json({ error: `Media asset ${mid} not found — upload the photo first` }, { status: 400 });
    if (!m.mimeType.startsWith("image/")) {
      return NextResponse.json({ error: "Repair evidence must be an image (JPEG/PNG/WebP)" }, { status: 415 });
    }
  }

  const from = order.status as WorkOrderStatus;
  const hasAfter = Boolean(body.afterMediaId);
  const now = new Date();

  const updated = await db.workOrder.update({
    where: { id },
    data: {
      ...(body.beforeMediaId ? { beforeMediaId: body.beforeMediaId } : {}),
      ...(body.afterMediaId ? { afterMediaId: body.afterMediaId } : {}),
      ...(body.resolutionNotes ? { resolutionNotes: body.resolutionNotes.slice(0, 2000) } : {}),
      ...(from === "ASSIGNED" || from === "OPEN" ? { startedAt: order.startedAt ?? now } : {}),
      ...(from === "OPEN" ? { status: "IN_PROGRESS" as WorkOrderStatus, startedAt: now } : {}),
      ...(from === "ASSIGNED" ? { status: "IN_PROGRESS" as WorkOrderStatus } : {}),
      ...(from === "IN_PROGRESS" && hasAfter ? { status: "COMPLETED" as WorkOrderStatus, completedAt: now } : {}),
      ...(from === "COMPLETED" && hasAfter ? { status: "VERIFICATION_PENDING" as WorkOrderStatus } : {}),
    },
  });

  // chain the auto-advance COMPLETED → VERIFICATION_PENDING when after-photo lands
  let finalStatus = updated.status as WorkOrderStatus;
  if (finalStatus === "COMPLETED" && hasAfter) {
    try {
      assertTransition(finalStatus, "VERIFICATION_PENDING");
      await db.workOrder.update({ where: { id }, data: { status: "VERIFICATION_PENDING" } });
      finalStatus = "VERIFICATION_PENDING";
    } catch (err) {
      if (err instanceof TransitionError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  }

  await db.workOrderUpdate.create({
    data: {
      workOrderId: id,
      authorId: auth.userId,
      fromStatus: from,
      toStatus: finalStatus,
      note: body.resolutionNotes?.slice(0, 1000) ?? "Repair evidence uploaded",
    },
  });

  if (finalStatus !== from) {
    await syncHazardLifecycle(order.hazardReportId, finalStatus);
    await notifyReporter(order.hazardReportId, noticeFor(finalStatus, updated.assignedTo));
    if (order.hazardReportId) await recomputePriorityForReport(order.hazardReportId);
  }

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "work_order.evidence",
    entityType: "work_order",
    entityId: id,
    metadata: {
      code: order.code,
      before: Boolean(body.beforeMediaId),
      after: Boolean(body.afterMediaId),
      resolutionNotes: body.resolutionNotes ?? null,
      from,
      to: finalStatus,
    },
    ip,
  });

  return NextResponse.json({ ok: true, status: finalStatus });
}
