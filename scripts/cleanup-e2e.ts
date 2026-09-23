// Cleanup: removes ALL E2E test artifacts created during the verification-feature
// test window (2026-09-23T18:40Z onwards) and restores the pristine data state.
// The user's real report RG-NC468A (created 14:17Z) is untouched.
// Run: bunx tsx scripts/cleanup-e2e.ts
import { unlink } from "fs/promises";
import path from "path";
import { db } from "../src/lib/db";

const TEST_WINDOW_START = new Date("2026-09-23T18:40:00Z");
const TEST_REFS = ["HL-6PMWWR", "HL-3RXQYB", "HL-HJENHH"];

function uploadDir(): string {
  return process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(process.cwd(), "uploads");
}

async function main() {
  const dir = uploadDir();

  // 1. test hazards
  const testHazards = await db.hazardReport.findMany({
    where: { OR: [{ referenceCode: { in: TEST_REFS } }, { notes: { contains: "E2E pipeline test" } }] },
    select: { id: true, referenceCode: true },
  });
  const hazardIds = testHazards.map((h) => h.id);
  console.log("test hazards:", testHazards.map((h) => h.referenceCode).join(", "));

  // 2. work orders tied to them (+ any WO created in the window)
  const wos = await db.workOrder.findMany({
    where: { OR: [{ hazardReportId: { in: hazardIds } }, { createdAt: { gte: TEST_WINDOW_START } }] },
    select: { id: true, code: true, beforeMediaId: true, afterMediaId: true },
  });
  const woIds = wos.map((w) => w.id);
  console.log("test work orders:", wos.map((w) => w.code).join(", "));

  // media referenced by WO evidence
  const woMediaIds = wos.flatMap((w) => [w.beforeMediaId, w.afterMediaId].filter(Boolean) as string[]);

  // 3. notifications (all test-generated — created in window)
  const notifs = await db.notification.findMany({ where: { createdAt: { gte: TEST_WINDOW_START } }, select: { id: true } });

  // 4. media: linked to test hazards OR created in the window (orphan uploads included)
  const media = await db.mediaAsset.findMany({
    where: { OR: [{ reportId: { in: hazardIds } }, { createdAt: { gte: TEST_WINDOW_START } }] },
    select: { id: true, storagePath: true },
  });

  // 5. delete in dependency order
  await db.workOrderUpdate.deleteMany({ where: { workOrderId: { in: woIds } } });
  await db.workOrder.deleteMany({ where: { id: { in: woIds } } });
  await db.detection.deleteMany({ where: { reportId: { in: hazardIds } } });
  await db.priorityScore.deleteMany({ where: { reportId: { in: hazardIds } } });
  await db.notification.deleteMany({ where: { id: { in: notifs.map((n) => n.id) } } });
  await db.auditLog.deleteMany({ where: { createdAt: { gte: TEST_WINDOW_START } } });
  await db.hazardReport.deleteMany({ where: { id: { in: hazardIds } } });
  await db.mediaAsset.deleteMany({ where: { id: { in: media.map((m) => m.id) } } });

  // 6. remove media files
  let files = 0;
  for (const m of media) {
    try {
      await unlink(path.join(dir, path.basename(m.storagePath)));
      files++;
    } catch { /* already gone */ }
  }
  console.log(`deleted: ${woIds.length} WOs, ${hazardIds.length} hazards, ${notifs.length} notifications, ${media.length} media assets (${files} files), audits in window`);

  // 7. final state check
  const remaining = {
    hazards: await db.hazardReport.findMany({ select: { referenceCode: true, status: true } }),
    workOrders: await db.workOrder.count(),
    notifications: await db.notification.count(),
    media: await db.mediaAsset.count(),
  };
  console.log("FINAL STATE:", JSON.stringify(remaining));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
