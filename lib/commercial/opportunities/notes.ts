import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import {
  insertCommercialOppNoteAddedNotifications,
  insertCommercialNoteMentionNotifications,
} from "@/lib/notifications/commercial-events";

/**
 * Per-opportunity notes — free-form timeline entries with edit + delete.
 *
 * Edits are audit-logged via logUpdate so the full history of "what
 * the note said before" is queryable. Soft-delete via deleted_at so a
 * note can be "removed" without losing the audit trail.
 */

export type OpportunityNote = {
  id: string;
  opportunity_id: string;
  body: string;
  author_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Migration 037 — when the note was pinned to the top of the list. */
  pinned_at: string | null;
  /** Migration 037 — profile.user_id values @mentioned in body. */
  mentioned_user_ids: string[];
};

export type OpportunityNoteWithAuthor = OpportunityNote & {
  author_email: string | null;
  author_full_name: string | null;
};

/**
 * Parse @mentions from a note body. Matches both:
 *
 *   - `@email@domain.com`  (typed by hand or after autocomplete)
 *   - `@<user-uuid>`       (autocomplete-inserted token form)
 *
 * Returns the unique set of matches; resolution to user_ids happens
 * server-side via resolveMentionsToUserIds so a client can't forge an
 * arbitrary user_id by putting it in the body.
 */
function extractMentionTokens(body: string): string[] {
  if (!body) return [];
  const tokens = new Set<string>();
  // Match @email or @uuid. Stop at whitespace, end-of-string, or
  // common sentence punctuation.
  const re = /@([A-Za-z0-9._%+\-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    tokens.add(m[1].toLowerCase());
  }
  return Array.from(tokens);
}

/** Resolve @ tokens (email-or-uuid) to profile.user_id values,
 *  filtering inactive users + users without platform access. */
async function resolveMentionsToUserIds(
  tokens: string[]
): Promise<{ user_ids: string[]; resolved: Array<{ token: string; user_id: string; email: string; full_name: string | null }> }> {
  if (tokens.length === 0) return { user_ids: [], resolved: [] };
  const sb = commercialDb();
  const emails = tokens.filter((t) => t.includes("@"));
  const uuids = tokens.filter((t) => !t.includes("@"));
  const out: Array<{ token: string; user_id: string; email: string; full_name: string | null }> = [];
  if (emails.length > 0) {
    const { data } = await sb
      .from("profiles")
      .select("user_id, email, sf_user_name, is_active, has_new_platform_access")
      .in("email", emails);
    for (const r of (data ?? []) as Array<{
      user_id: string;
      email: string;
      sf_user_name: string | null;
      is_active: boolean | null;
      has_new_platform_access: boolean | null;
    }>) {
      if (r.is_active === false) continue;
      if (!r.has_new_platform_access) continue;
      out.push({ token: r.email.toLowerCase(), user_id: r.user_id, email: r.email, full_name: r.sf_user_name });
    }
  }
  if (uuids.length > 0) {
    const { data } = await sb
      .from("profiles")
      .select("user_id, email, sf_user_name, is_active, has_new_platform_access")
      .in("user_id", uuids);
    for (const r of (data ?? []) as Array<{
      user_id: string;
      email: string;
      sf_user_name: string | null;
      is_active: boolean | null;
      has_new_platform_access: boolean | null;
    }>) {
      if (r.is_active === false) continue;
      if (!r.has_new_platform_access) continue;
      out.push({ token: r.user_id, user_id: r.user_id, email: r.email, full_name: r.sf_user_name });
    }
  }
  const dedup = new Map<string, typeof out[number]>();
  for (const r of out) dedup.set(r.user_id, r);
  const merged = Array.from(dedup.values());
  return { user_ids: merged.map((r) => r.user_id), resolved: merged };
}

export { extractMentionTokens, resolveMentionsToUserIds };

/** Newest-first timeline for one opp, joined to profile for the author
 *  name (so the UI doesn't have to fan out per row).
 *
 *  Sort: pinned notes first (pinned_at DESC), then unpinned (created_at
 *  DESC). Stage-3 ordering — keeps "do not forget this" notes visible
 *  at the top of the list. Pinned notes are also visually badged in
 *  the UI. */
export async function listOpportunityNotes(
  opportunity_id: string
): Promise<OpportunityNoteWithAuthor[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_notes")
    .select(
      "*, author:profiles!commercial_opportunity_notes_author_user_id_fkey(email, sf_user_name)"
    )
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[commercial/opportunities/notes] list failed:", error.message);
    return [];
  }
  type Row = OpportunityNote & {
    author:
      | { email: string; sf_user_name: string | null }
      | Array<{ email: string; sf_user_name: string | null }>
      | null;
  };
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    opportunity_id: r.opportunity_id,
    body: r.body,
    author_user_id: r.author_user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
    pinned_at: r.pinned_at ?? null,
    mentioned_user_ids: Array.isArray(r.mentioned_user_ids) ? r.mentioned_user_ids : [],
    author_email: (() => {
      const a = Array.isArray(r.author) ? r.author[0] ?? null : r.author;
      return a?.email ?? null;
    })(),
    author_full_name: (() => {
      const a = Array.isArray(r.author) ? r.author[0] ?? null : r.author;
      return a?.sf_user_name ?? null;
    })(),
  }));
  // Pinned-first sort: pinned notes (any) before any unpinned. Within
  // each group, newest first. Stable across re-render so pin position
  // doesn't jump.
  return rows.sort((a, b) => {
    const aPinned = a.pinned_at !== null;
    const bPinned = b.pinned_at !== null;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (aPinned) {
      // both pinned — newest pin first
      return (b.pinned_at ?? "").localeCompare(a.pinned_at ?? "");
    }
    // both unpinned — newest created first
    return b.created_at.localeCompare(a.created_at);
  });
}

/** Bulk: last-note-at per opp for the list-row "Last note 3d ago"
 *  badge. Returns only opps that have at least one note. */
export async function listLastNoteByOpp(
  opportunity_ids: string[]
): Promise<Map<string, { created_at: string; author_label: string | null }>> {
  if (opportunity_ids.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_notes")
    .select(
      "opportunity_id, created_at, author:profiles!commercial_opportunity_notes_author_user_id_fkey(email, sf_user_name)"
    )
    .in("opportunity_id", opportunity_ids)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[commercial/opportunities/notes] listLastNoteByOpp:", error.message);
    return new Map();
  }
  type Row = {
    opportunity_id: string;
    created_at: string;
    author:
      | { email: string; sf_user_name: string | null }
      | Array<{ email: string; sf_user_name: string | null }>
      | null;
  };
  const out = new Map<string, { created_at: string; author_label: string | null }>();
  for (const raw of (data ?? []) as unknown as Row[]) {
    if (out.has(raw.opportunity_id)) continue; // only the most recent
    const a = Array.isArray(raw.author) ? raw.author[0] ?? null : raw.author;
    out.set(raw.opportunity_id, {
      created_at: raw.created_at,
      author_label: a?.sf_user_name ?? a?.email ?? null,
    });
  }
  return out;
}

export type AddOpportunityNoteInput = {
  opportunity_id: string;
  body: string;
  author_user_id?: string | null;
};

export async function addOpportunityNote(
  input: AddOpportunityNoteInput
): Promise<{ ok: true; note: OpportunityNote } | { ok: false; error: string }> {
  const body = input.body?.trim() ?? "";
  if (!body) return { ok: false, error: "Note body can't be empty." };
  // Hard cap so a runaway paste / API misuse can't fill the table.
  // 5000 chars = ~10 paragraphs, more than any real opp note needs.
  if (body.length > 5000) {
    return { ok: false, error: "Note is too long (max 5,000 characters)." };
  }

  const sb = commercialDb();
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || opp.deleted_at) return { ok: false, error: "Opportunity not found." };
  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", opp.account_id)
    .maybeSingle();
  if (!acct || acct.deleted_at) return { ok: false, error: "Account not found." };

  // Parse @mentions from the body + resolve to active user_ids
  // server-side. Doing it before the insert means the stored
  // mentioned_user_ids column matches what we'll actually notify on,
  // and a malicious client can't forge user_ids via the JSON payload
  // (they'd need to actually type the email/uuid in the body, which
  // gets re-resolved against profiles here).
  const tokens = extractMentionTokens(body);
  const { user_ids: mentionedUserIds, resolved: mentionedResolved } =
    tokens.length > 0
      ? await resolveMentionsToUserIds(tokens)
      : { user_ids: [], resolved: [] };

  const { data, error } = await sb
    .from("commercial_opportunity_notes")
    .insert({
      opportunity_id: input.opportunity_id,
      body,
      author_user_id: input.author_user_id ?? null,
      mentioned_user_ids: mentionedUserIds,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const note = data as OpportunityNote;
  await logInsert("commercial_opportunity_notes", note.id, note, input.author_user_id);

  // Fire-and-forget notification fanout. TWO branches:
  //   1. Per-user "you were mentioned" notification → personal copy,
  //      goes to each mentioned user (minus author self-skip).
  //   2. Team "new note" notification → fans out to every active team
  //      member on the opp EXCEPT (a) the author + (b) any user who
  //      already got the @mention version above. Stops the same person
  //      from getting two emails for one note.
  void (async () => {
    try {
      let actorName = "PPP admin";
      if (input.author_user_id) {
        const { data: actor } = await sb
          .from("profiles")
          .select("sf_user_name, email")
          .eq("user_id", input.author_user_id)
          .maybeSingle();
        const a = actor as { sf_user_name?: string | null; email?: string | null } | null;
        actorName = a?.sf_user_name || a?.email || "PPP admin";
      }
      const preview = body.length > 240 ? `${body.slice(0, 240).trimEnd()}…` : body;

      // Mentions go first so the helper has a chance to skip-self the
      // author cleanly. Author@mention-of-self is a no-op anyway.
      if (mentionedResolved.length > 0) {
        await insertCommercialNoteMentionNotifications({
          opportunityId: input.opportunity_id,
          noteId: note.id,
          oppTitle: (opp as { title: string }).title,
          noteBodyPreview: preview,
          actingUserId: input.author_user_id ?? null,
          actorName,
          mentionedUserIds: mentionedUserIds,
        });
      }

      // Team fanout — exclude already-notified mention recipients so
      // each user gets exactly one notification per note.
      await insertCommercialOppNoteAddedNotifications({
        opportunityId: input.opportunity_id,
        noteId: note.id,
        oppTitle: (opp as { title: string }).title,
        noteBodyPreview: preview,
        actingUserId: input.author_user_id ?? null,
        actorName,
        excludeUserIds: mentionedUserIds,
      });
    } catch (err) {
      console.warn(
        "[notes] note_added notify failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  })();
  return { ok: true, note };
}

/**
 * Toggle pinned_at on a note. Pinning sets pinned_at = now() so the
 * note jumps to the top of the per-opp list. Unpinning sets it back
 * to null. Returns the new pinned state.
 *
 * Authorization: anyone on the team can pin/unpin (per the Stage-3
 * scope — pinning is a low-stakes UX nudge, not a permissions
 * decision). The UI hides the button when the viewer isn't on the
 * team; this server function trusts the caller did that gating.
 */
export async function togglePinOpportunityNote(
  opportunity_id: string,
  note_id: string,
  acting_user_id?: string | null
): Promise<{ ok: true; pinned: boolean } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_notes")
    .select("*")
    .eq("id", note_id)
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Note not found." };
  const wasPinned = (before as { pinned_at: string | null }).pinned_at !== null;
  const nextPinned = wasPinned ? null : new Date().toISOString();
  const { data: after, error } = await sb
    .from("commercial_opportunity_notes")
    .update({ pinned_at: nextPinned })
    .eq("id", note_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_opportunity_notes", note_id, before, after, acting_user_id);
  return { ok: true, pinned: !wasPinned };
}

export async function editOpportunityNote(
  opportunity_id: string,
  note_id: string,
  body: string,
  acting_user_id?: string | null
): Promise<{ ok: true; note: OpportunityNote } | { ok: false; error: string }> {
  const trimmed = body?.trim() ?? "";
  if (!trimmed) return { ok: false, error: "Note body can't be empty." };
  if (trimmed.length > 5000) {
    return { ok: false, error: "Note is too long (max 5,000 characters)." };
  }

  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_notes")
    .select("*")
    .eq("id", note_id)
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Note not found." };
  // Author-only gate: any CC user could otherwise rewrite anyone else's
  // note. The UI hides the edit link for non-authors but a hand-crafted
  // POST would bypass that. Server-side enforcement closes the loop.
  if (
    acting_user_id &&
    (before as { author_user_id: string | null }).author_user_id &&
    (before as { author_user_id: string }).author_user_id !== acting_user_id
  ) {
    return { ok: false, error: "Only the note's author can edit it." };
  }
  const { data: after, error } = await sb
    .from("commercial_opportunity_notes")
    .update({ body: trimmed })
    .eq("id", note_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_opportunity_notes", note_id, before, after, acting_user_id);
  return { ok: true, note: after as OpportunityNote };
}

export async function deleteOpportunityNote(
  opportunity_id: string,
  note_id: string,
  acting_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_notes")
    .select("*")
    .eq("id", note_id)
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Note not found." };
  const { data: after, error } = await sb
    .from("commercial_opportunity_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", note_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_opportunity_notes", note_id, before, acting_user_id);
  void after;
  return { ok: true };
}
