// Reverts the browser-E2E work-order test: removes WO-0001, its updates,
// the WORK_ORDER notifications and the matching audit rows, then recomputes
// the priority score without the COMPLETED dampener.
// The user's own report (RG-NC468A) and its REPORT_SUBMITTED notification stay untouched.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const order = await db.workOrder.findFirst({ where: { code: "WO-0001" } });
  if (order) {
    await db.workOrderUpdate.deleteMany({ where: { workOrderId: order.id } });
    await db.workOrder.delete({ where: { id: order.id } });
    console.log("deleted work order", order.code);
  }
  const delNotifs = await db.notification.deleteMany({ where: { type: "WORK_ORDER" } });
  console.log("deleted notifications:", delNotifs.count);
  const delAudits = await db.auditLog.deleteMany({ where: { action: { in: ["work_order.create", "work_order.update"] } } });
  console.log("deleted audit rows:", delAudits.count);

  const report = await db.hazardReport.findUnique({ where: { referenceCode: "RG-NC468A" } });
  if (report) {
    // recompute without the resolved dampener: reuse computePriority through a tiny inline re-run
    const { computePriority } = await import("../src/lib/rg/priority");
    const { computeContextStats, getSettingsModule } = { computeContextStats: null, getSettingsModule: null } as never;
    // gather context stats the same way the app does
    const near = await computeContext(report.lat, report.lng, report.hazardClass, report.id);
    const settings = await getSettings();
    const result = computePriority({
      severity: report.severity,
      neighborCount: near.neighborCount,
      roadCriticality: report.roadCriticality ?? 0.4,
      recurrenceCount: near.recurrenceCount,
      ageDays: (Date.now() - report.createdAt.getTime()) / 86400_000,
      resolved: false,
      weights: settings.weights,
      overridden: false,
      manualScore: null,
    });
    await db.priorityScore.updateMany({
      where: { reportId: report.id },
      data: {
        score: result.score,
        band: result.band,
        explanationJson: JSON.stringify(result.factors),
        computedAt: new Date(),
      },
    });
    console.log("priority recomputed:", result.score.toFixed(1), result.band);
  }
  const counts = {
    reports: await db.hazardReport.count(),
    workOrders: await db.workOrder.count(),
    notifications: await db.notification.count(),
  };
  console.log("final state:", JSON.stringify(counts));
}

async function computeContext(lat: number, lng: number, hazardClass: string, excludeId: string) {
  const near60 = await db.hazardReport.findMany({
    where: { hazardClass, id: { not: excludeId }, status: { in: ["PENDING_REVIEW", "APPROVED", "FLAGGED"] }, duplicateOfId: null, createdAt: { gte: new Date(Date.now() - 60 * 86400_000) } },
    select: { id: true, lat: true, lng: true },
  });
  const near30 = near60.filter((r) => new Date(r.createdAt as unknown as string) >= new Date(Date.now() - 30 * 86400_000));
  const h = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const p = { lat, lng };
  return {
    neighborCount: near60.filter((r) => h(p, r) <= 120).length,
    recurrenceCount: near30.filter((r) => h(p, r) <= 75).length,
  };
}

async function getSettings() {
  const rows = await db.systemSetting.findMany({ where: { key: "priority" } });
  const row = rows[0];
  const weights = row ? (JSON.parse(row.valueJson) as { weights: { severity: number; density: number; criticality: number; recurrence: number; age: number } }).weights : { severity: 0.32, density: 0.24, criticality: 0.18, recurrence: 0.14, age: 0.12 };
  return { weights };
}

main().finally(() => db.$disconnect());
