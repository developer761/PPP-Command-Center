import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Connects the customer-form pipeline back into the dashboard. For a given
 * set of Work Order IDs, returns the most recent token's lifecycle state per
 * WO so the Materials Ordering page can show:
 *
 *   ✓ Submitted   — customer picked colors, ready for materials order
 *   👁 Opened     — customer clicked the link but hasn't submitted yet
 *   📨 Sent       — email delivered, no open yet
 *   ⏳ Expired    — token past its 30-day window
 *   —             — no form sent for this WO yet
 *
 * One row per WO (the MOST RECENT token, since admin can re-send). The
 * status is derived purely from the customer_form_tokens columns set during
 * the lifecycle (sent_at / opened_at / submitted_at / expires_at).
 */

export type FormStatus =
  | { status: "none"; woId: string }
  | { status: "sent"; woId: string; token: string; sentAt: string | null; formUrl: string }
  | { status: "opened"; woId: string; token: string; sentAt: string | null; openedAt: string; formUrl: string }
  | { status: "submitted"; woId: string; token: string; sentAt: string | null; openedAt: string | null; submittedAt: string; formUrl: string }
  | { status: "expired"; woId: string; token: string; sentAt: string | null; openedAt: string | null; expiredAt: string; formUrl: string };

type TokenRow = {
  token: string;
  work_order_id: string;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  expires_at: string;
  created_at: string;
};

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Look up form status for many WOs in a single query. Returns a Map keyed by
 * work_order_id so callers can do constant-time lookups while rendering.
 *
 * If no token exists for a WO, the entry IS added (with status: "none") so
 * UI loops can render a consistent default badge without an existence check.
 */
export async function getFormStatusByWO(workOrderIds: string[]): Promise<Map<string, FormStatus>> {
  const out = new Map<string, FormStatus>();
  if (workOrderIds.length === 0) return out;

  // Seed all-none defaults; any matched WO overrides.
  for (const id of workOrderIds) {
    out.set(id, { status: "none", woId: id });
  }

  const sb = adminClient();
  // Pull all tokens for these WOs, sorted newest-first so we can pick the
  // first hit per WO as the "current" token. PPP shouldn't have many tokens
  // per WO (1-2 typically; admin only re-sends on bounce or expiry).
  const { data, error } = await sb
    .from("customer_form_tokens")
    .select("token, work_order_id, sent_at, opened_at, submitted_at, expires_at, created_at")
    .in("work_order_id", workOrderIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[customer-form] getFormStatusByWO failed:", error.message);
    return out;
  }

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const seen = new Set<string>();
  const now = Date.now();

  for (const row of (data as TokenRow[]) ?? []) {
    if (seen.has(row.work_order_id)) continue; // only keep the most recent per WO
    seen.add(row.work_order_id);
    const formUrl = `${baseUrl}/select/${row.token}`;

    if (row.submitted_at) {
      out.set(row.work_order_id, {
        status: "submitted",
        woId: row.work_order_id,
        token: row.token,
        sentAt: row.sent_at,
        openedAt: row.opened_at,
        submittedAt: row.submitted_at,
        formUrl,
      });
      continue;
    }
    // Expired check — only the most recent token. If admin re-sends after
    // expiry, the newer row supersedes via `seen` dedupe above.
    const expiresMs = new Date(row.expires_at).getTime();
    if (!isNaN(expiresMs) && expiresMs < now) {
      out.set(row.work_order_id, {
        status: "expired",
        woId: row.work_order_id,
        token: row.token,
        sentAt: row.sent_at,
        openedAt: row.opened_at,
        expiredAt: row.expires_at,
        formUrl,
      });
      continue;
    }
    if (row.opened_at) {
      out.set(row.work_order_id, {
        status: "opened",
        woId: row.work_order_id,
        token: row.token,
        sentAt: row.sent_at,
        openedAt: row.opened_at,
        formUrl,
      });
      continue;
    }
    out.set(row.work_order_id, {
      status: "sent",
      woId: row.work_order_id,
      token: row.token,
      sentAt: row.sent_at,
      formUrl,
    });
  }

  return out;
}

/** Roll-up counts across all WOs — used for the page-level summary chip. */
export function summarizeStatuses(statuses: Iterable<FormStatus>): {
  none: number;
  sent: number;
  opened: number;
  submitted: number;
  expired: number;
  total: number;
} {
  const summary = { none: 0, sent: 0, opened: 0, submitted: 0, expired: 0, total: 0 };
  for (const s of statuses) {
    summary[s.status] += 1;
    summary.total += 1;
  }
  return summary;
}
