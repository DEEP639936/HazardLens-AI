// /api/admin/users — ADMIN user management: list accounts, change roles.
// Role changes are audit-logged and take effect at the user's next token refresh.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { isValidRole } from "@/lib/rg/auth";
import type { Role } from "@/lib/rg/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const users = await db.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      phone: true,
      ward: true,
      createdAt: true,
      _count: { select: { reports: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return NextResponse.json({
    items: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role as Role,
      phone: u.phone,
      ward: u.ward,
      reportCount: u._count.reports,
      createdAt: u.createdAt.toISOString(),
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const ip = clientIp(req);
  const body = (await req.json().catch(() => null)) as { userId?: string; role?: string } | null;
  if (!body?.userId || !body?.role) return NextResponse.json({ error: "userId and role are required" }, { status: 400 });
  if (!isValidRole(body.role)) {
    return NextResponse.json({ error: "role must be one of: CITIZEN, FIELD_WORKER, AUTHORITY, ADMIN" }, { status: 400 });
  }
  const target = await db.user.findUnique({ where: { id: body.userId } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (target.id === auth.userId && body.role !== "ADMIN") {
    return NextResponse.json({ error: "You cannot demote your own admin account" }, { status: 409 });
  }

  const updated = await db.user.update({ where: { id: target.id }, data: { role: body.role } });
  await db.refreshToken.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.notification.create({
    data: {
      userId: target.id,
      type: "SYSTEM",
      title: "Your role changed",
      body: `Your HazardLensAI role is now “${body.role.replace("_", " ").toLowerCase()}”. Sign in again to refresh your workspace.`,
      link: "#",
    },
  }).catch(() => undefined);

  await writeAudit({
    actorId: auth.userId,
    actorEmail: auth.email,
    actorRole: auth.role,
    action: "admin.user_role_change",
    entityType: "user",
    entityId: target.id,
    metadata: { email: target.email, from: target.role, to: updated.role },
    ip,
  });
  return NextResponse.json({ ok: true, role: updated.role });
}
