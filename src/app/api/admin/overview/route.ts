// /api/admin/overview — command-center KPIs
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const actionable = { status: { in: ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW", "VERIFIED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "FLAGGED"] }, duplicateOfId: null };
  const [total, pending, critical, clusters, orders, queue] = await Promise.all([
    db.hazardReport.count({ where: actionable }),
    db.hazardReport.count({ where: { status: "PENDING_REVIEW", duplicateOfId: null } }),
    db.priorityScore.count({ where: { band: "CRITICAL", report: { status: { in: ["VERIFIED", "PENDING_REVIEW", "AI_VERIFIED", "REPORTED"] } } } }),
    db.hazardCluster.count(),
    db.workOrder.count({ where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } } }),
    db.hazardReport.findMany({
      where: { status: "PENDING_REVIEW", duplicateOfId: null },
      include: { priorityScores: { take: 1 } },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);
  const avg = await db.priorityScore.aggregate({ where: { report: { status: "VERIFIED" } }, _avg: { score: true } });
  return NextResponse.json({
    totals: {
      hazards: total,
      pendingReview: pending,
      critical,
      clusters,
      activeWorkOrders: orders,
      avgPriority: Math.round((avg._avg.score ?? 0) * 10) / 10,
    },
    recentQueue: queue.map((r) => ({
      id: r.id,
      referenceCode: r.referenceCode,
      hazardClass: r.hazardClass,
      severity: r.severity,
      createdAt: r.createdAt.toISOString(),
      priority: r.priorityScores[0]?.score ?? null,
      band: r.priorityScores[0]?.band ?? null,
    })),
  });
}
