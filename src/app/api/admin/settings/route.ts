// /api/admin/settings — priority weights, clustering parameters, auto-recompute
import { NextRequest, NextResponse } from "next/server";
import { isResponse, requireAdmin } from "@/lib/rg/auth";
import { getSettings, putSettings, type Settings } from "@/lib/rg/settings";
import { clientIp, writeAudit } from "@/lib/rg/audit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  return NextResponse.json({ settings: await getSettings() });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (isResponse(auth)) return auth;
  const body = (await req.json().catch(() => null)) as Partial<Settings> | null;
  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  try {
    const settings = await putSettings(body);
    await writeAudit({
      actorId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: "settings.update",
      entityType: "system_settings",
      metadata: body as Record<string, unknown>,
      ip: clientIp(req),
    });
    return NextResponse.json({ settings });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid settings" }, { status: 400 });
  }
}
