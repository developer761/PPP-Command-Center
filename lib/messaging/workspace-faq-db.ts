/**
 * Loading a workspace's standing answers.
 *
 * Cached like the Class A rules and for the same reason: these change when
 * somebody edits them, which is rarely, and reading them on every agent turn
 * is a round trip for an answer that is the same all day.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./paging";
import { usableFaqs, type WorkspaceFaq } from "./workspace-faq";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { faqs: WorkspaceFaq[]; at: number }>();

/** For tests, and for the moment right after an edit. */
export function clearWorkspaceFaqCache(): void {
  cache.clear();
}

/**
 * Every active answer for one workspace, safest-first.
 *
 * A row that fails checkFaq is DROPPED here rather than at the prompt, so a
 * bad answer cannot reach a customer even if it reached the table — the table
 * is the thing a person edits, and the check at save time is advice until
 * something enforces it at read time too.
 */
/**
 * A WORKSPACE ID GOING INTO A FILTER STRING HAS TO BE SHAPED LIKE ONE.
 *
 * `.eq(col, value)` hands PostgREST a parameter. `.or("a.eq.x,b.is.null")`
 * hands it GRAMMAR, where a comma starts another condition. So the moment
 * this read became an `.or`, an id with a comma in it stopped being data:
 *
 *   workspaceId = "<a real uuid>,workspace_id.not.is.null"
 *   → or=(workspace_id.eq.<uuid>,workspace_id.not.is.null,workspace_id.is.null)
 *   → every row in the table, every workspace's answers in one prompt
 *
 * Both callers pass a UUID read from the database today, so nothing is
 * reachable right now. But this is called from `runSimTurn`, a server action
 * whose workspaceId comes from the browser — one refactor from being user
 * input, into the screen where replies are graded into training data.
 *
 * This repo has had this exact bug and written it up: lib/commercial/search.ts,
 * "A raw user search term interpolated into a PostgREST `.or(...)` string is a
 * bug" (Karan, 2026-07-27 audit). Same fix loadThread already uses in db.ts.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key the shared tier caches under. Not a UUID, so it cannot collide. */
const SHARED_KEY = "__shared__";

/**
 * The answers every workspace has, with no workspace chosen.
 *
 * For the sandbox's "Default settings", which has no workspace and therefore
 * used to load nothing. A shared row belongs to no workspace and applies to
 * all of them, so "no workspace" is the one case where the shared tier is the
 * whole truth rather than half of it.
 *
 * `.eq(..., null)` is not a thing in PostgREST — `.is` is — and this one takes
 * no interpolated value at all, which is the other half of why the `.or` above
 * needs a UUID guard and this does not.
 */
export async function loadSharedFaqs(sb: SupabaseClient): Promise<WorkspaceFaq[]> {
  const hit = cache.get(SHARED_KEY);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.faqs;

  let rows: { question: string; answer: string; sort_order: number }[];
  try {
    rows = await selectAll<{ question: string; answer: string; sort_order: number }>(
      (from, to) => sb.from("sms_workspace_faqs")
        .select("question, answer, sort_order, id")
        .is("workspace_id", null).eq("is_active", true)
        .order("sort_order").order("id").range(from, to),
      "sms_workspace_faqs"
    );
  } catch (e) {
    // Same direction as loadWorkspaceFaqs: additive, so a failure must not
    // cost the reply. See the long note in that catch.
    console.error(`[faq] could not read the shared standing answers: ${
      e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const { usable } = usableFaqs(
    rows.map((r) => ({ question: r.question, answer: r.answer, shared: true, sortOrder: r.sort_order }))
  );
  cache.set(SHARED_KEY, { faqs: usable, at: Date.now() });
  return usable;
}

export async function loadWorkspaceFaqs(
  sb: SupabaseClient, workspaceId: string
): Promise<WorkspaceFaq[]> {
  if (!UUID.test(workspaceId)) {
    // Not silent. "No answers" is indistinguishable from "this workspace has
    // none", which is the shape that has cost this project four bugs.
    console.error(
      `[faq] not a workspace UUID, so no standing answers were read: `
      + `${JSON.stringify(workspaceId)}`
    );
    return [];
  }

  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.faqs;

  let rows: {
    question: string; answer: string; workspace_id: string | null; sort_order: number;
  }[];
  try {
    /**
     * BOTH TIERS, OR THE SHARED ONE IS A TABLE NOBODY READS.
     *
     * This was `.eq("workspace_id", workspaceId)`, which is exactly right for
     * a table where every row names a workspace and exactly wrong the moment
     * one can be NULL — a shared row would be saved, listed in the editor,
     * and silently never reach a prompt. That is the failure this codebase
     * keeps producing: a thing built and not wired, where nothing errors and
     * the screen looks correct.
     *
     * `.or` rather than two queries so the paging stays one ordered sequence;
     * selectAll needs a stable unique order and (sort_order, id) is one
     * across both tiers.
     */
    rows = await selectAll<{
      question: string; answer: string; workspace_id: string | null; sort_order: number;
    }>(
      (from, to) => sb.from("sms_workspace_faqs")
        .select("question, answer, sort_order, id, workspace_id")
        .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
        .eq("is_active", true)
        .order("sort_order").order("id").range(from, to),
      "sms_workspace_faqs"
    );
  } catch (e) {
    /**
     * THE ONE READ IN THIS SYSTEM WHERE FAILING CLOSED IS THE WRONG DIRECTION.
     *
     * Everywhere else a read that fails must stop the send. Not this one, and
     * the reason is the shape of the harm: a standing answer is ADDITIVE.
     * Without one the bot behaves exactly as it did yesterday — it escalates
     * the question to a person. But this read sits on the per-turn hot path,
     * so unguarded a failure throws through draftReply and the customer gets
     * NO REPLY AT ALL. A missing nice-to-have would cost a conversation.
     *
     * It is also the deploy window. This code and its migration cannot land in
     * the same instant, and the messaging cron runs every minute, so between
     * the push and the migration every draft in production would fail.
     * Guarded, the order the two land in stops mattering.
     *
     * LOUDLY, and NOT CACHED. A quiet catch here is the "silent nothing" shape
     * that has cost this project four separate bugs — a report that looks
     * healthy over no work. Caching the failure would stretch a transient
     * error into five minutes of missing answers, so the next turn retries.
     */
    const msg = e instanceof Error ? e.message : String(e);
    if (/Could not find the table|PGRST205|does not exist/i.test(msg)) {
      console.warn(
        `[faq] sms_workspace_faqs is not in the database yet — no standing answers for `
        + `${workspaceId}, and the turn continues without them. Apply `
        + `supabase/migrations/20260927100000_workspace_faqs.sql.`
      );
    } else {
      console.error(`[faq] could not read the standing answers for ${workspaceId}: ${msg}`);
    }
    return [];
  }

  /**
   * THE WORKSPACE'S OWN ANSWER BEATS THE SHARED ONE.
   *
   * Without this a workspace that needs to say something different has no way
   * to: it would get both rows, the model would see two answers to the same
   * question, and which one it used would be its choice and invisible. That is
   * the same "two rows answering 'Are you insured?' differently" failure the
   * original unique index was written to prevent, arriving across tiers where
   * an index cannot see it.
   *
   * So an override is a ROW, not a deletion — the shared default stays intact
   * for every other workspace, and what this one does differently is visible
   * as a thing somebody wrote rather than as an absence.
   */
  /**
   * VALIDATE FIRST, THEN LET THE SURVIVORS COMPETE.
   *
   * The order matters and the wrong way round loses answers. Deduping first
   * means a local row WINS the question and is then dropped by checkFaq — so
   * a perfectly good shared answer, already loaded, is evicted by a row that
   * does not survive, and the workspace ends up with neither. The prompt has
   * no answer to a question somebody wrote an answer for, and the editor
   * still shows both rows sitting there.
   *
   * Interior whitespace is collapsed as well as trimmed. "Are  you insured?"
   * and "Are you insured?" are different strings to the unique index, so the
   * database permits both, and a match that only trims would treat them as
   * two questions and put both in the prompt — the "two rows disagreeing
   * forever" failure the index exists to prevent, arriving through the gap
   * between what Postgres normalises and what we do.
   */
  const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");
  const tier = (r: { workspace_id: string | null }) => r.workspace_id === null;

  const graded = rows.map((r) => ({
    question: r.question, answer: r.answer, shared: tier(r), sortOrder: r.sort_order,
  }));
  const { usable, rejected } = usableFaqs(graded);

  if (rejected.length) {
    /**
     * LOUDLY. This used to discard `rejected` into nothing.
     *
     * When the read-time net catches something it means a row reached the
     * table without passing the save-time check — SQL, a seed, a future
     * writer — and it is now silently missing from a prompt while the editor
     * still renders it as a normal active answer. Nobody would have a thread
     * to pull. A shared row vanishing this way is missing from every
     * workspace at once.
     */
    for (const r of rejected) {
      console.error(
        `[faq] dropped a${r.faq.shared ? " SHARED" : ""} standing answer before the prompt: `
        + `${JSON.stringify(r.faq.question)} — ${r.problems.map((p) => p.why).join("; ")}`
      );
    }
  }

  const byQuestion = new Map<string, (typeof usable)[number]>();
  // Local first, so a workspace's own answer takes the key. The shared row for
  // the same question then loses, which is the override.
  for (const f of [...usable.filter((f) => !f.shared), ...usable.filter((f) => f.shared)]) {
    const key = norm(f.question);
    if (!byQuestion.has(key)) byQuestion.set(key, f);
  }

  /**
   * sort_order is documented as "the order they appear in the prompt", and
   * building the map local-then-shared had quietly redefined it as "every
   * local row, then every shared one" — a shared row at 0 landing behind a
   * local row at 99. Precedence is already decided above, so sorting here
   * costs nothing and gives the column back its meaning.
   */
  const out = [...byQuestion.values()].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.question.localeCompare(b.question)
  );

  cache.set(workspaceId, { faqs: out, at: Date.now() });
  return out;
}
