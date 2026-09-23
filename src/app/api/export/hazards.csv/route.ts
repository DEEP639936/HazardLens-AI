// /api/export/hazards.csv — admin CSV export (respects the same filters as /api/hazards)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { parseHazardFilters } from "@/lib/rg/hazards";
import { clientIp, writeAudit } from "@/lib/rg/audit";

export const runtime = "nodejs";

const COLUMNS = [
  "reference_code",
  "hazard_class",
  "severity",
  "status",
  "priority_score",
  "priority_band",
  "lat",
  "lng",
  "ward",
  "address",
  "road_name",
  "road_class",
  "detection_confidence",
  "detection_engine",
  "cluster_id",
  "created_at",
  "reviewed_at",
];

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const where = parseHazardFilters(req.nextUrl.searchParams);
  const reports = await db.hazardReport.findMany({
    where,
    include: { priorityScores: { take: 1 }, detections: { orderBy: { confidence: "desc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const lines = [COLUMNS.join(",")];
  for (const r of reports) {
    lines.push(
      [
        r.referenceCode,
        r.hazardClass,
        r.severity,
        r.status,
        r.priorityScores[0]?.score ?? "",
        r.priorityScores[0]?.band ?? "",
        r.lat,
        r.lng,
        r.ward,
        r.address,
        r.roadName,
        r.roadClass,
        r.detections[0]?.confidence ?? "",
        r.detections[0]?.engine ?? "",
        r.clusterId,
        r.createdAt.toISOString(),
        r.reviewedAt?.toISOString() ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "export.csv",
    entityType: "hazard_report",
    metadata: { rows: reports.length },
    ip: clientIp(req),
  });

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hazardlens-hazards-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
