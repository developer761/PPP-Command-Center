"use server";

/**
 * A person replying to a customer in their own words.
 *
 * THE DEAD END THIS CLOSES. There were exactly three doors to a customer's
 * phone — a campaign step, the agent (autosend or a held reply), and approving
 * a draft — and claiming a conversation closes the first two by design. The
 * third only exists if the bot happened to leave a draft. So taking a
 * conversation over, which the handoff bar invites a person to do and describes
 * as "the bot stops replying", left nobody able to reply at all: the bot had
 * stopped, and there was no composer anywhere on the thread.
 *
 * Kate could read the conversation, own it, and not answer it.
 *
 * STILL THROUGH THE GATE. This is a fourth door, not a back door. Suppression,
 * the daily cap, quiet hours and the opt-out disclosure all apply exactly as
 * they do to the bot — a person typing the message does not make it legal to
 * text somebody who said STOP, and the one thing a human send must never
 * become is the path that skips the rails.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { createClient } from "@/lib/supabase/server";
import { gatedSend } from "./gate";
import { gateDeps } from "./gate-deps";
import { toE164 } from "./phone";
import { queueTurnIfUnanswered } from "./turn-queue";

export type HumanReplyResult =
  | { ok: true; body: string }
  | { ok: false; error?: string; refused?: string };

export async function sendHumanReply(input: {
  conversationId: string;
  body: string;
}): Promise<HumanReplyResult> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();

  const body = input.body.trim();
  if (!body) return { ok: false, error: "There is nothing to send." };

  const { data: conv } = await sb
    .from("sms_conversations")
    .select("id, state, customer_phone, owning_user_id, owning_agent, sms_sub_accounts(id, name, phone_e164, origination_identity, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends)")
    .eq("id", input.conversationId).maybeSingle();
  if (!conv) return { ok: false, error: "That conversation no longer exists." };

  const ws = conv.sms_sub_accounts as unknown as {
    id: string; name: string; phone_e164: string | null; origination_identity: string | null;
    time_zone: string; quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
  } | null;
  if (!ws) return { ok: false, error: "That conversation has no workspace." };

  // The same rule the draft queue enforces, for the same reason: two people
  // answering one customer is the failure handing over exists to prevent.
  // Unclaimed is fine — sending IS taking responsibility for the words.
  if (conv.owning_user_id && conv.owning_user_id !== userId) {
    return {
      ok: false,
      error: `${conv.owning_agent ?? "Somebody else"} has taken this conversation over, so it is theirs to answer.`,
    };
  }
  if (conv.state === "ended") {
    return { ok: false, error: "That conversation has ended." };
  }

  const to = toE164(conv.customer_phone);
  if (!to) return { ok: false, error: "That conversation has no usable phone number." };

  const res = await gatedSend({ workspace: ws, to, body, agent: "human_reply" }, gateDeps(sb));
  if (!res.ok) return { ok: false, refused: res.reason };

  // WHO SENT IT, by name. sms_messages.sent_by_agent has been selected by the
  // thread view and the agent-performance report since the table was created
  // and written by nothing, so the human half of the Hatch comparison was
  // permanently empty. A person replying is the one moment the name is known.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const profile = user ? await getProfileByUserId(user.id) : null;
  const who = profile?.full_name?.trim() || profile?.email?.trim() || null;

  await sb.from("sms_messages").insert({
    conversation_id: conv.id,
    // What the gate actually sent, disclosure included — not what was typed.
    direction: "outbound", channel: "sms", body: res.body,
    provider_id: res.providerId, delivery_status: "sent",
    sent_by_user_id: userId,
    sent_by_agent: who,
  });

  await sb.from("sms_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conv.id);

  // If the customer has said something since this reply was typed, the bot
  // still owes them an answer. Same helper the release path uses, so a person
  // sending here cannot leave a message answered by nobody.
  await queueTurnIfUnanswered(sb, conv.id, null);

  return { ok: true, body: res.body };
}
