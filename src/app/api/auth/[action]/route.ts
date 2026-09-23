// /api/auth/[action] — register | login | refresh | logout | me | forgot-password | reset-password
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  hashPassword,
  issueRefreshToken,
  normalizeRole,
  rotateRefreshToken,
  setAuthCookies,
  signAccessToken,
  toSessionUser,
  verifyAccessToken,
  verifyPassword,
  revokeRefreshToken,
  sha256,
} from "@/lib/rg/auth";
import { clientIp, writeAudit } from "@/lib/rg/audit";
import { rateLimit } from "@/lib/rg/ratelimit";
import { randomBytes } from "crypto";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(error: string, status = 400, detail?: string) {
  return NextResponse.json({ error, ...(detail ? { detail } : {}) }, { status });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action !== "me") return bad("Unknown auth action", 404);
  const bearer = req.headers.get("authorization")?.startsWith("Bearer ")
    ? req.headers.get("authorization")!.slice(7)
    : req.cookies.get(ACCESS_COOKIE)?.value;
  if (!bearer) return NextResponse.json({ user: null });
  try {
    const claims = await verifyAccessToken(bearer);
    if (!claims) return NextResponse.json({ user: null });
    const user = await db.user.findUnique({ where: { id: claims.sub } });
    if (!user) return NextResponse.json({ user: null });
    return NextResponse.json({ user: toSessionUser(user) });
  } catch {
    return NextResponse.json({ user: null });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const ip = clientIp(req);

  if (action === "register") {
    const rl = rateLimit(`register:${ip}`, 5, 3600_000);
    if (!rl.ok) return bad("Too many registrations from this address", 429, `Retry in ${rl.retryAfterSec}s`);
    const body = (await req.json().catch(() => null)) as { email?: string; password?: string; name?: string } | null;
    if (!body?.email || !EMAIL_RE.test(body.email)) return bad("A valid email is required");
    if (!body.password || body.password.length < 8) return bad("Password must be at least 8 characters", 400, "Use a strong passphrase");
    if (!body.name || body.name.trim().length < 2) return bad("Your name is required");
    const existing = await db.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) return bad("An account with this email already exists", 409);
    const user = await db.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash: hashPassword(body.password),
        name: body.name.trim(),
        role: "CITIZEN",
      },
    });
    const access = await signAccessToken({ sub: user.id, email: user.email, role: "CITIZEN", name: user.name });
    const refresh = await issueRefreshToken(user.id);
    const res = NextResponse.json({ user: toSessionUser(user), access, tokenType: "bearer" }, { status: 201 });
    setAuthCookies(res, access, refresh);
    await writeAudit({ actorId: user.id, actorEmail: user.email, actorRole: "CITIZEN", action: "auth.register", entityType: "user", entityId: user.id, ip });
    return res;
  }

  if (action === "login") {
    const rl = rateLimit(`login:${ip}`, 10, 15 * 60_000);
    if (!rl.ok) return bad("Too many sign-in attempts", 429, `Retry in ${rl.retryAfterSec}s`);
    const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null;
    if (!body?.email || !body?.password) return bad("Email and password are required");
    const user = await db.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      await writeAudit({ action: "auth.login_failed", entityType: "user", metadata: { email: body.email }, ip });
      return bad("Invalid email or password", 401);
    }
    const access = await signAccessToken({ sub: user.id, email: user.email, role: normalizeRole(user.role), name: user.name });
    const refresh = await issueRefreshToken(user.id);
    const res = NextResponse.json({ user: toSessionUser(user), access, tokenType: "bearer" });
    setAuthCookies(res, access, refresh);
    await writeAudit({ actorId: user.id, actorEmail: user.email, actorRole: normalizeRole(user.role), action: "auth.login", entityType: "user", entityId: user.id, ip });
    return res;
  }

  if (action === "refresh") {
    const raw = req.cookies.get(REFRESH_COOKIE)?.value ?? req.headers.get("x-refresh-token") ?? undefined;
    if (!raw) return bad("Refresh token missing", 401);
    const rotated = await rotateRefreshToken(raw);
    if (!rotated) return bad("Refresh token invalid or expired", 401);
    const user = await db.user.findUnique({ where: { id: rotated.userId } });
    if (!user) return bad("Account no longer exists", 401);
    const access = await signAccessToken({ sub: user.id, email: user.email, role: normalizeRole(user.role), name: user.name });
    const res = NextResponse.json({ user: toSessionUser(user), access, tokenType: "bearer" });
    setAuthCookies(res, access, rotated.fresh);
    return res;
  }

  if (action === "logout") {
    const raw = req.cookies.get(REFRESH_COOKIE)?.value;
    if (raw) await revokeRefreshToken(raw);
    const res = NextResponse.json({ ok: true });
    clearAuthCookies(res);
    return res;
  }

  if (action === "forgot-password") {
    const rl = rateLimit(`forgot:${ip}`, 5, 3600_000);
    if (!rl.ok) return bad("Too many reset requests", 429);
    const body = (await req.json().catch(() => null)) as { email?: string } | null;
    if (!body?.email) return bad("Email is required");
    const user = await db.user.findUnique({ where: { email: body.email.toLowerCase() } });
    // Always respond identically (no account enumeration).
    const response = NextResponse.json({
      ok: true,
      message: "If an account exists for this address, a reset link has been issued.",
    });
    if (user) {
      const token = randomBytes(24).toString("hex");
      await db.systemSetting.upsert({
        where: { key: `reset:${sha256(token)}` },
        update: { valueJson: JSON.stringify({ userId: user.id, exp: Date.now() + 3600_000 }) },
        create: { key: `reset:${sha256(token)}`, valueJson: JSON.stringify({ userId: user.id, exp: Date.now() + 3600_000 }) },
      });
      // Demo deployment: no SMTP configured; token surfaced via header for the demo flow only.
      // Production would email this (see docs/SYSTEM_CARD.md — email delivery integration point).
      response.headers.set("x-demo-reset-token", token);
      await writeAudit({ actorId: user.id, actorEmail: user.email, action: "auth.forgot_password", entityType: "user", entityId: user.id, ip });
    }
    return response;
  }

  if (action === "reset-password") {
    const body = (await req.json().catch(() => null)) as { token?: string; password?: string } | null;
    if (!body?.token || !body?.password || body.password.length < 8) {
      return bad("Token and a password of at least 8 characters are required");
    }
    const key = `reset:${sha256(body.token)}`;
    const rec = await db.systemSetting.findUnique({ where: { key } });
    if (!rec) return bad("Reset token is invalid or has expired", 400);
    const data = JSON.parse(rec.valueJson) as { userId: string; exp: number };
    if (data.exp < Date.now()) {
      await db.systemSetting.delete({ where: { key } }).catch(() => undefined);
      return bad("Reset token is invalid or has expired", 400);
    }
    await db.user.update({ where: { id: data.userId }, data: { passwordHash: hashPassword(body.password) } });
    await db.refreshToken.updateMany({ where: { userId: data.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await db.systemSetting.delete({ where: { key } }).catch(() => undefined);
    await writeAudit({ actorId: data.userId, action: "auth.reset_password", entityType: "user", entityId: data.userId, ip });
    return NextResponse.json({ ok: true });
  }

  return bad("Unknown auth action", 404);
}
