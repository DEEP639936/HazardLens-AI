// One-off cleanup: remove ALL existing hazard data (reports, media, detections,
// clusters, work orders, notifications, audit logs) while KEEPING user accounts,
// sessions and system settings. Run with: bun scripts/clear-data.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // FK-safe order: children first
  const result: Record<string, number> = {};
  result.workOrderUpdates = await db.workOrderUpdate.deleteMany({}).then((r) => r.count);
  result.workOrders = await db.workOrder.deleteMany({}).then((r) => r.count);
  result.inferenceJobs = await db.inferenceJob.deleteMany({}).then((r) => r.count);
  result.detections = await db.detection.deleteMany({}).then((r) => r.count);
  result.priorityScores = await db.priorityScore.deleteMany({}).then((r) => r.count);
  result.clusterMemberships = await db.clusterMembership.deleteMany({}).then((r) => r.count);
  result.hazardClusters = await db.hazardCluster.deleteMany({}).then((r) => r.count);
  result.mediaAssets = await db.mediaAsset.deleteMany({}).then((r) => r.count);
  result.hazardReports = await db.hazardReport.deleteMany({}).then((r) => r.count);
  result.notifications = await db.notification.deleteMany({}).then((r) => r.count);
  result.auditLogs = await db.auditLog.deleteMany({}).then((r) => r.count);

  console.log("[clear-data] removed:", result);
  console.log("[clear-data] kept users:", await db.user.count(), "· settings:", await db.systemSetting.count());
}

main()
  .catch((err) => {
    console.error("[clear-data] failed", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
