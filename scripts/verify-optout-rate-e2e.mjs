/**
 * Opt-out rate per number, against the real database.
 *
 * The arithmetic is unit tested. What cannot be tested with fakes is the part
 * that decides whether the number is blamed correctly: an opt-out row carries
 * a phone number and nothing about WHICH of the fifteen numbers annoyed them.
 * It is attributed to the number that texted that person most recently, and
 * this builds exactly that situation — two workspaces text the same person,
 * one of them last — and checks the right one wears it.
 *
 * Everything it creates is deleted in finally. It sends nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { loadOptOutRates } from "../lib/messaging/db.ts";
import { rank, assess, MIN_PEOPLE } from "../lib/messaging/optout-rate.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const stamp = Date.now();
const made = { workspaces: [], conversations: [], optOuts: [] };
// Area code 999 is reserved and assigned to nobody.
const CUSTOMER = "+19992220160";

async function workspace(name, phone) {
  const { data, error } = await sb.from("sms_sub_accounts").insert({
    name, phone_e164: phone, time_zone: "America/New_York", is_active: true,
  }).select("id, name").single();
  if (error) throw new Error(`workspace: ${error.message}`);
  made.workspaces.push(data.id);
  return data;
}

async function texted(workspaceId, phone, when) {
  const { data: conv, error } = await sb.from("sms_conversations").insert({
    workspace_id: workspaceId, customer_phone: phone, state: "ai_active", consent_basis: "inquiry",
  }).select("id").single();
  if (error) throw new Error(`conversation: ${error.message}`);
  made.conversations.push(conv.id);
  const { error: mErr } = await sb.from("sms_messages").insert({
    conversation_id: conv.id, direction: "outbound", channel: "sms",
    body: "This is Precision Painting Plus. Reply STOP to opt out.",
    provider_id: `e2e-optout-${conv.id}`, created_at: when,
  });
  if (mErr) throw new Error(`message: ${mErr.message}`);
  return conv.id;
}

try {
  console.log(`\nOPT-OUT RATE — real schema\n`);

  const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
  const later = new Date(Date.now() - 1 * 3600_000).toISOString();

  const first = await workspace(`E2E OptOut First ${stamp}`, "+19992220161");
  const last = await workspace(`E2E OptOut Last ${stamp}`, "+19992220162");

  // Both text the same person; the second one texts them last.
  await texted(first.id, CUSTOMER, earlier);
  await texted(last.id, CUSTOMER, later);

  // ...and they opt out.
  const { error: oErr } = await sb.from("sms_opt_outs").insert({
    phone_e164: CUSTOMER, channel: "sms", source: "inbound_keyword",
    opted_out_at: new Date().toISOString(),
  });
  if (oErr) throw new Error(`opt-out: ${oErr.message}`);
  made.optOuts.push(CUSTOMER);

  const rows = await loadOptOutRates("7d");
  const byId = Object.fromEntries(rows.map((r) => [r.workspaceId, r]));

  ok("the number that texted them LAST wears the opt-out",
     byId[last.id]?.optOuts === 1, JSON.stringify(byId[last.id]));
  ok("the one that texted them earlier does not",
     byId[first.id]?.optOuts === 0, JSON.stringify(byId[first.id]));
  ok("both are credited with having texted the person",
     byId[first.id]?.peopleTexted === 1 && byId[last.id]?.peopleTexted === 1);

  /* ── One person is never enough to call a number bad ─────────── */
  const judged = assess(byId[last.id]);
  ok("one opt-out out of one person is reported, not condemned",
     judged.verdict === "quiet" && /too few/i.test(judged.note), `${judged.verdict}: ${judged.note}`);

  /* ── Real numbers are not dragged in ─────────────────────────── */
  const real = rows.filter((r) => !r.name.startsWith("E2E OptOut"));
  ok("every live workspace appears, including the quiet ones", real.length > 0, `${real.length} real workspaces`);
  const worst = rank(rows)[0];
  ok("the ranking puts the most worrying number first",
     worst.verdict === "high" || worst.verdict === "watch" || rows.every((r) => r.optOuts === 0 || r.peopleTexted < MIN_PEOPLE),
     `${worst.name}: ${worst.verdict}`);

  /* ── Somebody who opted back in is not counted ───────────────── */
  await sb.from("sms_opt_outs").update({ opted_in_at: new Date().toISOString() }).eq("phone_e164", CUSTOMER);
  const after = await loadOptOutRates("7d");
  const lastAfter = after.find((r) => r.workspaceId === last.id);
  ok("somebody who opted back in stops counting against the number", lastAfter?.optOuts === 0, JSON.stringify(lastAfter));

} catch (err) {
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (made.optOuts.length) await sb.from("sms_opt_outs").delete().in("phone_e164", made.optOuts);
  for (const id of made.workspaces) {
    await sb.from("sms_conversations").delete().eq("workspace_id", id);
    await sb.from("sms_sub_accounts").delete().eq("id", id);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
