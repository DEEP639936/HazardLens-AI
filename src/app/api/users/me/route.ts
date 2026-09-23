// /api/users/me — profile & privacy settings
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, isResponse, toSessionUser } from "@/lib/rg/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const user = await db.user.findUnique({ where: { id: auth.userId } });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  return NextResponse.json({ user: toSessionUser(user) });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isResponse(auth)) return auth;
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    phone?: string;
    ward?: string;
    notifyInApp?: boolean;
    geoConsent?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  if (body.name != null && body.name.trim().length < 2) {
    return NextResponse.json({ error: "Name must be at least 2 characters" }, { status: 400 });
  }
  const user = await db.user.update({
    where: { id: auth.userId },
    data: {
      ...(body.name != null ? { name: body.name.trim() } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.ward !== undefined ? { ward: body.ward } : {}),
      ...(body.notifyInApp != null ? { notifyInApp: body.notifyInApp } : {}),
      ...(body.geoConsent != null ? { geoConsent: body.geoConsent } : {}),
    },
  });
  return NextResponse.json({ user: toSessionUser(user) });
}
