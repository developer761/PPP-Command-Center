"use server";

/**
 * Reading, sending and rejecting drafts.
 *
 * APPROVING GOES THROUGH THE GATE. Not around it. A person clicking send is
 * not an override — suppression, quiet hours, the weekend rule and the daily
 * cap all still apply, because the reason those exist is not that the agent
 * might be wrong. Somebody who said stop said stop to PPP, and a screen that
 * can send anyway is a screen that can produce the exact violation the whole
 * gate was built to prevent.
 *
 * When the gate refuses, the draft stays pending and says why. Marking it sent
 * when nothing left the building would be the worst of both: a customer who
 * never heard from us and a queue that says they did.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { queueTurnIfUnanswered } from "./turn-queue";
import { gateDeps } from "./gate-deps";
import { gatedSend } from "./gate";
import { wasEdited, orderQueue, type DraftForReview } from "./drafts";
import { toE164 } from "./phone";

/**
 * How long somebody may hold a draft before it goes back in the queue.
 *
 * Claiming stops two reviewers sending the same reply twice. Without a
 * timeout it would also mean a closed tab strands that customer for ever,
 * which trades a rare double-send for a permanent silence. The scheduler
 * already reclaims rows abandoned by a dead worker for the same reason.
 */
const CLAIM_HOLD_MS = 2 * 60_000;

function claimCutoff(): string {
  return new Date(Date.now() - CLAIM_HOLD_MS).toISOString();
}

export async function pendingDrafts(limit = 25): Promise<DraftForReview[]> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data: rows } = await sb
    .from("sms_drafts")
    .select("id, conversation_id, answers_message_id, intent, confidence, reasoning, body, review_reason, created_at, sms_conversations(customer_phone, customer_name, sms_sub_accounts(name))")
    .eq("state", "pending")
    // Not the ones somebody is actively looking at, unless they have been
    // holding it long enough to have walked away.
    .or(`reviewed_at.is.null,reviewed_at.lt.${claimCutoff()}`)
    .order("created_at")
    .limit(limit);

  const ids = (rows ?? []).map((r) => r.conversation_id);
  // The newest inbound per conversation, so the screen can tell whether a
  // draft is answering something the customer has already moved past.
  const latest = new Map<string, { id: string; at: string }>();
  if (ids.length) {
    const { data: msgs } = await sb
      .from("sms_messages").select("id, conversation_id, created_at")
      .in("conversation_id", ids).eq("direction", "inbound")
      .order("created_at", { ascending: false });
    for (const m of msgs ?? []) {
      if (!latest.has(m.conversation_id)) latest.set(m.conversation_id, { id: m.id, at: m.created_at });
    }
  }

  const out: DraftForReview[] = (rows ?? []).map((r) => {
    const c = r.sms_conversations as unknown as {
      customer_phone: string; customer_name: string | null;
      sms_sub_accounts: { name: string } | null;
    } | null;
    const l = latest.get(r.conversation_id);
    return {
      id: r.id,
      conversationId: r.conversation_id,
      workspaceName: c?.sms_sub_accounts?.name ?? "—",
      customerPhone: c?.customer_phone ?? "",
      customerName: c?.customer_name ?? null,
      intent: r.intent,
      confidence: r.confidence === null ? null : Number(r.confidence),
      reasoning: r.reasoning,
      body: r.body,
      reviewReason: r.review_reason as DraftForReview["reviewReason"],
      createdAt: r.created_at,
      answersMessageId: r.answers_message_id,
      latestInboundId: l?.id ?? null,
      latestInboundAt: l?.at ?? null,
    };
  });

  return orderQueue(out);
}

/** The thread behind a draft, so it can be judged in context rather than alone. */
export async function draftThread(conversationId: string): Promise<{
  direction: "inbound" | "outbound"; body: string; createdAt: string;
}[]> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data } = await sb
    .from("sms_messages").select("direction, body, created_at")
    .eq("conversation_id", conversationId).order("created_at");
  return (data ?? []).map((m) => ({
    direction: m.direction as "inbound" | "outbound",
    body: m.body, createdAt: m.created_at,
  }));
}


export type SendOutcome =
  | { ok: true; edited: boolean }
  | { ok: false; refused: string }
  | { ok: false; error: string };

export async function sendDraft(input: { draftId: string; body: string }): Promise<SendOutcome> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();

  // CLAIM IT FIRST, atomically.
  //
  // Read-then-write is not enough: Kate and Katie both have access, and two
  // people looking at the same queue can both press send. Setting reviewed_at
  // only where it is still NULL means exactly one of them wins, and the loser
  // is told rather than silently sending the customer a second copy.
  const { data: claimedRows } = await sb.from("sms_drafts")
    .update({ reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq("id", input.draftId).eq("state", "pending")
    .or(`reviewed_at.is.null,reviewed_at.lt.${claimCutoff()}`)
    .select("id, body, state, answers_message_id, conversation_id, sms_conversations(customer_phone, state, owning_user_id, owning_agent, sms_sub_accounts(id, name, phone_e164, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends))");

  const d = claimedRows?.[0];
  if (!d) return { ok: false, error: "Somebody else is already dealing with this one." };

  /** Put it back in the queue when the send does not happen. */
  const release = async (sendError: string | null) => {
    await sb.from("sms_drafts")
      .update({ reviewed_by: null, reviewed_at: null, send_error: sendError, updated_at: new Date().toISOString() })
      .eq("id", d.id);
  };

  const conv = d.sms_conversations as unknown as {
    customer_phone: string;
    state: string;
    owning_user_id: string | null;
    owning_agent: string | null;
    sms_sub_accounts: {
      id: string; name: string; phone_e164: string | null; time_zone: string;
      quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
    } | null;
  } | null;
  const ws = conv?.sms_sub_accounts;
  if (!ws) { await release(null); return { ok: false, error: "That conversation has no workspace." }; }

  // THE THIRD DOOR TO THE CUSTOMER.
  //
  // Agent turns stop when somebody takes a conversation over, and campaign
  // steps wait. This queue did neither, because it never read the conversation
  // at all — so the bot escalating, a person claiming it, and a second person
  // sending the bot's draft from here was a complete path to two voices
  // answering one customer, through the one door that has a human pressing the
  // button and therefore looks deliberate.
  //
  // Unclaimed is fine: sending IS somebody taking responsibility for the words.
  // Held by you is fine, it is your conversation. Held by somebody else is not.
  if (conv.owning_user_id && conv.owning_user_id !== userId) {
    await release(null);
    return {
      ok: false,
      error: `${conv.owning_agent ?? "Somebody else"} has taken this conversation over, so this reply is theirs to send or drop.`,
    };
  }
  if (conv.state === "ended") {
    await release(null);
    return { ok: false, error: "That conversation has ended, so this reply is out of date." };
  }

  const to = toE164(conv?.customer_phone);
  if (!to) { await release(null); return { ok: false, error: "That conversation has no usable phone number." }; }

  const body = input.body.trim();
  if (!body) { await release(null); return { ok: false, error: "There is nothing to send." }; }

  const res = await gatedSend(
    { workspace: ws, to, body, agent: "human_review" },
    gateDeps(sb)
  );

  if (!res.ok) {
    // Back in the queue, with the reason. Never marked sent when nothing was
    // sent, and never left claimed by somebody who has walked away.
    await release(res.reason);
    return { ok: false, refused: res.reason };
  }

  const edited = wasEdited(d.body, body);

  await sb.from("sms_messages").insert({
    conversation_id: d.conversation_id,
    // What the gate actually sent, disclosure included.
    direction: "outbound", channel: "sms", body: res.body,
    provider_id: res.providerId, delivery_status: "sent",
    sent_by_user_id: userId,
  });

  await sb.from("sms_drafts").update({
    state: "sent",
    // Only when it actually differs. Storing an unchanged copy would bury the
    // corrections that matter under ones that say nothing.
    final_body: edited ? body : null,
    send_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", d.id);

  await sb.from("sms_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", d.conversation_id);

  // Anything they said while this waited still needs answering.
  await queueTurnIfUnanswered(sb, d.conversation_id, d.answers_message_id);

  return { ok: true, edited };
}

export async function rejectDraft(input: { draftId: string; reason?: string }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();
  const { data, error } = await sb.from("sms_drafts").update({
    state: "rejected",
    reject_reason: input.reason?.trim() || null,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", input.draftId).eq("state", "pending").select("conversation_id, answers_message_id");
  if (error) return { ok: false, error: error.message };
  const row = data?.[0];
  if (!row) return { ok: false, error: "Somebody else already dealt with this one." };

  // Binning a reply does not mean the customer stops needing one — and if they
  // wrote again while it waited, that is still unanswered.
  await queueTurnIfUnanswered(sb, row.conversation_id, row.answers_message_id);
  return { ok: true };
}
