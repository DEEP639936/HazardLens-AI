// /api/export/hazards.geojson — GeoJSON FeatureCollection export (admin)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { parseHazardFilters } from "@/lib/rg/hazards";
import { clientIp, writeAudit } from "@/lib/rg/audit";

export const runtime = "nodejs";

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

  const fc = {
    type: "FeatureCollection",
    name: "hazardlensai_hazards",
    features: reports.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lng, r.lat] },
      properties: {
        id: r.id,
        reference_code: r.referenceCode,
        hazard_class: r.hazardClass,
        severity: r.severity,
        status: r.status,
        priority_score: r.priorityScores[0]?.score ?? null,
        priority_band: r.priorityScores[0]?.band ?? null,
        ward: r.ward,
        address: r.address,
        road_name: r.roadName,
        road_class: r.roadClass,
        detection_confidence: r.detections[0]?.confidence ?? null,
        detection_engine: r.detections[0]?.engine ?? null,
        cluster_id: r.clusterId,
        created_at: r.createdAt.toISOString(),
      },
    })),
  };

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "export.geojson",
    entityType: "hazard_report",
    metadata: { features: fc.features.length },
    ip: clientIp(req),
  });

  return new NextResponse(JSON.stringify(fc, null, 2), {
    headers: {
      "Content-Type": "application/geo+json; charset=utf-8",
      "Content-Disposition": `attachment; filename="hazardlens-hazards-${new Date().toISOString().slice(0, 10)}.geojson"`,
    },
  });
}
