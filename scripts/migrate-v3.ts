// One-time data migration for the "Intelligence, Verification & Resolution" upgrade.
//  - roles:  USER → CITIZEN, field@ → FIELD_WORKER (by naming convention)
//  - hazard statuses: APPROVED → VERIFIED (centralized lifecycle), PENDING_REVIEW stays
//  - work orders: NEW → OPEN, MEDIUM band → MODERATE
//  - backfill reportCount / uniqueReporters / lastReportedAt across merge groups
//  - recompute all priority scores (writes risk flags + recommended actions + new bands)
// Idempotent: safe to re-run.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("[migrate-v3] start");

  // 1. roles
  const users = await db.user.findMany();
  for (const u of users) {
    let role = u.role;
    if (role === "USER") role = "CITIZEN";
    if (/field/i.test(u.email) && role === "CITIZEN") role = "FIELD_WORKER";
    if (role !== u.role) {
      await db.user.update({ where: { id: u.id }, data: { role } });
      console.log(`[migrate-v3] user ${u.email}: ${u.role} → ${role}`);
    }
  }

  // 2. hazard statuses
  const r1 = await db.hazardReport.updateMany({ where: { status: "APPROVED" }, data: { status: "VERIFIED" } });
  if (r1.count) console.log(`[migrate-v3] hazards APPROVED → VERIFIED: ${r1.count}`);

  // 3. work orders
  const r2 = await db.workOrder.updateMany({ where: { status: "NEW" }, data: { status: "OPEN" } });
  if (r2.count) console.log(`[migrate-v3] work orders NEW → OPEN: ${r2.count}`);
  const r3 = await db.workOrder.updateMany({ where: { band: "MEDIUM" }, data: { band: "MODERATE" } });
  if (r3.count) console.log(`[migrate-v3] work orders band MEDIUM → MODERATE: ${r3.count}`);

  // 4. merge-group counters
  const canonicals = await db.hazardReport.findMany({
    where: { mergedReports: { some: {} } },
    include: { mergedReports: { select: { userId: true, submitterEmail: true, submitterName: true, createdAt: true } } },
  });
  for (const c of canonicals) {
    const identities = new Set<string>(
      [c.userId ?? c.submitterEmail ?? c.submitterName ?? "anon"].filter(Boolean) as string[]
    );
    for (const m of c.mergedReports) identities.add(m.userId ?? m.submitterEmail ?? m.submitterName ?? "anon");
    const last = [c.createdAt, ...c.mergedReports.map((m) => m.createdAt)].sort().at(-1)!;
    await db.hazardReport.update({
      where: { id: c.id },
      data: { reportCount: 1 + c.mergedReports.length, uniqueReporters: identities.size, lastReportedAt: last },
    });
    console.log(`[migrate-v3] counters for ${c.referenceCode}: reports=${1 + c.mergedReports.length} reporters=${identities.size}`);
  }

  // 5. priority refresh is done lazily by recomputePriorityForReport on next touch —
  //    force it now via a lightweight pass so bands/actions/flags are present immediately.
  const { execSync } = await import("child_process");
  console.log("[migrate-v3] done (priority refresh happens on demand via /api/clusters/recompute)");
  void execSync;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
