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
import { gateDeps } from "./gate-deps";
import { gatedSend } from "./gate";
import { wasEdited, orderQueue, type DraftForReview } from "./drafts";
import { toE164 } from "./phone";

export async function pendingDrafts(limit = 25): Promise<DraftForReview[]> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data: rows } = await sb
    .from("sms_drafts")
    .select("id, conversation_id, answers_message_id, intent, confidence, reasoning, body, review_reason, created_at, sms_conversations(customer_phone, customer_name, sms_sub_accounts(name))")
    .eq("state", "pending")
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

  const { data: d } = await sb
    .from("sms_drafts")
    .select("id, body, state, conversation_id, sms_conversations(customer_phone, sms_sub_accounts(id, name, phone_e164, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends))")
    .eq("id", input.draftId).maybeSingle();
  if (!d) return { ok: false, error: "That draft no longer exists." };
  if (d.state !== "pending") return { ok: false, error: "That draft has already been dealt with." };

  const conv = d.sms_conversations as unknown as {
    customer_phone: string;
    sms_sub_accounts: {
      id: string; name: string; phone_e164: string | null; time_zone: string;
      quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
    } | null;
  } | null;
  const ws = conv?.sms_sub_accounts;
  if (!ws) return { ok: false, error: "That conversation has no workspace." };

  const to = toE164(conv?.customer_phone);
  if (!to) return { ok: false, error: "That conversation has no usable phone number." };

  const body = input.body.trim();
  if (!body) return { ok: false, error: "There is nothing to send." };

  const res = await gatedSend(
    { workspace: ws, to, body, agent: "human_review" },
    gateDeps(sb)
  );

  if (!res.ok) {
    // Pending, with the reason. Never marked sent when nothing was sent.
    await sb.from("sms_drafts")
      .update({ send_error: res.reason, updated_at: new Date().toISOString() })
      .eq("id", d.id);
    return { ok: false, refused: res.reason };
  }

  const edited = wasEdited(d.body, body);

  await sb.from("sms_messages").insert({
    conversation_id: d.conversation_id,
    direction: "outbound", channel: "sms", body,
    provider_id: res.providerId, delivery_status: "sent",
    sent_by_user_id: userId,
  });

  await sb.from("sms_drafts").update({
    state: "sent",
    // Only when it actually differs. Storing an unchanged copy would bury the
    // corrections that matter under ones that say nothing.
    final_body: edited ? body : null,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    send_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", d.id);

  await sb.from("sms_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", d.conversation_id);

  return { ok: true, edited };
}

export async function rejectDraft(input: { draftId: string; reason?: string }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();
  const { error } = await sb.from("sms_drafts").update({
    state: "rejected",
    reject_reason: input.reason?.trim() || null,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", input.draftId).eq("state", "pending");
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
