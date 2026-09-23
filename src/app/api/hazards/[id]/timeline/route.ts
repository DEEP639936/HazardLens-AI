// GET /api/hazards/[id]/timeline — backend-stored event timeline for a hazard.
// Sources: AuditLog rows for this entity + linked work-order updates. Nothing is fabricated
// in the frontend; each entry carries its actor and timestamp from the database.
// Roles: owner OR AUTHORITY | ADMIN.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuth, isResponse, requireManagement } from "@/lib/rg/auth";
import type { TimelineEntryDTO } from "@/lib/rg/types";

export const runtime = "nodejs";

function detailFromMetadata(action: string, meta: Record<string, unknown> | null): string {
  if (!meta) return "";
  switch (action) {
    case "report.create":
      return `Hazard reported (${meta.hazardClass ?? "unknown class"}) with ${meta.media ?? 0} media and ${meta.detections ?? 0} AI detections.`;
    case "report.create_merged":
      return `Reported and merged into ${meta.mergedInto ?? "an existing hazard"}.`;
    case "review.verify":
    case "review.approve":
      return meta.note ? `Verified — ${meta.note}` : "Hazard verified by an authority reviewer.";
    case "review.reject":
      return meta.note ? `Rejected — ${meta.note}` : "Hazard rejected by an authority reviewer.";
    case "review.escalate":
    case "review.flag":
      return meta.note ? `Escalated — ${meta.note}` : "Escalated for manual field inspection.";
    case "review.merge":
      return `Merged into ${meta.mergeIntoId ?? "another hazard"}.`;
    case "risk.recompute":
      return `Risk score calculated: ${meta.score ?? "—"}`;
    case "work_order.create":
      return `Work order ${meta.code ?? ""} created${meta.assignedTo ? ` and assigned to ${meta.assignedTo}` : ""}.`;
    case "work_order.update":
      return `${meta.from ?? "?"} → ${meta.to ?? "?"}${meta.note ? ` — ${meta.note}` : ""}`;
    case "work_order.evidence":
      return `Repair evidence uploaded${meta.after ? " (after photo attached)" : ""}${meta.before ? " (before photo attached)" : ""}.`;
    case "work_order.verify":
      return meta.decision === "reject"
        ? `Resolution rejected — ${meta.reason ?? "no reason recorded"}`
        : "Resolution verified by authority.";
    default:
      return meta.note ? String(meta.note) : "";
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await db.hazardReport.findUnique({ where: { id }, select: { id: true, userId: true, referenceCode: true } });
  if (!report) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });

  const auth = await getAuth(req);
  const isOwner = auth && report.userId === auth.userId;
  if (!isOwner) {
    const mgmt = await requireManagement(req);
    if (isResponse(mgmt)) return mgmt;
  }

  const [logs, woUpdates] = await Promise.all([
    db.auditLog.findMany({
      where: { entityType: "hazard_report", entityId: id },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
    db.workOrder.findUnique({
      where: { hazardReportId: id },
      select: { code: true, updates: { orderBy: { createdAt: "asc" }, include: { author: { select: { name: true } } } } },
    }),
  ]);

  const entries: TimelineEntryDTO[] = [];
  for (const l of logs) {
    let meta: Record<string, unknown> | null = null;
    try {
      meta = l.metadataJson ? (JSON.parse(l.metadataJson) as Record<string, unknown>) : null;
    } catch {
      meta = null;
    }
    entries.push({
      at: l.createdAt.toISOString(),
      actor: l.actorEmail,
      actorRole: l.actorRole,
      action: l.action,
      detail: detailFromMetadata(l.action, meta),
      kind: "hazard",
    });
  }
  for (const u of woUpdates?.updates ?? []) {
    const label =
      u.fromStatus && u.toStatus && u.fromStatus !== u.toStatus
        ? `${u.fromStatus.replace(/_/g, " ").toLowerCase()} → ${u.toStatus.replace(/_/g, " ").toLowerCase()}`
        : u.toStatus
          ? `${u.toStatus.replace(/_/g, " ").toLowerCase()}`
          : "update";
    entries.push({
      at: u.createdAt.toISOString(),
      actor: u.author?.name ?? null,
      action: "work_order.update",
      detail: `Work order ${woUpdates?.code ?? ""}: ${label}${u.note ? ` — ${u.note}` : ""}`,
      kind: "work_order",
    });
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));
  return NextResponse.json({ items: entries, referenceCode: report.referenceCode });
}
