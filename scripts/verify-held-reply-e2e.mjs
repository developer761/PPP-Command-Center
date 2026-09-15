/**
 * Held replies against the real database: the 30-90 second answer.
 *
 * Unit tests prove the timing arithmetic and every branch of runAction with
 * fakes. They cannot prove the constraint accepts a held reply and refuses one
 * with nothing to say, that the real sendHeldReply finds a newer message and
 * drops a stale reply, or that a sent reply is recorded as exactly what went
 * out. This runs the real scheduler code on a throwaway conversation.
 *
 * The transport is the logging fake: this refuses to run with
 * SMS_LIVE_SENDING=true, so it cannot text anybody. Cleanup in finally.
 *
 * Needs 20260915135711_reply_in_30_to_90_seconds.sql applied.
 */
import { createClient } from "@supabase/supabase-js";
import { runAction } from "../lib/messaging/scheduler.ts";
import { schedulerDeps } from "../lib/messaging/scheduler-db.ts";
import { withinQuietHours } from "../lib/messaging/compliance.ts";

if (process.env.SMS_LIVE_SENDING === "true") {
  console.log("SMS_LIVE_SENDING is true here. Refusing: this check must not reach a carrier.");
  process.exit(1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const conversations = [];
// A reserved fictional number (555-0100 to 0199), never a real customer.
const PHONE = "+12125550142";

async function thread(ws, state = "ai_active") {
  const { data: conv, error } = await sb.from("sms_conversations").insert({
    workspace_id: ws.id, customer_phone: PHONE, state, consent_basis: "inquiry",
  }).select("id").single();
  if (error) throw new Error(`conversation: ${error.message}`);
  conversations.push(conv.id);
  const { data: msg } = await sb.from("sms_messages").insert({
    conversation_id: conv.id, direction: "inbound", channel: "sms",
    body: "Hi, I need two bedrooms painted", provider_id: `e2e-held-${conv.id}`,
  }).select("id").single();
  return { convId: conv.id, msgId: msg.id };
}

async function holdReply(convId, msgId, body) {
  const due = new Date().toISOString();
  const { data, error } = await sb.from("sms_scheduled_actions").insert({
    conversation_id: convId, action: "send_reply", run_at: due, reply_due_at: due,
    reply_body: body, answers_message_id: msgId, reply_intent: "ask_address", reply_confidence: 0.9,
  }).select("*").single();
  if (error) throw new Error(`hold: ${error.message}`);
  return data;
}

try {
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends, reply_delay_min_seconds, reply_delay_max_seconds")
    .eq("is_active", true).not("phone_e164", "is", null).limit(1).single();
  console.log(`\nHELD REPLIES — real schema  (via ${ws.name})\n`);

  /* ── Defaults ───────────────────────────────────────────────── */
  const { data: all } = await sb.from("sms_sub_accounts").select("name, reply_delay_min_seconds, reply_delay_max_seconds");
  const offs = all.filter((r) => r.reply_delay_min_seconds === 0 && r.reply_delay_max_seconds === 0);
  ok("no workspace is left on the old off default", offs.length === 0, offs.map((r) => r.name).join(", "));
  const std = all.filter((r) => r.reply_delay_min_seconds === 30 && r.reply_delay_max_seconds === 90).length;
  ok("workspaces answer in 30-90 seconds", std > 0, `${std} of ${all.length} on 30-90`);

  /* ── The constraint ─────────────────────────────────────────── */
  const a = await thread(ws);
  const empty = await sb.from("sms_scheduled_actions").insert({
    conversation_id: a.convId, action: "send_reply", run_at: new Date().toISOString(),
  });
  ok("a held reply with nothing to say is refused", empty.error !== null);

  /* ── Delivered at its moment, recorded as what went out ─────── */
  const body = "Thanks! What is the street address for the project?";
  const heldA = await holdReply(a.convId, a.msgId, body);
  ok("a held reply is accepted", !!heldA.id);
  const open = withinQuietHours(new Date(), ws.time_zone, { startHour: ws.quiet_hours_start, endHour: ws.quiet_hours_end });
  const outA = await runAction(heldA, schedulerDeps());
  if (open) {
    ok("it is sent through the real gate", outA.kind === "sent", JSON.stringify(outA));
    const { data: out } = await sb.from("sms_messages").select("body").eq("conversation_id", a.convId).eq("direction", "outbound");
    ok("the thread records the reply that went out, with the opt-out line the gate adds on first contact",
       out.length === 1 && out[0].body.startsWith(body), out.map((m) => m.body).join(" | "));
    const { data: rowA } = await sb.from("sms_scheduled_actions").select("state").eq("id", heldA.id).single();
    ok("and its row is closed", rowA.state === "done");
  } else {
    ok("outside sending hours it becomes a draft instead of sending", outA.kind === "drafted", JSON.stringify(outA));
  }

  /* ── Stale: the customer texted again ───────────────────────── */
  const b = await thread(ws);
  const heldB = await holdReply(b.convId, b.msgId, "What is the address?");
  await new Promise((r) => setTimeout(r, 20));
  await sb.from("sms_messages").insert({
    conversation_id: b.convId, direction: "inbound", channel: "sms",
    body: "Actually it is 3 rooms", provider_id: `e2e-held-2-${b.convId}`,
  });
  const outB = await runAction(heldB, schedulerDeps());
  ok("a reply the customer has moved past is dropped", outB.kind === "cancelled" && /texted again/.test(outB.reason ?? ""), JSON.stringify(outB));
  const { data: sentB } = await sb.from("sms_messages").select("id").eq("conversation_id", b.convId).eq("direction", "outbound");
  ok("and nothing was sent or recorded", sentB.length === 0);

  /* ── A person took over ─────────────────────────────────────── */
  const c = await thread(ws, "human_active");
  const heldC = await holdReply(c.convId, c.msgId, "Emily's answer");
  const outC = await runAction(heldC, schedulerDeps());
  ok("a held reply is dropped once a person has the conversation", outC.kind === "cancelled", JSON.stringify(outC));
  const { data: rowC } = await sb.from("sms_scheduled_actions").select("state, run_at").eq("id", heldC.id).single();
  ok("dropped, not pushed an hour later", rowC.state === "cancelled");

} finally {
  if (conversations.length) await sb.from("sms_conversations").delete().in("id", conversations);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
