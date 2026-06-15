import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";

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
};

export type OpportunityNoteWithAuthor = OpportunityNote & {
  author_email: string | null;
  author_full_name: string | null;
};

/** Newest-first timeline for one opp, joined to profile for the author
 *  name (so the UI doesn't have to fan out per row). */
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
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const a = Array.isArray(r.author) ? r.author[0] ?? null : r.author;
    return {
      id: r.id,
      opportunity_id: r.opportunity_id,
      body: r.body,
      author_user_id: r.author_user_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      deleted_at: r.deleted_at,
      author_email: a?.email ?? null,
      author_full_name: a?.sf_user_name ?? null,
    };
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

  const sb = commercialDb();
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || opp.deleted_at) return { ok: false, error: "Opportunity not found." };
  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", opp.account_id)
    .maybeSingle();
  if (!acct || acct.deleted_at) return { ok: false, error: "Account not found." };

  const { data, error } = await sb
    .from("commercial_opportunity_notes")
    .insert({
      opportunity_id: input.opportunity_id,
      body,
      author_user_id: input.author_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const note = data as OpportunityNote;
  await logInsert("commercial_opportunity_notes", note.id, note, input.author_user_id);
  return { ok: true, note };
}

export async function editOpportunityNote(
  opportunity_id: string,
  note_id: string,
  body: string,
  acting_user_id?: string | null
): Promise<{ ok: true; note: OpportunityNote } | { ok: false; error: string }> {
  const trimmed = body?.trim() ?? "";
  if (!trimmed) return { ok: false, error: "Note body can't be empty." };

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
