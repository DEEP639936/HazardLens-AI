// POST /api/work-orders/[id]/verify — resolution verification (ADMIN only).
// The main administrator is the single authority who inspects the contractor's
// before/after evidence and decides the fate of the repair:
//   { decision: "approve" }  → VERIFICATION_PENDING → VERIFIED (verifiedBy/At recorded, reporter notified)
//   { decision: "reject", reason } → VERIFICATION_PENDING → IN_PROGRESS (reason REQUIRED, rework)
// Roles: ADMIN (403 for AUTHORITY/FIELD_WORKER/CITIZEN).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { TransitionError, assertTransition, executeTransition, notifyReporter, syncHazardLifecycle } from "@/lib/rg/workflow";
import { recomputePriorityForReport } from "@/lib/rg/hazards";
import type { WorkOrderStatus } from "@/lib/rg/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const { id } = await params;
  const ip = clientIp(req);

  const body = (await req.json().catch(() => null)) as { decision?: string; reason?: string } | null;
  if (body?.decision !== "approve" && body?.decision !== "reject") {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }
  if (body.decision === "reject" && !body.reason?.trim()) {
    return NextResponse.json({ error: "A rejection reason is required", detail: "Explain what the field crew must redo." }, { status: 400 });
  }

  const order = await db.workOrder.findUnique({ where: { id }, include: { hazardReport: true } });
  if (!order) return NextResponse.json({ error: "Work order not found" }, { status: 404 });

  const from = order.status as WorkOrderStatus;
  const to: WorkOrderStatus = body.decision === "approve" ? "VERIFIED" : "IN_PROGRESS";
  try {
    assertTransition(from, to);
  } catch (err) {
    if (err instanceof TransitionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const now = new Date();
  await db.workOrder.update({
    where: { id },
    data: {
      status: to,
      ...(body.decision === "approve" ? { verifiedBy: auth.email, verifiedAt: now, rejectReason: null } : { rejectReason: body.reason!.trim().slice(0, 1000) }),
    },
  });

  await executeTransition({
    orderId: id,
    actor: auth,
    ip,
    fromStatus: from,
    toStatus: to,
    note: body.decision === "approve" ? body.reason?.trim() ?? "Resolution approved" : `Rejected: ${body.reason!.trim()}`,
    extraMetadata: { decision: body.decision },
  });

  if (order.hazardReportId) {
    await syncHazardLifecycle(order.hazardReportId, to);
    await notifyReporter(
      order.hazardReportId,
      body.decision === "approve"
        ? { title: "Repair verified", body: "The authority verified the resolution with before/after evidence. Thank you for making the road safer." }
        : { title: "Repair needs rework", body: `The authority rejected the resolution: ${body.reason!.trim()}` }
    );
    if (body.decision === "reject" && order.assignedUserId) {
      await db.notification.create({
        data: {
          userId: order.assignedUserId,
          type: "WORK_ORDER",
          title: `Rework requested — ${order.code}`,
          body: `${body.reason!.trim()}. Upload fresh evidence after redoing the repair.`,
          link: "#/work",
        },
      });
    }
    await recomputePriorityForReport(order.hazardReportId);
  }

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "work_order.verify",
    entityType: "work_order",
    entityId: id,
    metadata: { code: order.code, decision: body.decision, reason: body.decision === "reject" ? body.reason!.trim() : null },
    ip,
  });

  return NextResponse.json({ ok: true, status: to });
}
