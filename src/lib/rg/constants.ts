import type { HazardClass, PriorityBand, ReportStatus, Role, SeverityBand, WorkOrderStatus } from "./types";

export const HAZARD_CLASSES: HazardClass[] = [
  "pothole",
  "crack",
  "erosion",
  "waterlogging",
  "marking",
  "debris",
  "edge_damage",
];

export const CLASS_META: Record<
  HazardClass,
  { label: string; short: string; color: string; chip: string; weight: number }
> = {
  pothole: { label: "Pothole", short: "Pothole", color: "#6A00F4", chip: "bg-[#6A00F4]/10 text-[#4d00b3] border-[#6A00F4]/25", weight: 0.62 },
  crack: { label: "Road crack", short: "Crack", color: "#8B3DFF", chip: "bg-[#8B3DFF]/10 text-[#5c1fc0] border-[#8B3DFF]/25", weight: 0.45 },
  erosion: { label: "Surface erosion", short: "Erosion", color: "#B45309", chip: "bg-amber-100 text-amber-800 border-amber-300", weight: 0.55 },
  waterlogging: { label: "Waterlogging", short: "Waterlog", color: "#0E7490", chip: "bg-cyan-100 text-cyan-900 border-cyan-300", weight: 0.7 },
  marking: { label: "Broken marking", short: "Marking", color: "#655D73", chip: "bg-slate-200 text-slate-700 border-slate-300", weight: 0.4 },
  debris: { label: "Debris / obstruction", short: "Debris", color: "#C83E4D", chip: "bg-rose-100 text-rose-800 border-rose-300", weight: 0.5 },
  edge_damage: { label: "Road-edge damage", short: "Edge", color: "#168266", chip: "bg-emerald-100 text-emerald-900 border-emerald-300", weight: 0.6 },
};

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */
export const ROLES: Role[] = ["CITIZEN", "FIELD_WORKER", "AUTHORITY", "ADMIN"];

export const ROLE_META: Record<Role, { label: string; blurb: string }> = {
  CITIZEN: { label: "Citizen", blurb: "Detect, report and track hazards" },
  FIELD_WORKER: { label: "Field worker", blurb: "Executes assigned repairs, uploads evidence" },
  AUTHORITY: { label: "Authority", blurb: "Verifies hazards, runs the work-order pipeline" },
  ADMIN: { label: "Administrator", blurb: "Full management: users, rules, audit" },
};

/* ------------------------------------------------------------------ */
/* Risk bands (0–100 risk score) + severity bands (from 1..5)          */
/* ------------------------------------------------------------------ */
export const BAND_META: Record<PriorityBand, { label: string; color: string; chip: string; action: string }> = {
  CRITICAL: { label: "Critical", color: "#C83E4D", chip: "bg-[#C83E4D] text-white border-[#C83E4D]", action: "Immediate intervention" },
  HIGH: { label: "High", color: "#D97706", chip: "bg-[#D97706] text-white border-[#D97706]", action: "Prioritize field inspection" },
  MODERATE: { label: "Moderate", color: "#8B3DFF", chip: "bg-[#8B3DFF]/15 text-[#4d00b3] border-[#8B3DFF]/30", action: "Schedule inspection" },
  LOW: { label: "Low", color: "#168266", chip: "bg-[#168266]/15 text-[#0f5c49] border-[#168266]/30", action: "Routine monitoring" },
};

export const BAND_RANGES: Record<PriorityBand, string> = {
  LOW: "0–25",
  MODERATE: "26–50",
  HIGH: "51–75",
  CRITICAL: "76–100",
};

export const SEVERITY_BANDS: SeverityBand[] = ["LOW", "MODERATE", "HIGH", "CRITICAL"];

export const SEVERITY_BAND_META: Record<SeverityBand, { label: string; color: string; chip: string }> = {
  LOW: { label: "Low", color: "#168266", chip: "bg-[#168266]/15 text-[#0f5c49] border-[#168266]/30" },
  MODERATE: { label: "Moderate", color: "#D97706", chip: "bg-amber-100 text-amber-800 border-amber-200" },
  HIGH: { label: "High", color: "#B45309", chip: "bg-orange-100 text-orange-900 border-orange-200" },
  CRITICAL: { label: "Critical", color: "#C83E4D", chip: "bg-[#C83E4D] text-white border-[#C83E4D]" },
};

/** Transparent rules layer: 1→Low, 2→Moderate, 3→High, 4–5→Critical. */
export function severityBandOf(severity: number): SeverityBand {
  if (severity >= 4) return "CRITICAL";
  if (severity === 3) return "HIGH";
  if (severity === 2) return "MODERATE";
  return "LOW";
}

/* ------------------------------------------------------------------ */
/* Hazard lifecycle — the single source of truth for report statuses   */
/* ------------------------------------------------------------------ */
export const HAZARD_STATUSES: ReportStatus[] = [
  "REPORTED",
  "AI_VERIFIED",
  "PENDING_REVIEW",
  "VERIFIED",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "REJECTED",
  "MERGED",
  "FLAGGED",
];

export const STATUS_META: Record<ReportStatus, { label: string; chip: string }> = {
  REPORTED: { label: "Reported", chip: "bg-slate-100 text-slate-700 border-slate-200" },
  AI_VERIFIED: { label: "AI verified", chip: "bg-[#8B3DFF]/15 text-[#4d00b3] border-[#8B3DFF]/30" },
  PENDING_REVIEW: { label: "Pending review", chip: "bg-amber-100 text-amber-800 border-amber-200" },
  VERIFIED: { label: "Verified", chip: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  ASSIGNED: { label: "Assigned", chip: "bg-[#6A00F4]/15 text-[#4d00b3] border-[#6A00F4]/30" },
  IN_PROGRESS: { label: "Repair in progress", chip: "bg-amber-100 text-amber-800 border-amber-200" },
  RESOLVED: { label: "Resolved", chip: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  CLOSED: { label: "Closed", chip: "bg-slate-200 text-slate-600 border-slate-300" },
  REJECTED: { label: "Rejected", chip: "bg-rose-100 text-rose-800 border-rose-200" },
  MERGED: { label: "Merged duplicate", chip: "bg-slate-200 text-slate-600 border-slate-300" },
  FLAGGED: { label: "Flagged · manual inspection", chip: "bg-[#8B3DFF]/15 text-[#4d00b3] border-[#8B3DFF]/30" },
};

/** Statuses that keep a hazard actionable for clustering / density / queue views. */
export const ACTIONABLE_STATUSES: ReportStatus[] = [
  "REPORTED",
  "AI_VERIFIED",
  "PENDING_REVIEW",
  "VERIFIED",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
  "FLAGGED",
];

/** Statuses surfaced by default on the live map (actionable + just-closed). */
export const DEFAULT_MAP_STATUSES: ReportStatus[] = [
  "REPORTED",
  "AI_VERIFIED",
  "PENDING_REVIEW",
  "VERIFIED",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
  "FLAGGED",
];

/* ------------------------------------------------------------------ */
/* Work-order status machine                                           */
/* ------------------------------------------------------------------ */
export const WO_STATUSES: WorkOrderStatus[] = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "VERIFICATION_PENDING",
  "VERIFIED",
  "CLOSED",
];

export const WO_STATUS_META: Record<WorkOrderStatus, { label: string; color: string; chip: string }> = {
  OPEN: { label: "Open", color: "#655D73", chip: "bg-slate-200 text-slate-700 border-slate-300" },
  ASSIGNED: { label: "Assigned", color: "#6A00F4", chip: "bg-[#6A00F4]/15 text-[#4d00b3] border-[#6A00F4]/30" },
  IN_PROGRESS: { label: "In progress", color: "#D97706", chip: "bg-amber-100 text-amber-800 border-amber-200" },
  COMPLETED: { label: "Completed", color: "#168266", chip: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  VERIFICATION_PENDING: { label: "Verification pending", color: "#B45309", chip: "bg-orange-100 text-orange-900 border-orange-200" },
  VERIFIED: { label: "Resolution verified", color: "#0f5c49", chip: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  CLOSED: { label: "Closed", color: "#655D73", chip: "bg-slate-200 text-slate-600 border-slate-300" },
};

/** Only these transitions pass the server-side guard (400 otherwise). */
export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  OPEN: ["ASSIGNED"],
  ASSIGNED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: ["VERIFICATION_PENDING"],
  VERIFICATION_PENDING: ["VERIFIED", "IN_PROGRESS"], // approve · reject (reason required)
  VERIFIED: ["CLOSED"],
  CLOSED: [],
};

/** Hazard lifecycle stage produced by each work-order stage. */
export const WO_TO_HAZARD_STATUS: Partial<Record<WorkOrderStatus, ReportStatus>> = {
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "RESOLVED",
  VERIFICATION_PENDING: "RESOLVED",
  VERIFIED: "CLOSED",
  CLOSED: "CLOSED",
};

/* ------------------------------------------------------------------ */
/* Road classes / weights / limits                                     */
/* ------------------------------------------------------------------ */
export const ROAD_CLASS_CRITICALITY: Record<string, number> = {
  highway: 1.0,
  arterial: 0.8,
  collector: 0.6,
  residential: 0.4,
};

export const DEFAULT_WEIGHTS = {
  severity: 0.32,
  density: 0.24,
  criticality: 0.18,
  recurrence: 0.14,
  age: 0.12,
};

export const MEDIA_LIMITS = {
  imageMaxBytes: 12 * 1024 * 1024,
  videoMaxBytes: 60 * 1024 * 1024,
  imageTypes: ["image/jpeg", "image/png", "image/webp"],
  videoTypes: ["video/mp4", "video/webm", "video/quicktime"],
};

export const DEMO_ACCOUNTS = {
  admin: { email: "admin@roadguardatlas.dev", password: "Atlas@Admin2024" },
  user: { email: "citizen@roadguardatlas.dev", password: "Atlas@User2024" },
};
// NOTE: demo account emails are intentionally unchanged — they match the seeded login accounts.

export const PRIORITY_FORMULA =
  "Risk score = 0.32 × severity + 0.24 × cluster density + 0.18 × road criticality + 0.14 × recurrence + 0.12 × unresolved age";
