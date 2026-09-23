// /api/users/me/notifications — in-app notification center
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, isResponse } from "@/lib/rg/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const [items, unread] = await Promise.all([
    db.notification.findMany({ where: { userId: auth.userId }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.notification.count({ where: { userId: auth.userId, read: false } }),
  ]);
  return NextResponse.json({ items, unread });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const body = (await req.json().catch(() => null)) as { action?: string; id?: string } | null;
  if (body?.action === "read-all") {
    await db.notification.updateMany({ where: { userId: auth.userId, read: false }, data: { read: true } });
    return NextResponse.json({ ok: true });
  }
  if (body?.action === "read" && body.id) {
    await db.notification.updateMany({ where: { id: body.id, userId: auth.userId }, data: { read: true } });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown notification action" }, { status: 400 });
}
