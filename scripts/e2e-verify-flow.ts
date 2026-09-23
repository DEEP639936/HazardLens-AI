// E2E pipeline test — drives one hazard through the full resolution flow to
// VERIFICATION_PENDING using the real HTTP APIs, including RBAC negative tests.
// Run: bunx tsx scripts/e2e-verify-flow.ts
import { writeFileSync } from "fs";

const BASE = "http://localhost:3000";

// --- tiny valid PNGs (1x1 and 2x2, distinct bytes so perceptual hashes differ) ---
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PNG_2PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function pngWithSize(bytes: Buffer, minKB: number): Buffer {
  // pad by repeating into a larger buffer is invalid for PNG; instead just use as-is (server re-encodes)
  void minKB;
  return bytes;
}

interface Jar { cookies: Map<string, string> }
function newJar(): Jar { return { cookies: new Map() }; }
function cookieHeader(jar: Jar): string {
  return [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Jar, res: Response): void {
  const setters = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of setters) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function call(jar: Jar, method: string, path: string, body?: unknown, raw?: Buffer, formData?: FormData) {
  const headers: Record<string, string> = { cookie: cookieHeader(jar) };
  let payload: BodyInit | undefined;
  if (formData) {
    payload = formData;
  } else if (raw) {
    headers["content-type"] = "application/octet-stream";
    payload = new Uint8Array(raw);
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: "manual" });
  absorb(jar, res);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: json ? undefined : text.slice(0, 300) };
}

function assert(cond: boolean, label: string, extra?: unknown) {
  if (!cond) {
    console.error(`✗ FAIL: ${label}`, extra ?? "");
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

async function login(email: string, password: string): Promise<Jar> {
  const jar = newJar();
  const r = await call(jar, "POST", "/api/auth/login", { email, password });
  assert(r.status === 200, `login ${email}`, r.json);
  return jar;
}

async function main() {
  writeFileSync("/tmp/rg-before.png", pngWithSize(PNG_1PX, 0));
  writeFileSync("/tmp/rg-after.png", pngWithSize(PNG_2PX, 0));

  // ---------- 1. citizen reports a hazard ----------
  const citizen = await login("citizen@roadguardatlas.dev", "Atlas@User2024");
  const up = await call(citizen, "POST", "/api/uploads", undefined, undefined, (() => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(PNG_1PX)], { type: "image/png" }), "report.png");
    fd.append("geoConsent", "false");
    return fd;
  })());
  assert(up.status === 201 && (up.json as { mediaId?: string })?.mediaId, "citizen uploads report photo", up.json);
  const reportMediaId = (up.json as { mediaId: string }).mediaId;

  const rep = await call(citizen, "POST", "/api/reports", {
    mediaIds: [reportMediaId],
    hazardClass: "pothole",
    severity: 3,
    // jitter ~100 m per run so the duplicate pre-flight doesn't hijack the pipeline test
    lat: 12.9716 + (Math.random() - 0.5) * 0.002,
    lng: 77.5946 + (Math.random() - 0.5) * 0.002,
    address: "E2E Test Road, near demo junction",
    ward: "Test Ward",
    roadName: "E2E Test Road",
    notes: "E2E pipeline test hazard — safe to delete",
    geoConsent: true,
  });
  assert(rep.status === 201 || rep.status === 200, "citizen files report", rep.json);
  const hazardId = (rep.json as { report?: { id?: string } })?.report?.id ?? (rep.json as { id?: string })?.id;
  assert(Boolean(hazardId), "hazard created", rep.json);

  // ---------- 2. admin verifies the hazard ----------
  const admin = await login("admin@roadguardatlas.dev", "Atlas@Admin2024");
  const hv = await call(admin, "POST", `/api/hazards/${hazardId}/verify`, { action: "verify", note: "E2E verification" });
  assert(hv.status === 200, "admin verifies hazard", hv.json);

  // ---------- 3. admin creates + assigns the work order ----------
  const fieldLogin = await login("field@roadguardatlas.dev", "Atlas@User2024");
  const me = await call(fieldLogin, "GET", "/api/users/me");
  const fieldUserId = (me.json as { user?: { id?: string } })?.user?.id;
  assert(Boolean(fieldUserId), "field worker id resolved", me.json);

  const wo = await call(admin, "POST", "/api/work-orders", {
    hazardReportId: hazardId,
    department: "Road Maintenance",
    assignedUserId: fieldUserId,
    assignedTeam: "Ward 7 crew",
    note: "E2E: patch the pothole",
  });
  assert(wo.status === 201, "admin creates work order", wo.json);
  const woId = (wo.json as { id?: string })?.id as string;
  const woCode = (wo.json as { code?: string })?.code as string;

  // ---------- 4. field worker: start + evidence ----------
  const start = await call(fieldLogin, "PATCH", `/api/work-orders/${woId}`, { status: "IN_PROGRESS", note: "On site" });
  assert(start.status === 200, "field worker starts work", start.json);

  const b1 = await call(fieldLogin, "POST", "/api/uploads", undefined, undefined, (() => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(PNG_1PX)], { type: "image/png" }), "before.png");
    fd.append("geoConsent", "false");
    return fd;
  })());
  const b2 = await call(fieldLogin, "POST", "/api/uploads", undefined, undefined, (() => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(PNG_2PX)], { type: "image/png" }), "after.png");
    fd.append("geoConsent", "false");
    return fd;
  })());
  assert(b1.status === 201 && b2.status === 201, "field worker uploads before/after", { b1: b1.status, b2: b2.status });
  const beforeMediaId = (b1.json as { mediaId: string }).mediaId;
  const afterMediaId = (b2.json as { mediaId: string }).mediaId;

  // evidence without after photo → 400 (validation)
  const badEv = await call(fieldLogin, "POST", `/api/work-orders/${woId}/evidence`, { resolutionNotes: "missing after" });
  assert(badEv.status === 400, "evidence without after photo rejected (400)", badEv.json);

  const ev = await call(fieldLogin, "POST", `/api/work-orders/${woId}/evidence`, {
    beforeMediaId, afterMediaId, resolutionNotes: "Patched with hot mix, compacted and reopened.",
  });
  assert(ev.status === 200 && (ev.json as { status?: string })?.status === "VERIFICATION_PENDING", "evidence → VERIFICATION_PENDING", ev.json);

  // ---------- 5. RBAC: only ADMIN may verify ----------
  const fieldVerify = await call(fieldLogin, "POST", `/api/work-orders/${woId}/verify`, { decision: "approve" });
  assert(fieldVerify.status === 403, "field worker verify → 403 (admin-only)", fieldVerify.json);
  const citizenVerify = await call(citizen, "POST", `/api/work-orders/${woId}/verify`, { decision: "approve" });
  assert(citizenVerify.status === 401 || citizenVerify.status === 403, "citizen verify → denied", citizenVerify.json);

  // ---------- 6. reject requires a reason ----------
  const noReason = await call(admin, "POST", `/api/work-orders/${woId}/verify`, { decision: "reject" });
  assert(noReason.status === 400, "reject without reason → 400", noReason.json);

  console.log("\nPIPELINE READY FOR BROWSER VERIFICATION:", { hazardId, woId, woCode, beforeMediaId, afterMediaId });
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
