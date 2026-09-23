// /api/media/[id] — stream stored media (original, annotated copies, extracted video frames)
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { db } from "@/lib/db";
import { safeResolve } from "@/lib/rg/media";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset) return NextResponse.json({ error: "Media not found" }, { status: 404 });
  const abs = safeResolve(asset.storagePath);
  if (!abs) return NextResponse.json({ error: "Media not found" }, { status: 404 });
  try {
    const data = await fs.readFile(abs);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(data.length),
        "Cache-Control": "private, max-age=86400",
        "Content-Disposition": `inline; filename="${asset.kind.toLowerCase()}-${asset.id.slice(0, 8)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Media file missing from storage" }, { status: 410 });
  }
}
