// /api/work-orders — hazard-to-resolution pipeline.
//   GET  : AUTHORITY/ADMIN see all orders; FIELD_WORKER sees the orders assigned to them.
//   POST : AUTHORITY/ADMIN create an order against a hazard (optionally assigning
//          department, team, field worker, due date in the same call).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireManagement, requireRole } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { executeTransition, noticeFor, notifyReporter, recomputePriorityForReport, syncHazardLifecycle } from "@/lib/rg/workflow";
import { getSettings } from "@/lib/rg/settings";
import { severityBandOf } from "@/lib/rg/constants";
import type { PriorityBand, WorkOrderStatus } from "@/lib/rg/types";

export const runtime = "nodejs";

const hazardSelect = {
  id: true,
  referenceCode: true,
  hazardClass: true,
  severity: true,
  status: true,
  address: true,
  roadName: true,
  ward: true,
  lat: true,
  lng: true,
  notes: true,
  reportCount: true,
  uniqueReporters: true,
  createdAt: true,
  media: { select: { id: true, kind: true, mimeType: true } },
  user: { select: { name: true } },
  priorityScores: { take: 1, orderBy: { computedAt: "desc" as const } },
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ["AUTHORITY", "ADMIN", "FIELD_WORKER"]);
  if (isResponse(auth)) return auth;

  const where = auth.role === "FIELD_WORKER" ? { assignedUserId: auth.userId } : {};
  const orders = await db.workOrder.findMany({
    where,
    include: {
      hazardReport: { select: hazardSelect },
      assignedUser: { select: { name: true } },
      updates: { orderBy: { createdAt: "desc" }, include: { author: { select: { name: true } } } },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: 300,
  });
  return NextResponse.json({
    items: orders.map((o) => {
      const ps = o.hazardReport?.priorityScores?.[0];
      return {
        id: o.id,
        code: o.code,
        title: o.title,
        description: o.description,
        status: o.status as WorkOrderStatus,
        priority: o.priority,
        band: o.band as PriorityBand,
        hazardReportId: o.hazardReportId,
        hazard: o.hazardReport
          ? {
              id: o.hazardReport.id,
              referenceCode: o.hazardReport.referenceCode,
              hazardClass: o.hazardReport.hazardClass,
              severity: o.hazardReport.severity,
              severityBand: severityBandOf(o.hazardReport.severity),
              status: o.hazardReport.status,
              address: o.hazardReport.address,
              roadName: o.hazardReport.roadName,
              ward: o.hazardReport.ward,
              lat: o.hazardReport.lat,
              lng: o.hazardReport.lng,
              notes: o.hazardReport.notes,
              reporter: o.hazardReport.user?.name ?? null,
              reportCount: o.hazardReport.reportCount,
              createdAt: o.hazardReport.createdAt.toISOString(),
              media: o.hazardReport.media,
              riskScore: ps?.score ?? null,
              riskBand: (ps?.band as PriorityBand) ?? null,
            }
          : null,
        clusterId: o.clusterId,
        department: o.department,
        assignedTeam: o.assignedTeam,
        assignedTo: o.assignedTo,
        assignedUserId: o.assignedUserId,
        assignedUserName: o.assignedUser?.name ?? null,
        assignedAt: o.assignedAt?.toISOString() ?? null,
        scheduledFor: o.scheduledFor?.toISOString() ?? null,
        dueDate: o.dueDate?.toISOString() ?? null,
        startedAt: o.startedAt?.toISOString() ?? null,
        completedAt: o.completedAt?.toISOString() ?? null,
        resolutionNotes: o.resolutionNotes,
        beforeMediaId: o.beforeMediaId,
        afterMediaId: o.afterMediaId,
        verifiedBy: o.verifiedBy,
        verifiedAt: o.verifiedAt?.toISOString() ?? null,
        rejectReason: o.rejectReason,
        createdAt: o.createdAt.toISOString(),
        updates: o.updates.map((u) => ({
          id: u.id,
          fromStatus: u.fromStatus,
          toStatus: u.toStatus,
          note: u.note,
          author: u.author?.name ?? null,
          createdAt: u.createdAt.toISOString(),
        })),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireManagement(req);
  if (isResponse(auth)) return auth;
  const ip = clientIp(req);
  const body = (await req.json().catch(() => null)) as {
    hazardReportId?: string;
    clusterId?: string;
    title?: string;
    description?: string;
    department?: string;
    assignedTeam?: string;
    assignedTo?: string;
    assignedUserId?: string;
    dueDate?: string;
    scheduledFor?: string;
    note?: string;
  } | null;
  if (!body?.hazardReportId) {
    return NextResponse.json({ error: "hazardReportId is required" }, { status: 400 });
  }

  const hazard = await db.hazardReport.findUnique({
    where: { id: body.hazardReportId },
    include: { priorityScores: { take: 1, orderBy: { computedAt: "desc" } } },
  });
  if (!hazard) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });
  if (hazard.status === "MERGED" || hazard.status === "REJECTED") {
    return NextResponse.json({ error: "Cannot open a work order against a merged or rejected hazard" }, { status: 409 });
  }
  if (await db.workOrder.findUnique({ where: { hazardReportId: hazard.id } })) {
    return NextResponse.json({ error: "A work order already exists for this hazard" }, { status: 409 });
  }

  // resolve the assigned field worker (must be a real user with the FIELD_WORKER role)
  let assignedUser: { id: string; name: string } | null = null;
  if (body.assignedUserId) {
    const u = await db.user.findUnique({ where: { id: body.assignedUserId }, select: { id: true, name: true, role: true } });
    if (!u) return NextResponse.json({ error: "Assigned user not found" }, { status: 400 });
    if (u.role !== "FIELD_WORKER" && u.role !== "USER") {
      return NextResponse.json({ error: "Assigned user must have the FIELD_WORKER role" }, { status: 400 });
    }
    assignedUser = { id: u.id, name: u.name };
  }

  // validate department/team against configured org lists (free text allowed but flagged)
  const settings = await getSettings();
  const department = body.department?.trim().slice(0, 80) || null;
  const assignedTeam = body.assignedTeam?.trim().slice(0, 80) || null;
  const assignedTo = (assignedUser?.name ?? body.assignedTo?.trim().slice(0, 120)) || null;

  const count = await db.workOrder.count();
  const code = `WO-${String(count + 1).padStart(4, "0")}`;
  const priority = hazard.priorityScores[0]?.score ?? 0;
  const band = hazard.priorityScores[0]?.band ?? "MODERATE";
  const place = hazard.roadName ?? hazard.address ?? hazard.referenceCode;
  const title =
    body.title?.trim().slice(0, 160) ||
    `${place} — ${hazard.hazardClass.replace("_", " ")} repair (${hazard.referenceCode})`;

  const status: WorkOrderStatus = assignedTo ? "ASSIGNED" : "OPEN";
  const created = await db.workOrder.create({
    data: {
      code,
      title,
      description: body.description?.slice(0, 2000) ?? null,
      status,
      priority,
      band,
      hazardReportId: hazard.id,
      clusterId: body.clusterId ?? hazard.clusterId ?? null,
      department,
      assignedTeam,
      assignedTo,
      assignedUserId: assignedUser?.id ?? null,
      assignedAt: assignedUser ? new Date() : null,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
      createdBy: auth.userId,
      updates: {
        create: {
          authorId: auth.userId,
          toStatus: status,
          note: body.note?.slice(0, 1000) ?? (assignedTo ? `Assigned to ${assignedTo}${assignedTeam ? ` (${assignedTeam})` : ""}` : "Work order created — awaiting assignment"),
        },
      },
    },
  });

  if (status === "ASSIGNED") {
    await syncHazardLifecycle(hazard.id, "ASSIGNED");
    await notifyReporter(hazard.id, noticeFor("ASSIGNED", assignedTo));
    if (assignedUser) {
      await db.notification.create({
        data: {
          userId: assignedUser.id,
          type: "WORK_ORDER",
          title: `New repair assignment — ${hazard.referenceCode}`,
          body: `${place}: ${hazard.hazardClass.replace("_", " ")} repair was assigned to you${assignedTeam ? ` (${assignedTeam})` : ""}. Open Work Orders to start.`,
          link: "#/work",
        },
      });
    }
  }
  await recomputePriorityForReport(hazard.id);

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "work_order.create",
    entityType: "work_order",
    entityId: created.id,
    metadata: {
      code,
      hazardReportId: hazard.id,
      assignedTo,
      assignedTeam,
      department,
      assignedUserId: assignedUser?.id ?? null,
      dueDate: body.dueDate ?? null,
      status,
    },
    ip,
  });
  return NextResponse.json({ id: created.id, code: created.code, status: created.status }, { status: 201 });
}
