// AI Hazard Risk & Severity Engine — explainability layer on top of the priority score.
//
// The 0–100 score itself is produced by priority.ts (transparent weighted factors). This module:
//   1. maps the operational 1–5 severity onto the four-level severity bands (LOW/MODERATE/HIGH/CRITICAL)
//   2. derives recommended actions from severity bands — configurable via system_settings.risk.actions
//      (never hardcoded in the frontend)
//   3. derives explainable boolean risk flags from REAL stored signals only (detection confidence,
//      bounding-box extent, report counts, road class, recurrence). No synthetic sensor data.
import { BAND_META, SEVERITY_BAND_META, severityBandOf } from "./constants";
import type { PriorityBand, RiskFlagDTO, SeverityBand } from "./types";

export { severityBandOf };

export type RecommendedActionMap = Record<SeverityBand, string>;

export const DEFAULT_RECOMMENDED_ACTIONS: RecommendedActionMap = {
  LOW: "Routine monitoring",
  MODERATE: "Schedule inspection",
  HIGH: "Prioritize field inspection",
  CRITICAL: "Immediate inspection / intervention",
};

export function recommendedActionFor(band: PriorityBand, actions?: Partial<RecommendedActionMap>): string {
  const map = { ...DEFAULT_RECOMMENDED_ACTIONS, ...(actions ?? {}) };
  // Severity band drives the action; risk band and severity band use the same vocabulary
  // but are distinct concepts (risk = prioritization, severity = physical hazard scale).
  return map[band] ?? map.MODERATE;
}

export function severityBandMeta(b: SeverityBand) {
  return SEVERITY_BAND_META[b];
}

export function bandMeta(b: PriorityBand) {
  return BAND_META[b];
}

export interface RiskFlagInput {
  hazardClass: string;
  /** Top detection confidence 0..1 (null when no AI detection was attached). */
  confidence: number | null;
  /** Primary detection bounding-box area ratio 0..1 (proxy for estimated size). */
  areaRatio: number | null;
  severity: number; // 1..5
  roadClass?: string | null;
  roadName?: string | null;
  /** Same-class reports within 75 m over the last 30 days (recurrence). */
  recurrenceCount: number;
  /** Same-class reports within 120 m over 60 days (cluster density). */
  neighborCount: number;
  /** Total reports merged onto this hazard (community confirmation). */
  reportCount: number;
  /** Distinct submitters across the merge group. */
  uniqueReporters: number;
}

/**
 * Risk factors for the "Why this risk score?" panel. Each flag is computed from data
 * that actually exists on the record — the panel never invents context.
 */
export function riskFlagsFor(input: RiskFlagInput): RiskFlagDTO[] {
  const flags: RiskFlagDTO[] = [];

  flags.push({
    key: "traffic_exposure",
    label: input.roadClass === "highway" || input.roadClass === "arterial" ? "High traffic exposure" : input.roadClass ? "Limited traffic exposure" : "Traffic exposure unclassified",
    met: input.roadClass === "highway" || input.roadClass === "arterial",
    detail: input.roadClass
      ? `Road class “${input.roadClass}” (criticality weight ${(input.roadClass === "highway" ? 1 : input.roadClass === "arterial" ? 0.8 : input.roadClass === "collector" ? 0.6 : 0.4) * 100}%).`
      : "Road class was not provided for this report.",
  });

  flags.push({
    key: "large_hazard",
    label: "Large estimated hazard extent",
    met: (input.areaRatio ?? 0) >= 0.08,
    detail:
      input.areaRatio == null
        ? "No AI bounding box attached — extent unknown."
        : `Detection covers ${(input.areaRatio * 100).toFixed(1)}% of the image frame${input.areaRatio >= 0.08 ? " (≥ 8% threshold)" : " (< 8% threshold)"}.`,
  });

  flags.push({
    key: "multiple_reports",
    label: "Multiple community reports",
    met: input.reportCount > 1,
    detail: `${input.reportCount} report${input.reportCount === 1 ? "" : "s"} from ${input.uniqueReporters} unique reporter${input.uniqueReporters === 1 ? "" : "s"} confirm this hazard.`,
  });

  flags.push({
    key: "main_road",
    label: "Main road / arterial location",
    met: /ring road|highway|nh-|national|expressway|flyover|main road|100 feet|80 feet|arterial/i.test(input.roadName ?? ""),
    detail: input.roadName ? `Road name “${input.roadName}” matched the arterial-road heuristic.` : "No road name supplied.",
  });

  flags.push({
    key: "high_ai_confidence",
    label: "High AI confidence",
    met: (input.confidence ?? 0) >= 0.85,
    detail:
      input.confidence == null
        ? "No AI detection attached — confidence signal absent."
        : `Top detection confidence ${(input.confidence * 100).toFixed(1)}%${input.confidence >= 0.85 ? " (≥ 85%)" : " (< 85%)"}.`,
  });

  flags.push({
    key: "recurring_reports",
    label: "Recurring reports at this spot",
    met: input.recurrenceCount > 0,
    detail: `${input.recurrenceCount} same-class report${input.recurrenceCount === 1 ? "" : "s"} within 75 m over the last 30 days.`,
  });

  flags.push({
    key: "cluster_hotspot",
    label: "Deteriorating cluster hotspot",
    met: input.neighborCount >= 3,
    detail: `${input.neighborCount} same-class hazards within 120 m over 60 days${input.neighborCount >= 3 ? " (hotspot ≥ 3)" : ""}.`,
  });

  flags.push({
    key: "high_severity",
    label: `Severity ${input.severity}/5 (${severityBandOf(input.severity).toLowerCase()})`,
    met: input.severity >= 4,
    detail: `Operational severity heuristic scored ${input.severity}/5 — band ${SEVERITY_BAND_META[severityBandOf(input.severity)].label}.`,
  });

  return flags;
}
