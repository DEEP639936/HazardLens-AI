// RoadGuard Atlas — demo seed: Bengaluru scenario.
// Creates users, settings, model registry, media, ~30 hazards across real corridors,
// DBSCAN clusters, explainable priorities, work orders, notifications and audit trail.
// Run: bun run scripts/seed.ts   (idempotent — wipes and re-seeds the operational demo data)
import { PrismaClient } from "@prisma/client";
import { promises as fs } from "fs";
import path from "path";
import { dbscan, summarizeClusters } from "../src/lib/rg/dbscan";
import { haversineM, inferRoadCriticality, nearestWard } from "../src/lib/rg/geo";
import { computePriority, bandOf } from "../src/lib/rg/priority";
import { areaRatioOf, severityFromDetection } from "../src/lib/rg/severity";
import { DEFAULT_WEIGHTS } from "../src/lib/rg/constants";

const db = new PrismaClient();
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(process.cwd(), "uploads");
const SAMPLE_DIR = path.join(process.cwd(), "sample-data", "images");

const day = 86400_000;
const now = Date.now();
const ago = (days: number, jitterHours = 0) => new Date(now - days * day - jitterHours * 3600_000);

// deterministic RNG so seeds are reproducible
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20250922);

type HazardClass = "pothole" | "crack" | "erosion" | "waterlogging" | "marking" | "debris" | "edge_damage";

interface Scenario {
  cls: HazardClass;
  lat: number;
  lng: number;
  daysAgo: number;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "MERGED" | "FLAGGED";
  conf: number;
  roadName: string;
  roadClass: "highway" | "arterial" | "collector" | "residential";
  notes: string;
  mediaIdx?: number;
  citizenReport?: boolean;
}

// Admin overrides applied at seed time (demonstrates the manual-priority feature with plausible
// field-inspection rationale: monsoon emergency + airport corridor).
const OVERRIDES: Record<string, { score: number; reason: string }> = {
  "Outer Ring Road": { score: 82, reason: "Monsoon emergency — field inspection confirmed standing water across both carriageways." },
  "Bellary Road": { score: 80, reason: "Airport corridor — raised after night-inspection found repeated tyre damage." },
  "MG Road": { score: 64, reason: "School-zone crossing — escalated to the current maintenance cycle." },
};

const SCENARIO: Scenario[] = [
  // ---- Silk Board pothole cluster (3 + 1 merged duplicate) ----
  { cls: "pothole", lat: 12.91723, lng: 77.62293, daysAgo: 42, status: "APPROVED", conf: 0.93, roadName: "Hosur Road", roadClass: "highway", notes: "Deep pothole in the left lane right after the junction — two-wheelers swerve dangerously.", mediaIdx: 0, citizenReport: true },
  { cls: "pothole", lat: 12.91751, lng: 77.62320, daysAgo: 28, status: "APPROVED", conf: 0.89, roadName: "Hosur Road", roadClass: "highway", notes: "Same stretch, near the bus stop. Filled once, reopened after last week's rain.", citizenReport: true },
  { cls: "pothole", lat: 12.91702, lng: 77.62341, daysAgo: 19, status: "APPROVED", conf: 0.86, roadName: "Silk Board Junction", roadClass: "highway", notes: "Wheel-breaking crater by the service road exit." },
  { cls: "pothole", lat: 12.91740, lng: 77.62302, daysAgo: 12, status: "MERGED", conf: 0.91, roadName: "Hosur Road", roadClass: "highway", notes: "Duplicate — same pothole as other reports.", citizenReport: true },
  // ---- ORR Marathahalli waterlogging cluster ----
  { cls: "waterlogging", lat: 12.95602, lng: 77.70142, daysAgo: 21, status: "APPROVED", conf: 0.9, roadName: "Outer Ring Road", roadClass: "highway", notes: "Knee-deep water near the bridge underpass every rain; buses stall here.", mediaIdx: 4 },
  { cls: "waterlogging", lat: 12.95634, lng: 77.70170, daysAgo: 15, status: "APPROVED", conf: 0.84, roadName: "Outer Ring Road", roadClass: "highway", notes: "Drains clogged, waterlogging stretches 80 m past the bus bay.", citizenReport: true },
  { cls: "waterlogging", lat: 12.95571, lng: 77.70112, daysAgo: 9, status: "APPROVED", conf: 0.88, roadName: "Marathahalli Bridge", roadClass: "highway", notes: "Third time this monsoon. Sediment visible after water recedes." },
  // ---- MG Road marking cluster ----
  { cls: "marking", lat: 12.97542, lng: 77.60632, daysAgo: 34, status: "APPROVED", conf: 0.87, roadName: "MG Road", roadClass: "arterial", notes: "Zebra crossing outside the metro station is completely faded.", mediaIdx: 6 },
  { cls: "marking", lat: 12.97561, lng: 77.60651, daysAgo: 26, status: "PENDING_REVIEW", conf: 0.78, roadName: "MG Road", roadClass: "arterial", notes: "Lane divider markings invisible after 6 pm; headlights don't catch them." },
  { cls: "marking", lat: 12.97525, lng: 77.60605, daysAgo: 7, status: "PENDING_REVIEW", conf: 0.81, roadName: "MG Road", roadClass: "arterial", notes: "School children cross here every morning — repainting is urgent.", citizenReport: true },
  // ---- Indiranagar cracks ----
  { cls: "crack", lat: 12.97182, lng: 77.64112, daysAgo: 38, status: "APPROVED", conf: 0.83, roadName: "100 Feet Road", roadClass: "arterial", notes: "Longitudinal cracking spreading across two lanes near the Sony signal.", mediaIdx: 7 },
  { cls: "crack", lat: 12.97204, lng: 77.64140, daysAgo: 20, status: "APPROVED", conf: 0.8, roadName: "100 Feet Road", roadClass: "arterial", notes: "Cracks widening; loose gravel starting to collect at the edge." },
  // ---- singles across wards ----
  { cls: "pothole", lat: 13.03592, lng: 77.59612, daysAgo: 55, status: "APPROVED", conf: 0.92, roadName: "Bellary Road", roadClass: "highway", notes: "Pothole cluster on the airport-bound carriageway under the Hebbal flyover.", mediaIdx: 1 },
  { cls: "edge_damage", lat: 12.92991, lng: 77.58261, daysAgo: 48, status: "APPROVED", conf: 0.79, roadName: "11th Main Road", roadClass: "residential", notes: "Road edge crumbled into the drain; two-wheelers risk dropping a wheel.", citizenReport: true },
  { cls: "debris", lat: 12.93521, lng: 77.62452, daysAgo: 33, status: "APPROVED", conf: 0.76, roadName: "80 Feet Road", roadClass: "collector", notes: "Construction debris dumped overnight, occupying half the carriageway." },
  { cls: "erosion", lat: 12.96981, lng: 77.75001, daysAgo: 30, status: "APPROVED", conf: 0.77, roadName: "Whitefield Main Road", roadClass: "arterial", notes: "Surface ravelling badly near the ITPL gate — loose stones everywhere.", mediaIdx: 5 },
  { cls: "pothole", lat: 12.91102, lng: 77.69012, daysAgo: 26, status: "APPROVED", conf: 0.9, roadName: "Sarjapur Road", roadClass: "arterial", notes: "Three potholes in a row near the Wipro gate; taxis slow down abruptly." },
  { cls: "crack", lat: 12.90811, lng: 77.62071, daysAgo: 24, status: "APPROVED", conf: 0.74, roadName: "Hosur Road", roadClass: "highway", notes: "Alligator cracking patch before the elevated section." },
  { cls: "debris", lat: 13.02841, lng: 77.55461, daysAgo: 22, status: "PENDING_REVIEW", conf: 0.72, roadName: "Tumkur Road", roadClass: "highway", notes: "Fallen tree branches after the storm, partially blocking the slip road." },
  { cls: "edge_damage", lat: 12.83011, lng: 77.59012, daysAgo: 20, status: "PENDING_REVIEW", conf: 0.7, roadName: "Bannerghatta Road", roadClass: "collector", notes: "Shoulder washed away near the lake; edge drops 20 cm." },
  { cls: "erosion", lat: 12.89002, lng: 77.58012, daysAgo: 18, status: "PENDING_REVIEW", conf: 0.68, roadName: "Kanakapura Road", roadClass: "arterial", notes: "Rutting and erosion near the metro work zone." },
  { cls: "waterlogging", lat: 12.91162, lng: 77.64741, daysAgo: 16, status: "FLAGGED", conf: 0.64, roadName: "27th Main Road", roadClass: "collector", notes: "Waterlogging reported but photo may show an adjacent storm drain, not the road." },
  { cls: "debris", lat: 12.96002, lng: 77.65002, daysAgo: 15, status: "APPROVED", conf: 0.75, roadName: "Old Airport Road", roadClass: "arterial", notes: "Truck spillage: gravel and sand across the lane near the footbridge." },
  { cls: "marking", lat: 12.97402, lng: 77.60602, daysAgo: 13, status: "APPROVED", conf: 0.82, roadName: "Church Street", roadClass: "collector", notes: "Pedestrian crossing paint worn through at both ends." },
  { cls: "pothole", lat: 12.99171, lng: 77.55512, daysAgo: 11, status: "APPROVED", conf: 0.88, roadName: "Dr Rajkumar Road", roadClass: "arterial", notes: "Pothole at the junction swallowing by the petrol bunk.", citizenReport: true },
  { cls: "crack", lat: 12.94261, lng: 77.57441, daysAgo: 10, status: "PENDING_REVIEW", conf: 0.79, roadName: "Gandhi Bazaar Main Road", roadClass: "collector", notes: "Transverse cracks across the shopping street." },
  { cls: "marking", lat: 13.00351, lng: 77.56961, daysAgo: 8, status: "PENDING_REVIEW", conf: 0.73, roadName: "Sampige Road", roadClass: "collector", notes: "Faded bus-lane markings near the metro station." },
  { cls: "pothole", lat: 12.84521, lng: 77.66021, daysAgo: 6, status: "APPROVED", conf: 0.85, roadName: "Neeladri Road", roadClass: "collector", notes: "Potholes near Electronic City phase 1 gate; Techies report daily." },
  { cls: "waterlogging", lat: 12.91661, lng: 77.61012, daysAgo: 4, status: "PENDING_REVIEW", conf: 0.81, roadName: "BTM 16th Main", roadClass: "collector", notes: "Storm water overflow flooding the junction for three days now.", citizenReport: true },
  { cls: "pothole", lat: 12.92502, lng: 77.54682, daysAgo: 3, status: "REJECTED", conf: 0.58, roadName: "Banashankari", roadClass: "residential", notes: "Reported as pothole; inspection shows it is a patched utility trench, not a hazard." },
  { cls: "crack", lat: 13.02845, lng: 77.55465, daysAgo: 2, status: "REJECTED", conf: 0.55, roadName: "Yeshwanthpur", roadClass: "residential", notes: "Out-of-focus image; cannot confirm — requested re-upload." },
];

const MEDIA_FILES = ["case-1.jpg", "pothole-1.jpg", "pothole-2.jpg", "hero-road.jpg", "waterlogging-1.jpg", "crack-1.jpg", "case-3.jpg", "case-2.jpg"];

async function main() {
  console.log("🌱 Seeding RoadGuard Atlas demo scenario (Bengaluru)…");

  // 1. wipe (FK-safe order)
  await db.workOrderUpdate.deleteMany();
  await db.workOrder.deleteMany();
  await db.clusterMembership.deleteMany();
  await db.priorityScore.deleteMany();
  await db.detection.deleteMany();
  await db.inferenceJob.deleteMany();
  await db.mediaAsset.deleteMany();
  await db.hazardReport.deleteMany();
  await db.hazardCluster.deleteMany();
  await db.notification.deleteMany();
  await db.auditLog.deleteMany();
  await db.refreshToken.deleteMany();
  await db.modelVersion.deleteMany();
  await db.systemSetting.deleteMany();
  await db.user.deleteMany();

  // 2. settings + model registry
  await db.systemSetting.createMany({
    data: [
      { key: "priority.weights", valueJson: JSON.stringify(DEFAULT_WEIGHTS) },
      { key: "cluster.params", valueJson: JSON.stringify({ epsM: 60, minPts: 3, sinceDays: 90 }) },
      { key: "map.autoRecompute", valueJson: "true" },
    ],
  });
  const mv = await db.modelVersion.create({
    data: {
      version: "roadguard-yolo-v1.2.0",
      framework: "pytorch-ultralytics",
      weightsRef: "ml/runs/detect/v1.2.0/weights/best.pt",
      mAP50: 0.847,
      mAP5095: 0.571,
      precision: 0.862,
      recall: 0.794,
      latencyMs: 41,
      datasetRef: "huggingface:roadguard/road-hazards-in+RDD2022 (see MODEL_CARD.md)",
      notes: "YOLOv8s baseline + class-balanced sampler. Registered from MLflow run (demo values).",
      mlflowRunId: "d41f0a2c7c1943b8ab52e91d0c3a7f11",
    },
  });
  console.log("  ✓ settings + model version", mv.version);

  // 3. users
  const bcrypt = await import("bcryptjs");
  const admin = await db.user.create({
    data: {
      email: "admin@roadguardatlas.dev",
      passwordHash: bcrypt.hashSync("Atlas@Admin2024", 10),
      name: "Riya Menon",
      role: "ADMIN",
      ward: "Central Business District",
      notifyInApp: true,
      geoConsent: true,
    },
  });
  const citizen = await db.user.create({
    data: {
      email: "citizen@roadguardatlas.dev",
      passwordHash: bcrypt.hashSync("Atlas@User2024", 10),
      name: "Arjun Rao",
      role: "USER",
      ward: "Indiranagar",
      notifyInApp: true,
      geoConsent: true,
    },
  });
  await db.user.create({
    data: {
      email: "field@roadguardatlas.dev",
      passwordHash: bcrypt.hashSync("Atlas@User2024", 10),
      name: "Kavya Shetty",
      role: "USER",
      ward: "Koramangala",
      notifyInApp: true,
      geoConsent: false,
    },
  });
  console.log("  ✓ users (admin@roadguardatlas.dev / citizen@roadguardatlas.dev)");

  // 4. media assets: copy sample images into uploads/
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const mediaIds: string[] = [];
  for (const file of MEDIA_FILES) {
    const src = path.join(SAMPLE_DIR, file);
    try {
      const buf = await fs.readFile(src);
      const name = `seed-${file}`;
      await fs.writeFile(path.join(UPLOAD_DIR, name), buf);
      const asset = await db.mediaAsset.create({
        data: {
          kind: "ORIGINAL",
          storagePath: name,
          mimeType: "image/jpeg",
          sizeBytes: buf.length,
          width: 1280,
          height: 860,
        },
      });
      mediaIds.push(asset.id);
    } catch (err) {
      console.warn(`  ! media skipped (${file}):`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`  ✓ ${mediaIds.length} media assets`);

  // 5. hazard reports + detections
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const refCode = () => `RG-${Array.from({ length: 6 }, () => alphabet[Math.floor(rng() * alphabet.length)]).join("")}`;
  const reportIds: string[] = [];
  const created: { id: string; lat: number; lng: number; cls: HazardClass; daysAgo: number; status: string }[] = [];

  let i = 0;
  for (const s of SCENARIO) {
    i++;
    const refs = refCode();
    const bbox = (() => {
      const r = mulberry32(i * 7919);
      const w = 0.1 + r() * 0.2;
      const h = 0.08 + r() * 0.12;
      return [0.12 + r() * (0.76 - w), 0.28 + r() * (0.5 - h), w, h] as const;
    })();
    const area = areaRatioOf({ x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] });
    const severity = severityFromDetection({ hazardClass: s.cls, confidence: s.conf, areaRatio: area });

    const report = await db.hazardReport.create({
      data: {
        referenceCode: refs,
        userId: s.citizenReport ? citizen.id : null,
        submitterName: s.citizenReport ? "Arjun Rao" : null,
        submitterEmail: s.citizenReport ? citizen.email : null,
        hazardClass: s.cls,
        hazardClassAi: s.cls,
        severity,
        severityAi: severity,
        notes: s.notes,
        status: s.status,
        lat: s.lat,
        lng: s.lng,
        ward: nearestWard({ lat: s.lat, lng: s.lng }),
        roadName: s.roadName,
        roadClass: s.roadClass,
        roadCriticality: inferRoadCriticality(s.roadName, s.roadClass),
        geoConsent: true,
        source: "DEMO_SEED",
        createdAt: ago(s.daysAgo, (i * 3) % 24),
        updatedAt: ago(s.daysAgo, (i * 3) % 24),
        ...(s.status !== "PENDING_REVIEW"
          ? { reviewedAt: ago(Math.max(1, s.daysAgo - 2)), reviewedBy: admin.email, reviewNote: s.status === "APPROVED" ? "Verified against street imagery and field notes." : s.status === "MERGED" ? "Duplicate of the primary hazard — merged to strengthen the cluster." : "Could not be confirmed." }
          : {}),
      },
    });
    created.push({ id: report.id, lat: s.lat, lng: s.lng, cls: s.cls, daysAgo: s.daysAgo, status: s.status });
    reportIds.push(report.id);

    await db.detection.create({
      data: {
        reportId: report.id,
        modelVersion: mv.version,
        engine: "yolo-service",
        hazardClass: s.cls,
        confidence: s.conf,
        bboxX: bbox[0],
        bboxY: bbox[1],
        bboxW: bbox[2],
        bboxH: bbox[3],
        areaRatio: area,
        severity,
        inferenceMs: 38 + Math.floor(rng() * 30),
        createdAt: ago(s.daysAgo, (i * 3) % 24),
      },
    });
    if (s.mediaIdx != null && mediaIds[s.mediaIdx]) {
      await db.mediaAsset.update({ where: { id: mediaIds[s.mediaIdx] }, data: { reportId: report.id } });
    }
  }

  // link merged duplicate to its primary (first Silk Board report)
  const merged = created.find((c) => c.status === "MERGED");
  const primary = created.find((c) => c.status === "APPROVED" && c.cls === "pothole");
  if (merged && primary) {
    await db.hazardReport.update({ where: { id: merged.id }, data: { duplicateOfId: primary.id } });
  }
  console.log(`  ✓ ${created.length} hazard reports with detections`);

  // 6. clusters via DBSCAN over actionable reports
  const actionable = created.filter((c) => ["PENDING_REVIEW", "APPROVED", "FLAGGED"].includes(c.status));
  const labels = dbscan(actionable.map((c) => ({ lat: c.lat, lng: c.lng })), 60, 3);
  const summaries = summarizeClusters(actionable.map((c) => ({ lat: c.lat, lng: c.lng })), labels);
  for (let ci = 0; ci < summaries.length; ci++) {
    const sum = summaries[ci];
    const members = sum.memberIndexes.map((idx) => actionable[idx]);
    const tally = new Map<string, number>();
    members.forEach((m) => tally.set(m.cls, (tally.get(m.cls) ?? 0) + 1));
    const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sev = members.map((m) => severityFromDetection({ hazardClass: m.cls, confidence: 0.85, areaRatio: 0.08 }));
    const cluster = await db.hazardCluster.create({
      data: {
        label: `C-${ci + 1} · ${nearestWard({ lat: sum.centerLat, lng: sum.centerLng })}`,
        centerLat: sum.centerLat,
        centerLng: sum.centerLng,
        radiusM: Math.round(sum.radiusM),
        hazardCount: members.length,
        dominantClass: dominant,
        avgSeverity: Math.round((sev.reduce((a, b) => a + b, 0) / sev.length) * 100) / 100,
        maxSeverity: Math.max(...sev),
        paramsJson: JSON.stringify({ epsM: 60, minPts: 3, sinceDays: 90 }),
      },
    });
    for (const m of members) {
      await db.clusterMembership.create({
        data: { clusterId: cluster.id, reportId: m.id, distanceM: Math.round(haversineM({ lat: m.lat, lng: m.lng }, { lat: sum.centerLat, lng: sum.centerLng })) },
      });
      await db.hazardReport.update({ where: { id: m.id }, data: { clusterId: cluster.id } });
    }
  }
  console.log(`  ✓ ${summaries.length} clusters (DBSCAN 60 m / 3 pts)`);

  // 7. priority scores (same factor logic as the service)
  for (const c of actionable) {
    const neighbors = actionable.filter(
      (o) => o.id !== c.id && o.cls === c.cls && o.daysAgo >= c.daysAgo - 60 && haversineM({ lat: c.lat, lng: c.lng }, { lat: o.lat, lng: o.lng }) <= 120
    ).length;
    const recurrence = actionable.filter(
      (o) => o.id !== c.id && o.cls === c.cls && o.daysAgo >= c.daysAgo - 30 && haversineM({ lat: c.lat, lng: c.lng }, { lat: o.lat, lng: o.lng }) <= 75
    ).length;
    const scenario = SCENARIO.find((s) => s.cls === c.cls && s.lat === c.lat)!;
    const crit = inferRoadCriticality(scenario.roadName, scenario.roadClass);
    const result = computePriority({
      severity: severityFromDetection({ hazardClass: c.cls, confidence: scenario.conf, areaRatio: 0.08, duplicateCount: recurrence }),
      neighborCount: neighbors,
      roadCriticality: crit,
      recurrenceCount: recurrence,
      ageDays: c.daysAgo,
      weights: DEFAULT_WEIGHTS,
    });
    const override = OVERRIDES[scenario.roadName];
    await db.priorityScore.create({
      data: {
        reportId: c.id,
        score: override ? override.score : result.score,
        band: override ? bandOf(override.score) : result.band,
        severityNorm: result.factors[0].normalized,
        densityNorm: result.factors[1].normalized,
        criticalityNorm: result.factors[2].normalized,
        recurrenceNorm: result.factors[3].normalized,
        ageNorm: result.factors[4].normalized,
        weightsJson: JSON.stringify(result.weights),
        explanationJson: JSON.stringify(result.factors),
        overridden: Boolean(override),
        overriddenBy: override ? admin.email : null,
        manualScore: override ? override.score : null,
        computedAt: new Date(),
      },
    });
  }
  console.log("  ✓ priority scores computed");

  // 8. work orders across the pipeline
  const scoreRows = await db.priorityScore.findMany({ include: { report: true } });
  const top = scoreRows.sort((a, b) => b.score - a.score);
  const woSpecs = [
    { idx: 0, status: "IN_REPAIR", assigned: "Ward crew B — hotmix team", note: "Crew on site; lane closed 10:00-13:00." },
    { idx: 1, status: "SCHEDULED", assigned: "Storm-water division", note: "Desilting scheduled before next spell." },
    { idx: 2, status: "APPROVED", assigned: null, note: "Approved in the weekly roads review." },
    { idx: 3, status: "RESOLVED", assigned: "Ward crew A", note: "Repainted; verified by field inspection photos." },
    { idx: 4, status: "UNDER_REVIEW", assigned: null, note: "Checking contractor scope for edge reconstruction." },
    { idx: 5, status: "REPORTED", assigned: null, note: "Auto-proposed from critical band." },
  ];
  let woCount = 0;
  for (const spec of woSpecs) {
    const row = top[spec.idx];
    if (!row) continue;
    woCount++;
    const wo = await db.workOrder.create({
      data: {
        code: `WO-${String(woCount).padStart(4, "0")}`,
        title: `${row.report.hazardClass.replace("_", " ").replace(/^\w/, (m) => m.toUpperCase())} repair · ${row.report.ward ?? "Bengaluru"}`,
        description: `Priority ${Math.round(row.score)} (${row.band}). Source report ${row.report.referenceCode}.`,
        status: spec.status,
        priority: row.score,
        band: row.band,
        hazardReportId: row.reportId,
        assignedTo: spec.assigned,
        scheduledFor: spec.status === "SCHEDULED" || spec.status === "IN_REPAIR" ? new Date(now + 3 * day) : null,
        createdBy: admin.id,
      },
    });
    await db.workOrderUpdate.create({ data: { workOrderId: wo.id, authorId: admin.id, toStatus: "REPORTED", note: "Work order created", createdAt: ago(10) } });
    await db.workOrderUpdate.create({ data: { workOrderId: wo.id, authorId: admin.id, fromStatus: "REPORTED", toStatus: spec.status, note: spec.note, createdAt: ago(5) } });
    if (spec.status === "RESOLVED") {
      await db.workOrderUpdate.create({ data: { workOrderId: wo.id, authorId: admin.id, fromStatus: "IN_REPAIR", toStatus: "RESOLVED", note: "Verified and closed.", createdAt: ago(2) } });
    }
  }
  console.log(`  ✓ ${woCount} work orders across the pipeline`);

  // 9. notifications for the citizen
  await db.notification.createMany({
    data: [
      { userId: citizen.id, type: "SYSTEM", title: "Welcome to RoadGuard Atlas", body: "Your account is ready. Report hazards in two taps — we handle detection, clustering and follow-up.", read: true, createdAt: ago(45) },
      { userId: citizen.id, type: "REPORT_REVIEWED", title: "Your Hosur Road pothole report was approved", body: "Verified by moderator Riya Menon. It is now on the public map and clustered with two nearby reports.", read: true, createdAt: ago(40) },
      { userId: citizen.id, type: "REPORT_SUBMITTED", title: "Report received — MG Road crossing", body: "Your broken-marking report is in the review queue.", read: false, createdAt: ago(7) },
      { userId: citizen.id, type: "WORK_ORDER", title: "Repair crew assigned", body: "The Hosur Road pothole cluster moved to In Repair — crew B scheduled this week.", read: false, createdAt: ago(4) },
      { userId: citizen.id, type: "REPORT_REVIEWED", title: "Duplicate merged", body: "Your second Hosur Road report was merged into the primary hazard. Duplicates raise cluster priority — thank you!", read: false, createdAt: ago(3) },
      { userId: citizen.id, type: "WORK_ORDER", title: "Repair verified and closed", body: "The 11th Main road-edge repair in Jayanagar is resolved. Ride safe!", read: false, createdAt: ago(1) },
    ],
  });
  console.log("  ✓ notifications");

  // 10. audit trail
  const audits: { action: string; entityType: string; email: string; role: string; days: number; meta: Record<string, unknown> }[] = [
    { action: "auth.login", entityType: "user", email: admin.email, role: "ADMIN", days: 12, meta: { session: "demo" } },
    { action: "report.create", entityType: "hazard_report", email: citizen.email, role: "USER", days: 42, meta: { scenario: "Silk Board pothole" } },
    { action: "review.approve", entityType: "hazard_report", email: admin.email, role: "ADMIN", days: 40, meta: { note: "Verified against street imagery" } },
    { action: "review.approve", entityType: "hazard_report", email: admin.email, role: "ADMIN", days: 39, meta: {} },
    { action: "cluster.recompute", entityType: "hazard_cluster", email: admin.email, role: "ADMIN", days: 39, meta: { epsM: 60, minPts: 3 } },
    { action: "review.merge", entityType: "hazard_report", email: admin.email, role: "ADMIN", days: 10, meta: { reason: "duplicate" } },
    { action: "work_order.create", entityType: "work_order", email: admin.email, role: "ADMIN", days: 9, meta: { code: "WO-0001" } },
    { action: "work_order.update", entityType: "work_order", email: admin.email, role: "ADMIN", days: 5, meta: { to: "IN_REPAIR" } },
    { action: "settings.update", entityType: "system_settings", email: admin.email, role: "ADMIN", days: 5, meta: { weights: DEFAULT_WEIGHTS } },
    { action: "export.csv", entityType: "hazard_report", email: admin.email, role: "ADMIN", days: 2, meta: { rows: actionable.length } },
  ];
  for (const a of audits) {
    await db.auditLog.create({
      data: {
        actorEmail: a.email,
        actorRole: a.role,
        action: a.action,
        entityType: a.entityType,
        metadataJson: JSON.stringify(a.meta),
        ip: "127.0.0.1",
        createdAt: ago(a.days),
      },
    });
  }
  console.log("  ✓ audit trail");

  const counts = {
    users: await db.user.count(),
    reports: await db.hazardReport.count(),
    detections: await db.detection.count(),
    clusters: await db.hazardCluster.count(),
    priorities: await db.priorityScore.count(),
    workOrders: await db.workOrder.count(),
    notifications: await db.notification.count(),
    audits: await db.auditLog.count(),
    media: await db.mediaAsset.count(),
  };
  console.log("🌿 Seed complete:", counts);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
