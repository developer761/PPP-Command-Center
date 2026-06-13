import "server-only";

import { commercialDb } from "./db";

/**
 * Write a row into `commercial_audit_log` whenever any commercial_* table
 * is mutated. The diagram's "Full audit trail on all records" requirement —
 * compliance + debugging + history view per record.
 *
 * Call this AFTER the actual write succeeds (so we never log phantoms).
 * Fire-and-forget: a failed audit write logs to console but never blocks
 * the caller — losing an audit entry is bad, but blocking a user action
 * because audit logging fell over is worse. Audit gaps are caught by a
 * separate consistency check (TBD: cron that scans tables vs. log).
 */

export type AuditAction = "insert" | "update" | "delete";

export type AuditWrite = {
  tableName: string;          // e.g. "commercial_accounts"
  rowId: string;              // the row's id (TEXT — not type-locked to UUID)
  action: AuditAction;
  beforeJson?: unknown;       // omit for inserts
  afterJson?: unknown;        // omit for deletes
  userId?: string | null;     // who did it (null for system-driven writes)
};

export async function writeCommercialAudit(input: AuditWrite): Promise<void> {
  try {
    const sb = commercialDb();
    const { error } = await sb.from("commercial_audit_log").insert({
      table_name: input.tableName,
      row_id: input.rowId,
      action: input.action,
      before_json: input.beforeJson ?? null,
      after_json: input.afterJson ?? null,
      user_id: input.userId ?? null,
    });
    if (error) {
      console.warn(`[commercial/audit] insert failed for ${input.tableName}/${input.rowId}:`, error.message);
    }
  } catch (err) {
    console.warn("[commercial/audit] unexpected error:", err instanceof Error ? err.message : String(err));
  }
}

/** Convenience wrapper: log an insert. */
export function logInsert(tableName: string, rowId: string, after: unknown, userId?: string | null) {
  return writeCommercialAudit({ tableName, rowId, action: "insert", afterJson: after, userId });
}

/** Convenience wrapper: log an update. */
export function logUpdate(tableName: string, rowId: string, before: unknown, after: unknown, userId?: string | null) {
  return writeCommercialAudit({ tableName, rowId, action: "update", beforeJson: before, afterJson: after, userId });
}

/** Convenience wrapper: log a delete. */
export function logDelete(tableName: string, rowId: string, before: unknown, userId?: string | null) {
  return writeCommercialAudit({ tableName, rowId, action: "delete", beforeJson: before, userId });
}
