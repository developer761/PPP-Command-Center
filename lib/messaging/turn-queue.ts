/**
 * Making sure an unanswered customer still gets answered.
 *
 * Deliberately NOT a "use server" module. Every export in one of those is a
 * POST endpoint reachable by any signed-in user, and this queues work for the
 * agent without checking who asked. It is an internal helper that the actions
 * call after they have done their own authorization, so it must not become an
 * endpoint of its own.
 */
import type { messagingDb } from "./db";

/**
 * Queue another turn when the customer has said something we have not answered.
 *
 * THE STALL THIS PREVENTS. While a draft waits, any further message from the
 * customer queues an agent turn that is then cancelled — there is already a
 * reply pending, and two pending replies to one person is worse than a slow
 * one. But nothing used to re-queue afterwards, so message two was answered by
 * nobody, ever. A customer who sent "the kitchen" and then "and the hallway"
 * got an answer to the kitchen and silence about the hallway, which is exactly
 * the not-listening failure the whole system is built to avoid.
 */
export async function queueTurnIfUnanswered(
  sb: ReturnType<typeof messagingDb>,
  conversationId: string,
  answeredMessageId: string | null
): Promise<void> {
  const { data: newest } = await sb.from("sms_messages")
    .select("id").eq("conversation_id", conversationId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!newest || newest.id === answeredMessageId) return;

  // Nothing to do if a turn is already waiting to run.
  const { data: queued } = await sb.from("sms_scheduled_actions")
    .select("id").eq("conversation_id", conversationId).eq("action", "agent_turn")
    .in("state", ["pending", "claimed"]).maybeSingle();
  if (queued) return;

  await sb.from("sms_scheduled_actions").insert({
    conversation_id: conversationId,
    action: "agent_turn",
    run_at: new Date().toISOString(),
  });
}
