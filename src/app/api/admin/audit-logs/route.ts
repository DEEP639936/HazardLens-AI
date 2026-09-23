// /api/admin/audit-logs — moderator/admin action trail
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const sp = req.nextUrl.searchParams;
  const take = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 100)));
  const action = sp.get("action");
  const entityType = sp.get("entityType");
  const entityId = sp.get("entityId");
  const q = sp.get("q");
  const logs = await db.auditLog.findMany({
    where: {
      ...(action ? { action: { contains: action } } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(q ? { OR: [{ action: { contains: q } }, { actorEmail: { contains: q } }, { entityId: { contains: q } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return NextResponse.json({
    items: logs.map((l) => ({
      id: l.id,
      actorEmail: l.actorEmail,
      actorRole: l.actorRole,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      metadataJson: l.metadataJson,
      ip: l.ip,
      createdAt: l.createdAt.toISOString(),
    })),
  });
}
