// /api/hazards/[id]/priority-explanation — transparent breakdown of the 0–100 score
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeContextStats } from "@/lib/rg/hazards";
import { inferRoadCriticality } from "@/lib/rg/geo";
import { getSettings } from "@/lib/rg/settings";
import { computePriority } from "@/lib/rg/priority";
import { PRIORITY_FORMULA } from "@/lib/rg/constants";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await db.hazardReport.findUnique({
    where: { id },
    include: { workOrder: { select: { status: true } }, priorityScores: { orderBy: { computedAt: "desc" }, take: 1 } },
  });
  if (!report) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });
  if (report.status === "REJECTED" || report.status === "MERGED") {
    return NextResponse.json({ error: `Priority is not computed for ${report.status.toLowerCase()} hazards` }, { status: 409 });
  }

  const settings = await getSettings();
  const { neighborCount, recurrenceCount } = await computeContextStats({
    lat: report.lat,
    lng: report.lng,
    hazardClass: report.hazardClass,
    excludeReportId: report.id,
  });
  const criticality = report.roadCriticality ?? inferRoadCriticality(report.roadName, report.roadClass);
  const ageDays = (Date.now() - report.createdAt.getTime()) / 86400_000;
  const prev = report.priorityScores[0];
  const fresh = computePriority({
    severity: report.severity,
    neighborCount,
    roadCriticality: criticality,
    recurrenceCount,
    ageDays,
    resolved: report.workOrder?.status === "COMPLETED",
    weights: settings.weights,
    overridden: prev?.overridden ?? false,
    manualScore: prev?.manualScore ?? null,
  });

  return NextResponse.json({
    referenceCode: report.referenceCode,
    formula: PRIORITY_FORMULA,
    score: fresh.score,
    band: fresh.band,
    factors: fresh.factors,
    weights: fresh.weights,
    raw: {
      severity: report.severity,
      neighborCount,
      recurrenceCount,
      roadCriticality: criticality,
      ageDays: Math.round(ageDays),
      resolved: report.workOrder?.status === "COMPLETED",
      adminOverridden: prev?.overridden ?? false,
      manualScore: prev?.manualScore ?? null,
    },
    disclaimer:
      "This score prioritizes maintenance crew attention. It is not an engineering-grade road-safety assessment; human review and municipal judgment always take precedence.",
    computedAt: new Date().toISOString(),
  });
}
