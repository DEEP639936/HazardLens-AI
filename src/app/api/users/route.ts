// /api/users — management listing of platform users (AUTHORITY | ADMIN).
// Used to populate field-worker assignment pickers. Regular users only get /api/users/me.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isResponse, requireManagement } from "@/lib/rg/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireManagement(req);
  if (isResponse(auth)) return auth;

  const role = req.nextUrl.searchParams.get("role");
  const users = await db.user.findMany({
    where: role ? { role } : undefined,
    select: { id: true, name: true, email: true, role: true, ward: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  return NextResponse.json({ items: users });
}
