/**
 * How far a conversation has got, recorded rather than recomputed from drafts.
 *
 * sms_conversations.qualification_stage has existed since migration 193 and has
 * never been written, so the funnel on /messaging/reporting reads 0 for every
 * row and renders "0 reached, -100%" at stage 1 — which says every customer
 * drops at the first question. That is not an empty report, it is a confidently
 * wrong one.
 *
 * The stage is derived from the intents the agent has chosen. The only record
 * of an intent was sms_drafts.intent, which is complete while a person reviews
 * every reply and EMPTY the moment autosend is on, because the autosend and
 * held-reply paths send without writing a draft. So this was two bugs: the
 * funnel was the visible one, and the invisible one was draftReply reading its
 * own current stage from those same rows and concluding, on an autosending
 * workspace, that it was permanently at stage 0 — after which its validator
 * refused ask_address, ask_contact and ask_availability as out of order, for
 * the rest of that conversation's life.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { stageFromIntents } from "./agent-output";

/** The stage a single intent implies. 0 when the intent is not a flow step. */
export function stageForIntent(intent: string | null | undefined): number {
  return stageFromIntents([intent]);
}

/**
 * Move the conversation's stage forward, never back.
 *
 * MONOTONIC on purpose. stageFromIntents is a max over every intent so far, so
 * taking the greater of the stored value and this one is the same answer
 * without re-reading the whole history — and it means a later clarifying
 * question cannot make the funnel say a customer un-qualified themselves.
 *
 * Best effort. A conversation whose stage is one behind is a slightly wrong
 * report; a send that failed because a metric could not be written would be a
 * customer who got no message. So the errors here are swallowed deliberately,
 * which is the opposite of the rule for the rails in gate-deps.ts.
 */
export async function bumpStage(
  sb: SupabaseClient,
  conversationId: string,
  intent: string | null | undefined
): Promise<void> {
  const stage = stageForIntent(intent);
  if (stage <= 0) return;
  const { data } = await sb.from("sms_conversations")
    .select("qualification_stage").eq("id", conversationId).maybeSingle();
  const current = (data?.qualification_stage as number | null) ?? 0;
  if (stage <= current) return;
  await sb.from("sms_conversations")
    .update({ qualification_stage: stage }).eq("id", conversationId);
}

/**
 * Every intent the agent has chosen on this conversation, oldest first.
 *
 * Reads SENT messages and PENDING drafts together. A sent message is what the
 * customer actually saw; a pending draft is a reply already written and
 * waiting, and forgetting it would make the next turn repeat the question.
 * Before agent_intent existed this read drafts alone, which is why an
 * autosending workspace saw an empty history.
 *
 * Tolerates the migration not being applied — this repo applies them by hand,
 * so there is always a window where the column is missing. A failed select
 * falls back to drafts alone, which is exactly the old behaviour.
 */
export async function priorIntentsFor(
  sb: SupabaseClient,
  conversationId: string
): Promise<string[]> {
  const drafts = await sb.from("sms_drafts")
    .select("intent, created_at").eq("conversation_id", conversationId);

  const msgs = await sb.from("sms_messages")
    .select("agent_intent, created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .not("agent_intent", "is", null);

  const rows: { intent: string | null; created_at: string }[] = [
    ...((drafts.data ?? []) as { intent: string | null; created_at: string }[]),
    ...(msgs.error
      ? []
      : ((msgs.data ?? []) as { agent_intent: string | null; created_at: string }[])
          .map((m) => ({ intent: m.agent_intent, created_at: m.created_at }))),
  ];

  return rows
    .filter((r) => r.intent)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((r) => r.intent as string);
}
