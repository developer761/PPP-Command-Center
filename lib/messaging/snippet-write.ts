"use server";

/**
 * Editing the snippet library, and listing it for one thread.
 *
 * The lesson this file exists because of: `sms_workspace_faqs` shipped with a
 * table, a loader, a safety check and prompt wiring — and no way to put a row
 * in. The feature was complete and unusable for two days. A capability with
 * no door is the same bug as a rule that is never wired, one storey up.
 */
import { assertMessagingAccess } from "./auth";
import { messagingDb } from "./db";
import { checkSnippet, type SnippetProblem } from "./snippets";
import { snippetsForConversation, type ReadySnippet } from "./snippet-db";

export type EditableSnippet = {
  id: string;
  name: string;
  body: string;
  isActive: boolean;
  sortOrder: number;
  shared: boolean;
  /** A shared snippet this workspace has replaced with its own. */
  overridden?: boolean;
  /**
   * Shown on the row. A saved reply is a sentence somebody wrote once and the
   * whole point is that it goes out fifty times without being rethought — so
   * "when was this last looked at" is the only thing standing between a price
   * from March and a customer in December.
   */
  updatedAt: string | null;
};

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a person answering this thread can drop in, already filled in. */
export async function listSnippetsFor(conversationId: string): Promise<ReadySnippet[]> {
  await assertMessagingAccess();
  return snippetsForConversation(messagingDb(), conversationId);
}

/** Every snippet a workspace sees, active or not, for the editor. */
export async function listSnippets(workspaceId: string): Promise<Result<{ snippets: EditableSnippet[] }>> {
  await assertMessagingAccess();
  if (!workspaceId) return { ok: false, error: "Pick a workspace first." };
  // Shaped like an id before it goes into a filter STRING — a comma in there
  // starts another condition. Same guard, same reason, as the standing answers.
  if (!UUID.test(workspaceId)) return { ok: false, error: "That is not a workspace id." };

  const sb = messagingDb();
  const { data, error } = await sb
    .from("sms_snippets")
    .select("id, name, body, is_active, sort_order, workspace_id, updated_at")
    .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
    .order("sort_order").order("name");
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as {
    id: string; name: string; body: string; is_active: boolean;
    sort_order: number; workspace_id: string | null; updated_at: string | null;
  }[];

  // ACTIVE local rows only, because that is what the resolver dedupes
  // against. Built from all of them, this badge would tell somebody who had
  // switched their own copy off that it was still the one in use.
  const norm = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");
  const own = new Set(
    rows.filter((r) => r.workspace_id !== null && r.is_active).map((r) => norm(r.name))
  );

  return {
    ok: true,
    snippets: rows.map((r) => ({
      id: r.id, name: r.name, body: r.body,
      isActive: r.is_active, sortOrder: r.sort_order,
      shared: r.workspace_id === null,
      overridden: r.workspace_id === null && own.has(norm(r.name)),
      updatedAt: r.updated_at,
    })),
  };
}

const sentence = (problems: SnippetProblem[]): string | null =>
  problems.length ? problems.map((p) => `This cannot be saved: ${p.why}.`).join(" ") : null;

export async function saveSnippet(input: {
  id?: string;
  workspaceId: string;
  name: string;
  body: string;
  sortOrder?: number;
  /** Save once for every workspace rather than for this one. */
  shared?: boolean;
}): Promise<Result<{ id: string }>> {
  await assertMessagingAccess();
  if (!input.workspaceId) return { ok: false, error: "Pick a workspace first." };
  if (!UUID.test(input.workspaceId)) return { ok: false, error: "That is not a workspace id." };

  /**
   * Inner whitespace collapsed as well as trimmed, so what is stored matches
   * what resolveSnippets treats as the same name. Without this, "Circling
   * Back" and "Circling  Back" save as two rows, appear as two buttons with
   * identical-looking labels, and the resolver silently shows one of them.
   * The unique index normalises the same way (migration 20260929180000) to
   * catch a row that arrives some other way.
   */
  const name = input.name.trim().replace(/\s+/g, " ");
  const body = input.body.trim();
  const sb = messagingDb();

  /**
   * ON AN EDIT, THE TIER COMES FROM THE DATABASE.
   *
   * This is a server action, so its arguments are whatever arrives over the
   * wire — the editor hiding a control enforces nothing. Without this, an
   * edit could demote a shared snippet to one workspace's (and every other
   * workspace silently loses it) or promote one workspace's into everybody's.
   */
  let shared = input.shared === true;
  if (input.id) {
    const { data: existing, error: readErr } = await sb
      .from("sms_snippets").select("workspace_id").eq("id", input.id).maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };
    // A missing row is an error, not a success: .update().select().maybeSingle()
    // returns {data: null, error: null} for an id that matches nothing, which
    // would otherwise be reported as "Saved".
    if (!existing) {
      return { ok: false, error: "That snippet no longer exists. Reload and add it again." };
    }
    shared = (existing as { workspace_id: string | null }).workspace_id === null;
  }

  const problem = sentence(checkSnippet({ name, body }));
  if (problem) return { ok: false, error: problem };

  const row = { name, body, sort_order: input.sortOrder ?? 0, updated_at: new Date().toISOString() };
  // workspace_id is written ONLY on insert — an update cannot move a tier.
  const res = input.id
    ? await sb.from("sms_snippets").update(row).eq("id", input.id).select("id").maybeSingle()
    : await sb.from("sms_snippets")
        .insert({ ...row, workspace_id: shared ? null : input.workspaceId })
        .select("id").maybeSingle();

  if (res.error) {
    if (res.error.code === "23505") {
      return {
        ok: false,
        error: shared
          ? "There is already a shared snippet with that name. Edit that one, or save this "
            + "for this workspace only and it will take precedence here."
          : "This workspace already has a snippet with that name.",
      };
    }
    return { ok: false, error: res.error.message };
  }
  return { ok: true, id: (res.data as { id?: string } | null)?.id ?? input.id ?? "" };
}

/** Switch one off without losing what it said. */
export async function setSnippetActive(id: string, isActive: boolean): Promise<Result> {
  await assertMessagingAccess();
  const { error } = await messagingDb()
    .from("sms_snippets")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function deleteSnippet(id: string): Promise<Result> {
  await assertMessagingAccess();
  const { error } = await messagingDb().from("sms_snippets").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
