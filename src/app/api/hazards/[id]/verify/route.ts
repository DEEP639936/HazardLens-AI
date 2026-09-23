// POST /api/hazards/[id]/verify — authority verification actions:
//   verify | reject | escalate | merge (+ legacy aliases approve/flag)
// Roles: AUTHORITY | ADMIN. Every action is written to the audit log.
import { NextRequest } from "next/server";
import { isResponse, requireManagement } from "@/lib/rg/auth";
import { clientIp } from "@/lib/rg/audit";
import { applyReviewAction, type ReviewPayload } from "@/lib/rg/review";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireManagement(req);
  if (isResponse(auth)) return auth;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as ReviewPayload | null;
  return applyReviewAction(id, body, auth, clientIp(req));
}
