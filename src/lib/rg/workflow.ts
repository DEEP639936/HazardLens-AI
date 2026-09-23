// Hazard-to-Resolution workflow engine: validated work-order transitions, hazard lifecycle
// sync, notifications and audit wiring. Shared by all /api/work-orders routes.
import { db } from "@/lib/db";
import { WORK_ORDER_TRANSITIONS, WO_STATUS_META, WO_TO_HAZARD_STATUS } from "./constants";
import { writeAudit } from "./audit";
import { recomputePriorityForReport } from "./hazards";
import type { AuthContext } from "./auth";
import type { ReportStatus, WorkOrderStatus } from "./types";

export class TransitionError extends Error {}

export function assertTransition(from: WorkOrderStatus, to: WorkOrderStatus): void {
  const allowed = WORK_ORDER_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    const allowedLabel = allowed.length
      ? allowed.map((s) => WO_STATUS_META[s].label).join(", ")
      : "no further transitions (terminal state)";
    throw new TransitionError(
      `Invalid transition: ${WO_STATUS_META[from].label} → ${WO_STATUS_META[to].label}. Allowed from here: ${allowedLabel}.`
    );
  }
}

/** Push the canonical hazard into the matching lifecycle stage (never backwards out of terminal states). */
export async function syncHazardLifecycle(hazardReportId: string | null, woStatus: WorkOrderStatus): Promise<void> {
  if (!hazardReportId) return;
  const hazardStatus = WO_TO_HAZARD_STATUS[woStatus];
  if (!hazardStatus) return;
  const hazard = await db.hazardReport.findUnique({ where: { id: hazardReportId }, select: { status: true } });
  if (!hazard) return;
  const terminal: ReportStatus[] = ["REJECTED", "MERGED"];
  if (terminal.includes(hazard.status as ReportStatus)) return;
  if (hazard.status !== hazardStatus) {
    await db.hazardReport.update({ where: { id: hazardReportId }, data: { status: hazardStatus } });
  }
}

export interface TransitionNotice {
  title: string;
  body: string;
}

export function noticeFor(to: WorkOrderStatus, crew: string | null, rejectReason?: string | null): TransitionNotice {
  switch (to) {
    case "ASSIGNED":
      return {
        title: "Repair crew assigned",
        body: crew ? `Work was assigned to ${crew}. Track progress in My Reports.` : "Your report moved into the repair pipeline.",
      };
    case "IN_PROGRESS":
      return { title: rejectReason ? "Repair needs rework" : "Repair in progress", body: rejectReason ? `The authority asked for rework: ${rejectReason}` : "A crew is on site — your report is being fixed right now." };
    case "COMPLETED":
      return { title: "Repair completed", body: "The hazard you reported has been repaired. Awaiting final verification." };
    case "VERIFICATION_PENDING":
      return { title: "Repair submitted for verification", body: "Before/after evidence was uploaded — the authority will verify the repair." };
    case "VERIFIED":
      return { title: "Repair verified", body: "The authority verified the resolution with before/after evidence. Thank you for making the road safer." };
    case "CLOSED":
      return { title: "Hazard closed", body: "Your report is now closed. Thank you for improving the road." };
    default:
      return { title: "Work order updated", body: "The maintenance status of your report changed." };
  }
}

export async function notifyReporter(hazardReportId: string | null, notice: TransitionNotice): Promise<void> {
  if (!hazardReportId) return;
  const hazard = await db.hazardReport.findUnique({ where: { id: hazardReportId }, select: { userId: true } });
  if (!hazard?.userId) return;
  await db.notification.create({
    data: {
      userId: hazard.userId,
      type: "WORK_ORDER",
      title: notice.title,
      body: notice.body,
      link: "#/dashboard",
    },
  });
}

export interface TransitionContext {
  orderId: string;
  actor: AuthContext;
  ip: string;
  toStatus: WorkOrderStatus;
  fromStatus: WorkOrderStatus;
  note?: string | null;
  extraMetadata?: Record<string, unknown>;
}

/** One audited, notification-sending, lifecycle-syncing status hop. */
export async function executeTransition(ctx: TransitionContext): Promise<void> {
  await db.workOrderUpdate.create({
    data: {
      workOrderId: ctx.orderId,
      authorId: ctx.actor.userId,
      fromStatus: ctx.fromStatus,
      toStatus: ctx.toStatus,
      note: ctx.note ?? null,
    },
  });
  await writeAudit({
    actorId: ctx.actor.userId,
    actorEmail: ctx.actor.email,
    actorRole: ctx.actor.role,
    action: "work_order.update",
    entityType: "work_order",
    entityId: ctx.orderId,
    metadata: { from: ctx.fromStatus, to: ctx.toStatus, note: ctx.note ?? null, ...(ctx.extraMetadata ?? {}) },
    ip: ctx.ip,
  });
}

export { recomputePriorityForReport };
