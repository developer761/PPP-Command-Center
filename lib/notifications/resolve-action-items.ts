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

/**
 * Everything on the Action Needed bar that a proposal can raise — for when the
 * DEAL ITSELF is gone.
 *
 * `PROPOSAL_ACTION_KINDS` above is "superseded by sending", and it excludes
 * `signed` on purpose: sending a proposal does not discharge a countersignature
 * duty, so that to-do must survive a send.
 *
 * Deleting the deal is a different question with a different answer. There is
 * nothing left to countersign. Excluding `signed` there left
 * "A GC signed — waiting on our signature" sitting on the bar pointing at a
 * proposal on a deleted deal — which is precisely the bug this whole module
 * exists to prevent, reintroduced by reusing one list for two situations.
 *
 * It is not caught by `retireNotificationsFor` either: that anchors on the
 * FINAL path segment, and a proposal deep-link ends with the PROPOSAL id, not
 * the deal's. That anchoring is itself deliberate — without it, deleting an
 * ACCOUNT marked read every live approval request underneath it.
 *
 * No `commercial_proposal_signed` rows exist yet (nobody has e-signed), so
 * this is latent. The kind is emitted, so it stops being latent the first time
 * a GC signs.
 */
export const PROPOSAL_ACTION_KINDS_ON_DELETE = [
  ...PROPOSAL_ACTION_KINDS,
  "commercial_proposal_signed",
] as const;
