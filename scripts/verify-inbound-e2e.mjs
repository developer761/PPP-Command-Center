/**
 * The inbound path, against the real database.
 *
 * decideInbound has tests; the WRITES did not. Threading to an open
 * conversation, creating one when there is none, the 23505 that means "already
 * suppressed", and what happens when SNS delivers the same message twice had
 * never executed once. Those are the parts that touch real rows.
 *
 * Cleanup runs in a finally block. A previous script left a __verify campaign
 * behind because its cleanup sat after a throwing assertion.
 */
import { createClient } from "@supabase/supabase-js";
import { decideInbound } from "../lib/messaging/inbound.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

// NOT 555-01XX. That range is reserved for fiction and phone.ts deliberately
// refuses it, so every write in this script was silently skipped and the
// "threads into the same conversation" check passed on undefined === undefined.
// Nothing here can reach a carrier — the transport is the fake and this script
// only writes rows it deletes — so a plausible unassigned number is correct.
const CUSTOMER = "+15165551234";
const created = { conversations: [], optOuts: [] };

/** The webhook's own logic, extracted so the script runs what ships. */
async function ingest(payload) {
  const d = decideInbound(payload);
  if (d.kind === "reject") return { rejected: d.code };

  if (d.keyword === "opt_out") {
    const { error } = await sb.from("sms_opt_outs").insert({
      phone_e164: d.from, channel: "sms", source: "inbound_keyword",
      inbound_body: d.body, opted_out_at: new Date().toISOString(),
    });
    if (error && error.code !== "23505") throw error;
    if (!error) created.optOuts.push(d.from);
  }

  const { data: ws } = await sb.from("sms_sub_accounts").select("id").eq("phone_e164", d.to).maybeSingle();
  let conversationId = null;
  if (ws?.id) {
    const { data: convo } = await sb.from("sms_conversations")
      .select("id").eq("workspace_id", ws.id).eq("customer_phone", d.from)
      .neq("state", "ended").order("created_at", { ascending: false }).limit(1).maybeSingle();
    conversationId = convo?.id ?? null;
    if (!conversationId) {
      const { data: c, error } = await sb.from("sms_conversations").insert({
        workspace_id: ws.id, customer_phone: d.from,
        state: d.keyword === "opt_out" ? "ended" : "ai_active",
        outcome: d.keyword === "opt_out" ? "discard" : null,
        first_inbound_at: new Date().toISOString(),
      }).select("id").single();
      if (error) throw error;
      conversationId = c.id;
      created.conversations.push(c.id);
    }
  }

  let duplicate = false;
  if (conversationId) {
    const { error } = await sb.from("sms_messages").insert({
      conversation_id: conversationId, direction: "inbound", channel: "sms",
      body: d.body, provider_id: d.providerId,
    });
    if (error && error.code === "23505") duplicate = true;
    else if (error) throw error;
  }
  return { conversationId, keyword: d.keyword, duplicate };
}

try {
  const { data: workspace } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164").eq("is_active", true).not("phone_e164", "is", null).limit(1).single();
  const WORKSPACE_NUMBER = workspace.phone_e164;
  console.log(`\nINBOUND — real schema, real rows  (via ${workspace.name})\n`);

  const msg = (body, id) => ({
    originationNumber: CUSTOMER, destinationNumber: WORKSPACE_NUMBER,
    messageBody: body, inboundMessageId: id,
  });

  // 1. A first reply from an unknown number opens a conversation.
  const first = await ingest(msg("Hi, looking for a quote on my kitchen", "e2e-1"));
  ok("a reply from a new number opens a conversation", typeof first.conversationId === "string",
     first.rejected ? `rejected: ${first.rejected}` : "");

  // 2. The next reply threads into the SAME conversation rather than opening one.
  //    Asserting both are strings as well as equal: the first version compared
  //    two undefineds and called it a pass.
  const second = await ingest(msg("It is about 200 square feet", "e2e-2"));
  ok("the next reply threads into the same conversation",
     typeof second.conversationId === "string" && second.conversationId === first.conversationId);

  // 3. SNS delivers at least once. The same message twice must not double-post.
  const replay = await ingest(msg("It is about 200 square feet", "e2e-2"));
  ok("a redelivered message is recognised, not duplicated", replay.duplicate === true);

  const { count: msgCount } = await sb.from("sms_messages")
    .select("*", { count: "exact", head: true }).eq("conversation_id", first.conversationId);
  ok("…and the thread holds exactly two messages", msgCount === 2, `got ${msgCount}`);

  // 4. STOP suppresses the handset and ends the conversation.
  const stop = await ingest(msg("STOP", "e2e-3"));
  ok("STOP is recognised as an opt-out", stop.keyword === "opt_out");

  const { data: sup } = await sb.from("sms_opt_outs")
    .select("phone_e164, source, inbound_body, opted_in_at").eq("phone_e164", CUSTOMER).is("opted_in_at", null);
  ok("…and the number is suppressed", (sup ?? []).length === 1);
  ok("…with the exact words kept as evidence", sup?.[0]?.inbound_body === "STOP", sup?.[0]?.inbound_body ?? "");

  // 5. A second STOP must not explode on the partial unique index.
  const stopAgain = await ingest(msg("STOP", "e2e-4"));
  ok("a second STOP is harmless, not an error", stopAgain.keyword === "opt_out");
  const { count: supCount } = await sb.from("sms_opt_outs")
    .select("*", { count: "exact", head: true }).eq("phone_e164", CUSTOMER).is("opted_in_at", null);
  ok("…and there is still exactly one active suppression", supCount === 1, `got ${supCount}`);

  // 6. A number nobody owns is not silently threaded somewhere wrong.
  // A VALID number that simply is not ours. 555-01XX would be refused by
  // phone.ts before the workspace lookup ever ran, which would prove nothing
  // about the lookup.
  const orphan = await ingest({
    originationNumber: CUSTOMER, destinationNumber: "+15165559999",
    messageBody: "hello", inboundMessageId: "e2e-5",
  });
  ok("a reply to a number no workspace owns is not threaded",
     orphan.rejected === undefined && orphan.conversationId === null,
     orphan.rejected ? `rejected: ${orphan.rejected}` : "");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} finally {
  for (const id of created.conversations) {
    await sb.from("sms_messages").delete().eq("conversation_id", id);
    await sb.from("sms_conversations").delete().eq("id", id);
  }
  await sb.from("sms_opt_outs").delete().eq("phone_e164", CUSTOMER);
  const { count: leftConv } = await sb.from("sms_conversations")
    .select("*", { count: "exact", head: true }).eq("customer_phone", CUSTOMER);
  const { count: leftSup } = await sb.from("sms_opt_outs")
    .select("*", { count: "exact", head: true }).eq("phone_e164", CUSTOMER);
  console.log(`cleanup: ${leftConv} conversations, ${leftSup} opt-outs remain (expect 0, 0)`);
}
process.exit(fail === 0 ? 0 : 1);
