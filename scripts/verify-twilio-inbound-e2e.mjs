/**
 * The Twilio inbound chain, against the real database.
 *
 * The pieces have unit tests: the signature matches Twilio's own library, the
 * payload maps into the shape decideInbound reads, and recordInbound is
 * exercised by verify-inbound-e2e. What none of them prove is that the four
 * fit together — that a request signed the way Twilio signs it, carrying the
 * fields Twilio actually sends, ends up as the right rows.
 *
 * So this signs a real form body with a real HMAC, verifies it the way the
 * route does, and records it. Nothing is mocked except the network hop.
 *
 * It sends nothing. The transport is never constructed here, and everything
 * written is deleted in finally.
 */
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import {
  verifyTwilioSignature, formParams, twilioToInbound, webhookUrl,
} from "../lib/messaging/twilio-webhook.ts";
import { decideInbound } from "../lib/messaging/inbound.ts";
import { recordInbound } from "../lib/messaging/record-inbound.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

// A number that is valid but nobody's. NOT 555-01XX, which phone.ts refuses.
const CUSTOMER = "+15165551234";
const URL_CALLED = "https://cc.example.com/api/webhooks/twilio-inbound";
const TOKEN = "e2e-not-a-real-auth-token-000000";
const created = { conversations: [], optOuts: [] };

/** Sign a form body exactly as Twilio does, so the route's check is real. */
function signedRequest(fields) {
  const body = new URLSearchParams(fields).toString();
  const params = formParams(new URLSearchParams(body));
  const payload = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], URL_CALLED);
  const signature = createHmac("sha1", TOKEN).update(Buffer.from(payload, "utf8")).digest("base64");
  return { body, signature };
}

/** Everything app/api/webhooks/twilio-inbound/route.ts does, minus the HTTP. */
async function deliver({ body, signature }) {
  const params = formParams(new URLSearchParams(body));
  const url = webhookUrl({
    configured: undefined,
    requestUrl: "http://internal.local/api/webhooks/twilio-inbound",
    forwardedProto: "https",
    forwardedHost: "cc.example.com",
  });
  const verified = verifyTwilioSignature({ authToken: TOKEN, url, params, signature });
  if (!verified.ok) return { status: 403, reason: verified.reason };

  const decision = decideInbound(twilioToInbound(params));
  if (decision.kind === "reject") return { status: 204, dropped: decision.code };

  const res = await recordInbound(sb, decision);
  if (res.conversationId && !created.conversations.includes(res.conversationId)) {
    created.conversations.push(res.conversationId);
  }
  if (decision.keyword === "opt_out") created.optOuts.push(decision.from);
  return { status: 204, ...res, keyword: decision.keyword };
}

try {
  const { data: workspace } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164").eq("is_active", true).not("phone_e164", "is", null).limit(1).single();
  console.log(`\nTWILIO INBOUND — real signature, real rows  (via ${workspace.name})\n`);

  const field = (body, sid, extra = {}) => ({
    From: CUSTOMER, To: workspace.phone_e164, Body: body,
    MessageSid: sid, NumMedia: "0", AccountSid: "ACe2e", ApiVersion: "2010-04-01",
    ...extra,
  });

  /* ── The URL rebuilt from the proxy headers is the one that was signed ── */
  const first = await deliver(signedRequest(field("Hi, do you paint cabinets?", "SMe2e1")));
  ok("a signed reply is accepted and threaded", first.status === 204 && typeof first.conversationId === "string",
     first.reason ?? first.dropped ?? "");

  /* ── Tampering is caught ──────────────────────────────────────────────── */
  const legit = signedRequest(field("Yes please book me in", "SMe2e2"));
  const tampered = { body: legit.body.replace("SMe2e2", "SMe2eX"), signature: legit.signature };
  const rejected = await deliver(tampered);
  ok("a body edited after signing is refused", rejected.status === 403, rejected.reason ?? "");

  const wrongToken = { body: legit.body, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
  ok("a forged signature is refused", (await deliver(wrongToken)).status === 403);

  /* ── The real one still gets through afterwards ───────────────────────── */
  const second = await deliver(legit);
  ok("the untampered request threads into the same conversation",
     second.conversationId === first.conversationId);

  /* ── Twilio's fallback URL can replay a message ───────────────────────── */
  const replay = await deliver(legit);
  ok("a replayed MessageSid is recognised, not duplicated", replay.isNew === false);
  const { count } = await sb.from("sms_messages")
    .select("*", { count: "exact", head: true }).eq("conversation_id", first.conversationId);
  ok("…and the thread holds exactly two messages", count === 2, `got ${count}`);

  /* ── STOP, which is the one that must never be lost ───────────────────── */
  const stop = await deliver(signedRequest(field("STOP", "SMe2e3")));
  ok("STOP arriving over Twilio suppresses the handset", stop.keyword === "opt_out");
  const { data: sup } = await sb.from("sms_opt_outs")
    .select("phone_e164, inbound_body").eq("phone_e164", CUSTOMER).is("opted_in_at", null);
  ok("…and there is exactly one active suppression", (sup ?? []).length === 1);
  ok("…with the exact words kept as evidence", sup?.[0]?.inbound_body === "STOP", sup?.[0]?.inbound_body ?? "");

  /* ── An emoji body must verify, which is where byte-vs-character bugs hide ── */
  const emoji = await deliver(signedRequest(field("sounds good 👍", "SMe2e4")));
  ok("a message with an emoji verifies and is recorded", emoji.status === 204 && !emoji.dropped,
     emoji.reason ?? emoji.dropped ?? "");

  /* ── MMS: the media is noted, never fetched ───────────────────────────── */
  const mms = await deliver(signedRequest(field("", "SMe2e5", {
    NumMedia: "1", MediaUrl0: "https://api.twilio.com/media/ME1", MediaContentType0: "image/jpeg",
  })));
  ok("a photo with no text is accepted rather than dropped as empty",
     mms.status === 204 && !mms.dropped, mms.dropped ?? "");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} catch (err) {
  // Without this, an error part-way through exits via finally as "N passed,
  // 0 failed" with every later check silently skipped.
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const id of created.conversations) {
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
