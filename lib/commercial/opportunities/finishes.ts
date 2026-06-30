import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logDelete, logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * Finish Schedule per opportunity. The "WD-1 = Penofin Verde Olive" codes
 * that appear on architect drawings + travel through to the submittal items
 * table + eventually feed Materials Ordering.
 *
 * Schema: commercial_opp_finishes (migration 041).
 *
 * Patterns matched from existing libs (lib/commercial/opportunities/notes.ts,
 * tasks.ts, attachments.ts):
 *   - "server-only" first import
 *   - commercialDb() singleton (service-role, bypasses RLS)
 *   - Discriminated result types { ok: true, ... } | { ok: false, error }
 *   - Chain-of-trust scoping: every mutation validates parent opp +
 *     parent account aren't soft-deleted before touching child rows
 *   - Double-scope on lookups before update/delete (eq id + eq opp_id)
 *   - Audit logging via logInsert/Update/Delete after successful write
 *   - No deleted_at on this table — hide via parent opp.deleted_at
 *     (pre-audit C5: matches notes/tasks/attachments convention)
 *
 * Position is sparse-gap-1000 (pre-audit S4) so drag-reorder doesn't need
 * to rewrite every row.
 */

export type OpportunityFinish = {
  id: string;
  opportunity_id: string;
  code: string;
  location_description: string | null;
  product_name: string | null;
  manufacturer: string | null;
  color: string | null;
  sheen: string | null;
  finish_type: string | null;
  notes: string | null;
  position: number;
  created_at: string;
  created_by_user_id: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
};

/**
 * List all finishes on an opp, ordered by position. Returns [] when:
 *   - opp doesn't exist
 *   - opp.deleted_at IS NOT NULL (parent-soft-delete guard, audit C5)
 *   - parent account is soft-deleted (defensive chain-of-trust)
 */
export async function listOpportunityFinishes(
  opportunity_id: string
): Promise<OpportunityFinish[]> {
  const sb = commercialDb();

  // Chain-of-trust: opp not deleted + account not deleted. Matches the
  // listOpportunityAttachments fix shipped 2026-06-24 (attachments.ts:69-79).
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  if (!opp) return [];
  const oppRow = opp as { id: string; account_id: string; deleted_at: string | null };
  if (oppRow.deleted_at) return [];

  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", oppRow.account_id)
    .maybeSingle();
  if (!acct || (acct as { deleted_at: string | null }).deleted_at) return [];

  const { data, error } = await sb
    .from("commercial_opp_finishes")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .order("position", { ascending: true });
  if (error) {
    console.warn("[commercial/opportunities/finishes] list failed:", error.message);
    return [];
  }
  return (data ?? []) as OpportunityFinish[];
}

/**
 * Bulk-fetch finish counts keyed by opp_id. For the opp list page badge
 * (e.g. "🎨 7 finishes"). Mirror of `listAttachmentCountByOpp` in
 * attachments.ts:98 — avoids N+1 on a 200-row opp list.
 *
 * Does NOT chain-of-trust the parent here because the caller already
 * filters out soft-deleted opps (they don't appear in the list).
 */
export async function listFinishCountByOpp(
  opportunity_ids: string[]
): Promise<Map<string, number>> {
  if (opportunity_ids.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opp_finishes")
    .select("opportunity_id")
    .in("opportunity_id", opportunity_ids);
  if (error) {
    console.warn("[commercial/opportunities/finishes] count failed:", error.message);
    return new Map();
  }
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { opportunity_id: string }[]) {
    out.set(row.opportunity_id, (out.get(row.opportunity_id) ?? 0) + 1);
  }
  return out;
}

// ────────────── add ──────────────

export type AddOpportunityFinishInput = {
  opportunity_id: string;
  code: string;                     // required; (opp_id, lower(code)) UNIQUE
  location_description?: string | null;
  product_name?: string | null;
  manufacturer?: string | null;
  color?: string | null;
  sheen?: string | null;
  finish_type?: string | null;
  notes?: string | null;
  position?: number | null;          // optional — lib computes MAX+1000 if null
  created_by_user_id?: string | null;
};

export async function addOpportunityFinish(
  input: AddOpportunityFinishInput
): Promise<{ ok: true; finish: OpportunityFinish } | { ok: false; error: string }> {
  const sb = commercialDb();

  const code = input.code?.trim();
  if (!code) return { ok: false, error: "Finish code is required." };

  // Chain-of-trust: opp + account not soft-deleted (security pattern from
  // 2026-06-24 cross-account scoping fix — every mutation must verify).
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp) return { ok: false, error: "Opportunity not found." };
  const oppRow = opp as { id: string; account_id: string; deleted_at: string | null };
  if (oppRow.deleted_at) return { ok: false, error: "Opportunity has been deleted." };

  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", oppRow.account_id)
    .maybeSingle();
  if (!acct || (acct as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "Account has been deleted." };
  }

  // Compute next position if not supplied — gap by 1000 for drag-reorder
  // (audit S4). MAX + 1000 keeps the list tail-sorted by insertion order.
  let nextPosition = input.position ?? null;
  if (nextPosition === null) {
    const { data: maxRow } = await sb
      .from("commercial_opp_finishes")
      .select("position")
      .eq("opportunity_id", input.opportunity_id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    nextPosition = ((maxRow as { position: number } | null)?.position ?? 0) + 1000;
  }

  const { data: inserted, error: insertErr } = await sb
    .from("commercial_opp_finishes")
    .insert({
      opportunity_id: input.opportunity_id,
      code,
      location_description: input.location_description ?? null,
      product_name: input.product_name ?? null,
      manufacturer: input.manufacturer ?? null,
      color: input.color ?? null,
      sheen: input.sheen ?? null,
      finish_type: input.finish_type ?? null,
      notes: input.notes ?? null,
      position: nextPosition,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();

  if (insertErr) {
    // 23505 = unique_violation. (opportunity_id, lower(code)) UNIQUE INDEX
    // means Alex typed a duplicate code. Surface a clear message.
    if ((insertErr as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: `Finish code "${code}" already exists on this opportunity. Pick a different code.`,
      };
    }
    return { ok: false, error: insertErr.message };
  }
  const row = inserted as OpportunityFinish;

  await logInsert("commercial_opp_finishes", row.id, row, input.created_by_user_id ?? null);
  return { ok: true, finish: row };
}

// ────────────── edit ──────────────

export type EditOpportunityFinishInput = {
  opportunity_id: string;             // double-scope guard
  finish_id: string;
  code?: string;                      // omit = no change
  location_description?: string | null;
  product_name?: string | null;
  manufacturer?: string | null;
  color?: string | null;
  sheen?: string | null;
  finish_type?: string | null;
  notes?: string | null;
  position?: number;
  updated_by_user_id?: string | null;
};

export async function editOpportunityFinish(
  input: EditOpportunityFinishInput
): Promise<{ ok: true; finish: OpportunityFinish } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Chain-of-trust + double-scope (pre-audit S5 + yesterday's cross-account fix):
  // lookup by id AND opportunity_id so a hand-crafted POST with a foreign
  // finish_id can't mutate a row on another opp.
  const { data: before } = await sb
    .from("commercial_opp_finishes")
    .select("*")
    .eq("id", input.finish_id)
    .eq("opportunity_id", input.opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Finish not found." };

  // Build the update payload — only include keys the caller passed.
  const patch: Record<string, unknown> = { updated_by_user_id: input.updated_by_user_id ?? null };
  if (input.code !== undefined) {
    const c = input.code.trim();
    if (!c) return { ok: false, error: "Finish code cannot be blank." };
    patch.code = c;
  }
  if (input.location_description !== undefined) patch.location_description = input.location_description;
  if (input.product_name !== undefined) patch.product_name = input.product_name;
  if (input.manufacturer !== undefined) patch.manufacturer = input.manufacturer;
  if (input.color !== undefined) patch.color = input.color;
  if (input.sheen !== undefined) patch.sheen = input.sheen;
  if (input.finish_type !== undefined) patch.finish_type = input.finish_type;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.position !== undefined) patch.position = input.position;

  const { data: after, error: updErr } = await sb
    .from("commercial_opp_finishes")
    .update(patch)
    .eq("id", input.finish_id)
    .eq("opportunity_id", input.opportunity_id)
    .select("*")
    .single();

  if (updErr) {
    if ((updErr as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: `Finish code "${patch.code}" already exists on this opportunity.`,
      };
    }
    return { ok: false, error: updErr.message };
  }
  const row = after as OpportunityFinish;

  await logUpdate(
    "commercial_opp_finishes",
    row.id,
    before,
    row,
    input.updated_by_user_id ?? null
  );
  return { ok: true, finish: row };
}

// ────────────── delete ──────────────

export async function deleteOpportunityFinish(
  opportunity_id: string,
  finish_id: string,
  deleted_by_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Double-scope lookup (same pattern as edit).
  const { data: before } = await sb
    .from("commercial_opp_finishes")
    .select("*")
    .eq("id", finish_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Finish not found." };

  const { error } = await sb
    .from("commercial_opp_finishes")
    .delete()
    .eq("id", finish_id)
    .eq("opportunity_id", opportunity_id);
  if (error) return { ok: false, error: error.message };

  await logDelete("commercial_opp_finishes", finish_id, before, deleted_by_user_id ?? null);
  return { ok: true };
}
