// /api/work-orders/[id] — detail + guarded status transitions.
//   AUTHORITY/ADMIN : assign (OPEN→ASSIGNED), start, complete, verify, close, reassignment, due dates
//   FIELD_WORKER    : start work on own assignment (ASSIGNED→IN_PROGRESS) and mark completion notes
// Transitions outside WORK_ORDER_TRANSITIONS are rejected with 400.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireRole } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { TransitionError, assertTransition, executeTransition, noticeFor, notifyReporter, syncHazardLifecycle } from "@/lib/rg/workflow";
import { severityBandOf } from "@/lib/rg/constants";
import type { PriorityBand, WorkOrderStatus } from "@/lib/rg/types";

export const runtime = "nodejs";

function isWoStatus(v: string): v is WorkOrderStatus {
  return ["OPEN", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "VERIFICATION_PENDING", "VERIFIED", "CLOSED"].includes(v);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ["AUTHORITY", "ADMIN", "FIELD_WORKER"]);
  if (isResponse(auth)) return auth;
  const { id } = await params;
  const order = await db.workOrder.findUnique({
    where: { id },
    include: {
      hazardReport: {
        select: {
          referenceCode: true,
          hazardClass: true,
          severity: true,
          status: true,
          address: true,
          reportCount: true,
          priorityScores: { take: 1, orderBy: { computedAt: "desc" as const } },
        },
      },
      assignedUser: { select: { name: true } },
      updates: { orderBy: { createdAt: "desc" }, include: { author: { select: { name: true } } } },
    },
  });
  if (!order) return NextResponse.json({ error: "Work order not found" }, { status: 404 });
  if (auth.role === "FIELD_WORKER" && order.assignedUserId !== auth.userId) {
    return NextResponse.json({ error: "This work order is not assigned to you" }, { status: 403 });
  }
  const ps = order.hazardReport?.priorityScores?.[0];
  return NextResponse.json({
    workOrder: {
      id: order.id,
      code: order.code,
      title: order.title,
      description: order.description,
      status: order.status,
      priority: order.priority,
      band: order.band,
      hazardReportId: order.hazardReportId,
      hazard: order.hazardReport
        ? {
            referenceCode: order.hazardReport.referenceCode,
            hazardClass: order.hazardReport.hazardClass,
            severity: order.hazardReport.severity,
            severityBand: severityBandOf(order.hazardReport.severity),
            status: order.hazardReport.status,
            address: order.hazardReport.address,
            reportCount: order.hazardReport.reportCount,
            riskScore: ps?.score ?? null,
            riskBand: (ps?.band as PriorityBand) ?? null,
          }
        : null,
      department: order.department,
      assignedTeam: order.assignedTeam,
      assignedTo: order.assignedTo,
      assignedUserId: order.assignedUserId,
      assignedUserName: order.assignedUser?.name ?? null,
      assignedAt: order.assignedAt?.toISOString() ?? null,
      scheduledFor: order.scheduledFor?.toISOString() ?? null,
      dueDate: order.dueDate?.toISOString() ?? null,
      startedAt: order.startedAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      resolutionNotes: order.resolutionNotes,
      beforeMediaId: order.beforeMediaId,
      afterMediaId: order.afterMediaId,
      verifiedBy: order.verifiedBy,
      verifiedAt: order.verifiedAt?.toISOString() ?? null,
      rejectReason: order.rejectReason,
      createdAt: order.createdAt.toISOString(),
      updates: order.updates.map((u) => ({
        id: u.id,
        fromStatus: u.fromStatus,
        toStatus: u.toStatus,
        note: u.note,
        author: u.author?.name ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    status?: string;
    note?: string;
    assignedTo?: string | null;
    assignedTeam?: string | null;
    department?: string | null;
    assignedUserId?: string | null;
    scheduledFor?: string | null;
    dueDate?: string | null;
  } | null;

  const from = order.status as WorkOrderStatus;
  const to = body?.status;
  if (to && !isWoStatus(to)) {
    return NextResponse.json({ error: `status must be one of: OPEN, ASSIGNED, IN_PROGRESS, COMPLETED, VERIFICATION_PENDING, VERIFIED, CLOSED` }, { status: 400 });
  }
  if (to && to !== from) {
    try {
      assertTransition(from, to as WorkOrderStatus);
    } catch (err) {
      if (err instanceof TransitionError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  }

  // field workers may only drive their own assignment's progress, not assign/verify
  if (auth.role === "FIELD_WORKER" && to && !["IN_PROGRESS", "COMPLETED"].includes(to)) {
    return NextResponse.json({ error: "Field workers can only start work or submit completion", detail: "Assignment and verification are authority actions." }, { status: 403 });
  }

  // resolve reassignment target
  let assignedUserId = order.assignedUserId;
  if (body?.assignedUserId !== undefined) {
    if (body.assignedUserId === null) {
      assignedUserId = null;
    } else {
      const u = await db.user.findUnique({ where: { id: body.assignedUserId }, select: { id: true, name: true, role: true } });
      if (!u) return NextResponse.json({ error: "Assigned user not found" }, { status: 400 });
      if (u.role !== "FIELD_WORKER" && u.role !== "USER") {
        return NextResponse.json({ error: "Assigned user must have the FIELD_WORKER role" }, { status: 400 });
      }
      assignedUserId = u.id;
    }
  }
  const assignedUserName = assignedUserId
    ? (await db.user.findUnique({ where: { id: assignedUserId }, select: { name: true } }))?.name ?? null
    : null;

  const toStatus = (to ?? from) as WorkOrderStatus;
  const now = new Date();
  const updated = await db.workOrder.update({
    where: { id },
    data: {
      ...(to ? { status: toStatus } : {}),
      ...(body?.assignedTo !== undefined ? { assignedTo: body.assignedTo?.slice(0, 120) || null } : {}),
      ...(body?.assignedTeam !== undefined ? { assignedTeam: body.assignedTeam?.slice(0, 80) || null } : {}),
      ...(body?.department !== undefined ? { department: body.department?.slice(0, 80) || null } : {}),
      ...(body?.assignedUserId !== undefined ? { assignedUserId } : {}),
      ...(assignedUserId && !order.assignedAt ? { assignedAt: now } : {}),
      ...(body?.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null } : {}),
      ...(body?.dueDate !== undefined ? { dueDate: body.dueDate ? new Date(body.dueDate) : null } : {}),
      ...(to === "IN_PROGRESS" && !order.startedAt ? { startedAt: now } : {}),
      ...(to === "COMPLETED" ? { completedAt: now } : {}),
      ...(to === "VERIFIED" ? { verifiedBy: auth.email, verifiedAt: now } : {}),
    },
  });

  // refresh the denormalized crew label when a field worker replaced free text
  if (assignedUserId && assignedUserName && body?.assignedUserId !== undefined) {
    await db.workOrder.update({ where: { id }, data: { assignedTo: assignedUserName } });
  }

  const statusChanged = toStatus !== from;
  await executeTransition({
    orderId: id,
    actor: auth,
    ip,
    fromStatus: from,
    toStatus,
    note: body?.note ?? null,
    extraMetadata: body?.assignedUserId !== undefined ? { reassignedTo: assignedUserName } : undefined,
  });

  if (statusChanged && order.hazardReportId) {
    await syncHazardLifecycle(order.hazardReportId, toStatus);
    if (auth.role !== "FIELD_WORKER" || toStatus !== "ASSIGNED") {
      await notifyReporter(order.hazardReportId, noticeFor(toStatus, updated.assignedTo));
    }
    await (await import("@/lib/rg/hazards")).recomputePriorityForReport(order.hazardReportId);
  }

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "work_order.update",
    entityType: "work_order",
    entityId: id,
    metadata: { code: order.code, from, to: toStatus, note: body?.note ?? null },
    ip,
  });
  return NextResponse.json({ ok: true, status: toStatus });
}
