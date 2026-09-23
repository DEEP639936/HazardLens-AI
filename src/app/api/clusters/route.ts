// /api/clusters — list current hazard clusters
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const minCount = Number(sp.get("minCount") ?? 1);
  const clusters = await db.hazardCluster.findMany({
    where: { hazardCount: { gte: minCount } },
    orderBy: { hazardCount: "desc" },
    take: 300,
  });
  const latest = await db.hazardCluster.findFirst({ orderBy: { computedAt: "desc" }, select: { computedAt: true, paramsJson: true } });
  return NextResponse.json({
    items: clusters.map((c) => ({
      id: c.id,
      label: c.label,
      centerLat: c.centerLat,
      centerLng: c.centerLng,
      radiusM: c.radiusM,
      hazardCount: c.hazardCount,
      dominantClass: c.dominantClass,
      avgSeverity: c.avgSeverity,
      maxSeverity: c.maxSeverity,
      computedAt: c.computedAt.toISOString(),
    })),
    lastComputedAt: latest?.computedAt?.toISOString() ?? null,
    params: latest?.paramsJson ? JSON.parse(latest.paramsJson) : null,
  });
}
