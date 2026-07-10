import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { classifySurface } from "@/lib/customer-form/surface-mapping";

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
  // Trim — URL params sometimes carry trailing whitespace from copy-paste
  // (e.g. "?wo=0WOWj000007AwUvOAK   "). Untrimmed, that whitespace propagates
  // into the .slice(0,15) prefix and every downstream comparison silently
  // fails to match. Karan 2026-07-08.
  const woId = url.searchParams.get("wo")?.trim() || null;
  const tokenParam = url.searchParams.get("token")?.trim() || null;
  if (!woId && !tokenParam) {
    return NextResponse.json({
      error: "missing_param",
      usage: {
        by_wo: "GET /api/admin/writeback-diagnose?wo=0WOWj000007AwUvOAK",
        by_token: "GET /api/admin/writeback-diagnose?token=Dwq69udfcWwx4jxTyh2Y1pLLKmMNtr4vWGM38GRYc0k",
      },
    });
  }

  const sb = adminClient();

  // Token lookup path — resolves a specific customer-form token to its
  // WO id (which becomes the woId for the rest of the diagnosis). Katie
  // 2026-07-08: her form URL was
  // /select/Dwq69udfcWwx4jxTyh2Y1pLLKmMNtr4vWGM38GRYc0k and the by-wo
  // lookup returned zero tokens for the WO she was checking, meaning
  // the form may have been generated for a different WO. This path
  // sidesteps the guessing.
  let resolvedWoId = woId;
  let tokenLookup: {
    found: boolean;
    token: string | null;
    work_order_id: string | null;
    work_order_number: string | null;
    kind: string | null;
    created_at: string | null;
    submitted_at: string | null;
    resubmitted_at: string | null;
    expires_at: string | null;
    customer_name: string | null;
    created_by_user_id: string | null;
  } | null = null;
  if (tokenParam) {
    const { data: tokenRow } = await sb
      .from("customer_form_tokens")
      .select(
        "token, work_order_id, work_order_number, kind, created_at, submitted_at, resubmitted_at, expires_at, customer_name, created_by_user_id"
      )
      .eq("token", tokenParam)
      .maybeSingle();
    tokenLookup = {
      found: !!tokenRow,
      token: tokenParam,
      work_order_id: (tokenRow?.work_order_id as string | null) ?? null,
      work_order_number: (tokenRow?.work_order_number as string | null) ?? null,
      kind: (tokenRow?.kind as string | null) ?? null,
      created_at: (tokenRow?.created_at as string | null) ?? null,
      submitted_at: (tokenRow?.submitted_at as string | null) ?? null,
      resubmitted_at: (tokenRow?.resubmitted_at as string | null) ?? null,
      expires_at: (tokenRow?.expires_at as string | null) ?? null,
      customer_name: (tokenRow?.customer_name as string | null) ?? null,
      created_by_user_id: (tokenRow?.created_by_user_id as string | null) ?? null,
    };
    if (tokenRow?.work_order_id && !resolvedWoId) {
      resolvedWoId = tokenRow.work_order_id as string;
    }
  }

  // If we still have no WO id (token param given but token doesn't exist)
  // return the token lookup + recent tokens so admin can see what's live.
  if (!resolvedWoId) {
    const { data: recent } = await sb
      .from("customer_form_tokens")
      .select("token, work_order_id, work_order_number, kind, customer_name, created_at, submitted_at, expires_at")
      .order("created_at", { ascending: false })
      .limit(20);
    return NextResponse.json({
      verdict: tokenLookup?.found
        ? `Token found but has no work_order_id — see token_lookup below.`
        : `❌ TOKEN NOT FOUND — no customer_form_tokens row matches token '${tokenParam}'. Either it was typoed, or the token was purged after expires_at. Recent tokens listed below.`,
      token_lookup: tokenLookup,
      recent_tokens: recent ?? [],
    });
  }

  // 1. Current mode
  const { data: modeRow } = await sb
    .from("customer_form_writeback_settings")
    .select("mode, updated_at, updated_by")
    .eq("key", "global")
    .maybeSingle();

  // 2. Allowlist check + total allowlist count. Salesforce Ids come in
  //    15-char (case-sensitive) and 18-char (case-insensitive) flavors —
  //    both refer to the same record. Check the exact string AND the
  //    15-char prefix so an allowlist with the 18-char version still
  //    matches a token stored with the 15-char version (or vice versa).
  const woPrefix = resolvedWoId.slice(0, 15);
  const [{ data: allAllowlist }, { count: allowCount }] = await Promise.all([
    sb
      .from("customer_form_writeback_allowlist")
      .select("work_order_id, label, added_by, added_at")
      .limit(200),
    sb
      .from("customer_form_writeback_allowlist")
      .select("work_order_id", { count: "exact", head: true }),
  ]);
  const allowRow = (allAllowlist ?? []).find((r) => {
    const stored = (r.work_order_id as string | null) ?? "";
    return stored.slice(0, 15).toLowerCase() === woPrefix.toLowerCase();
  }) ?? null;

  // 3. Tokens for this WO — Katie 2026-07-08 round 3: both .eq(exact) and
  //    .like(prefix%) queries returned 0 rows despite v2 recent_tokens
  //    clearly showing tokens with work_order_id === resolvedWoId. Some
  //    supabase-js / Postgres quirk with the filter (possibly hidden
  //    whitespace, encoding, or column collation). Bypass the mystery:
  //    pull the last 100 tokens unfiltered, filter in JS. Also captures
  //    tokens with different id formats (15/18 char) without depending
  //    on LIKE case-sensitivity.
  // Karan 2026-07-08 round 5: earlier SELECT list included submitted_payload
  // by name, but the column may live under a different name in this schema.
  // Supabase returns null data (0 rows) when SELECT hits an unknown column
  // — that made the previous diagnostic silently return zero tokens. Wildcard
  // SELECT is the safest way to get everything without knowing the exact
  // column names; we pluck payload out of whichever column has it below.
  const { data: allRecentTokens, error: tokensError } = await sb
    .from("customer_form_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  const allTokens = (allRecentTokens ?? []) as Array<Record<string, unknown>>;
  const tokens = allTokens.filter((t) => {
    const stored = (t.work_order_id as string | null) ?? "";
    if (!stored) return false;
    return stored.slice(0, 15).toLowerCase() === woPrefix.toLowerCase();
  });
  // Diagnostic breadcrumbs — surface the raw column names + query error
  // (if any) so a silent SELECT failure is obvious in the response.
  const firstRow = allTokens[0] ?? {};
  const diagnosticCrumbs = {
    total_tokens_fetched: allTokens.length,
    filter_wo_prefix: woPrefix,
    matched_tokens_count: tokens.length,
    tokens_query_error: tokensError ? tokensError.message : null,
    // Reveal which column actually stores the payload — could be
    // submitted_payload, payload, submission, etc.
    column_names_first_row: Object.keys(firstRow).sort(),
    distinct_wo_ids_in_last_200: Array.from(
      new Set(
        allTokens
          .map((t) => (t.work_order_id as string | null) ?? "")
          .filter(Boolean)
      )
    ).slice(0, 30),
    sample_first_5_stored_wo_ids: allTokens.slice(0, 5).map((t) => ({
      token_head: ((t.token as string) ?? "").slice(0, 12) + "…",
      work_order_id: t.work_order_id ?? null,
      submitted_at: t.submitted_at ?? null,
      matches_filter:
        typeof t.work_order_id === "string" &&
        t.work_order_id.slice(0, 15).toLowerCase() === woPrefix.toLowerCase(),
    })),
  };

  // 4. sf_writes_audit for those tokens OR any WOLI/WO record whose id
  //    starts with the WO's 15-char prefix (SOQL Ids are 15 or 18 chars
  //    — the 15-char prefix uniquely identifies the record). We also
  //    include audit rows targeting the WO itself (MaterialType__c
  //    writes go against WorkOrder).
  const tokenList = (tokens ?? []).map((t) => t.token).filter(Boolean);
  const prefix = woPrefix;
  const audit = await (async () => {
    const rows: unknown[] = [];
    if (tokenList.length > 0) {
      const { data: byToken } = await sb
        .from("sf_writes_audit")
        .select("*")
        .in("triggered_by_token", tokenList)
        .limit(100);
      if (byToken) rows.push(...byToken);
    }
    // Also include rows that hit the WO Id directly (e.g. WO-level
    // MaterialType__c writes) in case the token linkage is missing.
    const { data: byRecord } = await sb
      .from("sf_writes_audit")
      .select("*")
      .like("sf_record_id", `${prefix}%`)
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

  // Analyze submitted payloads — for tokens that have submitted_at set but
  // no audit rows, this tells us WHY writes weren't fired. attempts is
  // built from surfaces whose s.colorId is truthy AND whose surface name
  // maps to a known SF field. If every surface has colorId === null, the
  // attempts array is empty and the submit path skips the write with no
  // audit row (silent skip).
  const tokenRows = tokens as Array<Record<string, unknown>>;
  type PayloadSurface = { surface?: unknown; colorId?: unknown; skipped?: unknown };
  type PayloadLine = { id?: unknown; surfaces?: PayloadSurface[] };
  const payloadSummary = tokenRows
    .filter((t) => t.submitted_at || t.resubmitted_at)
    .slice(0, 5)
    .map((t) => {
      // Try every reasonable column name so we find the payload wherever
      // it's actually stored (schema might be submitted_payload, payload,
      // submission, submission_payload, etc.).
      const payloadRaw =
        t.submitted_payload ??
        t.payload ??
        t.submission_payload ??
        t.submission ??
        t.resubmitted_payload ??
        null;
      const p = payloadRaw as {
        lineItems?: PayloadLine[];
        globalNotes?: string;
        materialType?: string | null;
        deliveryAddress?: unknown;
      } | null;
      const lineItems = Array.isArray(p?.lineItems) ? p!.lineItems : [];
      let totalSurfaces = 0;
      let withColorId = 0;
      let withColorIdAndFinish = 0;
      let skippedFlag = 0;
      // A surface produces an SF write if it's a standard surface OR an orphan
      // (orphans route to ColorOther__c / ColorNotes__c — Kate 2026-07-09).
      // Shared classifier keeps this diagnostic in lockstep with the submit
      // route's actual mapping so orphan-only WOLIs don't false-flag as empty.
      let knownSurfaces = 0;
      for (const li of lineItems) {
        const surfaces = Array.isArray(li.surfaces) ? li.surfaces : [];
        for (const s of surfaces) {
          totalSurfaces++;
          const sname = typeof s?.surface === "string" ? s.surface : "";
          if (sname && classifySurface(sname).kind !== "unknown") knownSurfaces++;
          if (s?.colorId) withColorId++;
          if (s?.colorId && (s as { finish?: string }).finish) withColorIdAndFinish++;
          if (s?.skipped) skippedFlag++;
        }
      }
      const globalNotesLen = typeof p?.globalNotes === "string" ? p.globalNotes.length : 0;
      const materialType = typeof p?.materialType === "string" ? p.materialType : null;
      return {
        token: ((t.token as string) ?? "").slice(0, 12) + "…",
        kind: (t.kind as string | null) ?? null,
        submitted_at: (t.submitted_at as string | null) ?? null,
        resubmitted_at: (t.resubmitted_at as string | null) ?? null,
        payload_column_used:
          t.submitted_payload !== undefined
            ? "submitted_payload"
            : t.payload !== undefined
            ? "payload"
            : t.submission_payload !== undefined
            ? "submission_payload"
            : t.submission !== undefined
            ? "submission"
            : t.resubmitted_payload !== undefined
            ? "resubmitted_payload"
            : "NONE_FOUND",
        line_items_count: lineItems.length,
        total_surfaces: totalSurfaces,
        surfaces_with_colorId: withColorId,
        surfaces_with_colorId_and_finish: withColorIdAndFinish,
        surfaces_marked_skipped: skippedFlag,
        surfaces_with_known_field_name: knownSurfaces,
        global_notes_length: globalNotesLen,
        material_type: materialType,
        // Would attempts array be empty? Every WOLI update requires at
        // least one surface with a colorId AND a known-field mapping.
        would_produce_zero_attempts: withColorId === 0 || knownSurfaces === 0,
      };
    });

  const submittedTokens = tokenRows.filter((t) => t.submitted_at || t.resubmitted_at);
  const allPayloadsEmpty = payloadSummary.length > 0 && payloadSummary.every((s) => s.would_produce_zero_attempts);

  let verdict: string;
  if (mode === "off") {
    verdict = "❌ MODE IS OFF — writeback disabled globally. Flip to 'all' or 'test_only' on /dashboard/settings/writeback to re-enable.";
  } else if (mode === "test_only" && !onAllowlist) {
    verdict = `❌ WO NOT ON ALLOWLIST — mode is test_only and this specific WO ('${resolvedWoId}') isn't listed. The customer form saves the submission but skips SF. Either add this WO on /dashboard/settings/writeback OR flip mode to 'all'.`;
  } else if (submittedTokens.length > 0 && auditRows.length === 0 && allPayloadsEmpty) {
    const first = payloadSummary[0];
    verdict = `❌ CUSTOMER SUBMITTED BUT PAYLOAD IS EMPTY — ${submittedTokens.length} token(s) submitted for this WO, but every submission has zero surfaces with a valid colorId + known field mapping. That's why no SF writes fire (the submit route builds an empty attempts array and skips silently). Most recent submission: ${first.line_items_count} line item(s), ${first.total_surfaces} surface(s), ${first.surfaces_with_colorId} with colorId, ${first.surfaces_with_known_field_name} with a known field name (standard: walls/ceiling/trim/floor; orphan → Other/Notes: cabinets/accent wall/door/window/closet/shelves). Likely causes: (a) the customer picked colors in the UI but the form's JSON body isn't including colorId in each surface, (b) surface names in the payload aren't recognized by lib/customer-form/surface-mapping (neither standard nor orphan), or (c) the form UI regressed and stopped attaching color IDs. Inspect payload_summary[0] below + compare against the customer-form-view.tsx onSubmit builder.`;
  } else if (auditRows.length === 0) {
    verdict = `⚠ NO WRITE ATTEMPTS LOGGED — mode + allowlist look good (${mode}, on-allowlist=${onAllowlist}) but no SF writes have been attempted for this WO. Tokens submitted count: ${submittedTokens.length}. If that's 0 — customer never actually clicked submit. If >0 — the submit route bailed before reaching the write path. Read payload_summary[0] below to see what was actually submitted.`;
  } else if (recentSuccess) {
    verdict = `✅ RECENT SUCCESS — most recent write to this WO succeeded at ${recentSuccess.created_at}. If SF still shows nothing, check the specific field (e.g. ColorWall__c) via /api/admin/wo-debug?wo=<number>, or check SF field-level permissions (integration user might lack visibility on the specific field).`;
  } else if (recentFailure) {
    verdict = `❌ WRITES FAILING — most recent attempt failed with '${recentFailure.error_code ?? "UNKNOWN"}': ${recentFailure.error_message ?? "no message"}. Read the field_writes payload above to see what we tried to send. Fix the underlying SF permission/validation issue and re-test.`;
  } else {
    verdict = "⚠ UNEXPECTED STATE — see the raw data above.";
  }

  return NextResponse.json({
    wo_id: resolvedWoId,
    verdict,
    should_write: shouldWrite,
    token_lookup: tokenLookup,
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
    payload_summary: payloadSummary,
    diagnostic_crumbs: diagnosticCrumbs,
    sf_writes_audit: auditRows,
    // Katie 2026-07-08 round 8: sf_writes_audit is still empty
    // platform-wide even after SF reconnect + writeSf try/catch fix.
    // Something is still swallowing errors before logAudit(). Expose
    // the raw query error + row count so we can tell if the table is
    // (a) missing/wrong-name/RLS-blocked (would surface as error here)
    // or (b) really has never had a row inserted (would surface as
    // count 0 + no error). Also dump COUNT via head:true which uses
    // a different query path than .select("*").
    ...(await (async () => {
      const [full, headCount] = await Promise.all([
        sb.from("sf_writes_audit").select("*").limit(20),
        sb.from("sf_writes_audit").select("id", { count: "exact", head: true }),
      ]);
      return {
        sf_writes_audit_recent_all: full.data ?? [],
        sf_writes_audit_query_error: full.error ? {
          message: full.error.message,
          code: (full.error as { code?: string }).code ?? null,
          details: (full.error as { details?: string }).details ?? null,
          hint: (full.error as { hint?: string }).hint ?? null,
        } : null,
        sf_writes_audit_total_count: headCount.count ?? null,
        sf_writes_audit_count_error: headCount.error ? headCount.error.message : null,
      };
    })()),
  }, {
    // Pretty-print for easy admin reading. `no-store` defeats any edge
    // cache that would otherwise serve stale diagnostic results between
    // deploys — this endpoint is admin-only and never worth caching.
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
