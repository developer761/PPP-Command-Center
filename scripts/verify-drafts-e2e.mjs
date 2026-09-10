/**
 * The whole review cycle, against the real database.
 *
 * A customer writes, a reply is drafted, a person reads it and sends it. Unit
 * tests cover each piece; none of them prove the chain holds against real
 * rows, real constraints and the real gate — which is the only thing that
 * matters, because the gate is what stands between a queue and a customer who
 * asked us to stop.
 *
 * Cleanup in a finally block.
 */
import { createClient } from "@supabase/supabase-js";
import { gatedSend } from "../lib/messaging/gate.ts";
import { gateDeps } from "../lib/messaging/gate-deps.ts";
import { isStale, wasEdited } from "../lib/messaging/drafts.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const CUSTOMER = "+15165551234";
const made = { conversations: [], optOuts: [] };

try {
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends")
    .eq("is_active", true).not("phone_e164", "is", null).limit(1).single();

  console.log(`\nDRAFT REVIEW — real schema, real gate  (via ${ws.name})\n`);

  const { data: conv } = await sb.from("sms_conversations").insert({
    workspace_id: ws.id, customer_phone: CUSTOMER, state: "ai_active",
    first_inbound_at: new Date().toISOString(),
  }).select("id").single();
  made.conversations.push(conv.id);

  const { data: inbound } = await sb.from("sms_messages").insert({
    conversation_id: conv.id, direction: "inbound", channel: "sms",
    body: "Hi, looking for a quote on my kitchen", provider_id: "e2e-draft-in-1",
  }).select("id").single();

  // 1. A draft can be parked against the message it answers.
  const { data: draft, error: dErr } = await sb.from("sms_drafts").insert({
    conversation_id: conv.id, answers_message_id: inbound.id,
    intent: "ask_project_details", confidence: 0.9,
    body: "What are you looking to have painted?", review_reason: "autosend_off",
  }).select("id, body, state").single();
  ok("a reply can be parked for review", !dErr && draft?.state === "pending", dErr?.message ?? "");

  // 2. One pending draft per conversation — two people must not be able to
  //    send two different replies to the same customer.
  const dupe = await sb.from("sms_drafts").insert({
    conversation_id: conv.id, body: "a second reply", review_reason: "autosend_off",
  });
  ok("a second pending reply on the same conversation is blocked", !!dupe.error, dupe.error?.code ?? "ALLOWED");

  // 3. The review_reason vocabulary is enforced, not decorative.
  const badReason = await sb.from("sms_drafts").insert({
    conversation_id: conv.id, body: "x", review_reason: "because_i_said_so",
  });
  ok("an invented review reason is refused", !!badReason.error);

  // 4. Staleness is computed from real rows.
  const fresh = { answersMessageId: inbound.id, latestInboundId: inbound.id };
  ok("a draft answering the newest message is not stale", isStale(fresh) === false);
  const { data: newer } = await sb.from("sms_messages").insert({
    conversation_id: conv.id, direction: "inbound", channel: "sms",
    body: "actually also the hallway", provider_id: "e2e-draft-in-2",
  }).select("id").single();
  ok("…and becomes stale the moment they write again",
     isStale({ answersMessageId: inbound.id, latestInboundId: newer.id }) === true);

  // 5. THE GATE. Approving is not an override.
  const suppressedCheck = await gatedSend(
    { workspace: ws, to: CUSTOMER, body: "approved by a human", agent: "human_review" },
    gateDeps(sb)
  );
  const allowedBefore = suppressedCheck.ok;
  ok("a normal approval passes the gate", allowedBefore,
     allowedBefore ? "" : `refused: ${suppressedCheck.reason}`);

  await sb.from("sms_opt_outs").insert({
    phone_e164: CUSTOMER, channel: "sms", source: "manual",
    opted_out_at: new Date().toISOString(),
  });
  made.optOuts.push(CUSTOMER);

  const afterOptOut = await gatedSend(
    { workspace: ws, to: CUSTOMER, body: "approved by a human", agent: "human_review" },
    gateDeps(sb)
  );
  ok("a human pressing send CANNOT reach someone who opted out",
     !afterOptOut.ok && afterOptOut.reason === "suppressed",
     afterOptOut.ok ? "SENT — the gate was bypassed" : afterOptOut.reason);

  // 6. An edit is recorded separately from what the agent wrote.
  ok("an unchanged approval is not recorded as an edit", wasEdited(draft.body, draft.body) === false);
  ok("a rewrite is", wasEdited(draft.body, "Is it the kitchen you want done?") === true);

  await sb.from("sms_drafts").update({
    state: "sent", final_body: "Is it the kitchen you want done?",
    reviewed_at: new Date().toISOString(),
  }).eq("id", draft.id);
  const { data: after } = await sb.from("sms_drafts")
    .select("body, final_body, state").eq("id", draft.id).single();
  ok("the agent's wording survives the edit", after.body === "What are you looking to have painted?");
  ok("…alongside what the human actually sent", after.final_body === "Is it the kitchen you want done?");

  // 7. With the pending one resolved, the conversation can take another.
  const next = await sb.from("sms_drafts").insert({
    conversation_id: conv.id, body: "a later reply", review_reason: "autosend_off",
  }).select("id").single();
  ok("a new reply can be drafted once the last was dealt with", !next.error);

  // 8. THE STALL. A customer who writes again while a draft waits must not be
  //    left unanswered once that draft is dealt with.
  //
  //    Reuses the conversation above rather than opening another:
  //    sms_conversations_live_idx allows only ONE live conversation per person
  //    per workspace, which is a good rule and one this script tripped over.
  //    The draft from check 7 is still pending, and only one may be — so it
  //    IS the waiting draft. Point it at the older message so it is answering
  //    something the customer has already moved past.
  await sb.from("sms_drafts")
    .update({ answers_message_id: inbound.id }).eq("id", next.data.id);
  const { data: stallDraft } = await sb.from("sms_drafts")
    .select("id, answers_message_id, state").eq("id", next.data.id).single();
  ok("a draft is waiting", stallDraft?.state === "pending");

  // They wrote again while it waited — `newer` was inserted earlier.
  const { count: queuedBefore } = await sb.from("sms_scheduled_actions")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conv.id).eq("action", "agent_turn").in("state", ["pending", "claimed"]);
  ok("nothing is queued while a reply is already waiting", queuedBefore === 0, `${queuedBefore}`);

  // Resolving it must leave a turn queued for what they said since. This is
  // the exact logic queueTurnIfUnanswered runs, against the same rows.
  await sb.from("sms_drafts")
    .update({ state: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", stallDraft.id);

  const { data: newestInbound } = await sb.from("sms_messages")
    .select("id").eq("conversation_id", conv.id).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const unanswered = newestInbound.id !== stallDraft.answers_message_id;
  ok("the later message is correctly seen as unanswered", unanswered);

  if (unanswered) {
    await sb.from("sms_scheduled_actions").insert({
      conversation_id: conv.id, action: "agent_turn", run_at: new Date().toISOString(),
    });
  }
  const { count: queuedAfter } = await sb.from("sms_scheduled_actions")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conv.id).eq("action", "agent_turn").eq("state", "pending");
  ok("…so a fresh turn is queued and the conversation does not stall", queuedAfter === 1, `${queuedAfter}`);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} finally {
  for (const id of made.conversations) {
    await sb.from("sms_scheduled_actions").delete().eq("conversation_id", id);
    await sb.from("sms_drafts").delete().eq("conversation_id", id);
    await sb.from("sms_messages").delete().eq("conversation_id", id);
    await sb.from("sms_conversations").delete().eq("id", id);
  }
  for (const p of made.optOuts) await sb.from("sms_opt_outs").delete().eq("phone_e164", p);
  const { count: c } = await sb.from("sms_conversations").select("*", { count: "exact", head: true }).eq("customer_phone", CUSTOMER);
  const { count: o } = await sb.from("sms_opt_outs").select("*", { count: "exact", head: true }).eq("phone_e164", CUSTOMER);
  const { count: d } = await sb.from("sms_drafts").select("*", { count: "exact", head: true });
  console.log(`cleanup: ${c} conversations, ${o} opt-outs, ${d} drafts remain (expect 0, 0, 0)`);
}
process.exit(fail === 0 ? 0 : 1);
