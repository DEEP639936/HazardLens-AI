// Explainable maintenance-priority engine.
// Priority = w1·severity + w2·density + w3·roadCriticality + w4·recurrence + w5·age  → 0..100
// Weights are admin-configurable (system_settings.priority.weights) and snapshotted per computation.
// IMPORTANT (documented product stance): the score is a prioritization aid for maintenance crews —
// it is NOT an engineering-grade road-safety assessment and never replaces human review.
import { ROAD_CLASS_CRITICALITY } from "./constants";
import type { PriorityBand, PriorityDTO, PriorityFactorDTO, PriorityWeights } from "./types";

export const DEFAULT_WEIGHTS: PriorityWeights = {
  severity: 0.32,
  density: 0.24,
  criticality: 0.18,
  recurrence: 0.14,
  age: 0.12,
};

export interface PriorityInput {
  severity: number; // 1..5
  neighborCount: number; // same-class reports within 120m over last 60 days (density basis)
  roadCriticality: number; // 0..1 (road class or admin override)
  recurrenceCount: number; // same-class reports within 75m over last 30 days
  ageDays: number; // since report creation
  resolved?: boolean; // linked work order COMPLETED dampens urgency
  weights?: Partial<PriorityWeights>;
  overridden?: boolean;
  manualScore?: number | null;
}

/**
 * Risk bands on the 0–100 score (product contract):
 *   0–25 Low · 26–50 Moderate · 51–75 High · 76–100 Critical.
 */
export function bandOf(score: number): PriorityBand {
  if (score >= 76) return "CRITICAL";
  if (score >= 51) return "HIGH";
  if (score >= 26) return "MODERATE";
  return "LOW";
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function computePriority(input: PriorityInput): PriorityDTO {
  const w: PriorityWeights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const sevNorm = Math.min(1, Math.max(0, (input.severity - 1) / 4));
  const densNorm = Math.min(1, input.neighborCount / 12);
  const critNorm = Math.min(1, Math.max(0, input.roadCriticality));
  const recNorm = Math.min(1, input.recurrenceCount / 4);
  const rawAge = Math.min(1, Math.max(0, input.ageDays) / 90);
  const ageNorm = input.resolved ? rawAge * 0.2 : rawAge;

  const scoreRaw =
    w.severity * sevNorm +
    w.density * densNorm +
    w.criticality * critNorm +
    w.recurrence * recNorm +
    w.age * ageNorm;
  const score = input.overridden && input.manualScore != null
    ? Math.min(100, Math.max(0, input.manualScore))
    : round2(scoreRaw * 100);

  const factors: PriorityFactorDTO[] = [
    {
      key: "severity",
      label: "Detection severity",
      raw: `${input.severity}/5`,
      normalized: round2(sevNorm),
      weight: w.severity,
      contribution: round2(w.severity * sevNorm * 100),
      note: "AI confidence + bounding-box extent + hazard class, with admin override.",
    },
    {
      key: "density",
      label: "Cluster density",
      raw: `${input.neighborCount} nearby hazards`,
      normalized: round2(densNorm),
      weight: w.density,
      contribution: round2(w.density * densNorm * 100),
      note: "Same-class reports within 120 m over the last 60 days.",
    },
    {
      key: "criticality",
      label: "Road criticality",
      raw: `${Math.round(critNorm * 100)}%`,
      normalized: round2(critNorm),
      weight: w.criticality,
      contribution: round2(w.criticality * critNorm * 100),
      note: "Highways 1.0 · arterials 0.8 · collectors 0.6 · residential 0.4.",
    },
    {
      key: "recurrence",
      label: "Recurrence",
      raw: `${input.recurrenceCount} repeats`,
      normalized: round2(recNorm),
      weight: w.recurrence,
      contribution: round2(w.recurrence * recNorm * 100),
      note: "Repeat reports of the same class within 75 m over 30 days.",
    },
    {
      key: "age",
      label: "Unresolved age",
      raw: `${Math.round(input.ageDays)} days`,
      normalized: round2(ageNorm),
      weight: w.age,
      contribution: round2(w.age * ageNorm * 100),
      note: input.resolved
        ? "Work order resolved — urgency dampened by 80%."
        : "Days unresolved, saturating at 90 days.",
    },
  ];

  return {
    score,
    band: bandOf(score),
    factors,
    riskFlags: [], // populated by recomputePriorityForReport from stored signals
    recommendedAction: null, // attached server-side from system_settings.risk.actions
    weights: w,
    overridden: Boolean(input.overridden),
    manualScore: input.manualScore ?? null,
    computedAt: new Date().toISOString(),
  };
}

export { ROAD_CLASS_CRITICALITY };
