import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getSalesforceClient } from "@/lib/salesforce/client";
import { clearSalesforceCache } from "@/lib/salesforce/queries";

/**
 * Write-back helper for Salesforce. Every write that originates from Command
 * Center flows through this module so we get four things for free:
 *
 *   1. Consistent error handling + retry with exponential backoff
 *   2. Append-only audit trail (sf_writes_audit table) — every attempt logged
 *   3. Snapshot cache invalidation — after a write, next read is fresh from SF
 *   4. Optional prior-values snapshot for diff/replay
 *
 * Used by the customer-form submit handler (writes ColorWall__c / ColorCeiling__c
 * / etc. to WOLI) and any future admin-driven SF write.
 */

export type SfWriteSource =
  | "customer_form_submit"
  | "admin_manual"
  | "system_resync"
  | "vendor_email_sent";

export type SfWriteAttempt = {
  /** SF object name, e.g. "WorkOrderLineItem". */
  sObject: string;
  /** SF record Id to update. */
  recordId: string;
  /** Field map to write, e.g. { ColorWall__c: 'a02...', ColorNotes__c: 'matte' }. */
  fields: Record<string, string | number | boolean | null>;
};

export type SfWriteResult =
  | { ok: true; recordId: string; attempts: number }
  | { ok: false; recordId: string; error: string; errorCode: string | null; attempts: number };

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Write a single SF record with retry + audit + cache invalidation.
 *
 * Retry policy: 3 attempts, exponential backoff (250ms, 750ms, 2250ms). Only
 * retries on network errors / 5xx; bails immediately on validation errors
 * (since those won't fix themselves).
 */
export async function writeSf(
  attempt: SfWriteAttempt,
  ctx: {
    source: SfWriteSource;
    triggeredByUserId?: string | null;
    triggeredByToken?: string | null;
    /** Optional snapshot of pre-write values for the audit row. */
    priorValues?: Record<string, unknown> | null;
  }
): Promise<SfWriteResult> {
  const t0 = Date.now();
  const conn = await getSalesforceClient();
  let attempts = 0;
  let lastError: unknown = null;
  let lastErrorCode: string | null = null;

  const MAX_ATTEMPTS = 3;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      // jsforce's sobject().update() expects { Id, ...fields }
      const payload = { Id: attempt.recordId, ...attempt.fields };
      const result = await conn.sobject(attempt.sObject).update(payload) as
        | { success: boolean; errors?: Array<{ statusCode?: string; message?: string }> }
        | Array<{ success: boolean; errors?: Array<{ statusCode?: string; message?: string }> }>;
      const r = Array.isArray(result) ? result[0] : result;
      if (r?.success) {
        // Success — log, invalidate cache, return.
        await logAudit({
          sObject: attempt.sObject,
          recordId: attempt.recordId,
          fields: attempt.fields,
          priorValues: ctx.priorValues ?? null,
          source: ctx.source,
          triggeredByUserId: ctx.triggeredByUserId ?? null,
          triggeredByToken: ctx.triggeredByToken ?? null,
          succeeded: true,
          errorCode: null,
          errorMessage: null,
          retryCount: attempts - 1,
          durationMs: Date.now() - t0,
        });
        clearSalesforceCache();
        return { ok: true, recordId: attempt.recordId, attempts };
      }
      // SF returned a non-success — extract error info, don't retry validation errors
      const errInfo = r?.errors?.[0];
      lastError = new Error(errInfo?.message ?? "Unknown SF error");
      lastErrorCode = errInfo?.statusCode ?? null;
      if (lastErrorCode && /VALIDATION|FIELD_INTEGRITY|MALFORMED|DUPLICATE|REQUIRED_FIELD_MISSING/.test(lastErrorCode)) {
        break; // bail — these don't fix themselves
      }
    } catch (err) {
      lastError = err;
      lastErrorCode = (err as { errorCode?: string })?.errorCode ?? null;
      // Only retry on network/5xx, NOT on validation errors
      if (lastErrorCode && /VALIDATION|FIELD_INTEGRITY|MALFORMED|REQUIRED_FIELD_MISSING/.test(lastErrorCode)) {
        break;
      }
    }
    if (attempts < MAX_ATTEMPTS) {
      const backoff = 250 * Math.pow(3, attempts - 1); // 250, 750, 2250
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // All attempts failed — log and return
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await logAudit({
    sObject: attempt.sObject,
    recordId: attempt.recordId,
    fields: attempt.fields,
    priorValues: ctx.priorValues ?? null,
    source: ctx.source,
    triggeredByUserId: ctx.triggeredByUserId ?? null,
    triggeredByToken: ctx.triggeredByToken ?? null,
    succeeded: false,
    errorCode: lastErrorCode,
    errorMessage: message,
    retryCount: attempts - 1,
    durationMs: Date.now() - t0,
  });
  return {
    ok: false,
    recordId: attempt.recordId,
    error: message,
    errorCode: lastErrorCode,
    attempts,
  };
}

/**
 * Write multiple records sequentially. Each gets its own audit row. Returns
 * an array of results in input order so the caller can show per-record status.
 * Bails on the first FATAL (validation/permission) error to avoid cascading bad
 * data; transient errors are retried per writeSf() policy.
 */
export async function writeSfBatch(
  attempts: SfWriteAttempt[],
  ctx: Parameters<typeof writeSf>[1]
): Promise<SfWriteResult[]> {
  const results: SfWriteResult[] = [];
  for (const a of attempts) {
    const r = await writeSf(a, ctx);
    results.push(r);
    if (!r.ok && r.errorCode && /VALIDATION|FIELD_INTEGRITY|MALFORMED|REQUIRED_FIELD_MISSING/.test(r.errorCode)) {
      break;
    }
  }
  return results;
}

async function logAudit(input: {
  sObject: string;
  recordId: string;
  fields: Record<string, unknown>;
  priorValues: Record<string, unknown> | null;
  source: SfWriteSource;
  triggeredByUserId: string | null;
  triggeredByToken: string | null;
  succeeded: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  durationMs: number;
}): Promise<void> {
  try {
    const sb = adminClient();
    await sb.from("sf_writes_audit").insert({
      triggered_by: input.source,
      triggered_by_user_id: input.triggeredByUserId,
      triggered_by_token: input.triggeredByToken,
      sf_object: input.sObject,
      sf_record_id: input.recordId,
      field_writes: input.fields,
      prior_values: input.priorValues,
      succeeded: input.succeeded,
      error_code: input.errorCode,
      error_message: input.errorMessage,
      retry_count: input.retryCount,
      duration_ms: input.durationMs,
    });
  } catch (err) {
    // Audit logging failure is non-fatal — log to console so we can spot it,
    // but don't block the actual write from returning.
    console.error("[sf-writeback] audit log insert failed:", err);
  }
}
