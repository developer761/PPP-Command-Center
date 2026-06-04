import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Customer-form Salesforce-writeback safety gate (migration 015).
 *
 *   - mode='test_only' (DEFAULT) — only writes to WOs explicitly in
 *     customer_form_writeback_allowlist. Empty allowlist = no writes
 *     happen anywhere. Used during Katie's testing phase.
 *   - mode='all'                   — writes to every customer-form submit.
 *     Flip when PPP confirms platform is ready for production rollout.
 *   - mode='off'                   — disables writeback entirely.
 *
 * Soft-fails OPEN by default — if Supabase is unreachable we treat the
 * mode as 'off' (skip the write) rather than risk corrupting production
 * data with a stale fallback. The audit log preserves the customer's
 * submission either way so admin can replay later.
 */

export type WritebackMode = "test_only" | "all" | "off";

export type WritebackDecision = {
  mode: WritebackMode;
  /** True when the WO IS allowed to write back to Salesforce right now. */
  shouldWrite: boolean;
  /** Human-readable reason — used in audit logs + admin UI. */
  reason: string;
  /** True only when mode='test_only' — surfaced on the customer form so the
   *  banner copy can say "test mode" without leaking the production mode. */
  isTestMode: boolean;
  /** When mode='test_only', whether this specific WO is on the allowlist. */
  isInAllowlist: boolean;
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Read the global writeback mode. Defaults to 'test_only' if the
 *  settings table is missing (migration 015 not run yet) or unreachable. */
export async function getWritebackMode(): Promise<WritebackMode> {
  try {
    const sb = adminClient();
    const { data, error } = await sb
      .from("customer_form_writeback_settings")
      .select("mode")
      .eq("key", "global")
      .maybeSingle();
    if (error) {
      console.warn(`[writeback-mode] settings query failed (defaulting to test_only):`, error.message);
      return "test_only";
    }
    const raw = (data?.mode as string | undefined) ?? "test_only";
    if (raw === "test_only" || raw === "all" || raw === "off") return raw;
    return "test_only";
  } catch (err) {
    console.warn(`[writeback-mode] threw (defaulting to test_only):`, err instanceof Error ? err.message : err);
    return "test_only";
  }
}

/** True when the given WO id is on the test allowlist. False when not
 *  on it OR when the table can't be read. */
export async function isWoOnAllowlist(workOrderId: string): Promise<boolean> {
  if (!workOrderId) return false;
  try {
    const sb = adminClient();
    const { data, error } = await sb
      .from("customer_form_writeback_allowlist")
      .select("work_order_id")
      .eq("work_order_id", workOrderId)
      .maybeSingle();
    if (error) {
      console.warn(`[writeback-mode] allowlist lookup failed:`, error.message);
      return false;
    }
    return !!data?.work_order_id;
  } catch (err) {
    console.warn(`[writeback-mode] allowlist threw:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Combine mode + allowlist into a single decision. */
export async function decideWriteback(workOrderId: string): Promise<WritebackDecision> {
  const mode = await getWritebackMode();
  if (mode === "off") {
    return {
      mode,
      shouldWrite: false,
      reason: "Writeback is currently disabled (mode=off). Customer submissions are saved in Command Center but not written to Salesforce.",
      isTestMode: false,
      isInAllowlist: false,
    };
  }
  if (mode === "all") {
    return {
      mode,
      shouldWrite: true,
      reason: "Writeback is enabled for all work orders (production mode).",
      isTestMode: false,
      isInAllowlist: true,
    };
  }
  // mode === 'test_only'
  const inAllowlist = await isWoOnAllowlist(workOrderId);
  return {
    mode,
    shouldWrite: inAllowlist,
    reason: inAllowlist
      ? "This work order is on the test allowlist — writes proceed."
      : "Writeback is in test mode and this WO isn't on the allowlist — write skipped. Submission is preserved in Command Center.",
    isTestMode: true,
    isInAllowlist: inAllowlist,
  };
}

/** Load all WOs currently on the allowlist — used by admin surfaces. */
export async function loadAllowlist(): Promise<Array<{ workOrderId: string; label: string | null; addedBy: string | null; addedAt: string }>> {
  try {
    const sb = adminClient();
    const { data, error } = await sb
      .from("customer_form_writeback_allowlist")
      .select("work_order_id, label, added_by, added_at")
      .order("added_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => ({
      workOrderId: r.work_order_id as string,
      label: (r.label as string | null) ?? null,
      addedBy: (r.added_by as string | null) ?? null,
      addedAt: (r.added_at as string) ?? new Date().toISOString(),
    }));
  } catch (err) {
    console.warn(`[writeback-mode] loadAllowlist failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}
