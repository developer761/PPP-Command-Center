import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WoProgress } from "@/lib/wo-progress/types";

/**
 * Who did what on a work order's colour form (Kate round-3 #02 + #03).
 *
 * THIS FILE EXISTS BECAUSE THE LOGIC DRIFTED ONCE ALREADY. Round-2 #04 asked
 * for AM attribution on the progress bar; it was implemented in
 * lib/wo-progress/derive.ts, which only feeds the Overview page. The materials
 * work-order page — the one Kate was actually looking at — loads through
 * lib/materials-page-data.ts, which never read the column. The bar kept saying
 * "Customer Submitted" and the fix looked done from the code but not from the
 * screen. Both loaders now call this, so there is one implementation.
 *
 * The rule: an INTERNAL token is PPP staff entering colours on the customer's
 * behalf, so every event on it belongs to that staffer. A normal token is the
 * customer's, so opens and submits are theirs even though a staffer sent it.
 */

export type AttributionTokenRow = {
  work_order_id: string;
  kind?: string | null;
  created_by_user_id?: string | null;
  opened_at?: string | null;
  submitted_at?: string | null;
};

export type Attribution = Pick<
  WoProgress,
  "entryMode" | "sentByName" | "openedByName" | "submittedByName"
>;

/** First name only ("Amy Mariano" → "Amy"), matching Katie's example. */
function firstName(full: string): string {
  const trimmed = full.trim();
  return trimmed.split(/\s+/)[0] || trimmed;
}

/**
 * Resolve display names for a set of user ids. Returns an empty map on any
 * failure — attribution is a nicety, never a reason to fail a page load.
 */
export async function resolveUserNames(
  sb: SupabaseClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data } = await sb
      .from("profiles")
      .select("user_id, sf_user_name, email")
      .in("user_id", ids);
    for (const p of (data ?? []) as Array<{ user_id: string; sf_user_name: string | null; email: string | null }>) {
      const full = (p.sf_user_name ?? "").trim() || (p.email ?? "").split("@")[0] || "";
      const name = firstName(full);
      if (name) out.set(p.user_id, name);
    }
  } catch (err) {
    console.warn("[wo-progress/attribution] name lookup failed:", err);
  }
  return out;
}

/**
 * Build per-WO attribution from the winning token row for each work order.
 *
 * `rows` should already be de-duplicated to one token per WO (the most
 * advanced one) — the same row the progress timestamps came from, so the
 * attribution can't describe a different token than the dates do.
 */
export async function buildAttribution(
  sb: SupabaseClient,
  rows: Iterable<AttributionTokenRow>
): Promise<Map<string, Attribution>> {
  const list = [...rows];
  const names = await resolveUserNames(
    sb,
    list.map((r) => r.created_by_user_id ?? "").filter(Boolean)
  );

  const out = new Map<string, Attribution>();
  for (const row of list) {
    const isInternal = row.kind === "internal";
    const staffName = row.created_by_user_id ? names.get(row.created_by_user_id) ?? null : null;
    out.set(row.work_order_id, {
      entryMode: isInternal ? "internal" : "customer",
      // Whoever created the token is PPP-side either way.
      sentByName: staffName,
      // On an internal token the staffer opened it; on a customer token the
      // customer did, and we deliberately return null rather than inventing a
      // name — the UI says "by the customer".
      openedByName: isInternal && row.opened_at ? staffName ?? "Internal entry" : null,
      submittedByName: isInternal && row.submitted_at ? staffName ?? "Internal entry" : null,
    });
  }
  return out;
}
