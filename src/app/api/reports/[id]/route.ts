// /api/reports/[id] — report detail (owner or admin)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuth } from "@/lib/rg/auth";
import { reportInclude, serializeHazard } from "@/lib/rg/hazards";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await db.hazardReport.findUnique({ where: { id }, include: reportInclude });
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });
  const auth = await getAuth(req);
  const isOwner = Boolean(auth && report.userId === auth.userId);
  const isAdmin = auth?.role === "ADMIN";
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "You do not have access to this report" }, { status: 403 });
  }
  return NextResponse.json({ report: serializeHazard(report) });
}
