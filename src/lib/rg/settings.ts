// Admin-configurable system settings (priority weights, clustering parameters, auto-recompute,
// risk-engine recommended actions, duplicate-detection parameters, org departments/teams).
import { db } from "@/lib/db";
import { DEFAULT_WEIGHTS } from "./priority";
import { DEFAULT_RECOMMENDED_ACTIONS, type RecommendedActionMap } from "./risk";
import type { PriorityWeights, SeverityBand } from "./types";

export interface ClusterParams {
  epsM: number;
  minPts: number;
  sinceDays: number;
}

export interface DuplicateParams {
  radiusM: number; // candidates must be within this distance
  windowDays: number; // …and reported within this window
  thresholdPct: number; // similarity ≥ threshold → potential duplicate (0..100)
}

export interface Settings {
  weights: PriorityWeights;
  cluster: ClusterParams;
  autoRecompute: boolean;
  /** Severity-band → recommended action (served to clients; never hardcoded in the UI). */
  actions: RecommendedActionMap;
  duplicates: DuplicateParams;
  org: { departments: string[]; teams: string[] };
}

const DEFAULTS: Settings = {
  weights: DEFAULT_WEIGHTS,
  cluster: { epsM: 60, minPts: 3, sinceDays: 90 },
  autoRecompute: true,
  actions: DEFAULT_RECOMMENDED_ACTIONS,
  duplicates: { radiusM: 75, windowDays: 30, thresholdPct: 70 },
  org: {
    departments: ["Road Maintenance", "Traffic Engineering", "Storm Water Division"],
    teams: ["Ward 7 crew", "Ward 12 patch crew", "Rapid response unit"],
  },
};

const KEYS = [
  "priority.weights",
  "cluster.params",
  "map.autoRecompute",
  "risk.actions",
  "duplicates.params",
  "org.departments",
  "org.teams",
] as const;

function normalizeActions(raw: unknown): RecommendedActionMap {
  const out = { ...DEFAULTS.actions };
  if (raw && typeof raw === "object") {
    for (const band of ["LOW", "MODERATE", "HIGH", "CRITICAL"] as SeverityBand[]) {
      const v = (raw as Record<string, unknown>)[band];
      if (typeof v === "string" && v.trim()) out[band] = v.trim().slice(0, 200);
    }
  }
  return out;
}

function normalizeStringList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const list = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 80));
  return list.length ? Array.from(new Set(list)).slice(0, 40) : fallback;
}

export async function getSettings(): Promise<Settings> {
  const rows = await db.systemSetting.findMany({ where: { key: { in: [...KEYS] } } });
  const out: Settings = JSON.parse(JSON.stringify(DEFAULTS));
  for (const row of rows) {
    try {
      const v = JSON.parse(row.valueJson);
      if (row.key === "priority.weights") {
        // merge defensively: stored payloads may predate a new weight key
        out.weights = { ...DEFAULTS.weights, ...v } as PriorityWeights;
        for (const k of Object.keys(DEFAULTS.weights) as (keyof PriorityWeights)[]) {
          if (typeof out.weights[k] !== "number" || !Number.isFinite(out.weights[k])) out.weights[k] = DEFAULTS.weights[k];
        }
      }
      if (row.key === "cluster.params") out.cluster = { ...DEFAULTS.cluster, ...v };
      if (row.key === "map.autoRecompute") out.autoRecompute = Boolean(v);
      if (row.key === "risk.actions") out.actions = normalizeActions(v);
      if (row.key === "duplicates.params") out.duplicates = { ...DEFAULTS.duplicates, ...v };
      if (row.key === "org.departments") out.org.departments = normalizeStringList(v, DEFAULTS.org.departments);
      if (row.key === "org.teams") out.org.teams = normalizeStringList(v, DEFAULTS.org.teams);
    } catch {
      // ignore malformed rows, fall back to defaults
    }
  }
  return out;
}

export async function putSettings(patch: Partial<Settings>): Promise<Settings> {
  const entries: [string, unknown][] = [];
  if (patch.weights) {
    const w = patch.weights;
    const sum = w.severity + w.density + w.criticality + w.recurrence + w.age;
    if (Math.abs(sum - 1) > 0.001) {
      throw new Error(`Priority weights must sum to 1.0 (received ${sum.toFixed(3)})`);
    }
    entries.push(["priority.weights", w]);
  }
  if (patch.cluster) entries.push(["cluster.params", patch.cluster]);
  if (patch.autoRecompute != null) entries.push(["map.autoRecompute", patch.autoRecompute]);
  if (patch.actions) entries.push(["risk.actions", patch.actions]);
  if (patch.duplicates) {
    const d = patch.duplicates;
    if (d.radiusM < 10 || d.radiusM > 500) throw new Error("Duplicate radius must be 10–500 m");
    if (d.windowDays < 1 || d.windowDays > 365) throw new Error("Duplicate window must be 1–365 days");
    if (d.thresholdPct < 50 || d.thresholdPct > 99) throw new Error("Duplicate threshold must be 50–99%");
    entries.push(["duplicates.params", d]);
  }
  if (patch.org) {
    if (patch.org.departments) entries.push(["org.departments", patch.org.departments]);
    if (patch.org.teams) entries.push(["org.teams", patch.org.teams]);
  }

  for (const [key, value] of entries) {
    await db.systemSetting.upsert({
      where: { key },
      update: { valueJson: JSON.stringify(value) },
      create: { key, valueJson: JSON.stringify(value) },
    });
  }
  return getSettings();
}
