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
import { messagingDb, selectAllIn } from "./db";
import { assertMessagingAccess } from "./auth";
import { queueTurnIfUnanswered } from "./turn-queue";
import { gateDeps } from "./gate-deps";
import { gatedSend } from "./gate";
import { wasEdited, orderQueue, type DraftForReview } from "./drafts";
import { toE164 } from "./phone";
import { bumpStage } from "./stage";
import { recordOutbound } from "./outbound";
import { reportWarn } from "@/lib/observability";

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

/**
 * HOW MANY ARE REALLY WAITING — which is not how many were fetched.
 *
 * The review screen rendered `{drafts.length} waiting` and the list is capped
 * at 25. Sixty customers waiting for an answer read as "25 waiting", and the
 * number stopped moving as the queue grew: work through five and it still says
 * 25, which reads as making no progress at all. It is the mistake the board
 * already had, where db.ts explains at length why a capped list must never be
 * shown as a total — that fix landed there and not here.
 *
 * head+count, so the database counts and no rows are read. The filters have to
 * stay identical to the query below, or the number describes a different queue
 * from the list underneath it.
 */
export async function pendingDraftCount(): Promise<number> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { count, error } = await sb
    .from("sms_drafts")
    .select("id", { count: "exact", head: true })
    .eq("state", "pending")
    .or(`reviewed_at.is.null,reviewed_at.lt.${claimCutoff()}`);
  // Thrown for the same reason the list throws: a review queue that lies about
  // being empty is the most expensive lie in this product.
  if (error) throw new Error(`could not count the review queue: ${error.message}`);
  return count ?? 0;
}

export async function pendingDrafts(limit = 25): Promise<DraftForReview[]> {
  await assertMessagingAccess();
  const sb = messagingDb();

  // THROWS RATHER THAN RETURNING AN EMPTY QUEUE.
  //
  // This discarded its error, so any failure — a timeout, a 5xx, a dropped
  // connection — returned [] and the review screen rendered "Nothing waiting —
  // every reply has been dealt with" over a queue of customers waiting for an
  // answer. Autosend is off everywhere, so this IS the path every reply takes:
  // a lie here is the most expensive one in the product. app/messaging/error.tsx
  // catches this and says the screen could not load, which is the truth.
  const { data: rows, error } = await sb
    .from("sms_drafts")
    .select("id, conversation_id, answers_message_id, intent, confidence, reasoning, body, review_reason, send_error, created_at, sms_conversations(customer_phone, customer_name, sms_sub_accounts(name))")
    .eq("state", "pending")
    // Not the ones somebody is actively looking at, unless they have been
    // holding it long enough to have walked away.
    .or(`reviewed_at.is.null,reviewed_at.lt.${claimCutoff()}`)
    .order("created_at")
    .limit(limit);
  if (error) throw new Error(`could not load the review queue: ${error.message}`);

  const ids = (rows ?? []).map((r) => r.conversation_id);
  // The newest inbound per conversation, so the screen can tell whether a
  // draft is answering something the customer has already moved past.
  const latest = new Map<string, { id: string; at: string }>();
  if (ids.length) {
    const msgs = await selectAllIn<{ id: string; conversation_id: string; created_at: string }>(
      ids,
      (chunk, from, to) => sb.from("sms_messages").select("id, conversation_id, created_at")
        .in("conversation_id", chunk).eq("direction", "inbound")
        .order("created_at", { ascending: false }).order("id").range(from, to),
      "the newest inbound per draft"
    );
    for (const m of msgs) {
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
      // Why the gate has already refused it, if it has. See DraftForReview.
      sendError: (r as { send_error?: string | null }).send_error ?? null,
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
  // THROWS RATHER THAN SHOWING AN EMPTY THREAD. A draft is judged against the
  // conversation above it — "is this answering what they actually said?" — and
  // a read that fails silently renders that judgement against nothing at all.
  // app/messaging/error.tsx turns this into "the screen could not load", which
  // is the truth.
  const { data, error } = await sb
    .from("sms_messages").select("direction, body, created_at")
    .eq("conversation_id", conversationId).order("created_at");
  if (error) throw new Error(`could not load the conversation behind this draft: ${error.message}`);
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
  const { data: claimedRows, error: claimErr } = await sb.from("sms_drafts")
    .update({ reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq("id", input.draftId).eq("state", "pending")
    .or(`reviewed_at.is.null,reviewed_at.lt.${claimCutoff()}`)
    .select("id, body, state, intent, answers_message_id, conversation_id, sms_conversations(customer_phone, state, owning_user_id, owning_agent, sms_sub_accounts(id, name, phone_e164, origination_identity, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends, send_on_holidays))");

  /**
   * A FAILED CLAIM IS NOT SOMEBODY ELSE'S CLAIM.
   *
   * This destructured only `data`, so any failure — a timeout, a dropped
   * connection, an RLS change — produced `d === undefined` and the reviewer
   * was told "Somebody else is already dealing with this one". That is the
   * one message guaranteed to make them move on and never look again, and
   * the customer is still waiting. Two files up, this same module throws on a
   * failed read for exactly that reason.
   */
  if (claimErr) {
    reportWarn({
      key: "sms_draft_claim_failed", platform: "ppp_cc",
      message: "could not claim a draft for review",
      context: { draftId: input.draftId, error: claimErr.message },
    });
    return { ok: false, error: "We could not pick that one up just now — try again in a moment." };
  }

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
      quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean; send_on_holidays: boolean;
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

  /**
   * A DRAFT ANSWERS AN INBOUND, BY DEFINITION, AND DID NOT SAY SO.
   *
   * Every draft carries answers_message_id — it exists because the customer
   * wrote. Without answersInbound the gate applies CUSTOMER_OUTBOUND, 9 AM to
   * 7 PM on the recipient's clock plus PPP's office window, which is the rule
   * for contact PPP STARTS.
   *
   * So after 7 PM a reviewer pressing "Send it" was refused as quiet_hours and
   * the draft bounced back with send_error, while the bot's own held reply to
   * the very same message would have gone out under the federal window. The
   * same reply, legal or not depending on which door it came through — and
   * which door it came through depends only on whether a reply delay happens
   * to be configured for that workspace.
   *
   * The comment in sendHeldReply states the rule this follows: "Every held
   * reply is by definition a reply to a message the customer sent — that is
   * what answers_message_id means."
   */
  const res = await gatedSend(
    { workspace: ws, to, body, agent: "human_review", answersInbound: true },
    gateDeps(sb)
  );

  if (!res.ok) {
    // Back in the queue, with the reason. Never marked sent when nothing was
    // sent, and never left claimed by somebody who has walked away.
    await release(res.reason);
    return { ok: false, refused: res.reason };
  }

  const edited = wasEdited(d.body, body);

  await recordOutbound(sb, {
    conversation_id: d.conversation_id,
    // What the gate actually sent, disclosure included.
    body: res.body,
    provider_id: res.providerId,
    sent_by_user_id: userId,
    // The intent the agent chose, kept on the message a person approved. The
    // funnel and the next turn both derive the stage from these, and
    // sms_drafts alone was complete only while every reply was reviewed.
    agent_intent: d.intent,
  });
  await bumpStage(sb, d.conversation_id, d.intent);

  /**
   * MARKING IT SENT IS THE OTHER HALF OF SENDING, AND IT WAS UNCHECKED.
   *
   * The carrier has the message by now. This update discarded its error —
   * postgrest-js returns `{ error }` rather than throwing — so a failure left
   * the draft `pending` with only `reviewed_at` set, and claimCutoff() is two
   * minutes: the draft reappears in the queue and the next reviewer sends the
   * customer the same text again. Autosend is off everywhere, so this is the
   * path EVERY reply takes.
   *
   * Retried once, then marked failed rather than left pending, for the reason
   * markSent gives: a reply that has to be re-approved by hand is a far
   * smaller fault than a customer receiving it twice. The reviewer is told,
   * because they are standing there and can check the thread.
   */
  const closeDraft = () => sb.from("sms_drafts").update({
    state: "sent",
    // Only when it actually differs. Storing an unchanged copy would bury the
    // corrections that matter under ones that say nothing.
    final_body: edited ? body : null,
    send_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", d.id);
  let { error: closeErr } = await closeDraft();
  if (closeErr) ({ error: closeErr } = await closeDraft());
  if (closeErr) {
    /**
     * TAKEN OUT OF THE QUEUE, whichever state the schema will accept.
     *
     * 'failed' is the honest one and migration 20261006210000 adds it. Until
     * that is applied the CHECK refuses it — and a refused write here would
     * leave the draft pending, which is the bug. So it falls back to
     * 'rejected', which is also terminal and which the CHECK has always
     * allowed. The same shape record-inbound uses for its own source CHECK:
     * the customer being protected matters more than the label being exact.
     */
    const terminal = async (state: "failed" | "rejected") =>
      sb.from("sms_drafts").update({
        state,
        send_error: `sent, but the draft could not be closed: ${closeErr!.message}`,
        ...(state === "rejected"
          ? { reject_reason: "sent — the record of it failed, closed so it cannot go twice" }
          : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", d.id);
    const { error: failErr } = await terminal("failed");
    if (failErr) await terminal("rejected");
    reportWarn({
      key: "sms_draft_sent_not_closed", platform: "ppp_cc",
      message: "a reply was sent and its draft could not be marked sent — marked failed so it cannot be sent twice",
      context: { draftId: d.id, conversationId: d.conversation_id, error: closeErr.message },
    });
    return {
      ok: false,
      error: "It went out, but we could not record that. It is marked failed so nobody sends it twice — check the thread.",
    };
  }

  const { error: convErr } = await sb.from("sms_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", d.conversation_id);
  // Cannot cause a second send, so it is reported rather than surfaced.
  if (convErr) {
    reportWarn({
      key: "sms_draft_last_message_at", platform: "ppp_cc",
      message: "a reply went out and the conversation's last_message_at was not updated",
      context: { conversationId: d.conversation_id, error: convErr.message },
    });
  }

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
