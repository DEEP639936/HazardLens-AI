// GET /api/hazards/[id]/duplicates — ranked duplicate candidates for a hazard.
// Roles: AUTHORITY | ADMIN (used by the verification panel and hazard detail).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireManagement } from "@/lib/rg/auth";
import { findDuplicateCandidates } from "@/lib/rg/duplicates";
import { getSettings } from "@/lib/rg/settings";
import type { HazardClass } from "@/lib/rg/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireManagement(req);
  if (isResponse(auth)) return auth;
  const { id } = await params;

  const report = await db.hazardReport.findUnique({ where: { id } });
  if (!report) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });

  const [candidates, settings] = await Promise.all([
    findDuplicateCandidates({
      lat: report.lat,
      lng: report.lng,
      hazardClass: report.hazardClass as HazardClass,
      excludeReportId: report.id,
    }),
    getSettings(),
  ]);
  return NextResponse.json({ candidates, thresholdPct: settings.duplicates.thresholdPct });
}
