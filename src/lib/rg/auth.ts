// Authentication: JWT access (15 min) + rotating refresh tokens (30 d), bcrypt password hashing,
// role-based guards. In this deployment JWTs are issued in httpOnly cookies AND returned in the
// response body (for OpenAPI/Swagger bearer flows). Production FastAPI backend mirrors this in
// backend/app/core/security.py.
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";
import type { Role, SessionUser } from "./types";

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_SEC = 30 * 24 * 3600;

const VALID_ROLES: Role[] = ["CITIZEN", "FIELD_WORKER", "AUTHORITY", "ADMIN"];

/** Legacy tokens/rows may carry "USER" — normalize to the four-role model. */
export function normalizeRole(raw: string | null | undefined): Role {
  if (raw === "ADMIN") return "ADMIN";
  if (raw === "FIELD_WORKER" || raw === "AUTHORITY") return raw;
  return "CITIZEN"; // "USER" and anything unknown land here
}

export function isValidRole(raw: string): raw is Role {
  return (VALID_ROLES as string[]).includes(raw);
}

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET ?? "roadguard-dev-only-secret-change-me";
  if (!process.env.JWT_SECRET) console.warn("[auth] JWT_SECRET not set — using development fallback");
  return new TextEncoder().encode(s);
}

export const ACCESS_COOKIE = "rg_access";
export const REFRESH_COOKIE = "rg_refresh";

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}
export function verifyPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface AccessClaims {
  sub: string;
  email: string;
  role: Role;
  name: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("roadguard-atlas")
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: "roadguard-atlas" });
    if (!payload.sub || !payload.role) return null;
    return { sub: payload.sub, email: String(payload.email), role: normalizeRole(String(payload.role)), name: String(payload.name ?? "") };
  } catch {
    return null;
  }
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = randomBytes(48).toString("hex");
  await db.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
    },
  });
  return raw;
}

export async function rotateRefreshToken(raw: string): Promise<{ userId: string; fresh: string } | null> {
  const rec = await db.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!rec || rec.revokedAt || rec.expiresAt < new Date()) return null;
  await db.refreshToken.update({ where: { id: rec.id }, data: { revokedAt: new Date() } });
  const fresh = await issueRefreshToken(rec.userId);
  return { userId: rec.userId, fresh };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { tokenHash: sha256(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function setAuthCookies(res: NextResponse, access: string, refresh?: string) {
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set(ACCESS_COOKIE, access, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: ACCESS_TTL_SEC });
  if (refresh) {
    res.cookies.set(REFRESH_COOKIE, refresh, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: REFRESH_TTL_SEC });
  }
}

export function clearAuthCookies(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

function tokenFrom(req: NextRequest): string | null {
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
  return req.cookies.get(ACCESS_COOKIE)?.value ?? null;
}

export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  name: string;
}

/** Resolve the caller from cookie or Authorization header. Returns null when anonymous. */
export async function getAuth(req: NextRequest): Promise<AuthContext | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  if (!claims) return null;
  return { userId: claims.sub, email: claims.email, role: claims.role, name: claims.name };
}

export async function requireAuth(req: NextRequest): Promise<AuthContext | Response> {
  const auth = await getAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  return auth;
}

export async function requireAdmin(req: NextRequest): Promise<AuthContext | Response> {
  const auth = await getAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (auth.role !== "ADMIN") {
    return NextResponse.json({ error: "Administrator role required" }, { status: 403 });
  }
  return auth;
}

/** Backend authorization gate: the caller's normalized role must be in `allowed`. */
export async function requireRole(req: NextRequest, allowed: Role[]): Promise<AuthContext | Response> {
  const auth = await getAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!allowed.includes(auth.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions", detail: `This action requires one of: ${allowed.join(", ")}.` },
      { status: 403 }
    );
  }
  return auth;
}

/** Management surfaces (verification, work orders, analytics): authority + admin. */
export function requireManagement(req: NextRequest): Promise<AuthContext | Response> {
  return requireRole(req, ["AUTHORITY", "ADMIN"]);
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}

export function toSessionUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  notifyInApp: boolean;
  geoConsent: boolean;
}): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: normalizeRole(u.role),
    notifyInApp: u.notifyInApp,
    geoConsent: u.geoConsent,
  };
}
