// /api/hazards/[id] — hazard detail.
// Public: VERIFIED (authority-confirmed) hazards. Everything else needs the owner,
// a management role (AUTHORITY/ADMIN), or a field worker assigned to the hazard.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuth } from "@/lib/rg/auth";
import { reportInclude, serializeHazard } from "@/lib/rg/hazards";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await db.hazardReport.findUnique({ where: { id }, include: reportInclude });
  if (!report) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });
  const isPublic = report.status === "VERIFIED";
  if (!isPublic) {
    const auth = await getAuth(req);
    let allowed = auth?.role === "ADMIN" || auth?.role === "AUTHORITY" || (auth && report.userId === auth.userId);
    if (!allowed && auth?.role === "FIELD_WORKER") {
      const wo = await db.workOrder.findUnique({ where: { hazardReportId: report.id }, select: { assignedUserId: true } });
      allowed = wo?.assignedUserId === auth.userId;
    }
    if (!allowed) return NextResponse.json({ error: "Hazard not found" }, { status: 404 });
  }
  return NextResponse.json({ hazard: serializeHazard(report) });
}
