// /api/map — hazards + clusters for the public map (GeoJSON-ready payloads)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { autoRecomputeIfStale, parseHazardFilters, reportInclude, serializeHazard } from "@/lib/rg/hazards";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  await autoRecomputeIfStale();

  const where = parseHazardFilters(sp);
  const limit = Math.min(1000, Math.max(1, Number(sp.get("limit") ?? 500)));
  const [reports, clusters] = await Promise.all([
    db.hazardReport.findMany({ where, include: reportInclude, orderBy: { createdAt: "desc" }, take: limit }),
    db.hazardCluster.findMany({ orderBy: { hazardCount: "desc" }, take: 300 }),
  ]);

  const clusterIds = new Set(clusters.map((c) => c.id));
  return NextResponse.json({
    hazards: reports.map(serializeHazard),
    clusters: clusters.map((c) => ({
      id: c.id,
      label: c.label,
      centerLat: c.centerLat,
      centerLng: c.centerLng,
      radiusM: c.radiusM,
      hazardCount: c.hazardCount,
      dominantClass: c.dominantClass,
      avgSeverity: c.avgSeverity,
      maxSeverity: c.maxSeverity,
    })),
    // cluster ids referenced by hazards but absent from the cluster list (filtered out) — used by the client to dim orphans
    staleClusterIds: [...new Set(reports.map((r) => r.clusterId).filter((x): x is string => Boolean(x)))].filter((x) => !clusterIds.has(x)),
    computedAt: new Date().toISOString(),
  });
}
