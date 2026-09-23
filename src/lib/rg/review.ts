// Authority verification actions shared by /api/hazards/[id]/review (legacy alias)
// and /api/hazards/[id]/verify (canonical endpoint). Every action is audit-logged.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { AuthContext } from "./auth";
import { writeAudit } from "./audit";
import { isValidLatLng } from "./geo";
import { recomputePriorityForReport, reportInclude, serializeHazard } from "./hazards";
import { mergeHazardReports } from "./duplicates";
import { HAZARD_CLASSES } from "./constants";
import type { HazardClass, ReportStatus } from "./types";

export const REVIEW_ACTIONS = ["verify", "approve", "reject", "flag", "escalate", "merge"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const ACTION_TO_STATUS: Record<ReviewAction, ReportStatus | "MERGE"> = {
  verify: "VERIFIED",
  approve: "VERIFIED", // legacy alias
  reject: "REJECTED",
  flag: "FLAGGED",
  escalate: "FLAGGED", // escalation = flag for manual inspection
  merge: "MERGE",
};

export interface ReviewPayload {
  action?: string;
  note?: string;
  edits?: {
    hazardClass?: string;
    severity?: number;
    lat?: number;
    lng?: number;
    address?: string;
    ward?: string;
    roadName?: string;
    roadClass?: string;
    roadCriticality?: number;
  };
  mergeIntoId?: string;
  manualScore?: number;
}

export async function applyReviewAction(
  id: string,
  body: ReviewPayload | null,
  auth: AuthContext,
  ip: string
): Promise<NextResponse> {
  if (!body?.action || !REVIEW_ACTIONS.includes(body.action as ReviewAction)) {
    return NextResponse.json({ error: `action must be one of: ${REVIEW_ACTIONS.join(", ")}` }, { status: 400 });
  }
  const action = body.action as ReviewAction;

  const report = await db.hazardReport.findUnique({ where: { id } });
  if (!report) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });
  if (report.status === "MERGED") {
    return NextResponse.json({ error: "This hazard was merged into a canonical record", detail: "Verify the canonical hazard instead." }, { status: 409 });
  }

  // apply optional edits first
  const edits = body.edits ?? {};
  const editData: Record<string, unknown> = {};
  if (edits.hazardClass && (HAZARD_CLASSES as string[]).includes(edits.hazardClass)) editData.hazardClass = edits.hazardClass as HazardClass;
  if (edits.severity != null) {
    if (edits.severity < 1 || edits.severity > 5) return NextResponse.json({ error: "severity must be 1..5" }, { status: 400 });
    editData.severity = Math.round(edits.severity);
  }
  if (edits.lat != null && edits.lng != null) {
    if (!isValidLatLng(edits.lat, edits.lng)) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
    editData.lat = edits.lat;
    editData.lng = edits.lng;
  }
  for (const k of ["address", "ward", "roadName", "roadClass"] as const) {
    if (edits[k] !== undefined) editData[k] = edits[k];
  }
  if (edits.roadCriticality != null) {
    if (edits.roadCriticality < 0 || edits.roadCriticality > 1) return NextResponse.json({ error: "roadCriticality must be 0..1" }, { status: 400 });
    editData.roadCriticality = edits.roadCriticality;
  }
  if (Object.keys(editData).length > 0) {
    await db.hazardReport.update({ where: { id }, data: editData });
  }

  // optional explainable manual risk-score override
  if (body.manualScore != null) {
    if (body.manualScore < 0 || body.manualScore > 100) return NextResponse.json({ error: "manualScore must be 0..100" }, { status: 400 });
    await db.priorityScore.upsert({
      where: { reportId: id },
      update: { overridden: true, manualScore: body.manualScore, overriddenBy: auth.email },
      create: { reportId: id, score: body.manualScore, band: "MODERATE", severityNorm: 0, densityNorm: 0, criticalityNorm: 0, recurrenceNorm: 0, ageNorm: 0, weightsJson: "{}", explanationJson: "[]", overridden: true, manualScore: body.manualScore, overriddenBy: auth.email },
    });
  }

  let updated;
  if (action !== "merge") {
    const status = ACTION_TO_STATUS[action];
    updated = await db.hazardReport.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedBy: auth.email, reviewNote: body.note ?? null },
    });
    if (report.userId) {
      const label = status === "VERIFIED" ? "verified" : status === "REJECTED" ? "rejected" : "flagged for inspection";
      await db.notification.create({
        data: {
          userId: report.userId,
          type: "REPORT_REVIEWED",
          title: `Report ${report.referenceCode} ${label}`,
          body: body.note ?? `An authority reviewer has ${label} your report${status === "VERIFIED" ? ". It is now confirmed on the live map." : "."}`,
          link: "#/dashboard",
        },
      });
    }
  } else {
    // merge
    if (!body.mergeIntoId || body.mergeIntoId === id) {
      return NextResponse.json({ error: "mergeIntoId must reference a different hazard" }, { status: 400 });
    }
    try {
      await mergeHazardReports({
        duplicateId: id,
        primaryId: body.mergeIntoId,
        actorId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        note: body.note ?? null,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Merge failed" }, { status: 409 });
    }
    const primary = await db.hazardReport.findUnique({ where: { id: body.mergeIntoId } });
    if (report.userId) {
      await db.notification.create({
        data: {
          userId: report.userId,
          type: "REPORT_REVIEWED",
          title: `Report ${report.referenceCode} merged`,
          body: `Your report was confirmed as a duplicate of ${primary?.referenceCode ?? "an existing hazard"}. Thank you — duplicates raise the hazard's community confidence.`,
          link: "#/dashboard",
        },
      });
    }
  }

  await recomputePriorityForReport(id);
  if (action === "merge") await recomputePriorityForReport(body.mergeIntoId!);

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: `review.${action}`,
    entityType: "hazard_report",
    entityId: id,
    metadata: {
      reference: report.referenceCode,
      note: body.note ?? null,
      edits: Object.keys(editData),
      manualScore: body.manualScore ?? null,
      mergeIntoId: action === "merge" ? body.mergeIntoId : null,
    },
    ip,
  });

  const full = await db.hazardReport.findUnique({ where: { id }, include: reportInclude });
  return NextResponse.json({ hazard: full ? serializeHazard(full) : null });
}
