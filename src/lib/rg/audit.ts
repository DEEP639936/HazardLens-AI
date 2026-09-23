// Structured audit logging for administrative and security-relevant actions.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

export interface AuditEntry {
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string; // e.g. "report.approve", "cluster.recompute", "auth.login"
  entityType: string; // "hazard_report" | "work_order" | "settings" | ...
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "127.0.0.1"
  );
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
        ip: entry.ip ?? null,
      },
    });
  } catch (err) {
    // Audit must never break the request path — log and continue.
    console.error("[audit] failed to persist entry", err);
  }
}
