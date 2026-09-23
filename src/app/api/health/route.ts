// /api/health — liveness + dependency probe
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  let dbStatus = "up";
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "down";
  }
  return NextResponse.json({
    status: dbStatus === "up" ? "ok" : "degraded",
    service: "hazardlensai-web",
    version: "1.0.0",
    checks: { database: dbStatus, inferenceEngine: process.env.INFERENCE_SERVICE_URL ? "yolo-service" : "auto (glm-vision → demo-engine-v2)" },
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
}
