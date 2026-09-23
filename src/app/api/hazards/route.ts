// /api/hazards — public, filterable hazard feed
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseHazardFilters, reportInclude, serializeHazard } from "@/lib/rg/hazards";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(1000, Math.max(1, Number(sp.get("limit") ?? 300)));
  const where = parseHazardFilters(sp);
  const reports = await db.hazardReport.findMany({
    where,
    include: reportInclude,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({
    items: reports.map(serializeHazard),
    count: reports.length,
  });
}
