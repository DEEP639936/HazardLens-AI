// Hazard domain service: serialization, geospatial context stats, priority recompute and
// DBSCAN cluster recomputation. Production parity: backend/app/services/{hazards,clustering,priority}.py
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { computePriority } from "./priority";
import { haversineM, inferRoadCriticality, nearestWard } from "./geo";
import { getSettings, type Settings } from "./settings";
import { dbscan, summarizeClusters } from "./dbscan";
import { ACTIONABLE_STATUSES, CLASS_META, DEFAULT_MAP_STATUSES, HAZARD_STATUSES, severityBandOf } from "./constants";
import { recommendedActionFor, riskFlagsFor } from "./risk";
import type { BboxDTO, HazardDTO, HazardClass, PriorityBand, ReportStatus, RiskFlagDTO, WorkOrderStatus } from "./types";

export const reportInclude = {
  media: true,
  detections: { orderBy: { confidence: "desc" as const } },
  priorityScores: { orderBy: { computedAt: "desc" as const }, take: 1 },
  workOrder: {
    select: {
      id: true,
      code: true,
      status: true,
      beforeMediaId: true,
      afterMediaId: true,
      resolutionNotes: true,
      completedAt: true,
      verifiedBy: true,
      verifiedAt: true,
      rejectReason: true,
    },
  },
  mergedReports: {
    select: {
      id: true,
      referenceCode: true,
      submitterName: true,
      createdAt: true,
      media: { select: { id: true, kind: true, mimeType: true } },
    },
  },
} satisfies Prisma.HazardReportInclude;

export type ReportWithRelations = Prisma.HazardReportGetPayload<{ include: typeof reportInclude }>;

export function serializeHazard(r: ReportWithRelations): HazardDTO {
  const ps = r.priorityScores[0];
  let priority: HazardDTO["priority"] = null;
  if (ps) {
    try {
      let riskFlags: RiskFlagDTO[] = [];
      if (ps.riskFlagsJson) {
        try { riskFlags = JSON.parse(ps.riskFlagsJson); } catch { riskFlags = []; }
      }
      priority = {
        score: ps.score,
        band: ps.band as PriorityBand,
        factors: JSON.parse(ps.explanationJson),
        riskFlags,
        recommendedAction: ps.recommendedAction ?? null,
        weights: JSON.parse(ps.weightsJson),
        overridden: ps.overridden,
        manualScore: ps.manualScore,
        computedAt: ps.computedAt.toISOString(),
      };
    } catch {
      priority = null;
    }
  }
  return {
    severityBand: severityBandOf(r.severity),
    reportCount: r.reportCount,
    uniqueReporters: r.uniqueReporters,
    lastReportedAt: r.lastReportedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    mergedEvidence: (r.mergedReports ?? []).flatMap((m) =>
      m.media.map((mm) => ({ id: mm.id, kind: mm.kind, mimeType: mm.mimeType, referenceCode: m.referenceCode, submitterName: m.submitterName, createdAt: m.createdAt.toISOString() }))
    ),
    id: r.id,
    referenceCode: r.referenceCode,
    hazardClass: r.hazardClass as HazardClass,
    severity: r.severity,
    status: r.status as ReportStatus,
    lat: r.lat,
    lng: r.lng,
    address: r.address,
    ward: r.ward,
    roadName: r.roadName,
    roadClass: (r.roadClass as HazardDTO["roadClass"]) ?? null,
    notes: r.notes,
    source: r.source,
    duplicateOfId: r.duplicateOfId,
    submitterName: r.submitterName,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewNote: r.reviewNote,
    userId: r.userId,
    media: r.media.map((m) => ({
      id: m.id,
      kind: m.kind,
      mimeType: m.mimeType,
      width: m.width,
      height: m.height,
      durationSec: m.durationSec,
    })),
    detections: r.detections.map(
      (d): BboxDTO => ({
        id: d.id,
        hazardClass: d.hazardClass as HazardClass,
        confidence: d.confidence,
        bbox: [d.bboxX, d.bboxY, d.bboxW, d.bboxH],
        areaRatio: d.areaRatio,
        severity: d.severity,
        engine: d.engine,
        modelVersion: d.modelVersion,
      })
    ),
    priority,
    clusterId: r.clusterId,
    workOrderStatus: (r.workOrder?.status as WorkOrderStatus) ?? null,
    workOrder: r.workOrder
      ? {
          id: r.workOrder.id,
          code: r.workOrder.code,
          status: r.workOrder.status as WorkOrderStatus,
          beforeMediaId: r.workOrder.beforeMediaId,
          afterMediaId: r.workOrder.afterMediaId,
          resolutionNotes: r.workOrder.resolutionNotes,
          completedAt: r.workOrder.completedAt?.toISOString() ?? null,
          verifiedBy: r.workOrder.verifiedBy,
          verifiedAt: r.workOrder.verifiedAt?.toISOString() ?? null,
          rejectReason: r.workOrder.rejectReason,
        }
      : null,
  };
}

/** Same-class actionable reports within 120 m over 60 days (density) and 75 m over 30 days (recurrence). */
export async function computeContextStats(params: {
  lat: number;
  lng: number;
  hazardClass: string;
  excludeReportId?: string;
}): Promise<{ neighborCount: number; recurrenceCount: number }> {
  const actionable: Prisma.HazardReportWhereInput = {
    status: { in: ACTIONABLE_STATUSES },
    duplicateOfId: null,
  };
  const around = {
    ...actionable,
    lat: { gte: params.lat - 0.003, lte: params.lat + 0.003 },
    lng: { gte: params.lng - 0.004, lte: params.lng + 0.004 },
    ...(params.excludeReportId ? { id: { not: params.excludeReportId } } : {}),
  };
  const near60 = await db.hazardReport.findMany({
    where: { ...around, hazardClass: params.hazardClass, createdAt: { gte: new Date(Date.now() - 60 * 86400_000) } },
    select: { id: true, lat: true, lng: true },
  });
  const near30 = await db.hazardReport.findMany({
    where: { ...around, hazardClass: params.hazardClass, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
    select: { id: true, lat: true, lng: true },
  });
  const p = { lat: params.lat, lng: params.lng };
  const neighborCount = near60.filter((r) => haversineM(p, r) <= 120).length;
  const recurrenceCount = near30.filter((r) => haversineM(p, r) <= 75).length;
  return { neighborCount, recurrenceCount };
}

export async function recomputePriorityForReport(reportId: string, settings?: Settings): Promise<void> {
  const s = settings ?? (await getSettings());
  const report = await db.hazardReport.findUnique({
    where: { id: reportId },
    include: {
      workOrder: { select: { status: true } },
      priorityScores: { orderBy: { computedAt: "desc" }, take: 1 },
      media: { where: { kind: "ORIGINAL" }, take: 1 },
      detections: { orderBy: { confidence: "desc" }, take: 1 },
    },
  });
  if (!report) return;
  if (report.status === "REJECTED" || report.status === "MERGED") return;

  const { neighborCount, recurrenceCount } = await computeContextStats({
    lat: report.lat,
    lng: report.lng,
    hazardClass: report.hazardClass,
    excludeReportId: report.id,
  });
  const criticality = report.roadCriticality ?? inferRoadCriticality(report.roadName, report.roadClass);
  const ageDays = (Date.now() - report.createdAt.getTime()) / 86400_000;
  const prev = report.priorityScores[0];
  const resolved = report.workOrder?.status === "COMPLETED" || report.workOrder?.status === "VERIFICATION_PENDING" || report.workOrder?.status === "VERIFIED" || report.workOrder?.status === "CLOSED";
  const result = computePriority({
    severity: report.severity,
    neighborCount,
    roadCriticality: criticality,
    recurrenceCount,
    ageDays,
    resolved,
    weights: s.weights,
    overridden: prev?.overridden ?? false,
    manualScore: prev?.manualScore ?? null,
  });

  // explainable risk flags from real signals (AI confidence, bbox extent, community reports, road class)
  const top = report.detections[0] ?? null;
  const riskFlags = riskFlagsFor({
    hazardClass: report.hazardClass,
    confidence: top?.confidence ?? null,
    areaRatio: top?.areaRatio ?? null,
    severity: report.severity,
    roadClass: report.roadClass,
    roadName: report.roadName,
    recurrenceCount,
    neighborCount,
    reportCount: report.reportCount,
    uniqueReporters: report.uniqueReporters,
  });
  const recommendedAction = recommendedActionFor(result.band, s.actions);

  const shared = {
    score: result.score,
    band: result.band,
    severityNorm: result.factors[0].normalized,
    densityNorm: result.factors[1].normalized,
    criticalityNorm: result.factors[2].normalized,
    recurrenceNorm: result.factors[3].normalized,
    ageNorm: result.factors[4].normalized,
    weightsJson: JSON.stringify(result.weights),
    explanationJson: JSON.stringify(result.factors),
    riskFlagsJson: JSON.stringify(riskFlags),
    recommendedAction,
    computedAt: new Date(),
  };
  await db.priorityScore.upsert({
    where: { reportId },
    update: shared,
    create: {
      reportId,
      ...shared,
      overridden: prev?.overridden ?? false,
      overriddenBy: prev?.overriddenBy ?? null,
      manualScore: prev?.manualScore ?? null,
    },
  });
}

export interface RecomputeScope {
  bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  sinceDays?: number;
  epsM?: number;
  minPts?: number;
}

export interface RecomputeSummary {
  scopedReports: number;
  clusters: number;
  assignedReports: number;
  epsM: number;
  minPts: number;
  computedAt: string;
}

let recomputeInFlight = false;

/** Full clustering recompute (idempotent): DBSCAN → clusters + memberships → priority refresh. */
export async function recomputeClusters(scope: RecomputeScope = {}): Promise<RecomputeSummary> {
  if (recomputeInFlight) throw new Error("Cluster recompute already in progress");
  recomputeInFlight = true;
  try {
    const s = await getSettings();
    const epsM = scope.epsM ?? s.cluster.epsM;
    const minPts = scope.minPts ?? s.cluster.minPts;
    const sinceDays = scope.sinceDays ?? s.cluster.sinceDays;

    const where: Prisma.HazardReportWhereInput = {
      status: { in: ACTIONABLE_STATUSES },
      duplicateOfId: null,
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
      ...(scope.bbox
        ? { lat: { gte: scope.bbox.minLat, lte: scope.bbox.maxLat }, lng: { gte: scope.bbox.minLng, lte: scope.bbox.maxLng } }
        : {}),
    };
    const reports = await db.hazardReport.findMany({ where, select: { id: true, lat: true, lng: true } });
    const labels = dbscan(reports.map((r) => ({ lat: r.lat, lng: r.lng })), epsM, minPts);
    const summaries = summarizeClusters(reports.map((r) => ({ lat: r.lat, lng: r.lng })), labels);

    // gather aggregate info per cluster
    const full = await db.hazardReport.findMany({
      where: { id: { in: reports.map((r) => r.id) } },
      select: { id: true, hazardClass: true, severity: true, ward: true, lat: true, lng: true },
    });
    const byId = new Map(full.map((r) => [r.id, r]));

    await db.$transaction([
      db.clusterMembership.deleteMany({}),
      db.hazardCluster.deleteMany({}),
    ]);

    let assigned = 0;
    for (let ci = 0; ci < summaries.length; ci++) {
      const sum = summaries[ci];
      const members = sum.memberIndexes.map((i) => byId.get(reports[i].id)!).filter(Boolean);
      const classTally = new Map<string, number>();
      members.forEach((m) => classTally.set(m.hazardClass, (classTally.get(m.hazardClass) ?? 0) + 1));
      const dominant = [...classTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "pothole";
      const avgSeverity = members.reduce((acc, m) => acc + m.severity, 0) / Math.max(1, members.length);
      const maxSeverity = members.reduce((acc, m) => Math.max(acc, m.severity), 0);
      const ward = nearestWard({ lat: sum.centerLat, lng: sum.centerLng });
      const cluster = await db.hazardCluster.create({
        data: {
          label: ward ? `C-${ci + 1} · ${ward}` : `C-${ci + 1}`,
          centerLat: sum.centerLat,
          centerLng: sum.centerLng,
          radiusM: Math.round(sum.radiusM),
          hazardCount: members.length,
          dominantClass: dominant,
          avgSeverity: Math.round(avgSeverity * 100) / 100,
          maxSeverity,
          paramsJson: JSON.stringify({ epsM, minPts, sinceDays }),
        },
      });
      for (const m of members) {
        const point = { lat: m.lat, lng: m.lng };
        const dist = haversineM(point, { lat: sum.centerLat, lng: sum.centerLng });
        await db.clusterMembership.create({
          data: { clusterId: cluster.id, reportId: m.id, distanceM: Math.round(dist) },
        });
        await db.hazardReport.update({ where: { id: m.id }, data: { clusterId: cluster.id } });
        assigned++;
      }
    }
    // clear stale cluster pointers for in-scope noise points
    const memberIds = new Set(summaries.flatMap((s) => s.memberIndexes.map((i) => reports[i].id)));
    for (const r of reports) {
      if (!memberIds.has(r.id) && r.id) {
        await db.hazardReport.updateMany({ where: { id: r.id, clusterId: { not: null } }, data: { clusterId: null } });
      }
    }

    // refresh priorities for the whole scope (density may have changed)
    for (const r of reports) await recomputePriorityForReport(r.id, s);

    return {
      scopedReports: reports.length,
      clusters: summaries.length,
      assignedReports: assigned,
      epsM,
      minPts,
      computedAt: new Date().toISOString(),
    };
  } finally {
    recomputeInFlight = false;
  }
}

/** Lazily refresh clusters before serving map data (bounded to once per 10 minutes). */
let lastAutoRecompute = 0;
export async function autoRecomputeIfStale(): Promise<void> {
  const s = await getSettings();
  if (!s.autoRecompute) return;
  if (Date.now() - lastAutoRecompute < 10 * 60_000) return;
  lastAutoRecompute = Date.now();
  try {
    await recomputeClusters();
  } catch (err) {
    console.error("[clusters] auto-recompute failed", err);
  }
}

/** Parses shared filter query params for /api/hazards and /api/map. */
export function parseHazardFilters(sp: URLSearchParams): Prisma.HazardReportWhereInput {
  const where: Prisma.HazardReportWhereInput = { duplicateOfId: null };
  const classes = sp.get("classes");
  if (classes) where.hazardClass = { in: classes.split(",").filter((c) => validClass(c)) };
  const sevMin = Number(sp.get("severityMin") ?? 1);
  const sevMax = Number(sp.get("severityMax") ?? 5);
  if (sevMin > 1 || sevMax < 5) where.severity = { gte: Math.max(1, sevMin), lte: Math.min(5, sevMax) };
  const statuses = sp.get("statuses");
  where.status = statuses
    ? { in: statuses.split(",").filter((s) => (VALID_STATUSES as string[]).includes(s)) as ReportStatus[] }
    : { in: DEFAULT_MAP_STATUSES };
  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) where.createdAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to.slice(0, 10)}T23:59:59.999Z`) } : {}) };
  const bbox = sp.get("bbox");
  if (bbox) {
    const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
    if ([minLat, minLng, maxLat, maxLng].every(Number.isFinite)) {
      where.lat = { gte: Math.min(minLat, maxLat), lte: Math.max(minLat, maxLat) };
      where.lng = { gte: Math.min(minLng, maxLng), lte: Math.max(minLng, maxLng) };
    }
  }
  const q = sp.get("q");
  if (q) where.OR = [{ referenceCode: { contains: q } }, { address: { contains: q } }, { ward: { contains: q } }, { roadName: { contains: q } }];
  const bands = sp.get("bands");
  if (bands) {
    const bandList = bands.split(",").filter((b) => VALID_BANDS.includes(b));
    if (bandList.length > 0) where.priorityScores = { some: { band: { in: bandList } } };
  }
  return where;
}

const VALID_STATUSES = HAZARD_STATUSES;
const VALID_BANDS = ["CRITICAL", "HIGH", "MODERATE", "LOW"];

function validClass(c: string): c is HazardClass {
  return (Object.keys(CLASS_META) as string[]).includes(c);
}
