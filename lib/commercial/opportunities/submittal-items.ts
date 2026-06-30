import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logDelete, logInsert, logUpdate } from "@/lib/commercial/audit-log";
import { verifyOppEditable } from "./guards";

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

// Internal helper: validate the parent opp+account aren't soft-deleted,
// then validate the submittal is on this opp AND in draft.
//
// All item mutations route through this. Returns submittal status so
// callers can include it in error messages.
//
// Race-window note: the draft check happens here but the actual write
// happens in the caller, so a concurrent Send between the two could let
// an item land on a now-submitted package. Each mutation re-asserts
// `status='draft'` via a separate guard query at the WHERE-clause level
// after the write — see addSubmittalItem / editSubmittalItem /
// deleteSubmittalItem (audit data-integrity #2, 2026-06-30).
async function loadSubmittalForItemMutation(
  opportunity_id: string,
  submittal_id: string
): Promise<
  | { ok: true; submittal: { id: string; opportunity_id: string; status: string } }
  | { ok: false; error: string }
> {
  // Chain-of-trust on parent opp + account (audit follow-up).
  const oppGuard = await verifyOppEditable(opportunity_id);
  if (!oppGuard.ok) return { ok: false, error: oppGuard.error };

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

// Race-guard: confirm the parent submittal is STILL in draft. Called
// after item writes to detect the window where (1) we read status=draft,
// (2) another tab sent the submittal, (3) we wrote anyway. If the
// confirm returns false, the caller treats the write as void.
async function confirmSubmittalStillDraft(
  submittal_id: string
): Promise<boolean> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opp_submittals")
    .select("status")
    .eq("id", submittal_id)
    .maybeSingle();
  return (data as { status: string } | null)?.status === "draft";
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

  // Race-guard: if the submittal was sent in another tab between our
  // status check and the insert, roll back the insert. Otherwise we'd
  // dirty a sent package (audit data-integrity #2).
  if (!(await confirmSubmittalStillDraft(input.submittal_id))) {
    await sb.from("commercial_opp_submittal_items").delete().eq("id", row.id);
    return {
      ok: false,
      error: "Submittal was sent in another tab. Reload to see the latest.",
    };
  }

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

  // Double-scope: id + submittal_id (parent already scoped to opp via guard).
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

  // Race-guard: if a concurrent Send slipped in, the edit just dirtied
  // a sent package. Roll the row back to its pre-edit state.
  if (!(await confirmSubmittalStillDraft(input.submittal_id))) {
    await sb
      .from("commercial_opp_submittal_items")
      .update({
        description: (before as { description: string }).description,
        copies: (before as { copies: number }).copies,
        item_date: (before as { item_date: string | null }).item_date,
        item_number: (before as { item_number: string | null }).item_number,
        finish_code: (before as { finish_code: string | null }).finish_code,
        position: (before as { position: number }).position,
      })
      .eq("id", input.item_id);
    return {
      ok: false,
      error: "Submittal was sent in another tab. Reload to see the latest.",
    };
  }

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

  // Race-guard: if a concurrent Send slipped in, the delete just removed
  // a line from a sent package. Restore the row.
  if (!(await confirmSubmittalStillDraft(submittal_id))) {
    const beforeRow = before as {
      position: number;
      copies: number;
      item_date: string | null;
      item_number: string | null;
      description: string;
      finish_code: string | null;
    };
    await sb.from("commercial_opp_submittal_items").insert({
      id: item_id,
      submittal_id,
      position: beforeRow.position,
      copies: beforeRow.copies,
      item_date: beforeRow.item_date,
      item_number: beforeRow.item_number,
      description: beforeRow.description,
      finish_code: beforeRow.finish_code,
    });
    return {
      ok: false,
      error: "Submittal was sent in another tab. Reload to see the latest.",
    };
  }

  await logDelete(
    "commercial_opp_submittal_items",
    item_id,
    before,
    deleted_by_user_id ?? null
  );
  return { ok: true };
}
