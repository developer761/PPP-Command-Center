import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { FormStatus } from "@/lib/customer-form/wo-status";
import type { WoProgress } from "@/lib/wo-progress/types";
import { getJobCompletedAt } from "@/lib/wo-progress/completion";
import { buildAttribution } from "@/lib/wo-progress/attribution";
import { retainedPicksByLine, type RetainedPick } from "@/lib/customer-form/retained-picks";

/**
 * One-shot loader for the materials page's two auxiliary datasets:
 *   - form status per WO (from customer_form_tokens)
 *   - progress timeline per WO (from customer_form_tokens + supplier_orders)
 *
 * Previously these came from TWO separate Supabase helpers
 * (`getFormStatusByWO` + `getProgressByWO`) running in parallel via
 * Promise.all. They each opened a separate Supabase client + each made
 * their own queries (2-3 round-trips total). Speed-audit identified this
 * as ~300-600ms of avoidable latency on every materials page load.
 *
 * Consolidated path: one Supabase client + one query per source object
 * (tokens, orders) — 2 round-trips total instead of 3+. Builds both
 * output Maps from the same fetched rows.
 *
 * Falls back to empty Maps on any error so the page still renders.
 */

type TokenRow = {
  token: string;
  work_order_id: string;
  work_order_number: string | null;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  expires_at: string;
  created_at: string;
  kind?: string | null;
  /** Kate round-3 #02/#03 — the staffer behind an internal entry. */
  created_by_user_id?: string | null;
  /** R4.5 — the "Colors needed by" date the sender chose (migration 147). */
  color_deadline?: string | null;
};

type OrderRow = {
  work_order_id: string;
  supplier_account_id: string;
  supplier_name: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  delivered_at: string | null;
};

// Module-scope singleton. Speed audit 2026-06-24: previously a new
// Supabase client + connection pool was being instantiated on every
// `getMaterialsPageAuxData()` call (once per Materials page load + once
// per JobDetail page load = a lot of repeated client+pool setup).
// Same pattern coverage-config + sf-cache already use. Reusing the
// client also lets Supabase keep its internal HTTP/2 connection warm.
// Saves ~30-50ms per call on warm instances.
let _adminClient: ReturnType<typeof createClient> | null = null;
function adminClient() {
  if (_adminClient) return _adminClient;
  _adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return _adminClient;
}

/** Pick the max-non-null timestamp from a list. */
function pickMax(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (isNaN(t)) continue;
    if (best === null || t > best) { best = t; bestStr = v; }
  }
  return bestStr;
}
function pickMin(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  let bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (isNaN(t)) continue;
    if (best === null || t < best) { best = t; bestStr = v; }
  }
  return bestStr;
}

export type MaterialsPageAuxData = {
  formStatusByWO: Map<string, FormStatus>;
  progressByWO: Map<string, WoProgress>;
  /** R4.9/R4.10: WO id → (line item id → the customer's actual per-surface
   *  picks). Only populated when the caller asks — see `includeRetainedPicks`. */
  retainedPicksByWO: Map<string, Map<string, RetainedPick[]>>;
};

/** Optional per-WO Salesforce metadata. When provided, the progress builder
 *  uses it to stamp `jobCompletedAt` from the WO's Status + CloseDate so the
 *  Job Complete stage of the progress bar can advance automatically (no
 *  manual admin action). When omitted, jobCompletedAt stays null. */
export type WorkOrderCompletionMeta = { status: string | null; closeDate: string | null };

export async function getMaterialsPageAuxData(
  workOrderIds: string[],
  workOrderMeta?: Map<string, WorkOrderCompletionMeta>,
  opts: {
    /** Pull `submitted_payload` too. Off by default: it's a fat JSON column and
     *  the browse list asks for ~460 work orders at once, while the only screen
     *  that renders per-surface colours (Rooms & Colors) exists solely on the
     *  focused work-order page, which asks for one. */
    includeRetainedPicks?: boolean;
  } = {},
): Promise<MaterialsPageAuxData> {
  const formStatusByWO = new Map<string, FormStatus>();
  const progressByWO = new Map<string, WoProgress>();
  const retainedPicksByWO = new Map<string, Map<string, RetainedPick[]>>();
  if (workOrderIds.length === 0) return { formStatusByWO, progressByWO, retainedPicksByWO };

  // Seed all-defaults so callers can do constant-time lookups. When the caller
  // passed WO metadata, derive jobCompletedAt now so the bar reflects the SF
  // status on first render (no waiting for a separate request).
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  for (const id of workOrderIds) {
    formStatusByWO.set(id, { status: "none", woId: id });
    const meta = workOrderMeta?.get(id);
    progressByWO.set(id, {
      workOrderId: id,
      workOrderNumber: null,
      formSentAt: null,
      formOpenedAt: null,
      formSubmittedAt: null,
      supplierDraftedAt: null,
      supplierSentAt: null,
      supplierAcknowledgedAt: null,
      materialsDeliveredAt: null,
      jobCompletedAt: meta ? getJobCompletedAt(meta) : null,
    });
  }

  const sb = adminClient();

  // Pull both source tables in parallel — one shared Supabase client.
  // CRITICAL: include `kind` so we can skip kind='preview' rows below.
  // Admin Preview clicks must NOT count as real customer activity — the
  // progress timeline + form status surface both feed off this loop.
  // Audit 2026-06-07 (Karan caught a Preview click stamping "Customer
  // Opened" on WO 00303551's timeline).
  const [tokensResult, ordersResult] = await Promise.allSettled([
    sb
      .from("customer_form_tokens")
      // Kate round-3 #02/#03: created_by_user_id comes back too, so the bar and
      // the activity history can say WHO opened and submitted. Round 2 added the
      // attribution logic but only to the other loader, which is why the page
      // Kate tests kept reading "Customer Submitted".
      .select(
        "token, work_order_id, work_order_number, sent_at, opened_at, submitted_at, expires_at, created_at, kind, created_by_user_id, color_deadline" +
          (opts.includeRetainedPicks ? ", submitted_payload" : "")
      )
      .in("work_order_id", workOrderIds)
      // NO .neq("kind", "preview") HERE — it silently deleted the feature.
      //
      // `kind` is nullable with no default, and EVERY real customer invite is
      // written with kind = null. PostgREST turns .neq into `kind <> 'preview'`,
      // which evaluates to NULL for a NULL row — not TRUE — so every genuine
      // sent colour form was filtered out of this query. Measured against
      // production: 35 of 90 tokens invisible. The consequence was that after
      // sending a form the badge still read "not sent", the progress bar never
      // advanced, and Send Reminder never appeared — only internal-entry
      // tokens (kind='internal') survived, which is why the bug hid behind
      // every "the progress bar is stuck" report.
      //
      // Introduced 2026-06-29 (53658899) as a speed tweak: "push the preview
      // skip down to the DB". The JS guard it was meant to replace is still
      // in the loop below, so filtering in JS is both correct and sufficient.
      // If this is ever pushed down again it MUST be
      // .or("kind.is.null,kind.neq.preview") — the form used by
      // app/api/admin/sent/route.ts, which got this right.
      .order("created_at", { ascending: false }),
    sb
      .from("supplier_orders")
      .select("work_order_id, supplier_account_id, supplier_name, status, created_at, sent_at, acknowledged_at, delivered_at")
      .in("work_order_id", workOrderIds)
      .order("created_at", { ascending: true }),
  ]);

  // ── Token rows → form status + progress stages 1-3 ──
  if (tokensResult.status === "fulfilled" && !tokensResult.value.error) {
    const now = Date.now();

    // Kate #13: pick the MOST-ADVANCED token per WO, not just the newest.
    // Rows arrive newest-first; the old code kept the first-seen, so a
    // re-sent form (newer token, no submitted_at) shadowed an earlier
    // SUBMITTED token and the progress bar got stuck at "Sent". Rank by
    // stage (submitted > opened > sent) and let the newest win only on a
    // tie — so a real submission always beats a later blank re-send. An
    // EXPIRED unsubmitted token is demoted to 0 so it can't shadow a newer
    // valid re-send (which would wrongly show "expired" + a dead link).
    const tokenRank = (r: TokenRow): number => {
      if (r.submitted_at) return 3;
      const expMs = new Date(r.expires_at).getTime();
      if (!Number.isNaN(expMs) && expMs < now) return 0;
      if (r.opened_at) return 2;
      return 1;
    };
    const bestByWo = new Map<string, TokenRow>();
    for (const row of (tokensResult.value.data ?? []) as TokenRow[]) {
      // Skip preview tokens — admin test links, not real customer activity.
      if (row.kind === "preview") continue;
      const cur = bestByWo.get(row.work_order_id);
      // Strict > keeps the first-seen (newest) on ties, since rows are
      // ordered created_at DESC.
      if (!cur || tokenRank(row) > tokenRank(cur)) {
        bestByWo.set(row.work_order_id, row);
      }
    }

    // Kate round-3 #02/#03 — attribution from the SAME winning rows the
    // timestamps come from, via the shared helper both loaders use.
    const attribution = await buildAttribution(sb, bestByWo.values());

    for (const row of bestByWo.values()) {
      // R4.9/R4.10: the customer's picks as they entered them. `bestByWo` ranks
      // a submitted token above every other state, so when a WO has a
      // submission this row IS that submission.
      if (opts.includeRetainedPicks && row.submitted_at) {
        const picks = retainedPicksByLine(
          (row as { submitted_payload?: unknown }).submitted_payload
        );
        if (picks.size > 0) retainedPicksByWO.set(row.work_order_id, picks);
      }

      // Progress stages from this same row
      const progress = progressByWO.get(row.work_order_id);
      if (progress) {
        progress.workOrderNumber = row.work_order_number ?? progress.workOrderNumber;
        progress.formSentAt = row.sent_at;
        progress.formOpenedAt = row.opened_at;
        progress.formSubmittedAt = row.submitted_at;
        const who = attribution.get(row.work_order_id);
        if (who) Object.assign(progress, who);
      }

      // Form status — same shape getFormStatusByWO produced
      const formUrl = `${baseUrl}/select/${row.token}`;
      // R4.5 — carried on every state, not just the live ones: a sender wants to
      // check the date they set just as much after the customer submitted.
      // Sliced because the column may come back as a timestamp on some drivers.
      const colorDeadline = row.color_deadline ? String(row.color_deadline).slice(0, 10) : null;
      const expiresAt = row.expires_at ?? null;
      if (row.submitted_at) {
        formStatusByWO.set(row.work_order_id, {
          status: "submitted",
          woId: row.work_order_id,
          token: row.token,
          sentAt: row.sent_at,
          openedAt: row.opened_at,
          submittedAt: row.submitted_at,
          formUrl,
          colorDeadline,
          expiresAt,
        });
        continue;
      }
      const expiresMs = new Date(row.expires_at).getTime();
      if (!isNaN(expiresMs) && expiresMs < now) {
        formStatusByWO.set(row.work_order_id, {
          status: "expired",
          woId: row.work_order_id,
          token: row.token,
          sentAt: row.sent_at,
          openedAt: row.opened_at,
          expiredAt: row.expires_at,
          formUrl,
          colorDeadline,
          expiresAt,
        });
        continue;
      }
      if (row.opened_at) {
        formStatusByWO.set(row.work_order_id, {
          status: "opened",
          woId: row.work_order_id,
          token: row.token,
          sentAt: row.sent_at,
          openedAt: row.opened_at,
          formUrl,
          colorDeadline,
          expiresAt,
        });
        continue;
      }
      formStatusByWO.set(row.work_order_id, {
        status: "sent",
        woId: row.work_order_id,
        token: row.token,
        sentAt: row.sent_at,
        formUrl,
        colorDeadline,
        expiresAt,
      });
    }
  } else if (tokensResult.status === "rejected") {
    console.warn("[materials-aux] tokens query failed:", tokensResult.reason);
  }

  // ── Supplier orders → progress stages 4-6 + perSupplier sub-rows ──
  if (ordersResult.status === "fulfilled" && !ordersResult.value.error) {
    const byWO = new Map<string, OrderRow[]>();
    for (const r of (ordersResult.value.data ?? []) as OrderRow[]) {
      if (!byWO.has(r.work_order_id)) byWO.set(r.work_order_id, []);
      byWO.get(r.work_order_id)!.push(r);
    }
    for (const [woId, rows] of byWO) {
      const existing = progressByWO.get(woId);
      if (!existing) continue;
      existing.supplierDraftedAt = pickMin(rows.map((r) => r.created_at));
      existing.supplierSentAt = pickMin(rows.map((r) => r.sent_at));
      const allAcked = rows.length > 0 && rows.every((r) => r.acknowledged_at);
      existing.supplierAcknowledgedAt = allAcked ? pickMax(rows.map((r) => r.acknowledged_at)) : null;
      const allDelivered = rows.length > 0 && rows.every((r) => r.delivered_at);
      existing.materialsDeliveredAt = allDelivered ? pickMax(rows.map((r) => r.delivered_at)) : null;
      if (rows.length > 0) {
        existing.perSupplier = rows.map((r) => ({
          supplierAccountId: r.supplier_account_id,
          supplierName: r.supplier_name,
          draftedAt: r.created_at,
          sentAt: r.sent_at,
          acknowledgedAt: r.acknowledged_at,
          deliveredAt: r.delivered_at,
        }));
      }
    }
  } else if (ordersResult.status === "rejected") {
    console.warn("[materials-aux] supplier_orders query failed:", ordersResult.reason);
  }

  return { formStatusByWO, progressByWO, retainedPicksByWO };
}
