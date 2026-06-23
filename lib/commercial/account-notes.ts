import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";

/**
 * Per-account notes — sibling to lib/commercial/opportunities/notes.ts.
 *
 * Two kinds:
 *   - 'user'         — typed by a person via the account-detail notes tab
 *   - 'auto_debrief' — system-posted when a linked opp closed (won/lost/no_bid).
 *                      Source opp linked via source_opportunity_id so the UI
 *                      can render a "View opportunity" link, and so the
 *                      two-stage debrief flow can find + enrich the placeholder.
 *
 * @mentions parsing intentionally NOT wired here yet — auto-debrief notes
 * never @mention anyone (silent system post), and user-typed account notes
 * are a future enhancement. Keep this lean; mirror the opp-notes
 * @mention pattern only when actually needed.
 */

export type AccountNoteKind = "user" | "auto_debrief";

export type AccountNote = {
  id: string;
  account_id: string;
  body: string;
  kind: AccountNoteKind;
  source_opportunity_id: string | null;
  author_user_id: string | null;
  pinned_at: string | null;
  mentioned_user_ids: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type AccountNoteWithAuthor = AccountNote & {
  author_email: string | null;
  author_full_name: string | null;
  // For auto_debrief rows: the source opp's title for the "View opportunity" link.
  source_opportunity_title: string | null;
};

export type AddAccountNoteInput = {
  account_id: string;
  body: string;
  kind?: AccountNoteKind;
  source_opportunity_id?: string | null;
  author_user_id?: string | null;
};

/**
 * Add a note to an account's timeline. Validates account exists + not
 * soft-deleted. Audit-logged on success.
 *
 * Auto-debrief notes pass kind='auto_debrief' + source_opportunity_id so
 * the UI renders the slate-badge variant + the source-opp link.
 */
export async function addAccountNote(
  input: AddAccountNoteInput
): Promise<{ ok: true; note: AccountNote } | { ok: false; error: string }> {
  const body = input.body?.trim() ?? "";
  if (!body) return { ok: false, error: "Note body can't be empty." };
  if (body.length > 5000) {
    return { ok: false, error: "Note is too long (max 5,000 characters)." };
  }
  const kind: AccountNoteKind = input.kind ?? "user";

  const sb = commercialDb();
  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", input.account_id)
    .maybeSingle();
  if (!acct || (acct as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "Account not found." };
  }

  const { data, error } = await sb
    .from("commercial_account_notes")
    .insert({
      account_id: input.account_id,
      body,
      kind,
      source_opportunity_id: input.source_opportunity_id ?? null,
      author_user_id: input.author_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const note = data as AccountNote;
  await logInsert("commercial_account_notes", note.id, note, input.author_user_id);
  return { ok: true, note };
}

/**
 * Two-stage debrief flow helper — write a placeholder auto-note that gets
 * enriched later. Returns the note id so the caller can find+update it
 * when the user submits the structured debrief.
 *
 * Body format (placeholder): `[AUTO] Opportunity "<title>" — closed as <OUTCOME>. Debrief pending.`
 * Body format (enriched):    `[AUTO] Opportunity "<title>" — closed as <OUTCOME> to <competitor>. Deciding factor: <factor>. "<lessons excerpt>"`
 */
export async function writeAccountNoteEnrichment(
  noteId: string,
  newBody: string,
  authorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = newBody.trim();
  if (!body) return { ok: false, error: "Enrichment body can't be empty." };
  if (body.length > 5000) {
    return { ok: false, error: "Enrichment too long (max 5,000 chars)." };
  }
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_notes")
    .select("*")
    .eq("id", noteId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Note not found." };
  const { error } = await sb
    .from("commercial_account_notes")
    .update({ body })
    .eq("id", noteId);
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_account_notes", noteId, before, { ...(before as object), body }, authorUserId);
  return { ok: true };
}

/**
 * Soft-delete an account note. Auto-debrief notes are also soft-deletable
 * (admin cleanup) but the UI's auto-debrief renderer hides the delete
 * button — admins delete via the admin Settings hub instead if ever needed.
 */
export async function softDeleteAccountNote(
  noteId: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_notes")
    .select("*")
    .eq("id", noteId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Note not found." };
  const { error } = await sb
    .from("commercial_account_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", noteId);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_account_notes", noteId, before, actorUserId);
  return { ok: true };
}

/** List notes for an account (timeline view). Excludes soft-deleted by default. */
export async function listAccountNotes(
  accountId: string
): Promise<AccountNoteWithAuthor[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_notes")
    .select(`
      *,
      author:profiles!commercial_account_notes_author_user_id_fkey(email, sf_user_name),
      source_opp:commercial_opportunities!commercial_account_notes_source_opportunity_id_fkey(title)
    `)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return [];
  type Row = AccountNote & {
    author: { email: string | null; sf_user_name: string | null } | Array<{ email: string | null; sf_user_name: string | null }> | null;
    source_opp: { title: string | null } | Array<{ title: string | null }> | null;
  };
  return (data as unknown as Row[]).map((r) => {
    const a = Array.isArray(r.author) ? r.author[0] ?? null : r.author;
    const s = Array.isArray(r.source_opp) ? r.source_opp[0] ?? null : r.source_opp;
    return {
      ...r,
      author_email: a?.email ?? null,
      author_full_name: a?.sf_user_name ?? null,
      source_opportunity_title: s?.title ?? null,
    };
  });
}

/**
 * Find the auto-debrief placeholder note for a given opp (used by the
 * two-stage enrichment flow). Returns the note id or null.
 */
export async function findAutoDebriefNoteForOpp(
  opportunityId: string
): Promise<string | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_account_notes")
    .select("id")
    .eq("source_opportunity_id", opportunityId)
    .eq("kind", "auto_debrief")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
