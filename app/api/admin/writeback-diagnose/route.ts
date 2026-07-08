import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";

/**
 * Diagnostic: why isn't the customer-form Salesforce writeback firing for
 * a specific work order? Built 2026-07-08 for Katie's second failed
 * writeback test — she tried WO 0WOWj000007AwUvOAK after we said we'd
 * allowlisted it, and it still didn't write to SF.
 *
 * Returns a single JSON with everything an admin needs to figure out
 * why a specific submission didn't hit SF:
 *
 *   1. Current global writeback mode + when it was last changed
 *   2. Whether the given WO id is on the allowlist right now
 *   3. Every token that ever pointed at this WO + its submission state
 *   4. Every sf_writes_audit row triggered by any of those tokens
 *      OR that targeted a WOLI/WO Id starting with this WO's prefix
 *   5. Per-attempt: succeeded / errorCode / errorMessage / retryCount
 *
 * Usage:
 *   GET /api/admin/writeback-diagnose?wo=0WOWj000007AwUvOAK
 *
 * Admin-only.
 */

export const dynamic = "force-dynamic";

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const woId = url.searchParams.get("wo");
  if (!woId) {
    return NextResponse.json({
      error: "missing_param",
      usage: "GET /api/admin/writeback-diagnose?wo=0WOWj000007AwUvOAK",
    });
  }

  const sb = adminClient();

  // 1. Current mode
  const { data: modeRow } = await sb
    .from("customer_form_writeback_settings")
    .select("mode, updated_at, updated_by")
    .eq("key", "global")
    .maybeSingle();

  // 2. Allowlist check + total allowlist count
  const [{ data: allowRow }, { count: allowCount }] = await Promise.all([
    sb
      .from("customer_form_writeback_allowlist")
      .select("work_order_id, label, added_by, added_at")
      .eq("work_order_id", woId)
      .maybeSingle(),
    sb
      .from("customer_form_writeback_allowlist")
      .select("work_order_id", { count: "exact", head: true }),
  ]);

  // 3. Tokens for this WO
  const { data: tokens } = await sb
    .from("customer_form_tokens")
    .select(
      "token, kind, work_order_id, work_order_number, customer_name, created_at, submitted_at, resubmitted_at, vendor_email_sent_at, expires_at, created_by_user_id"
    )
    .eq("work_order_id", woId)
    .order("created_at", { ascending: false })
    .limit(50);

  // 4. sf_writes_audit for those tokens OR any WOLI/WO record whose id
  //    starts with the WO's 15-char prefix (SOQL Ids are 15 or 18 chars
  //    — the 15-char prefix uniquely identifies the record). We also
  //    include audit rows targeting the WO itself (MaterialType__c
  //    writes go against WorkOrder).
  const tokenList = (tokens ?? []).map((t) => t.token).filter(Boolean);
  const prefix = woId.slice(0, 15);
  const audit = await (async () => {
    const rows: unknown[] = [];
    if (tokenList.length > 0) {
      const { data: byToken } = await sb
        .from("sf_writes_audit")
        .select(
          "id, created_at, triggered_by, triggered_by_token, sf_object, sf_record_id, field_writes, succeeded, error_code, error_message, retry_count, duration_ms"
        )
        .in("triggered_by_token", tokenList)
        .order("created_at", { ascending: false })
        .limit(100);
      if (byToken) rows.push(...byToken);
    }
    // Also include rows that hit the WO Id directly (e.g. WO-level
    // MaterialType__c writes) in case the token linkage is missing.
    const { data: byRecord } = await sb
      .from("sf_writes_audit")
      .select(
        "id, created_at, triggered_by, triggered_by_token, sf_object, sf_record_id, field_writes, succeeded, error_code, error_message, retry_count, duration_ms"
      )
      .like("sf_record_id", `${prefix}%`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (byRecord) {
      for (const r of byRecord) {
        if (!rows.some((existing) => (existing as { id: string }).id === (r as { id: string }).id)) {
          rows.push(r);
        }
      }
    }
    return rows;
  })();

  // Verdict — a human-readable summary of the diagnosis. Explicit checks
  // so admin doesn't have to eyeball three tables.
  const mode = (modeRow?.mode as string | undefined) ?? "test_only";
  const onAllowlist = !!allowRow;
  const auditRows = audit as Array<{
    succeeded: boolean;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    triggered_by: string;
    sf_object: string;
    sf_record_id: string;
    field_writes: Record<string, unknown>;
  }>;
  const recentSuccess = auditRows.find((r) => r.succeeded);
  const recentFailure = auditRows.find((r) => !r.succeeded);
  const shouldWrite = mode === "all" || (mode === "test_only" && onAllowlist);

  let verdict: string;
  if (mode === "off") {
    verdict = "❌ MODE IS OFF — writeback disabled globally. Flip to 'all' or 'test_only' on /dashboard/settings/writeback to re-enable.";
  } else if (mode === "test_only" && !onAllowlist) {
    verdict = `❌ WO NOT ON ALLOWLIST — mode is test_only and this specific WO ('${woId}') isn't listed. The customer form saves the submission but skips SF. Either add this WO on /dashboard/settings/writeback OR flip mode to 'all'.`;
  } else if (auditRows.length === 0) {
    verdict = `⚠ NO WRITE ATTEMPTS LOGGED — mode + allowlist look good (${mode}, on-allowlist=${onAllowlist}) but no SF writes have been attempted for this WO. Either the customer never actually submitted the form OR the submit route bailed before reaching the write path. Check tokens[].submitted_at above — if that's populated but no audit rows exist, there's a code-path bug (route hitting an early return). If submitted_at is null, the customer never actually clicked submit.`;
  } else if (recentSuccess) {
    verdict = `✅ RECENT SUCCESS — most recent write to this WO succeeded at ${recentSuccess.created_at}. If SF still shows nothing, check the specific field (e.g. ColorWall__c) via /api/admin/wo-debug?wo=<number>, or check SF field-level permissions (integration user might lack visibility on the specific field).`;
  } else if (recentFailure) {
    verdict = `❌ WRITES FAILING — most recent attempt failed with '${recentFailure.error_code ?? "UNKNOWN"}': ${recentFailure.error_message ?? "no message"}. Read the field_writes payload above to see what we tried to send. Fix the underlying SF permission/validation issue and re-test.`;
  } else {
    verdict = "⚠ UNEXPECTED STATE — see the raw data above.";
  }

  return NextResponse.json({
    wo_id: woId,
    verdict,
    should_write: shouldWrite,
    mode: {
      current: mode,
      last_updated_at: modeRow?.updated_at ?? null,
      last_updated_by: modeRow?.updated_by ?? null,
    },
    allowlist: {
      this_wo_on_list: onAllowlist,
      label: (allowRow?.label as string | null) ?? null,
      added_at: (allowRow?.added_at as string | null) ?? null,
      added_by: (allowRow?.added_by as string | null) ?? null,
      total_wos_on_allowlist: allowCount ?? 0,
    },
    tokens: tokens ?? [],
    sf_writes_audit: auditRows,
  }, {
    // Pretty-print for easy admin reading.
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
