/**
 * Does the messaging system work as a SYSTEM?
 *
 * Every piece is unit-tested and mutation-tested in isolation. This is the
 * other question: do they compose? It walks a lead through the real production
 * code — the real routing, the real gate, the real scheduler RPC — against the
 * real database, and checks what actually happened.
 *
 *   npm run verify:messaging
 *
 * Everything it creates uses the reserved 555-015X range, which toE164 refuses
 * and no carrier will route, and it cleans up in a finally block — an earlier
 * verification script left a row behind because its cleanup sat after an
 * assertion that threw.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const base = new URL("../lib/messaging/", import.meta.url).pathname;
const { decideIntake } = await import(`${base}lead-intake.ts`);
const { gatedSend } = await import(`${base}gate.ts`);
const { LoggingTransport } = await import(`${base}transport.ts`);
const { toE164 } = await import(`${base}phone.ts`);

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (b, m, extra = "") => { b ? pass++ : fail++; console.log(`  ${b ? "✓" : "✗ FAIL"}  ${m}${extra ? `  ${extra}` : ""}`); };
const CUSTOMER = "+15550159901";      // reserved range, unroutable
const SUPPRESSED = "+15550159902";
const made = { conversations: [], leads: [], optOuts: [], actions: [] };

try {
  // ── the real workspaces, as routing will see them ──────────────────
  const { data: workspaces } = await sb.from("sms_sub_accounts")
    .select("id, name, is_active, phone_e164");
  console.log(`\nLEAD INTAKE — real routing against ${workspaces.length} real workspaces\n`);

  const lead = {
    sfRecordId: `00Q_E2E_${Date.now()}`,
    phone: "(555) 015-9901", state: "NY", locality: "Garden City", leadSource: "Referral",
  };
  const decision = decideIntake(lead, { workspaces });
  // toE164 rejects the reserved block by design, so intake correctly triages
  // it. That is the rule working, not a failure — use a routable number for
  // the routing half and keep the reserved one for anything that gets stored.
  ok(decision.action === "triage" && decision.reason === "no_contactable_phone",
     "a reserved 555-01XX number is refused at intake", `(${decision.action})`);

  const realish = decideIntake(
    { ...lead, phone: "516-892-3401" }, { workspaces });
  ok(realish.action === "route", "a routable Nassau lead routes", realish.action === "route" ? `→ ${realish.workspaceName}` : realish.detail);
  ok(realish.action === "route" && realish.workspaceName === "NY LI Nassau Leads",
     "…to the right workspace");

  const meta = decideIntake({ ...lead, phone: "516-892-3401", leadSource: "Meta Ad" }, { workspaces });
  ok(meta.action === "route" && meta.workspaceName === "NY LI Meta",
     "source beats region — a Meta lead goes to NY LI Meta");

  // ── a conversation, through the real tables ────────────────────────
  console.log(`\nCONVERSATION — real schema, real trigger\n`);
  const ws = workspaces.find((w) => w.name === "NY LI Nassau Leads");
  const { data: conv, error: convErr } = await sb.from("sms_conversations")
    .insert({ workspace_id: ws.id, customer_phone: CUSTOMER, state: "ai_active", consent_basis: "inquiry" })
    .select().single();
  ok(!convErr && conv, "conversation created", convErr?.message ?? "");
  if (conv) made.conversations.push(conv.id);

  const { data: acts } = await sb.from("sms_scheduled_actions").insert([
    { conversation_id: conv.id, action: "send_step", run_at: new Date(Date.now() - 60_000).toISOString() },
    { conversation_id: conv.id, action: "send_step", run_at: new Date(Date.now() + 3 * 864e5).toISOString() },
  ]).select();
  ok(acts?.length === 2, "two sends queued — one due now, one on day 3");

  // ── the real claim RPC ─────────────────────────────────────────────
  const { data: claimed, error: claimErr } = await sb.rpc("sms_claim_due_actions", { p_limit: 10 });
  const mine = (claimed ?? []).filter((a) => a.conversation_id === conv.id);
  ok(!claimErr && mine.length === 1, "the claim RPC took ONLY the due one", claimErr?.message ?? `(${mine.length})`);
  ok(mine[0]?.attempts === 1, "attempts incremented on CLAIM, not completion");

  const { data: reclaim } = await sb.rpc("sms_claim_due_actions", { p_limit: 10 });
  ok(!(reclaim ?? []).some((a) => a.conversation_id === conv.id),
     "a second worker cannot claim the same row");

  // ── the real gate, real suppression, fake carrier ──────────────────
  console.log(`\nTHE GATE — real rules, real opt-out table, fake carrier\n`);
  await sb.from("sms_opt_outs").insert({ phone_e164: SUPPRESSED, source: "inbound_keyword", channel: "sms" });
  made.optOuts.push(SUPPRESSED);

  const deps = {
    transport: new LoggingTransport(),
    isSuppressed: async (target) => {
      if (!target.phone) return true;
      const { data } = await sb.from("sms_opt_outs").select("id")
        .eq("phone_e164", target.phone).is("opted_in_at", null).maybeSingle();
      return !!data;
    },
    sentToday: async () => 0,
  };
  const gws = {
    id: ws.id, name: ws.name, phone_e164: ws.phone_e164,
    time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20, send_on_weekends: true,
  };
  const noon = new Date("2026-09-09T16:00:00Z");   // 12:00 EDT, Wednesday
  const night = new Date("2026-09-09T03:00:00Z");  // 23:00 EDT

  const sent = await gatedSend({ workspace: gws, to: CUSTOMER, body: "Hello from PPP", agent: "lead_nurture", now: noon }, deps);
  ok(sent.ok, "a normal message passes the gate", sent.ok ? "" : sent.reason);
  ok(deps.transport.sent.length === 1, "…and reached the (fake) carrier exactly once");
  ok(deps.transport.sent[0]?.from === ws.phone_e164, "…sent FROM the workspace's own number");

  const blocked = await gatedSend({ workspace: gws, to: SUPPRESSED, body: "Hello", agent: "lead_nurture", now: noon }, deps);
  ok(!blocked.ok && blocked.reason === "suppressed", "a suppressed number is blocked", blocked.ok ? "SENT!" : blocked.reason);
  ok(deps.transport.sent.length === 1, "…and the carrier was NOT called again");

  const deferred = await gatedSend({ workspace: gws, to: CUSTOMER, body: "Hello", agent: "lead_nurture", now: night }, deps);
  ok(!deferred.ok && deferred.reason === "quiet_hours", "11pm is deferred, not dropped");
  ok(!deferred.ok && deferred.retryAt instanceof Date, "…and it says when to retry", !deferred.ok ? String(deferred.retryAt) : "");
  ok(deps.transport.sent.length === 1, "…and the carrier was still not called");

  // ── the trigger, on the real conversation ──────────────────────────
  console.log(`\nBOOKED MONDAY, CHASED FRIDAY — the trigger\n`);
  const before = await sb.from("sms_scheduled_actions").select("state").eq("conversation_id", conv.id);
  ok(before.data.some((a) => a.state !== "cancelled"), "sends are still live before the booking");

  await sb.from("sms_conversations")
    .update({ state: "ended", outcome: "success", ended_at: new Date().toISOString() })
    .eq("id", conv.id);

  const after = await sb.from("sms_scheduled_actions").select("state, cancelled_reason").eq("conversation_id", conv.id);
  ok(after.data.every((a) => a.state === "cancelled"),
     "booking cancels EVERY remaining send", after.data.map((a) => a.state).join(", "));
  ok(/success/.test(after.data[0]?.cancelled_reason ?? ""), "…and records why", after.data[0]?.cancelled_reason ?? "");

  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURES`} — ${pass} checks\n`);
} finally {
  // In a finally block on purpose. An earlier verification script left a row
  // behind because its cleanup came after an assertion that threw.
  for (const id of made.conversations) await sb.from("sms_conversations").delete().eq("id", id);
  for (const p of made.optOuts) await sb.from("sms_opt_outs").delete().eq("phone_e164", p);
  const { count } = await sb.from("sms_conversations").select("*", { count: "exact", head: true }).like("customer_phone", "+1555015990%");
  console.log(`cleanup: ${count} test conversations remain (expect 0)`);
}
process.exit(fail === 0 ? 0 : 1);
