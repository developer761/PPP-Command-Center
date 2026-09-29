"use server";

/**
 * Applying a standing-answer import.
 *
 * ── ONLY ASYNC EXPORTS LIVE HERE ────────────────────────────────────────
 *
 * A "use server" module may export nothing but async functions. A plain const
 * or type here makes Next drop EVERY export in the module — which tsc cannot
 * see and only a production build catches. MAX_FAQ_IMPORT_ROWS and the types
 * live in faq-import.ts for that reason, the same split optout-import uses.
 *
 * ── THE PREVIEW IS RE-COMPUTED, NEVER TRUSTED ───────────────────────────
 *
 * The browser sends the FILE, not the rows to write. It would be shorter to
 * send the parsed rows the preview already produced, and it would mean the
 * checks that ran in the browser are the only ones that ever ran — a caller
 * posting straight to this action could write a price into every workspace's
 * prompt. So the text is parsed and checked again here, against the database
 * as it is now rather than as it was when the preview was drawn.
 */
import { assertMessagingAccess } from "./auth";
import { messagingDb } from "./db";
import { buildFaqImportPreview, toFaqRecords } from "./faq-import";
import { clearWorkspaceFaqCache } from "./workspace-faq-db";

/** What the screen needs to draw a preview: the workspaces and what is held. */
export async function faqImportContext(): Promise<{
  workspaces: { id: string; name: string }[];
  existing: { workspaceId: string | null; question: string }[];
}> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const [{ data: ws }, { data: faqs }] = await Promise.all([
    sb.from("sms_sub_accounts").select("id, name").order("name"),
    sb.from("sms_workspace_faqs").select("workspace_id, question"),
  ]);
  return {
    workspaces: (ws ?? []) as { id: string; name: string }[],
    existing: ((faqs ?? []) as { workspace_id: string | null; question: string }[])
      .map((f) => ({ workspaceId: f.workspace_id, question: f.question })),
  };
}

export async function applyFaqImport(text: string): Promise<
  | { ok: true; written: number; replaced: number; skipped: number }
  | { ok: false; error: string }
> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const [{ data: ws }, { data: faqs }] = await Promise.all([
    sb.from("sms_sub_accounts").select("id, name"),
    sb.from("sms_workspace_faqs").select("id, workspace_id, question"),
  ]);
  const workspaces = (ws ?? []) as { id: string; name: string }[];
  const existingRows = (faqs ?? []) as { id: string; workspace_id: string | null; question: string }[];

  // Re-parsed and re-checked here. See the note above.
  const preview = buildFaqImportPreview(text, {
    workspaces,
    existing: existingRows.map((f) => ({ workspaceId: f.workspace_id, question: f.question })),
  });
  const records = toFaqRecords(preview);
  if (!records.length) {
    return { ok: false, error: "Nothing in that file could be imported. The preview says why." };
  }

  /**
   * UPDATE WHERE IT EXISTS, INSERT WHERE IT DOES NOT.
   *
   * Not a delete-then-insert: that would drop every answer for a moment, and
   * the messaging cron runs every minute, so a conversation landing in that
   * window gets a bot with no standing answers and escalates a question it
   * could have answered. Not an upsert either — the unique index is on a
   * normalised EXPRESSION, `lower(btrim(question))`, and PostgREST's
   * on-conflict needs a named constraint, so a plain upsert would not match
   * "Are you insured?" against "are you insured ".
   */
  const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");
  const byKey = new Map(existingRows.map((r) => [`${r.workspace_id ?? ""}::${norm(r.question)}`, r.id]));

  const now = new Date().toISOString();
  const toInsert: { workspace_id: string | null; question: string; answer: string }[] = [];
  const toUpdate: { id: string; answer: string; question: string }[] = [];

  for (const r of records) {
    const id = byKey.get(`${r.workspaceId ?? ""}::${norm(r.question)}`);
    if (id) toUpdate.push({ id, answer: r.answer, question: r.question });
    else toInsert.push({ workspace_id: r.workspaceId, question: r.question, answer: r.answer });
  }

  if (toInsert.length) {
    const { error } = await sb.from("sms_workspace_faqs").insert(toInsert);
    if (error) return { ok: false, error: `Could not add the new answers: ${error.message}` };
  }
  for (const u of toUpdate) {
    const { error } = await sb.from("sms_workspace_faqs")
      .update({ question: u.question, answer: u.answer, updated_at: now })
      .eq("id", u.id);
    if (error) return { ok: false, error: `Could not update an existing answer: ${error.message}` };
  }

  /**
   * Clears every workspace's entry, which matters more here than anywhere:
   * one import can change what thirty-two workspaces say. It still only
   * reaches THIS server process — the cron that builds prompts holds its own
   * copy for up to five minutes. Known, logged in HATCH_PARITY_GAPS, and the
   * reason the screen says "within about five minutes" rather than "now".
   */
  clearWorkspaceFaqCache();

  return {
    ok: true,
    written: toInsert.length + toUpdate.length,
    replaced: toUpdate.length,
    skipped: preview.unusable,
  };
}
