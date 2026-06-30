import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logDelete, logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * Submittal items — the rows in the cover's "Copies / Date / # / Description"
 * table. Each item describes one piece of what's being transmitted:
 *   - "1 each, 1/12/26, Material Spec Sheets"
 *   - "3 each, 1/12/26, Drawdowns Samples and Stain Color Chart"
 *
 * Optionally references a finish code (WD-1, P-1) via TEXT field — NOT a
 * hard FK (pre-audit C6) because items often get logged off architect
 * drawings before the finish-schedule entry is created.
 *
 * Scoping pattern: every mutation takes opportunity_id AND submittal_id.
 * The lib looks up the submittal scoped to the opp, then the item scoped
 * to the submittal — defense in depth against hand-crafted POSTs (audit
 * S5 + mirror of 2026-06-24 cross-account fixes).
 *
 * No edits allowed on items once the parent submittal status is anything
 * other than 'draft' — would invalidate the GC's copy. Submitting a
 * correction means voiding + creating a revision.
 */

export type OpportunitySubmittalItem = {
  id: string;
  submittal_id: string;
  position: number;
  copies: number;
  item_date: string | null;
  item_number: string | null;
  description: string;
  finish_code: string | null;
  created_at: string;
  updated_at: string;
};

// Internal helper: validate that the submittal is on this opp AND in draft.
// All item mutations route through this. Returns the submittal status on
// success so callers can include it in error messages.
async function loadSubmittalForItemMutation(
  opportunity_id: string,
  submittal_id: string
): Promise<
  | { ok: true; submittal: { id: string; opportunity_id: string; status: string } }
  | { ok: false; error: string }
> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opp_submittals")
    .select("id, opportunity_id, status")
    .eq("id", submittal_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!data) return { ok: false, error: "Submittal not found." };
  const row = data as { id: string; opportunity_id: string; status: string };
  if (row.status !== "draft") {
    return {
      ok: false,
      error: `Submittal is ${row.status} — items can only change while in draft. Create a revision instead.`,
    };
  }
  return { ok: true, submittal: row };
}

// ─── Add ─────────────────────────────────────────────────────────────

export type AddSubmittalItemInput = {
  opportunity_id: string;
  submittal_id: string;
  description: string;
  copies?: number;          // default 1
  item_date?: string | null;
  item_number?: string | null;
  finish_code?: string | null;
  position?: number | null; // optional — lib computes MAX+1000 if null
  created_by_user_id?: string | null;
};

export async function addSubmittalItem(
  input: AddSubmittalItemInput
): Promise<{ ok: true; item: OpportunitySubmittalItem } | { ok: false; error: string }> {
  const sb = commercialDb();

  const description = input.description?.trim();
  if (!description) return { ok: false, error: "Description is required." };

  const guard = await loadSubmittalForItemMutation(input.opportunity_id, input.submittal_id);
  if (!guard.ok) return guard;

  const copies = input.copies ?? 1;
  if (!Number.isFinite(copies) || copies < 1) {
    return { ok: false, error: "Copies must be a positive number." };
  }

  // Compute next position (gap-1000 for drag-reorder — audit S4).
  let nextPosition = input.position ?? null;
  if (nextPosition === null) {
    const { data: maxRow } = await sb
      .from("commercial_opp_submittal_items")
      .select("position")
      .eq("submittal_id", input.submittal_id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    nextPosition = ((maxRow as { position: number } | null)?.position ?? 0) + 1000;
  }

  const { data: inserted, error: insertErr } = await sb
    .from("commercial_opp_submittal_items")
    .insert({
      submittal_id: input.submittal_id,
      position: nextPosition,
      copies,
      item_date: input.item_date ?? null,
      item_number: input.item_number?.trim() || null,
      description,
      finish_code: input.finish_code?.trim() || null,
    })
    .select("*")
    .single();
  if (insertErr) return { ok: false, error: insertErr.message };

  const row = inserted as OpportunitySubmittalItem;
  await logInsert(
    "commercial_opp_submittal_items",
    row.id,
    row,
    input.created_by_user_id ?? null
  );
  return { ok: true, item: row };
}

// ─── Edit ────────────────────────────────────────────────────────────

export type EditSubmittalItemInput = {
  opportunity_id: string;
  submittal_id: string;
  item_id: string;
  description?: string;
  copies?: number;
  item_date?: string | null;
  item_number?: string | null;
  finish_code?: string | null;
  position?: number;
  updated_by_user_id?: string | null;
};

export async function editSubmittalItem(
  input: EditSubmittalItemInput
): Promise<{ ok: true; item: OpportunitySubmittalItem } | { ok: false; error: string }> {
  const sb = commercialDb();

  const guard = await loadSubmittalForItemMutation(input.opportunity_id, input.submittal_id);
  if (!guard.ok) return guard;

  // Triple-scope: id + submittal_id (parent already scoped to opp via guard).
  const { data: before } = await sb
    .from("commercial_opp_submittal_items")
    .select("*")
    .eq("id", input.item_id)
    .eq("submittal_id", input.submittal_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Item not found." };

  const patch: Record<string, unknown> = {};
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (!d) return { ok: false, error: "Description cannot be blank." };
    patch.description = d;
  }
  if (input.copies !== undefined) {
    if (!Number.isFinite(input.copies) || input.copies < 1) {
      return { ok: false, error: "Copies must be a positive number." };
    }
    patch.copies = input.copies;
  }
  if (input.item_date !== undefined) patch.item_date = input.item_date;
  if (input.item_number !== undefined) patch.item_number = input.item_number?.trim() || null;
  if (input.finish_code !== undefined) patch.finish_code = input.finish_code?.trim() || null;
  if (input.position !== undefined) patch.position = input.position;

  if (Object.keys(patch).length === 0) {
    return { ok: true, item: before as OpportunitySubmittalItem }; // no-op
  }

  const { data: after, error: updErr } = await sb
    .from("commercial_opp_submittal_items")
    .update(patch)
    .eq("id", input.item_id)
    .eq("submittal_id", input.submittal_id)
    .select("*")
    .single();
  if (updErr) return { ok: false, error: updErr.message };

  await logUpdate(
    "commercial_opp_submittal_items",
    input.item_id,
    before,
    after,
    input.updated_by_user_id ?? null
  );
  return { ok: true, item: after as OpportunitySubmittalItem };
}

// ─── Delete ──────────────────────────────────────────────────────────

export async function deleteSubmittalItem(
  opportunity_id: string,
  submittal_id: string,
  item_id: string,
  deleted_by_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  const guard = await loadSubmittalForItemMutation(opportunity_id, submittal_id);
  if (!guard.ok) return guard;

  const { data: before } = await sb
    .from("commercial_opp_submittal_items")
    .select("*")
    .eq("id", item_id)
    .eq("submittal_id", submittal_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Item not found." };

  const { error } = await sb
    .from("commercial_opp_submittal_items")
    .delete()
    .eq("id", item_id)
    .eq("submittal_id", submittal_id);
  if (error) return { ok: false, error: error.message };

  await logDelete(
    "commercial_opp_submittal_items",
    item_id,
    before,
    deleted_by_user_id ?? null
  );
  return { ok: true };
}
