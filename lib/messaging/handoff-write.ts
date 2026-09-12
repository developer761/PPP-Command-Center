"use server";

/**
 * Taking a conversation off the bot, and handing it back.
 *
 * TWO PEOPLE, ONE CONVERSATION. Claiming is a single UPDATE guarded on
 * owning_user_id IS NULL. Two people clicking at the same moment both send
 * that UPDATE; exactly one matches a row and the other matches none, decided
 * by the database rather than by a read-then-write in the app that would let
 * both through. The loser is told who won rather than being left looking at a
 * button that did nothing.
 *
 * NOBODY IS TIMED OUT. The draft queue expires a claim after two minutes
 * because a draft is a task. A conversation is not: if a person took it over,
 * the bot resuming on its own is the worst outcome this system can produce —
 * two voices answering one customer. A hold ends when somebody ends it, and
 * another admin can take it over deliberately, which is recorded.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isTakeoverReason, stateOnRelease, type TakeoverReason } from "./handoff";
import { queueTurnIfUnanswered } from "./turn-queue";

export type HandoffResult =
  | { ok: true; holder: string }
  | { ok: false; error: string; heldBy?: string };

async function displayName(userId: string): Promise<string> {
  const p = await getProfileByUserId(userId);
  return p?.sf_user_name?.trim() || p?.email || "Someone";
}

/**
 * Take a conversation off the bot.
 *
 * `force` is for taking one that somebody else is already holding — a separate
 * decision with a separate confirmation, never the fallback when the ordinary
 * claim loses its race.
 */
export async function claimConversation(input: {
  conversationId: string;
  reason: string;
  force?: boolean;
}): Promise<HandoffResult> {
  const userId = await assertMessagingAccess();

  if (!isTakeoverReason(input.reason)) {
    // The database CHECK would refuse this too, but a constraint violation
    // reaches the screen as a Postgres string. This says what to do instead.
    return { ok: false, error: "Pick why you are taking it over." };
  }
  const reason: TakeoverReason = input.reason;
  const me = await displayName(userId);
  const sb = messagingDb();

  const patch = {
    state: "human_active",
    owning_user_id: userId,
    owning_agent: me,
    takeover_reason: reason,
    takeover_at: new Date().toISOString(),
  };

  let q = sb.from("sms_conversations").update(patch)
    .eq("id", input.conversationId)
    // An ended conversation is not claimable at any time, forced or not.
    // Re-opening one is a different act than taking it over.
    .neq("state", "ended");
  if (!input.force) q = q.is("owning_user_id", null);

  const { data, error } = await q.select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (data) return { ok: true, holder: me };

  // The UPDATE matched nothing. Read why, so the message is the actual reason
  // rather than a generic failure.
  const { data: now } = await sb.from("sms_conversations")
    .select("state, owning_agent, owning_user_id")
    .eq("id", input.conversationId).maybeSingle();

  if (!now) return { ok: false, error: "That conversation no longer exists." };
  if (now.state === "ended") {
    return { ok: false, error: "That conversation has ended, so there is nothing to take over." };
  }
  if (now.owning_user_id === userId) {
    // Already ours — a double click, or two tabs. Not a failure.
    return { ok: true, holder: me };
  }
  return {
    ok: false,
    error: `${now.owning_agent ?? "Somebody"} took this one first.`,
    heldBy: now.owning_agent ?? undefined,
  };
}

/**
 * Hand it back to the bot.
 *
 * Guarded on the holder being you, so releasing is not a way to quietly undo
 * somebody else's takeover. takeover_reason and takeover_at survive on
 * purpose: they are the record that a human was needed here, which is what the
 * takeover rate counts. Clearing them would erase every escalation at the
 * moment it was dealt with.
 */
export async function releaseConversation(input: {
  conversationId: string;
}): Promise<HandoffResult> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();

  // Where it goes back to depends on whether the customer is owed a reply.
  const { data: last } = await sb.from("sms_messages")
    .select("direction")
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();

  const next = stateOnRelease((last?.direction as "inbound" | "outbound") ?? null);

  const { data, error } = await sb.from("sms_conversations")
    .update({ state: next, owning_user_id: null, owning_agent: null })
    .eq("id", input.conversationId)
    .eq("owning_user_id", userId)
    .select("id").maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (data) {
    // THE STALL THIS PREVENTS, again.
    //
    // A customer writing while somebody held the conversation had their turn
    // queued and then cancelled, because the bot stops while a person has it.
    // Handing it back put the conversation into ai_active — the state that
    // means the bot owes a reply — with nothing scheduled to write one. The
    // message was answered by nobody, ever, which is the exact failure the
    // draft queue already had to fix once.
    if (next === "ai_active") {
      await queueTurnIfUnanswered(sb, input.conversationId, null);
    }
    return { ok: true, holder: "" };
  }

  const { data: now } = await sb.from("sms_conversations")
    .select("owning_agent, owning_user_id").eq("id", input.conversationId).maybeSingle();
  if (!now) return { ok: false, error: "That conversation no longer exists." };
  if (!now.owning_user_id) return { ok: true, holder: "" }; // already handed back
  return {
    ok: false,
    error: `${now.owning_agent ?? "Somebody else"} is holding this one, so it is not yours to hand back.`,
    heldBy: now.owning_agent ?? undefined,
  };
}
