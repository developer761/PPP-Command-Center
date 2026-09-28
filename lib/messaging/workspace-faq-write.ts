"use server";

/**
 * Editing a workspace's standing answers. Hatch parity gap 9, the other half.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * The table, the loader, the safety check and the prompt wiring all shipped
 * and all work. Nothing could put a row in. `sms_workspace_faqs` held zero
 * rows, and the only way to add one was SQL — so the feature was complete and
 * unusable, and could not be exercised in the sandbox either, because there
 * was nothing to exercise.
 *
 * A capability with no door is the same bug this codebase keeps producing at
 * the code level — a rule written and never wired — one storey up.
 *
 * ── THESE SENTENCES REACH A CUSTOMER ────────────────────────────────────
 *
 * Every answer here may be put in front of the model and repeated to somebody
 * as PPP's own word. So checkFaq runs HERE at save time as well as in the
 * loader at read time. Not belt and braces: the loader drops a bad row
 * silently, which is right for a prompt build and useless to the person
 * typing, who needs to be told why their answer will not be used.
 */
import { assertMessagingAccess } from "./auth";
import { messagingDb } from "./db";
import { checkFaq, type FaqProblem } from "./workspace-faq";
import { clearWorkspaceFaqCache } from "./workspace-faq-db";

export type EditableFaq = {
  id: string;
  question: string;
  answer: string;
  isActive: boolean;
  sortOrder: number;
};

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Every row a workspace holds, ACTIVE OR NOT, uncached.
 *
 * loadWorkspaceFaqs is the wrong read for an editor twice over: it selects
 * only active rows and it serves a five-minute cache, so a row you just
 * switched off would still be listed and a row you just added would not.
 */
export async function listWorkspaceFaqs(
  workspaceId: string
): Promise<Result<{ faqs: EditableFaq[] }>> {
  await assertMessagingAccess();
  if (!workspaceId) return { ok: false, error: "Pick a workspace first." };

  const sb = messagingDb();
  const { data, error } = await sb
    .from("sms_workspace_faqs")
    .select("id, question, answer, is_active, sort_order")
    .eq("workspace_id", workspaceId)
    .order("sort_order")
    .order("question");
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as {
    id: string; question: string; answer: string; is_active: boolean; sort_order: number;
  }[];
  return {
    ok: true,
    faqs: rows.map((r) => ({
      id: r.id, question: r.question, answer: r.answer,
      isActive: r.is_active, sortOrder: r.sort_order,
    })),
  };
}

/** The problems in plain sentences, or null when there are none. */
function problemSentence(problems: FaqProblem[]): string | null {
  if (!problems.length) return null;
  return problems.map((p) => `The ${p.field} cannot be saved: ${p.why}.`).join(" ");
}

/**
 * Add a new answer, or replace one that exists.
 *
 * The unique index is (workspace_id, lower(btrim(question))) — one answer per
 * question, so two rows cannot disagree about whether we are insured. A
 * collision is a person's mistake rather than a system failure, so it comes
 * back as a sentence naming what happened instead of a Postgres error.
 */
export async function saveWorkspaceFaq(input: {
  id?: string;
  workspaceId: string;
  question: string;
  answer: string;
  sortOrder?: number;
}): Promise<Result<{ id: string }>> {
  await assertMessagingAccess();
  if (!input.workspaceId) return { ok: false, error: "Pick a workspace first." };

  const question = input.question.trim();
  const answer = input.answer.trim();

  // The same check the loader runs, so what saves is what will be used.
  const problem = problemSentence(checkFaq({ question, answer }));
  if (problem) return { ok: false, error: problem };

  const sb = messagingDb();
  const row = {
    workspace_id: input.workspaceId,
    question,
    answer,
    sort_order: input.sortOrder ?? 0,
    updated_at: new Date().toISOString(),
    /**
     * NO updated_by, DELIBERATELY. The other messaging write files record one
     * and this table has no such column — writing it fails at runtime with a
     * Postgres "column does not exist", which tsc cannot see because the
     * Supabase row types are loose here. Adding the column is a migration,
     * and this repo applies those by hand; it is worth doing for a table
     * whose rows are sentences the bot says as PPP, but it is a separate
     * change with a deploy step, not something to smuggle in here.
     */
  };

  const res = input.id
    ? await sb.from("sms_workspace_faqs").update(row).eq("id", input.id).select("id").maybeSingle()
    : await sb.from("sms_workspace_faqs").insert(row).select("id").maybeSingle();

  if (res.error) {
    // 23505 is unique_violation. The only unique index here is the one
    // question, so the message can say exactly what to do about it.
    if (res.error.code === "23505") {
      return {
        ok: false,
        error: "This workspace already has an answer for that question. "
          + "Edit the existing one rather than adding a second — two answers to the same "
          + "question disagree forever, because nothing compares them.",
      };
    }
    return { ok: false, error: res.error.message };
  }

  clearWorkspaceFaqCache();
  const id = (res.data as { id?: string } | null)?.id ?? input.id ?? "";
  return { ok: true, id };
}

/**
 * Switch an answer off without losing it.
 *
 * The column exists for the case where an answer turns out to be wrong: it
 * stops reaching the prompt immediately, and what it said is still readable.
 */
export async function setWorkspaceFaqActive(
  id: string, isActive: boolean
): Promise<Result> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { error } = await sb
    .from("sms_workspace_faqs")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  clearWorkspaceFaqCache();
  return { ok: true };
}

/** Remove one outright. Switching off is usually what somebody means. */
export async function deleteWorkspaceFaq(id: string): Promise<Result> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { error } = await sb.from("sms_workspace_faqs").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  clearWorkspaceFaqCache();
  return { ok: true };
}
