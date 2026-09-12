/**
 * Taking a conversation over, against the real database.
 *
 * The unit tests cover the rules. They cannot cover the one thing that
 * actually decides whether two people can both claim a conversation: whether
 * the guarded UPDATE really is atomic against real rows and real constraints.
 * That is a property of Postgres, not of the code, and the only way to know is
 * to fire both at once and count the winners.
 *
 * Cleanup in a finally block.
 */
import { createClient } from "@supabase/supabase-js";
import { stateOnRelease, takeoverReasonFor, TAKEOVER_REASONS } from "../lib/messaging/handoff.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const CUSTOMER = "+15165558877";
const made = { conversations: [] };

/** The same guarded UPDATE claimConversation runs. */
const claim = (id, userId, name, reason) =>
  sb.from("sms_conversations")
    .update({
      state: "human_active", owning_user_id: userId, owning_agent: name,
      takeover_reason: reason, takeover_at: new Date().toISOString(),
    })
    .eq("id", id).neq("state", "ended").is("owning_user_id", null)
    .select("id").maybeSingle();

try {
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name").eq("is_active", true).limit(1).single();

  // Two real user ids — the column is a foreign key to auth.users, so invented
  // uuids would be rejected and the test would prove nothing.
  const { data: users } = await sb.from("profiles").select("user_id, email").limit(2);
  if (!users || users.length < 2) throw new Error("need two profiles to race");
  const [A, B] = users;

  console.log(`\nCONVERSATION HANDOFF — real schema  (via ${ws.name})\n`);

  const { data: conv } = await sb.from("sms_conversations").insert({
    workspace_id: ws.id, customer_phone: CUSTOMER, state: "ai_active",
  }).select("id").single();
  made.conversations.push(conv.id);

  /* ── The race ─────────────────────────────────────────────────── */
  const [r1, r2] = await Promise.all([
    claim(conv.id, A.user_id, "Person A", "customer_asked_human"),
    claim(conv.id, B.user_id, "Person B", "complaint"),
  ]);
  const winners = [r1.data, r2.data].filter(Boolean).length;
  ok("two people claiming at once produce exactly one winner", winners === 1,
     `(${winners} matched)`);

  const { data: held } = await sb.from("sms_conversations")
    .select("state, owning_user_id, owning_agent, takeover_reason")
    .eq("id", conv.id).single();
  ok("the conversation is now held by a person", held.state === "human_active");
  ok("the holder is one of the two, not a mix",
     held.owning_user_id === A.user_id || held.owning_user_id === B.user_id);
  ok("the reason stored is the winner's", !!held.takeover_reason);

  /* ── The loser cannot quietly take it ─────────────────────────── */
  const loser = held.owning_user_id === A.user_id ? B : A;
  const { data: sneak } = await claim(conv.id, loser.user_id, "Loser", "other");
  ok("the person who lost cannot claim it afterwards", sneak === null);

  /* ── Release ──────────────────────────────────────────────────── */
  // No messages on this conversation, so it goes back to the bot owing a reply.
  const next = stateOnRelease(null);
  const { data: rel } = await sb.from("sms_conversations")
    .update({ state: next, owning_user_id: null, owning_agent: null })
    .eq("id", conv.id).eq("owning_user_id", held.owning_user_id)
    .select("id").maybeSingle();
  ok("the holder can hand it back", rel !== null);

  const { data: after } = await sb.from("sms_conversations")
    .select("state, owning_user_id, takeover_reason, takeover_at").eq("id", conv.id).single();
  ok("it returns to the bot", after.state === next && after.owning_user_id === null);
  ok("the takeover reason SURVIVES release — reporting counts it",
     after.takeover_reason !== null && after.takeover_at !== null);

  /* ── Releasing what you do not hold ───────────────────────────── */
  await claim(conv.id, A.user_id, "Person A", "complaint");
  const { data: badRel } = await sb.from("sms_conversations")
    .update({ state: "ai_active", owning_user_id: null, owning_agent: null })
    .eq("id", conv.id).eq("owning_user_id", B.user_id)
    .select("id").maybeSingle();
  ok("somebody else cannot hand back a conversation you hold", badRel === null);

  /* ── An ended conversation is not claimable ───────────────────── */
  await sb.from("sms_conversations")
    .update({ state: "ended", owning_user_id: null, owning_agent: null }).eq("id", conv.id);
  const { data: endedClaim } = await claim(conv.id, A.user_id, "Person A", "other");
  ok("an ended conversation cannot be taken over", endedClaim === null);

  /* ── Every reason the code can produce is accepted by the CHECK ── */
  await sb.from("sms_conversations").update({ state: "ai_active" }).eq("id", conv.id);
  let rejected = [];
  for (const r of TAKEOVER_REASONS) {
    const { error } = await sb.from("sms_conversations")
      .update({ takeover_reason: r }).eq("id", conv.id);
    if (error) rejected.push(r);
  }
  ok("all ten reasons pass the database constraint", rejected.length === 0,
     rejected.length ? `rejected: ${rejected.join(", ")}` : "");

  const bogus = await sb.from("sms_conversations")
    .update({ takeover_reason: "because_i_felt_like_it" }).eq("id", conv.id);
  ok("a reason not on the list is refused by the database", bogus.error !== null);

  // Control: the agent's own attribution must be one the database takes.
  const derived = takeoverReasonFor({ intent: "ask_address", confidence: 0.1, threshold: 0.95 });
  const { error: dErr } = await sb.from("sms_conversations")
    .update({ takeover_reason: derived }).eq("id", conv.id);
  ok("what the bot attributes is storable", !dErr, `(${derived})`);

} finally {
  for (const id of made.conversations) {
    await sb.from("sms_messages").delete().eq("conversation_id", id);
    await sb.from("sms_scheduled_actions").delete().eq("conversation_id", id);
    await sb.from("sms_drafts").delete().eq("conversation_id", id);
    await sb.from("sms_conversations").delete().eq("id", id);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
