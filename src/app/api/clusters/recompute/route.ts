// /api/clusters/recompute — admin: re-run DBSCAN for a configurable area + time window
import { NextRequest, NextResponse } from "next/server";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { recomputeClusters } from "@/lib/rg/hazards";
import { clientIp, writeAudit } from "@/lib/rg/audit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const body = (await req.json().catch(() => ({}))) as {
    bbox?: [number, number, number, number]; // minLng, minLat, maxLng, maxLat (GeoJSON order)
    sinceDays?: number;
    epsM?: number;
    minPts?: number;
  };
  if (body.epsM != null && (body.epsM < 10 || body.epsM > 2000)) {
    return NextResponse.json({ error: "epsM must be between 10 and 2000 meters" }, { status: 400 });
  }
  if (body.minPts != null && (body.minPts < 1 || body.minPts > 50)) {
    return NextResponse.json({ error: "minPts must be between 1 and 50" }, { status: 400 });
  }
  if (body.sinceDays != null && (body.sinceDays < 1 || body.sinceDays > 365)) {
    return NextResponse.json({ error: "sinceDays must be between 1 and 365" }, { status: 400 });
  }
  const bbox = body.bbox
    ? { minLng: body.bbox[0], minLat: body.bbox[1], maxLng: body.bbox[2], maxLat: body.bbox[3] }
    : undefined;
  if (bbox && ![bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng].every(Number.isFinite)) {
    return NextResponse.json({ error: "bbox must be [minLng, minLat, maxLng, maxLat]" }, { status: 400 });
  }

  try {
    const summary = await recomputeClusters({
      bbox,
      sinceDays: body.sinceDays,
      epsM: body.epsM,
      minPts: body.minPts,
    });
    await writeAudit({
      actorId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: "cluster.recompute",
      entityType: "hazard_cluster",
      metadata: summary,
      ip: clientIp(req),
    });
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Recompute failed" },
      { status: 409 }
    );
  }
}
