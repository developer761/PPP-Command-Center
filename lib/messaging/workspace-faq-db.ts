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
export async function loadWorkspaceFaqs(
  sb: SupabaseClient, workspaceId: string
): Promise<WorkspaceFaq[]> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.faqs;

  let rows: { question: string; answer: string }[];
  try {
    rows = await selectAll<{ question: string; answer: string }>(
      (from, to) => sb.from("sms_workspace_faqs")
        .select("question, answer, sort_order, id")
        .eq("workspace_id", workspaceId).eq("is_active", true)
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

  const { usable } = usableFaqs(rows.map((r) => ({ question: r.question, answer: r.answer })));
  cache.set(workspaceId, { faqs: usable, at: Date.now() });
  return usable;
}
