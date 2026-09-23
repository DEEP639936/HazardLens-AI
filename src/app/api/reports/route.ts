// /api/reports — submit a hazard report (public, rate-limited) and list own reports.
//
// Duplicate flow: unless the client passes forceNew, a pre-check runs against nearby
// actionable hazards. When the top similarity ≥ duplicates.params.thresholdPct the API
// responds 200 { requiresDecision, candidates } WITHOUT creating anything — the UI shows
// "Possible Existing Hazard" and the user chooses Merge / Create New. Passing mergeIntoId
// merges the submission into the canonical hazard (12 reports ≠ 12 potholes).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuth, isResponse, requireAuth } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { rateLimit } from "@/lib/rg/ratelimit";
import { inferRoadCriticality, isValidLatLng, nearestWard } from "@/lib/rg/geo";
import { computeContextStats, recomputePriorityForReport, reportInclude, serializeHazard } from "@/lib/rg/hazards";
import { findDuplicateCandidates, mergeHazardReports } from "@/lib/rg/duplicates";
import { areaRatioOf, severityFromDetection } from "@/lib/rg/severity";
import { getSettings } from "@/lib/rg/settings";
import { CLASS_META, HAZARD_CLASSES } from "@/lib/rg/constants";
import type { HazardClass } from "@/lib/rg/types";

export const runtime = "nodejs";

function makeReference(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `HL-${code}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const reports = await db.hazardReport.findMany({
    where: auth.role === "CITIZEN" || auth.role === "FIELD_WORKER" ? { userId: auth.userId } : {},
    include: reportInclude,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ items: reports.map(serializeHazard) });
}

interface ReportBody {
  mediaIds?: string[];
  detectionIds?: string[];
  hazardClass?: string;
  severity?: number;
  lat?: number;
  lng?: number;
  notes?: string;
  address?: string;
  ward?: string;
  roadName?: string;
  roadClass?: string;
  roadCriticality?: number;
  geoConsent?: boolean;
  blurRequested?: boolean;
  submitterName?: string;
  submitterEmail?: string;
  occurredAt?: string;
  /** Duplicate-resolution controls (see module doc). */
  forceNew?: boolean;
  mergeIntoId?: string;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const rl = rateLimit(`report:${ip}`, 5, 3600_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Report rate limit reached", detail: `You can submit up to 5 reports per hour. Retry in ${Math.ceil(rl.retryAfterSec / 60)} min.` },
      { status: 429 }
    );
  }
  const body = (await req.json().catch(() => null)) as ReportBody | null;

  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  if (body.lat == null || body.lng == null || !isValidLatLng(body.lat, body.lng)) {
    return NextResponse.json({ error: "A valid hazard location is required", detail: "Place the pin on the map or allow geolocation." }, { status: 400 });
  }
  if (!body.geoConsent) {
    return NextResponse.json({ error: "Location consent is required", detail: "Confirm the location-privacy notice to submit a report." }, { status: 400 });
  }
  const hazardClass = ((body.hazardClass && (HAZARD_CLASSES as string[]).includes(body.hazardClass)
    ? body.hazardClass
    : "pothole") as HazardClass);
  const severity = Math.min(5, Math.max(1, Math.round(body.severity ?? 3)));

  const auth = await getAuth(req);
  const media = body.mediaIds?.length
    ? await db.mediaAsset.findMany({ where: { id: { in: body.mediaIds }, reportId: null } })
    : [];
  const detections = body.detectionIds?.length
    ? await db.detection.findMany({ where: { id: { in: body.detectionIds }, reportId: null } })
    : [];

  /* ---------------- duplicate decision layer ---------------- */
  const settings = await getSettings();
  if (!body.forceNew) {
    const candidates = await findDuplicateCandidates({
      lat: body.lat,
      lng: body.lng,
      hazardClass,
      excludeReportId: undefined,
      createdAtForTemporal: new Date(),
    });
    const top = candidates[0];
    if (body.mergeIntoId) {
      const target = candidates.find((c) => c.hazardId === body.mergeIntoId) ?? null;
      if (!target) {
        return NextResponse.json(
          { error: "The hazard you tried to merge with is too far away or no longer actionable", detail: "Create a new hazard instead." },
          { status: 409 }
        );
      }
    } else if (top && top.similarityPct >= settings.duplicates.thresholdPct) {
      // do NOT create anything — let the reporter decide
      return NextResponse.json({
        requiresDecision: true,
        thresholdPct: settings.duplicates.thresholdPct,
        candidates: candidates.slice(0, 3),
        message: "This report appears similar to an existing hazard nearby.",
      });
    }
  }

  /* ---------------- AI-derived severity (refined by duplicate context) ---------------- */
  let finalSeverity = severity;
  if (!body.severity && detections.length > 0) {
    const primary = detections.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const { recurrenceCount } = await computeContextStats({ lat: body.lat, lng: body.lng, hazardClass });
    finalSeverity = severityFromDetection({
      hazardClass,
      confidence: primary.confidence,
      areaRatio: primary.areaRatio || areaRatioOf({ x: primary.bboxX, y: primary.bboxY, w: primary.bboxW, h: primary.bboxH }),
      duplicateCount: recurrenceCount,
    });
  }

  let reference = makeReference();
  for (let i = 0; i < 5; i++) {
    const clash = await db.hazardReport.findUnique({ where: { referenceCode: reference } });
    if (!clash) break;
    reference = makeReference();
  }

  // Lifecycle entry point: AI_VERIFIED when a confident AI detection backs the report,
  // otherwise plain REPORTED. Both states sit in the authority verification queue.
  const topConfidence = detections.length ? Math.max(...detections.map((d) => d.confidence)) : 0;
  const initialStatus = topConfidence >= 0.5 ? "AI_VERIFIED" : "REPORTED";

  const created = await db.hazardReport.create({
    data: {
      referenceCode: reference,
      userId: auth?.userId ?? null,
      submitterName: body.submitterName ?? auth?.name ?? null,
      submitterEmail: body.submitterEmail ?? auth?.email ?? null,
      hazardClass,
      hazardClassAi: detections.length > 0 ? detections[0].hazardClass : null,
      severity: finalSeverity,
      severityAi: detections.length > 0 ? detections.reduce((a, b) => (b.confidence > a.confidence ? b : a)).severity : null,
      notes: body.notes?.slice(0, 2000) ?? null,
      status: initialStatus,
      lat: body.lat,
      lng: body.lng,
      address: body.address?.slice(0, 300) ?? null,
      ward: body.ward ?? nearestWard({ lat: body.lat, lng: body.lng }),
      roadName: body.roadName?.slice(0, 200) ?? null,
      roadClass: body.roadClass ?? null,
      roadCriticality: body.roadCriticality ?? inferRoadCriticality(body.roadName, body.roadClass),
      geoConsent: true,
      blurRequested: Boolean(body.blurRequested),
      source: "WEB_UPLOAD",
    },
  });

  if (media.length > 0) {
    await db.mediaAsset.updateMany({ where: { id: { in: media.map((m) => m.id) } }, data: { reportId: created.id } });
  }
  for (const det of detections) {
    await db.detection.update({
      where: { id: det.id },
      data: {
        reportId: created.id,
        severity: severityFromDetection({
          hazardClass,
          confidence: det.confidence,
          areaRatio: det.areaRatio,
        }),
      },
    });
  }

  let mergedIntoRef: string | null = null;
  if (body.mergeIntoId) {
    try {
      const merge = await mergeHazardReports({
        duplicateId: created.id,
        primaryId: body.mergeIntoId,
        actorId: auth?.userId ?? null,
        actorEmail: auth?.email ?? body.submitterEmail ?? null,
        actorRole: auth?.role ?? "ANONYMOUS",
        note: "Reporter confirmed this is the same hazard",
      });
      mergedIntoRef = (await db.hazardReport.findUnique({ where: { id: body.mergeIntoId }, select: { referenceCode: true } }))?.referenceCode ?? null;
      await recomputePriorityForReport(body.mergeIntoId);
      void merge;
      if (auth) {
        await db.notification.create({
          data: {
            userId: auth.userId,
            type: "REPORT_SUBMITTED",
            title: `Report ${reference} merged with ${mergedIntoRef ?? "existing hazard"}`,
            body: `Thanks for confirming — your report was counted toward the existing hazard${mergedIntoRef ? ` ${mergedIntoRef}` : ""}, raising its community confidence.`,
            link: "#/map",
          },
        });
      }
    } catch (err) {
      // merge target vanished mid-flight — keep the report as a standalone hazard
      console.error("[reports] merge failed, keeping standalone report", err);
      await db.hazardReport.update({ where: { id: created.id }, data: { status: initialStatus, duplicateOfId: null } });
    }
  }

  await recomputePriorityForReport(created.id);
  if (auth && !body.mergeIntoId) {
    await db.notification.create({
      data: {
        userId: auth.userId,
        type: "REPORT_SUBMITTED",
        title: `Report ${reference} received`,
        body: `Your ${CLASS_META[hazardClass].label.toLowerCase()} report is in the verification queue. You will be notified once an authority reviews it.`,
        link: "#/dashboard",
      },
    });
  }
  await writeAudit({
    actorId: auth?.userId ?? null,
    actorEmail: auth?.email ?? body.submitterEmail ?? null,
    actorRole: auth?.role ?? "ANONYMOUS",
    action: body.mergeIntoId ? "report.create_merged" : "report.create",
    entityType: "hazard_report",
    entityId: created.id,
    metadata: {
      reference,
      hazardClass,
      detections: detections.length,
      media: media.length,
      lifecycle: body.mergeIntoId ? "MERGED" : initialStatus,
      mergedInto: body.mergeIntoId ?? null,
    },
    ip,
  });

  const full = await db.hazardReport.findUnique({ where: { id: created.id }, include: reportInclude });
  return NextResponse.json(
    { report: full ? serializeHazard(full) : null, mergedIntoRef },
    { status: 201 }
  );
}
