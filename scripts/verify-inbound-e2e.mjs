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
import { recordInbound } from "../lib/messaging/record-inbound.ts";
import { renderMessage } from "../lib/messaging/render.ts";
import { helpReplyChecks } from "../lib/messaging/help-reply.ts";

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

/**
 * THE WEBHOOK'S OWN CODE, not a copy of it.
 *
 * This used to be a hand-written reimplementation of the route, under a
 * comment claiming it was "extracted so the script runs what ships" — it was
 * not, and a divergence between the two would have gone unnoticed here, which
 * is the one place it would have mattered. recordInbound is now a real module
 * that both webhook routes call, so this exercises the shipping path.
 */
async function ingest(payload) {
  const d = decideInbound(payload);
  if (d.kind === "reject") return { rejected: d.code };

  const res = await recordInbound(sb, d);
  if (res.conversationId && !created.conversations.includes(res.conversationId)) {
    created.conversations.push(res.conversationId);
  }
  if (d.keyword === "opt_out") created.optOuts.push(d.from);
  return { conversationId: res.conversationId, keyword: d.keyword, duplicate: !res.isNew };
}

try {
  const { data: workspace } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164").eq("is_active", true).not("phone_e164", "is", null).limit(1).single();
  const WORKSPACE_NUMBER = workspace.phone_e164;
  console.log(`\nINBOUND — real schema, real rows  (via ${workspace.name})\n`);

  const msg = (body, id, mediaUrls) => ({
    originationNumber: CUSTOMER, destinationNumber: WORKSPACE_NUMBER,
    messageBody: body, inboundMessageId: id,
    ...(mediaUrls ? { mediaUrls } : {}),
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

  // 3b. A44: the customer says when they cannot be reached, and it is kept.
  //
  // Against the real schema on purpose. The CHECK demands both hours or
  // neither, so a write that got the shape wrong is rejected here and nowhere
  // in the unit tests, which have no constraint to violate.
  const { data: beforeReach } = await sb.from("sms_conversations")
    .select("unreachable_start_hour").eq("id", first.conversationId).maybeSingle();
  ok("no constraint is recorded before the customer states one",
     (beforeReach?.unreachable_start_hour ?? null) === null);

  await ingest(msg("I'm at work until 5, can you text after that", "e2e-reach"));
  const { data: reach } = await sb.from("sms_conversations")
    .select("unreachable_start_hour, unreachable_end_hour, unreachable_stated_at, unreachable_message_id")
    .eq("id", first.conversationId).maybeSingle();
  ok("a stated constraint is recorded",
     reach?.unreachable_start_hour === 0 && reach?.unreachable_end_hour === 17,
     `${reach?.unreachable_start_hour}-${reach?.unreachable_end_hour}`);
  ok("…with when they said it", !!reach?.unreachable_stated_at);
  ok("…and which message said it, so a screen can quote them back",
     typeof reach?.unreachable_message_id === "string");

  // "It does not expire." Silence about it is not a retraction.
  await ingest(msg("The fence is about 40 feet", "e2e-reach-2"));
  const { data: stillReach } = await sb.from("sms_conversations")
    .select("unreachable_start_hour").eq("id", first.conversationId).maybeSingle();
  ok("…and a later message saying nothing about it does not clear it",
     stillReach?.unreachable_start_hour === 0, String(stillReach?.unreachable_start_hour));

  // 3c. A26: a photo arrived, and the system remembers that it did.
  //
  // Kate measured this one: "42 of 45 bot replies after a customer photo
  // never mentioned it." The acknowledgement has existed in render.ts the
  // whole time and could never fire, because the count was computed on the
  // way in and then had nowhere to be written. Asserting on the stored ROW is
  // the point — the agent turn runs seconds later in another process and can
  // only know what the row remembers.
  await ingest(msg("Here is the wall", "e2e-photo", ["https://example.invalid/a.jpg", "https://example.invalid/b.jpg"]));
  const { data: withMedia } = await sb.from("sms_messages")
    .select("media_count, body").eq("conversation_id", first.conversationId)
    .eq("provider_id", "e2e-photo").maybeSingle();
  ok("a photo that arrived is remembered on the message", withMedia?.media_count === 2,
     `media_count ${withMedia?.media_count}`);

  const { data: noMedia } = await sb.from("sms_messages")
    .select("media_count").eq("conversation_id", first.conversationId)
    .eq("provider_id", "e2e-1").maybeSingle();
  ok("…and a message with no photo is not claimed to have one", noMedia?.media_count === 0,
     `media_count ${noMedia?.media_count}`);

  // The acknowledgement the rule actually asks for, rendered from that count.
  const acked = renderMessage({ intent: "acknowledge", turn: 0, photos: withMedia?.media_count ?? 0 });
  ok("…so the reply names the photo", /thanks for the photos?/i.test(acked), acked);
  ok("…and does not describe or price it", !/\$|\blooks?\b|\bsee\b|\bcolou?r\b/i.test(acked), acked);

  // 4. STOP suppresses the handset and ends the conversation.
  const stop = await ingest(msg("STOP", "e2e-3"));
  ok("STOP is recognised as an opt-out", stop.keyword === "opt_out");

  const { data: sup } = await sb.from("sms_opt_outs")
    .select("phone_e164, source, inbound_body, opted_in_at").eq("phone_e164", CUSTOMER).is("opted_in_at", null);
  ok("…and the number is suppressed", (sup ?? []).length === 1);
  ok("…with the exact words kept as evidence", sup?.[0]?.inbound_body === "STOP", sup?.[0]?.inbound_body ?? "");

  // 5. A second STOP must not explode — on the partial unique index, nor on
  //    sms_conversations_ended_shape.
  //
  //    The first STOP ended the conversation, so this one finds nothing open
  //    and opens a fresh already-ended row. That row needs state, outcome AND
  //    ended_at together or the check constraint rejects it, which is exactly
  //    what the live webhook was doing: 500, and SNS retrying it for hours.
  //    The old hand-written copy of the webhook in this script never ended the
  //    conversation at all, so it never reached this path and the bug sat
  //    behind a passing test.
  const stopAgain = await ingest(msg("STOP", "e2e-4"));
  ok("a second STOP is harmless, not an error", stopAgain.keyword === "opt_out");
  ok("…and it is recorded rather than lost", typeof stopAgain.conversationId === "string",
     String(stopAgain.conversationId));
  const { count: supCount } = await sb.from("sms_opt_outs")
    .select("*", { count: "exact", head: true }).eq("phone_e164", CUSTOMER).is("opted_in_at", null);
  ok("…and there is still exactly one active suppression", supCount === 1, `got ${supCount}`);

  // 5b. A24: AN OPT-OUT CAN BE A SENTENCE.
  //
  //     "Any clear 'STOP', 'stop', or PLAIN-LANGUAGE REQUEST to end or halt
  //     communication STOPS all further text outreach immediately." Live,
  //     critical, and only the carrier keywords were honoured — so somebody
  //     who wrote "take me off your list" kept getting texts.
  //
  //     Run against the REAL table because the value it writes needed a
  //     migration: source allowed only inbound_keyword, manual and
  //     hatch_import, and inbound_phrase failed the CHECK with 23514. A unit
  //     test cannot see that, which is the whole reason this file exists.
  const PHRASE_CUSTOMER = "+19995550461";
  created.optOuts.push(PHRASE_CUSTOMER);
  // originationNumber, NOT from — the payload is the carrier's shape, and a
  // `from` key here is silently ignored, which sent this down the default
  // customer's already-suppressed thread and made three checks lie.
  const phrase = await ingest({ ...msg("Thanks but please take me off your list", "e2e-phrase"), originationNumber: PHRASE_CUSTOMER });
  ok("a plain-language opt-out is honoured (A24)", phrase.keyword === "opt_out");

  const { data: phraseSup } = await sb.from("sms_opt_outs")
    .select("source, inbound_body").eq("phone_e164", PHRASE_CUSTOMER).is("opted_in_at", null);
  ok("…and the number is suppressed", (phraseSup ?? []).length === 1);
  ok("…recorded as a phrase, not as a carrier keyword",
     phraseSup?.[0]?.source === "inbound_phrase", phraseSup?.[0]?.source ?? "");
  ok("…with the exact words kept as evidence",
     phraseSup?.[0]?.inbound_body === "Thanks but please take me off your list",
     phraseSup?.[0]?.inbound_body ?? "");

  // AND THE OTHER DIRECTION, which is the expensive one to get wrong.
  // "AN OPT-OUT IS NOT A DECLINE" — somebody who has declined the SERVICE
  // must not be suppressed, or a live lead is gone for good.
  const DECLINER = "+19995550462";
  const declined = await ingest({ ...msg("No thanks, we already hired someone", "e2e-decline"), originationNumber: DECLINER });
  ok("declining the work is NOT an opt-out (A17, not A24)", declined.keyword !== "opt_out",
     String(declined.keyword));
  const { count: declineSup } = await sb.from("sms_opt_outs")
    .select("*", { count: "exact", head: true }).eq("phone_e164", DECLINER);
  ok("…and that number is not suppressed", declineSup === 0, `got ${declineSup}`);

  // 6. HELP must be answered, and never by the model.
  //
  //    compliance.ts has said "a reply is legally required" since the keywords
  //    were written, and nothing ever replied — the classification was used
  //    only to keep the agent away. Carriers check this during A2P vetting.
  const help = await ingest(msg("HELP", "e2e-help"));
  ok("HELP is recognised as a carrier keyword", help.keyword === "help");

  const { data: queued } = await sb.from("sms_scheduled_actions")
    .select("action, reply_body, reply_intent, run_at")
    .eq("conversation_id", help.conversationId)
    .eq("reply_intent", "help_response");
  const helpRow = (queued ?? [])[0];
  ok("…and a reply is queued for it", (queued ?? []).length === 1, String(queued?.length));
  ok("…carrying the four things CTIA asks for",
     helpReplyChecks(helpRow?.reply_body ?? "").every((c) => c.ok),
     helpRow?.reply_body ?? "nothing queued");
  ok("…due immediately, not after the human-pacing delay",
     new Date(helpRow?.run_at ?? 0).getTime() <= Date.now() + 1000);

  const { data: turns } = await sb.from("sms_scheduled_actions")
    .select("action").eq("conversation_id", help.conversationId).eq("action", "agent_turn");
  ok("…and the model is never asked to improvise it", (turns ?? []).length === 0,
     `${turns?.length ?? 0} agent turns`);

  // 7. A number nobody owns is not silently threaded somewhere wrong.
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
} catch (err) {
  // Without this an error part-way exits through finally as "N passed, 0 failed",
  // exit 0, with every later check skipped. It is a failure.
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const id of created.conversations) {
    // Scheduled actions first. recordInbound queues an agent_turn for every
    // reply that is not a STOP, and those rows reference the conversation —
    // the old hand-written copy never created them, so this delete is new.
    await sb.from("sms_scheduled_actions").delete().eq("conversation_id", id);
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
