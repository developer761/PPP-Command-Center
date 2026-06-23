import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import {
  addAccountNote,
  findAutoDebriefNoteForOpp,
  writeAccountNoteEnrichment,
} from "@/lib/commercial/account-notes";
import { getOrCreateCompetitor } from "@/lib/commercial/competitors";
import { OPPORTUNITY_LOSS_REASONS } from "@/lib/commercial/opportunities/db";

/**
 * Win/Loss Debrief — captures structured "what happened" data when an opp
 * closes (won/lost/no_bid). Designed as an ENHANCEMENT on top of the
 * existing detail-page status-change flow:
 *
 *   1. User flips opp to terminal state via the detail-page form. The
 *      existing `changeOpportunityStatus` writes the status + status_log
 *      row + bumps decided_at + clears/sets probability — that all stays.
 *   2. `postPlaceholderAutoNote` runs IMMEDIATELY after the status change
 *      (called from the same server action). Drops a minimal placeholder
 *      note on the linked account's timeline so the account history shows
 *      the closure even if the user skips the structured debrief.
 *   3. When the user submits the structured debrief (later, same form, or
 *      via the Debrief Needed banner), `writeDebrief` runs the atomic
 *      sequence: insert debrief row → resolve/create competitor → enrich
 *      the placeholder note → set opp.win_loss_debriefed_at.
 *   4. If the opp later flips OUT of terminal (reopened), the debrief row
 *      is PRESERVED (audit history) but win_loss_debriefed_at clears via
 *      `clearDebriefFlagOnReopen` so a future re-close requires a new
 *      debrief.
 *
 * Won deals only require competitor (optional even — you might've won
 * without a known competitor). Lost/no_bid require competitor + deciding
 * factor + at least one of lessons_learned or internal_notes.
 */

export type DebriefOutcome = "won" | "lost" | "no_bid";

export type WinLossDebrief = {
  id: string;
  opportunity_id: string;
  outcome: DebriefOutcome;
  competitor_id: string | null;
  deciding_factor: string | null;
  lessons_learned: string | null;
  internal_notes: string | null;
  debriefed_by_user_id: string | null;
  debriefed_at: string;
  status_log_id: string | null;
  created_at: string;
  updated_at: string;
};

export type WriteDebriefInput = {
  opportunityId: string;
  outcome: DebriefOutcome;
  /** Free-text competitor name; resolved to competitor_id via getOrCreateCompetitor.
   *  Pass null for won-without-competitor or no_bid cases. */
  competitorName?: string | null;
  /** Must match OPPORTUNITY_LOSS_REASONS. For won, this is "what sealed it"
   *  using the same enum (price = we beat them on price, etc). */
  decidingFactor?: string | null;
  lessonsLearned?: string | null;
  internalNotes?: string | null;
  /** FK to the status_log row that triggered this debrief. Lets the Timeline
   *  tab pair each debrief with the specific closure event. */
  statusLogId?: string | null;
  actorUserId: string | null;
};

/** Valid loss-reason values — defensively re-listed here so the type
 *  guard doesn't rely on `OPPORTUNITY_LOSS_REASONS` being an array of
 *  strings at runtime if it's a const-asserted readonly tuple. */
const VALID_DECIDING_FACTORS: ReadonlySet<string> = new Set(
  OPPORTUNITY_LOSS_REASONS as readonly string[]
);

/**
 * Post the initial placeholder auto-note immediately when an opp enters a
 * terminal state. Returns the note id so the caller can stash it for the
 * later enrichment update — but we also re-find it via
 * `findAutoDebriefNoteForOpp` so the writeDebrief flow doesn't need to
 * carry the id across HTTP boundaries.
 *
 * Idempotent — if a placeholder already exists for this opp (e.g. the
 * user reopened then re-closed without debriefing the first closure), we
 * post a NEW placeholder (each closure gets its own audit trail) rather
 * than reusing the old one.
 */
export async function postPlaceholderAutoNote(input: {
  opportunityId: string;
  outcome: DebriefOutcome;
  actorUserId: string | null;
}): Promise<{ ok: true; noteId: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title")
    .eq("id", input.opportunityId)
    .maybeSingle();
  if (!opp) return { ok: false, error: "Opportunity not found." };
  const o = opp as { id: string; account_id: string | null; title: string };
  if (!o.account_id) {
    // Orphan opp (no linked account) — skip the auto-note. Future
    // enhancement: stash + post retroactively when account gets linked.
    return { ok: false, error: "Opportunity has no linked account." };
  }
  const outcomeLabel = input.outcome.toUpperCase().replace("_", " ");
  const body = `[AUTO] Opportunity "${o.title}" — closed as ${outcomeLabel}. Debrief pending.`;
  const result = await addAccountNote({
    account_id: o.account_id,
    body,
    kind: "auto_debrief",
    source_opportunity_id: o.id,
    author_user_id: input.actorUserId,
  });
  if (!result.ok) return result;
  return { ok: true, noteId: result.note.id };
}

/**
 * Write the structured debrief + enrich the placeholder auto-note + set
 * the debriefed_at flag on the opp. Sequenced (not transactional) but
 * idempotent enough: a failure on step N leaves earlier steps in place,
 * the user can retry, and the duplicate-row guard on win_loss_debriefed_at
 * keeps the flag truthful.
 */
export async function writeDebrief(
  input: WriteDebriefInput
): Promise<{ ok: true; debrief: WinLossDebrief } | { ok: false; error: string }> {
  // Validate inputs.
  if (!["won", "lost", "no_bid"].includes(input.outcome)) {
    return { ok: false, error: `Invalid outcome: ${input.outcome}` };
  }
  if (input.decidingFactor && !VALID_DECIDING_FACTORS.has(input.decidingFactor)) {
    return { ok: false, error: `Invalid deciding factor: ${input.decidingFactor}` };
  }
  // Lost/no_bid require deciding_factor (the underlying status change
  // already enforces loss_reason at the lib level, but we re-enforce here
  // so a direct lib call can't bypass it).
  if ((input.outcome === "lost" || input.outcome === "no_bid") && !input.decidingFactor) {
    return { ok: false, error: "Deciding factor is required for lost/no_bid debriefs." };
  }

  const sb = commercialDb();

  // Confirm opp exists + is currently in the claimed terminal state.
  // Prevents a stale form from writing a "won" debrief on an opp that's
  // already been reopened.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title, current_status, win_loss_debriefed_at, deleted_at")
    .eq("id", input.opportunityId)
    .maybeSingle();
  if (!opp || (opp as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "Opportunity not found." };
  }
  const o = opp as {
    id: string;
    account_id: string | null;
    title: string;
    current_status: string;
    win_loss_debriefed_at: string | null;
  };
  if (o.current_status !== input.outcome) {
    return {
      ok: false,
      error: `Opportunity is currently "${o.current_status}", not "${input.outcome}". Status may have changed since you opened the debrief.`,
    };
  }

  // Resolve competitor (auto-create if a new name).
  let competitorId: string | null = null;
  if (input.competitorName?.trim()) {
    const result = await getOrCreateCompetitor(input.competitorName, input.actorUserId);
    if (!result.ok) return result;
    competitorId = result.competitor.id;
  }

  // Insert the debrief row.
  const { data: debriefInserted, error: debriefErr } = await sb
    .from("commercial_win_loss_debrief")
    .insert({
      opportunity_id: input.opportunityId,
      outcome: input.outcome,
      competitor_id: competitorId,
      deciding_factor: input.decidingFactor ?? null,
      lessons_learned: input.lessonsLearned?.trim() || null,
      internal_notes: input.internalNotes?.trim() || null,
      debriefed_by_user_id: input.actorUserId,
      status_log_id: input.statusLogId ?? null,
    })
    .select("*")
    .single();
  if (debriefErr) return { ok: false, error: debriefErr.message };
  const debrief = debriefInserted as WinLossDebrief;
  await logInsert("commercial_win_loss_debrief", debrief.id, debrief, input.actorUserId);

  // Set the debriefed_at flag so the amber "Debrief needed" banner disappears.
  const { error: flagErr } = await sb
    .from("commercial_opportunities")
    .update({ win_loss_debriefed_at: new Date().toISOString() })
    .eq("id", input.opportunityId);
  if (flagErr) {
    // Non-fatal: the debrief row exists; the banner will catch up on next
    // page load via a join query if necessary. Log but don't abort.
    console.warn("[debrief] failed to set win_loss_debriefed_at:", flagErr.message);
  }

  // Enrich the auto-note (if a placeholder exists). Best-effort.
  if (o.account_id) {
    const placeholderId = await findAutoDebriefNoteForOpp(input.opportunityId);
    const competitorLabel = competitorId
      ? input.competitorName?.trim() ?? "(competitor)"
      : null;
    const lessonsExcerpt = (input.lessonsLearned ?? "")
      .trim()
      .slice(0, 200);
    const outcomeLabel = input.outcome.toUpperCase().replace("_", " ");
    const enriched = buildEnrichedNoteBody({
      oppTitle: o.title,
      outcomeLabel,
      competitorLabel,
      decidingFactor: input.decidingFactor ?? null,
      lessonsExcerpt: lessonsExcerpt || null,
    });
    if (placeholderId) {
      await writeAccountNoteEnrichment(placeholderId, enriched, input.actorUserId);
    } else {
      // No placeholder (maybe the opp closed before this feature shipped,
      // or the placeholder was deleted). Post the enriched note fresh.
      await addAccountNote({
        account_id: o.account_id,
        body: enriched,
        kind: "auto_debrief",
        source_opportunity_id: input.opportunityId,
        author_user_id: input.actorUserId,
      });
    }
  }

  return { ok: true, debrief };
}

/** Build the enriched auto-note body. Extracted for testability. */
export function buildEnrichedNoteBody(input: {
  oppTitle: string;
  outcomeLabel: string;
  competitorLabel: string | null;
  decidingFactor: string | null;
  lessonsExcerpt: string | null;
}): string {
  const parts: string[] = [];
  parts.push(`[AUTO] Opportunity "${input.oppTitle}" — closed as ${input.outcomeLabel}`);
  if (input.competitorLabel) {
    parts[0] += ` to ${input.competitorLabel}`;
  }
  parts[0] += ".";
  if (input.decidingFactor) {
    parts.push(`Deciding factor: ${input.decidingFactor}.`);
  }
  if (input.lessonsExcerpt) {
    const trailing = input.lessonsExcerpt.length === 200 ? "…" : "";
    parts.push(`"${input.lessonsExcerpt}${trailing}"`);
  }
  return parts.join(" ");
}

/**
 * Called when an opp transitions OUT of a terminal state (reopen).
 * Clears the win_loss_debriefed_at flag so a future re-close requires a
 * new debrief. The historic debrief row is preserved.
 */
export async function clearDebriefFlagOnReopen(
  opportunityId: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("id, win_loss_debriefed_at")
    .eq("id", opportunityId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Opportunity not found." };
  if (!(before as { win_loss_debriefed_at: string | null }).win_loss_debriefed_at) {
    return { ok: true }; // already null, nothing to do
  }
  const { error } = await sb
    .from("commercial_opportunities")
    .update({ win_loss_debriefed_at: null })
    .eq("id", opportunityId);
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_opportunities",
    opportunityId,
    before,
    { ...(before as object), win_loss_debriefed_at: null },
    actorUserId
  );
  return { ok: true };
}

/** Fetch all debriefs for an opp (Timeline tab). Most recent first. */
export async function listDebriefsForOpp(opportunityId: string): Promise<
  Array<WinLossDebrief & { competitor_name: string | null }>
> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_win_loss_debrief")
    .select(`
      *,
      competitor:commercial_competitors!commercial_win_loss_debrief_competitor_id_fkey(name)
    `)
    .eq("opportunity_id", opportunityId)
    .order("debriefed_at", { ascending: false });
  type Row = WinLossDebrief & {
    competitor: { name: string | null } | Array<{ name: string | null }> | null;
  };
  return ((data as unknown as Row[]) ?? []).map((r) => {
    const c = Array.isArray(r.competitor) ? r.competitor[0] ?? null : r.competitor;
    return { ...r, competitor_name: c?.name ?? null };
  });
}

/** Helper for the amber "Debrief needed" banner — checks a single opp. */
export async function oppNeedsDebrief(opportunityId: string): Promise<boolean> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("current_status, win_loss_debriefed_at, deleted_at")
    .eq("id", opportunityId)
    .maybeSingle();
  if (!data) return false;
  const o = data as {
    current_status: string;
    win_loss_debriefed_at: string | null;
    deleted_at: string | null;
  };
  if (o.deleted_at) return false;
  if (!["won", "lost", "no_bid"].includes(o.current_status)) return false;
  return o.win_loss_debriefed_at === null;
}

/** Bulk count for the dashboard widget. */
export async function countOppsNeedingDebrief(): Promise<number> {
  const sb = commercialDb();
  const { count } = await sb
    .from("commercial_opportunities")
    .select("id", { count: "exact", head: true })
    .in("current_status", ["won", "lost", "no_bid"])
    .is("win_loss_debriefed_at", null)
    .is("deleted_at", null);
  return count ?? 0;
}
