// /api/analytics — analytics aggregate (AUTHORITY | ADMIN)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireManagement } from "@/lib/rg/auth";
import { CLASS_META, HAZARD_CLASSES } from "@/lib/rg/constants";
import type { AnalyticsDTO, HazardClass, PriorityBand } from "@/lib/rg/types";

export const runtime = "nodejs";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function GET(req: NextRequest) {
  const auth = await requireManagement(req);
  if (isResponse(auth)) return auth;

  const actionable = { status: { in: ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW", "VERIFIED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "FLAGGED"] }, duplicateOfId: null };
  const [allReports, scores, clusters, detections, resolvedCount] = await Promise.all([
    db.hazardReport.findMany({ where: actionable, select: { id: true, hazardClass: true, severity: true, status: true, ward: true, createdAt: true } }),
    db.priorityScore.findMany({ include: { report: { select: { id: true, status: true, duplicateOfId: true } } } }),
    db.hazardCluster.count(),
    db.detection.findMany({ select: { hazardClass: true, confidence: true, engine: true, modelVersion: true, inferenceMs: true } }),
    db.workOrder.count({ where: { status: { in: ["COMPLETED", "VERIFICATION_PENDING", "VERIFIED", "CLOSED"] } } }),
  ]);

  const verifiedScores = scores.filter((s) => s.report.status === "VERIFIED" && !s.report.duplicateOfId);
  const pending = allReports.filter((r) => r.status === "PENDING_REVIEW").length;
  const critical = verifiedScores.filter((s) => s.band === "CRITICAL").length;
  const avgPriority = verifiedScores.length
    ? verifiedScores.reduce((acc, s) => acc + s.score, 0) / verifiedScores.length
    : 0;

  const byClass = HAZARD_CLASSES.map((hc) => {
    const items = allReports.filter((r) => r.hazardClass === hc);
    return {
      hazardClass: hc as HazardClass,
      count: items.length,
      avgSeverity: items.length ? Math.round((items.reduce((a, r) => a + r.severity, 0) / items.length) * 100) / 100 : 0,
    };
  }).sort((a, b) => b.count - a.count);

  const bySeverity = [1, 2, 3, 4, 5].map((sev) => ({
    severity: sev,
    count: allReports.filter((r) => r.severity === sev).length,
  }));

  // weekly buckets over the last 12 weeks
  const weeks: { week: string; avgSeverity: number; count: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(Date.now() - i * 7 * 86400_000);
    const start = new Date(end.getTime() - 7 * 86400_000);
    const items = allReports.filter((r) => r.createdAt >= start && r.createdAt < end);
    weeks.push({
      week: start.toISOString().slice(0, 10),
      avgSeverity: items.length ? Math.round((items.reduce((a, r) => a + r.severity, 0) / items.length) * 100) / 100 : 0,
      count: items.length,
    });
  }

  const scoreByReport = new Map(scores.map((s) => [s.reportId, s]));
  const wardMap = new Map<string, { count: number; prioritySum: number; critical: number }>();
  for (const r of allReports) {
    const ward = r.ward ?? "Unassigned";
    const entry = wardMap.get(ward) ?? { count: 0, prioritySum: 0, critical: 0 };
    entry.count++;
    const s = scoreByReport.get(r.id);
    if (s) {
      entry.prioritySum += s.score;
      if (s.band === "CRITICAL") entry.critical++;
    }
    wardMap.set(ward, entry);
  }
  const wards = [...wardMap.entries()]
    .map(([ward, v]) => ({ ward, count: v.count, avgPriority: v.count ? Math.round((v.prioritySum / v.count) * 10) / 10 : 0, critical: v.critical }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const bands: PriorityBand[] = ["CRITICAL", "HIGH", "MODERATE", "LOW"];
  const priorityBands = bands.map((band) => ({
    band,
    count: verifiedScores.filter((s) => s.band === band).length,
  }));

  const confidences = detections.map((d) => d.confidence);
  const latencies = detections.map((d) => d.inferenceMs ?? 0).filter((v) => v > 0);
  const byClassConf = HAZARD_CLASSES.map((hc) => {
    const items = detections.filter((d) => d.hazardClass === hc);
    return {
      hazardClass: hc as HazardClass,
      meanConfidence: items.length ? Math.round((items.reduce((a, d) => a + d.confidence, 0) / items.length) * 1000) / 1000 : 0,
      count: items.length,
    };
  }).filter((x) => x.count > 0);

  const payload: AnalyticsDTO = {
    totals: {
      hazards: allReports.length,
      pendingReview: pending,
      critical,
      clusters,
      avgPriority: Math.round(avgPriority * 10) / 10,
      resolved: resolvedCount,
      approvalRate: allReports.length
        ? Math.round((allReports.filter((r) => r.status === "VERIFIED").length / allReports.length) * 1000) / 10
        : 0,
    },
    byClass,
    bySeverity,
    severityOverTime: weeks,
    wards,
    priorityBands,
    confidence: {
      overallMean: confidences.length ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) / 1000 : 0,
      overallMedian: Math.round(median(confidences) * 1000) / 1000,
      p95LatencyMs: latencies.length ? Math.round(latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] ?? 0) : 0,
      byClass: byClassConf,
      engine: detections[0]?.engine ?? "demo-engine-v2",
      modelVersion: detections[0]?.modelVersion ?? "roadguard-yolo-demo-v2",
    },
  };
  void CLASS_META;
  return NextResponse.json(payload);
}
