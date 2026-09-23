// Smart Duplicate Detection & Verification engine.
//
// When a report is submitted (or an authority inspects a hazard), nearby existing hazards are
// compared on four transparent signals:
//   location (Haversine distance) + hazard type + evidence image (perceptual hash) + time.
// The weighted result is a 0–100 similarity score. Thresholds live in system_settings
// (duplicates.params) and are editable by administrators — no magic numbers in the UI.
//
// Spatial predicates run in the application layer (Haversine) in this SQLite deployment;
// the production PostGIS backend performs the identical filtering with ST_DWithin
// (see backend/app/services/geo.py) — the abstraction boundary is this module.
import { db } from "@/lib/db";
import { haversineM, bboxAround } from "./geo";
import { hashSimilarity } from "./media";
import { getSettings } from "./settings";
import type { DuplicateCandidateDTO, HazardClass, ReportStatus } from "./types";

/** Class pairs that frequently describe the same physical defect. */
const RELATED_CLASSES: Record<string, string[]> = {
  pothole: ["edge_damage", "erosion"],
  crack: ["erosion", "marking"],
  erosion: ["pothole", "crack"],
  waterlogging: ["debris"],
  marking: ["crack"],
  debris: ["waterlogging"],
  edge_damage: ["pothole"],
};

function classSimilarity(a: HazardClass, b: HazardClass): number {
  if (a === b) return 1;
  if ((RELATED_CLASSES[a] ?? []).includes(b)) return 0.5;
  return 0.2;
}

export interface DuplicateSearchParams {
  lat: number;
  lng: number;
  hazardClass: HazardClass;
  excludeReportId?: string;
  /** Only canonical hazards are considered unless this is false. */
  canonicalOnly?: boolean;
  createdAtForTemporal?: Date;
}

/**
 * Ranked duplicate candidates. Only actionable, non-rejected hazards are considered;
 * merged (non-canonical) hazards are skipped so duplicates always point at the live record.
 */
export async function findDuplicateCandidates(params: DuplicateSearchParams): Promise<DuplicateCandidateDTO[]> {
  const s = await getSettings();
  const { radiusM, windowDays } = s.duplicates;

  const box = bboxAround({ lat: params.lat, lng: params.lng }, radiusM);
  const since = new Date(Date.now() - windowDays * 86400_000);

  const rows = await db.hazardReport.findMany({
    where: {
      status: { in: ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW", "VERIFIED", "FLAGGED"] },
      duplicateOfId: params.canonicalOnly === false ? undefined : null,
      lat: { gte: box.minLat, lte: box.maxLat },
      lng: { gte: box.minLng, lte: box.maxLng },
      createdAt: { gte: since },
      ...(params.excludeReportId ? { id: { not: params.excludeReportId } } : {}),
    },
    include: {
      media: { where: { kind: "ORIGINAL" }, take: 1 },
      detections: { orderBy: { confidence: "desc" }, take: 1 },
    },
    take: 60,
  });

  const now = params.createdAtForTemporal ?? new Date();
  const candidates: DuplicateCandidateDTO[] = [];

  const myHash = params.excludeReportId
    ? (
        await db.mediaAsset.findFirst({
          where: { reportId: params.excludeReportId, kind: "ORIGINAL", perceptualHash: { not: null } },
          select: { perceptualHash: true },
        })
      )?.perceptualHash ?? null
    : null;

  for (const r of rows) {
    const distanceM = haversineM({ lat: params.lat, lng: params.lng }, { lat: r.lat, lng: r.lng });
    if (distanceM > radiusM) continue;

    const locationSimilarity = 1 - Math.min(1, distanceM / radiusM);
    const classSim = classSimilarity(params.hazardClass, r.hazardClass as HazardClass);

    // temporal: full score when reports are 1 day apart, decaying to 0 at the window edge
    const ageDiffDays = Math.abs(now.getTime() - r.createdAt.getTime()) / 86400_000;
    const temporalSimilarity = 1 - Math.min(1, ageDiffDays / windowDays);

    // image: perceptual hash over ORIGINAL evidence photos (null when either side has none)
    const theirHash = r.media[0]?.perceptualHash ?? null;
    const imageSim = myHash || theirHash ? hashSimilarity(myHash, theirHash) : null;

    // Weighted composite — location dominates, image carries real evidential weight.
    const parts: { w: number; v: number | null }[] = [
      { w: 0.45, v: locationSimilarity },
      { w: 0.25, v: classSim },
      { w: 0.2, v: imageSim },
      { w: 0.1, v: temporalSimilarity },
    ];
    const usable = parts.filter((p) => p.v != null);
    const weightSum = usable.reduce((a, p) => a + p.w, 0);
    const similarity = usable.reduce((a, p) => a + p.w * (p.v as number), 0) / (weightSum || 1);

    candidates.push({
      hazardId: r.id,
      referenceCode: r.referenceCode,
      hazardClass: r.hazardClass as HazardClass,
      distanceM: Math.round(distanceM),
      similarityPct: Math.round(similarity * 100),
      locationSimilarityPct: Math.round(locationSimilarity * 100),
      classSimilarityPct: Math.round(classSim * 100),
      imageSimilarityPct: imageSim == null ? null : Math.round(imageSim * 100),
      temporalSimilarityPct: Math.round(temporalSimilarity * 100),
      createdAt: r.createdAt.toISOString(),
      mediaId: r.media[0]?.id ?? null,
      status: r.status as ReportStatus,
    });
  }

  return candidates.sort((a, b) => b.similarityPct - a.similarityPct);
}

export interface MergeResult {
  duplicateId: string;
  primaryId: string;
  reportCount: number;
  uniqueReporters: number;
}

/**
 * Merge a duplicate report into its canonical hazard: the duplicate row is kept (audit trail,
 * reporter notifications) but flagged MERGED + duplicateOfId, and the canonical hazard's
 * community counters grow. "12 reports ≠ 12 potholes."
 */
export async function mergeHazardReports(opts: {
  duplicateId: string;
  primaryId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  note?: string | null;
}): Promise<MergeResult> {
  const dup = await db.hazardReport.findUnique({ where: { id: opts.duplicateId } });
  const primary = await db.hazardReport.findUnique({ where: { id: opts.primaryId } });
  if (!dup || !primary) throw new Error("Hazard not found");
  if (dup.id === primary.id) throw new Error("Cannot merge a hazard into itself");
  if (dup.status === "MERGED" && dup.duplicateOfId === primary.id) {
    // idempotent re-merge — just refresh counters
    return finalizeCounters(primary.id);
  }
  if (dup.status === "REJECTED") throw new Error("Rejected hazards cannot be merged");
  if (primary.status === "MERGED") throw new Error("Merge target is itself a duplicate — choose the canonical hazard");
  if (primary.status === "REJECTED") throw new Error("Cannot merge into a rejected hazard");

  await db.hazardReport.update({
    where: { id: dup.id },
    data: {
      status: "MERGED",
      duplicateOfId: primary.id,
      clusterId: null,
      reviewedAt: new Date(),
      reviewedBy: opts.actorEmail ?? "duplicate-engine",
      reviewNote: opts.note ?? "Merged as a duplicate of an existing hazard",
    },
  });

  // re-point media/detections that belong to the duplicate so evidence stays queryable via primary
  // (they keep their own reportId; the canonical detail view unions merged evidence)
  const result = await finalizeCounters(primary.id);
  return { ...result, duplicateId: dup.id };
}

async function finalizeCounters(primaryId: string): Promise<MergeResult> {
  const primary = await db.hazardReport.findUnique({
    where: { id: primaryId },
    include: { mergedReports: { select: { userId: true, submitterEmail: true, submitterName: true, createdAt: true } } },
  });
  if (!primary) throw new Error("Primary hazard vanished");
  const identities = new Set<string>([primary.userId ?? primary.submitterEmail ?? primary.submitterName ?? "anon"]);
  for (const m of primary.mergedReports) identities.add(m.userId ?? m.submitterEmail ?? m.submitterName ?? "anon");
  const last = [primary.createdAt, ...primary.mergedReports.map((m) => m.createdAt)].sort().at(-1)!;
  await db.hazardReport.update({
    where: { id: primaryId },
    data: {
      reportCount: 1 + primary.mergedReports.length,
      uniqueReporters: identities.size,
      lastReportedAt: last,
    },
  });
  return { duplicateId: "", primaryId, reportCount: 1 + primary.mergedReports.length, uniqueReporters: identities.size };
}
