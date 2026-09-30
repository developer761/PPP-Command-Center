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
  /** Stored once with `workspace_id IS NULL` and read by every workspace. */
  shared: boolean;
  /**
   * TRUE when this is a shared row that this workspace has replaced with its
   * own. Computed for the editor rather than stored: the loader's precedence
   * rule is what actually decides, and a screen that worked it out separately
   * could disagree with the bot about which answer is in use — the worst kind
   * of wrong, because the screen is what somebody checks.
   */
  overridden?: boolean;
};

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/** Same shape guard the loader uses, for the same `.or()` reason. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Shaped like an id before it goes into a filter STRING. See the same guard
  // and the reasoning in workspace-faq-db.ts.
  if (!UUID.test(workspaceId)) return { ok: false, error: "That is not a workspace id." };

  const sb = messagingDb();
  /**
   * BOTH TIERS, because a list showing only this workspace's rows would be a
   * lie about what the bot can answer. Most of what it knows will be shared,
   * and a screen that hides those makes somebody write a duplicate — which
   * the unique index then refuses for a reason they cannot see.
   */
  const { data, error } = await sb
    .from("sms_workspace_faqs")
    .select("id, question, answer, is_active, sort_order, workspace_id")
    .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
    .order("sort_order")
    .order("question");
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as {
    id: string; question: string; answer: string; is_active: boolean;
    sort_order: number; workspace_id: string | null;
  }[];

  // Which questions this workspace answers itself — the same normalisation the
  // loader uses, so "overridden" on the screen means what it means to the bot.
  const norm = (q: string) => q.trim().toLowerCase();
  // ACTIVE local rows only, because that is what the loader dedupes against
  // (workspace-faq-db.ts filters is_active BEFORE precedence). Built from all
  // local rows, this badge told somebody who had switched their own answer OFF
  // that the bot was still using it — when the bot had fallen back to the
  // shared one. The comment on `overridden` says this is computed centrally so
  // the screen cannot disagree with the bot; it disagreed anyway, because the
  // two functions filtered on different criteria.
  const ownQuestions = new Set(
    rows.filter((r) => r.workspace_id !== null && r.is_active).map((r) => norm(r.question))
  );

  return {
    ok: true,
    faqs: rows.map((r) => ({
      id: r.id, question: r.question, answer: r.answer,
      isActive: r.is_active, sortOrder: r.sort_order,
      shared: r.workspace_id === null,
      overridden: r.workspace_id === null && ownQuestions.has(norm(r.question)),
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
  /**
   * Save this once for EVERY workspace rather than for this one. The reason
   * the tier exists: "Are you insured?", EPA, warranty and payment terms are
   * company policy, identical in Nassau and Pasadena, and storing them per
   * workspace means writing the same sentence fifteen or thirty-two times and
   * editing it that many times when it changes.
   *
   * checkFaq refuses a location-bound question here — see isLocationBound.
   */
  shared?: boolean;
}): Promise<Result<{ id: string }>> {
  await assertMessagingAccess();
  if (!input.workspaceId) return { ok: false, error: "Pick a workspace first." };

  const question = input.question.trim();
  const answer = input.answer.trim();
  const sb = messagingDb();

  /**
   * ON AN EDIT, THE TIER COMES FROM THE DATABASE — NEVER FROM THE CALLER.
   *
   * The client hides the scope radio when editing and a comment there says
   * "an existing row keeps the tier it was saved in". That was the ONLY thing
   * enforcing it. This is a `"use server"` action, i.e. a POST endpoint that
   * accepts whatever arguments arrive, so the invariant lived entirely in the
   * browser. Two ways it broke:
   *
   *   shared: false on a shared row's id  → workspace_id becomes this
   *     workspace's, and thirty-one others silently lose the answer.
   *   shared: true on another row's id    → one workspace's private answer is
   *     promoted into every workspace's prompt.
   *
   * Neither needs an attacker — any second caller (a script, a bulk editor)
   * that edits a row without passing `shared` back does the first one.
   *
   * So an edit reads the row it is about to change, derives the tier from
   * what is stored, and never writes workspace_id at all.
   */
  let shared = input.shared === true;
  if (input.id) {
    const { data: existing, error: readErr } = await sb
      .from("sms_workspace_faqs")
      .select("workspace_id")
      .eq("id", input.id)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };
    /**
     * A MISSING ROW IS AN ERROR, NOT A SUCCESS.
     *
     * `.update().select().maybeSingle()` on an id that matches nothing returns
     * `{ data: null, error: null }`, so the old code fell through and told the
     * person "Saved. It reaches the bot within about five minutes." for a
     * write that never happened.
     */
    if (!existing) {
      return {
        ok: false,
        error: "That answer no longer exists — somebody may have deleted it. "
          + "Reload the page and add it again.",
      };
    }
    shared = (existing as { workspace_id: string | null }).workspace_id === null;
  }

  // The same check the loader runs, so what saves is what will be used — and
  // `shared` is passed, or the one check that only applies to shared rows
  // would never run on the path that creates them.
  const problem = problemSentence(checkFaq({ question, answer, shared }));
  if (problem) return { ok: false, error: problem };

  const row = {
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

  // workspace_id is written ONLY on insert — an update cannot move a tier.
  const res = input.id
    ? await sb.from("sms_workspace_faqs").update(row).eq("id", input.id).select("id").maybeSingle()
    : await sb.from("sms_workspace_faqs")
        .insert({ ...row, workspace_id: shared ? null : input.workspaceId })
        .select("id").maybeSingle();

  if (res.error) {
    // 23505 is unique_violation. The only unique index here is the one
    // question, so the message can say exactly what to do about it.
    if (res.error.code === "23505") {
      return {
        ok: false,
        error: shared
          // Caught by sms_workspace_faqs_one_shared_per_question, which exists
          // because the original index cannot see these: Postgres treats NULLs
          // as distinct, so (NULL, 'are you insured?') would insert twice.
          ? "There is already a shared answer for that question. Edit that one — or, if "
            + "this workspace needs to say something different, save it for this workspace "
            + "instead and it will override the shared answer."
          : "This workspace already has an answer for that question. "
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
