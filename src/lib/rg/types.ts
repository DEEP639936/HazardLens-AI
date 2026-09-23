// HazardLensAI — shared API types (client contract mirrors /api responses and OpenAPI spec)

/** Platform roles. Legacy "USER" is normalized to "CITIZEN" at the auth boundary. */
export type Role = "CITIZEN" | "FIELD_WORKER" | "AUTHORITY" | "ADMIN";

export type HazardClass =
  | "pothole"
  | "crack"
  | "erosion"
  | "waterlogging"
  | "marking"
  | "debris"
  | "edge_damage";

/** Centralized hazard lifecycle. Never scatter these strings — use STATUS_META. */
export type ReportStatus =
  | "REPORTED"
  | "AI_VERIFIED"
  | "PENDING_REVIEW"
  | "VERIFIED"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED"
  | "REJECTED"
  | "MERGED"
  | "FLAGGED";

/** Risk band (0–100): 0–25 Low · 26–50 Moderate · 51–75 High · 76–100 Critical. */
export type PriorityBand = "CRITICAL" | "HIGH" | "MODERATE" | "LOW";

/** Four-level hazard severity derived from the 1–5 operational heuristic. */
export type SeverityBand = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

/** Work-order status machine. Transitions are enforced server-side (WORK_ORDER_TRANSITIONS). */
export type WorkOrderStatus =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "VERIFICATION_PENDING"
  | "VERIFIED"
  | "CLOSED";

export type RoadClass = "highway" | "arterial" | "collector" | "residential";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  notifyInApp: boolean;
  geoConsent: boolean;
}

export interface MediaDTO {
  id: string;
  kind: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface BboxDTO {
  hazardClass: HazardClass;
  confidence: number;
  bbox: [number, number, number, number]; // x, y, w, h normalized
  severity: number;
  areaRatio: number;
  engine?: string;
  modelVersion?: string;
  id?: string;
}

export interface PriorityFactorDTO {
  key: "severity" | "density" | "criticality" | "recurrence" | "age";
  label: string;
  raw: string;
  normalized: number;
  weight: number;
  contribution: number;
  note: string;
}

/** Explainable boolean risk signal — every entry must trace to a real stored signal. */
export interface RiskFlagDTO {
  key: string;
  label: string;
  met: boolean;
  detail: string;
}

export interface PriorityDTO {
  score: number;
  band: PriorityBand;
  factors: PriorityFactorDTO[];
  riskFlags: RiskFlagDTO[];
  recommendedAction: string | null;
  weights: PriorityWeights;
  overridden: boolean;
  manualScore?: number | null;
  computedAt: string;
}

export interface PriorityWeights {
  severity: number;
  density: number;
  criticality: number;
  recurrence: number;
  age: number;
}

export interface HazardDTO {
  id: string;
  referenceCode: string;
  hazardClass: HazardClass;
  severity: number;
  severityBand: SeverityBand;
  status: ReportStatus;
  lat: number;
  lng: number;
  address?: string | null;
  ward?: string | null;
  roadName?: string | null;
  roadClass?: RoadClass | null;
  notes?: string | null;
  source: string;
  duplicateOfId?: string | null;
  reportCount: number;
  uniqueReporters: number;
  lastReportedAt?: string | null;
  submitterName?: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  userId?: string | null;
  media: MediaDTO[];
  detections: BboxDTO[];
  priority: PriorityDTO | null;
  clusterId?: string | null;
  workOrderStatus?: WorkOrderStatus | null;
  /** Repair record attached to this hazard — carries the contractor's before/after evidence
   *  and verification outcome so detail surfaces can render the resolution trail. */
  workOrder?: {
    id: string;
    code: string;
    status: WorkOrderStatus;
    beforeMediaId?: string | null;
    afterMediaId?: string | null;
    resolutionNotes?: string | null;
    completedAt?: string | null;
    verifiedBy?: string | null;
    verifiedAt?: string | null;
    rejectReason?: string | null;
  } | null;
  /** Evidence photos contributed by merged duplicate reports (community confirmations). */
  mergedEvidence: { id: string; kind: string; mimeType: string; referenceCode: string; submitterName?: string | null; createdAt: string }[];
}

export interface ClusterDTO {
  id: string;
  label: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  hazardCount: number;
  dominantClass: HazardClass;
  avgSeverity: number;
  maxSeverity: number;
}

export interface MapFilters {
  classes: HazardClass[];
  severityMin: number;
  severityMax: number;
  statuses: ReportStatus[];
  bands: PriorityBand[];
  from?: string;
  to?: string;
}

export interface MapResponse {
  hazards: HazardDTO[];
  clusters: ClusterDTO[];
  computedAt: string;
}

/** Candidate returned by the duplicate-detection engine. */
export interface DuplicateCandidateDTO {
  hazardId: string;
  referenceCode: string;
  hazardClass: HazardClass;
  distanceM: number;
  similarityPct: number; // 0..100
  locationSimilarityPct: number;
  classSimilarityPct: number;
  imageSimilarityPct: number | null; // null when no comparable images
  temporalSimilarityPct: number;
  createdAt: string;
  mediaId?: string | null;
  status: ReportStatus;
}

export interface TimelineEntryDTO {
  at: string;
  actor?: string | null;
  actorRole?: string | null;
  action: string;
  detail: string;
  kind: "hazard" | "work_order";
}

export interface WorkOrderDTO {
  id: string;
  code: string;
  title: string;
  description?: string | null;
  status: WorkOrderStatus;
  priority: number;
  band: PriorityBand;
  hazardReportId?: string | null;
  hazard?: {
    id: string;
    referenceCode: string;
    hazardClass: HazardClass;
    severity: number;
    severityBand: SeverityBand;
    status: ReportStatus;
    address?: string | null;
    roadName?: string | null;
    ward?: string | null;
    lat: number;
    lng: number;
    notes?: string | null;
    reporter?: string | null;
    reportCount: number;
    createdAt: string;
    media: { id: string; kind: string; mimeType: string }[];
  } | null;
  clusterId?: string | null;
  department?: string | null;
  assignedTeam?: string | null;
  assignedTo?: string | null;
  assignedUserId?: string | null;
  assignedUserName?: string | null;
  assignedAt?: string | null;
  scheduledFor?: string | null;
  dueDate?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  resolutionNotes?: string | null;
  beforeMediaId?: string | null;
  afterMediaId?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  rejectReason?: string | null;
  createdAt: string;
  updates: {
    id: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
    author?: string | null;
    createdAt: string;
  }[];
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  link?: string | null;
  createdAt: string;
}

export interface AuditLogDTO {
  id: string;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadataJson?: string | null;
  ip?: string | null;
  createdAt: string;
}

export interface ModelVersionDTO {
  id: string;
  version: string;
  framework: string;
  weightsRef?: string | null;
  mAP50?: number | null;
  mAP5095?: number | null;
  precision?: number | null;
  recall?: number | null;
  latencyMs?: number | null;
  datasetRef?: string | null;
  notes?: string | null;
  mlflowRunId?: string | null;
  registeredAt: string;
}

export interface AnalyticsDTO {
  totals: {
    hazards: number;
    pendingReview: number;
    critical: number;
    clusters: number;
    avgPriority: number;
    resolved: number;
    approvalRate: number;
  };
  byClass: { hazardClass: HazardClass; count: number; avgSeverity: number }[];
  bySeverity: { severity: number; count: number }[];
  severityOverTime: { week: string; avgSeverity: number; count: number }[];
  wards: { ward: string; count: number; avgPriority: number; critical: number }[];
  priorityBands: { band: PriorityBand; count: number }[];
  confidence: {
    overallMean: number;
    overallMedian: number;
    p95LatencyMs: number;
    byClass: { hazardClass: HazardClass; meanConfidence: number; count: number }[];
    engine: string;
    modelVersion: string;
  };
}

export interface InferenceResponse {
  mediaId: string;
  engine: string;
  modelVersion: string;
  inferenceMs: number;
  detections: BboxDTO[];
  annotatedMediaId?: string | null;
  jobId?: string | null;
}

export interface ApiError {
  error: string;
  detail?: string;
}
