// Operational severity heuristic (1..5) — transparent by design.
// severity = clamp(ceil( 100·(0.45·confidence + 0.35·min(areaRatio/0.25,1) + 0.20·classWeight) / 20 ), 1, 5)
// Duplicate reports within 75 m add +0.5 before rounding. Admins may override manually.
// NOT an engineering-grade road-safety assessment — see MODEL_CARD.md for limitations.
import { CLASS_META } from "./constants";
import type { HazardClass } from "./types";

export function severityFromDetection(params: {
  hazardClass: HazardClass;
  confidence: number;
  areaRatio: number;
  duplicateCount?: number;
}): number {
  const classWeight = CLASS_META[params.hazardClass]?.weight ?? 0.5;
  const base =
    0.45 * Math.min(1, Math.max(0, params.confidence)) +
    0.35 * Math.min(1, params.areaRatio / 0.25) +
    0.2 * classWeight;
  const dupBoost = Math.min(params.duplicateCount ?? 0, 4) * 0.125; // up to +0.5
  const raw = Math.ceil((base * 100) / 20 + dupBoost);
  return Math.min(5, Math.max(1, raw));
}

export function areaRatioOf(bbox: { x: number; y: number; w: number; h: number }): number {
  return Math.min(1, Math.max(0, bbox.w * bbox.h));
}
