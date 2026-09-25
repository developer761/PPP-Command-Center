import "server-only";
import { commercialDb } from "@/lib/commercial/db";

/**
 * Clear the "you need to do X" rows once X has been done.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The Action Needed bar is driven purely by UNREAD notifications of a few
 * actionable kinds. It never re-checks whether the thing still needs doing, so
 * a to-do only disappears when somebody presses "Seen".
 *
 * Walking the platform, the bar said "Approved: Proposal — ready to send" on a
 * proposal that had already been sent and then superseded by a revision. The
 * database showed exactly that: a `commercial_proposal_sent` row sitting
 * beside four unread `commercial_proposal_approved` rows for the same
 * proposal. The follow-on event fired and never cleared the to-do it resolved.
 *
 * A to-do list that cannot clear itself trains people to ignore it, and the
 * bar is the one place the platform gets to say "this one is yours".
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Resolving is marking READ, never deleting: the bell is a history, and the
 * event did happen. Only the bar treats unread-and-actionable as a task.
 *
 * Scoped by LINK, not by a source id. `dispatchCommercialNotification` takes a
 * `sourceId`, but the `notifications` table has no such column — it stores
 * id, recipient, kind, title, body, link, read_at — so the id goes nowhere.
 * The link IS the proposal's page and is identical across every row about it,
 * which makes it the only handle that actually exists.
 */
export async function resolveActionItems(input: {
  link: string;
  kinds: readonly string[];
}): Promise<{ resolved: number }> {
  if (!input.link || input.kinds.length === 0) return { resolved: 0 };
  const sb = commercialDb();
  const { data, error } = await sb
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("link", input.link)
    .in("kind", input.kinds as string[])
    .is("read_at", null)
    .select("id");
  // Read the error: supabase-js resolves on failure. A notification that fails
  // to clear is a stale to-do, not a broken send, so this never throws — but
  // it must not claim to have resolved rows it did not.
  if (error) {
    console.warn("[notifications] could not resolve action items:", error.message);
    return { resolved: 0 };
  }
  return { resolved: (data ?? []).length };
}

/**
 * The proposal to-dos that sending, winning or losing one makes obsolete.
 *
 * `commercial_proposal_signed` is NOT here: a signed contract waiting on our
 * countersignature stays somebody's job until it is countersigned, and that is
 * a different event.
 */
export const PROPOSAL_ACTION_KINDS = [
  "commercial_proposal_approval_requested",
  "commercial_proposal_changes_requested",
  "commercial_proposal_approved",
] as const;
