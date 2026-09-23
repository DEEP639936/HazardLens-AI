// /api/metrics — Prometheus text exposition format
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push("# HELP rg_reports_total Total hazard reports by status.");
  push("# TYPE rg_reports_total counter");
  const byStatus = await db.hazardReport.groupBy({ by: ["status"], _count: { _all: true } });
  for (const row of byStatus) push(`rg_reports_total{status="${row.status}"} ${row._count._all}`);

  push("# HELP rg_detections_total Total detections produced.");
  push("# TYPE rg_detections_total counter");
  push(`rg_detections_total ${(await db.detection.count())}`);

  push("# HELP rg_inference_jobs Inference jobs by status.");
  push("# TYPE rg_inference_jobs gauge");
  const jobs = await db.inferenceJob.groupBy({ by: ["status"], _count: { _all: true } });
  for (const j of jobs) push(`rg_inference_jobs{status="${j.status}"} ${j._count._all}`);

  push("# HELP rg_clusters_current Current hazard cluster count.");
  push("# TYPE rg_clusters_current gauge");
  push(`rg_clusters_current ${(await db.hazardCluster.count())}`);

  push("# HELP rg_work_orders_total Work orders by status.");
  push("# TYPE rg_work_orders_total gauge");
  const orders = await db.workOrder.groupBy({ by: ["status"], _count: { _all: true } });
  for (const o of orders) push(`rg_work_orders_total{status="${o.status}"} ${o._count._all}`);

  push("# HELP rg_users_total Registered users.");
  push("# TYPE rg_users_total gauge");
  push(`rg_users_total ${(await db.user.count())}`);

  push("# HELP rg_build_info Build metadata.");
  push("# TYPE rg_build_info gauge");
  push('rg_build_info{version="1.0.0",service="hazardlensai-web"} 1');

  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
