/**
 * DO TWO SCREENS GIVE THE SAME ANSWER TO THE SAME QUESTION?
 *
 *   npm run verify:surfaces
 *
 * READ ONLY. It writes nothing and creates nothing. Every figure comes from
 * the function the screen itself calls, against real data.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Every module here is self-consistent. The damage is two surfaces answering
 * one question differently, which nobody sees unless they hold both at once.
 * That happened today, twice, to the same number:
 *
 *   the opt-out screen counted with an unbounded select, so it would have
 *   reported exactly 1,000 of 31,601 suppressions and looked plausible
 *
 *   the dashboard counted every row including people who had texted START,
 *   so somebody who opted back IN still counted towards the check that says
 *   it is safe to start sending
 *
 * Both were wrong. Neither test was wrong. Nothing compared them.
 *
 * ── THE RULES THIS FILE HOLDS ITSELF TO ─────────────────────────────────
 *
 * It says how much it measured, and it FAILS rather than passes when a set is
 * empty — a scan that silently matched nothing prints a clean bill over
 * nothing. Per-group as well as total, because two groups wrong in opposite
 * directions cancel out in a sum.
 */
import { createClient } from "@supabase/supabase-js";
import { readinessChecks, activeWorkspaces, loadBoard, messagingDb, suppressionCounts } from "../lib/messaging/db.ts";
import { loadRuleOverview } from "../lib/messaging/rules-db.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};
/** An identity is only meaningful over something. Nothing measured is a FAIL. */
const measured = (label, n, min = 1) =>
  ok(`measured something: ${label}`, n >= min, `${n} (need ≥ ${min})`);

/** Counts read straight from the table, owing nothing to either surface. */
const count = async (build) => {
  const { count: n, error } = await build(sb.from("sms_opt_outs").select("*", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  return n ?? 0;
};

console.log("\nTWO SURFACES, ONE QUESTION\n");

/* ── 1. How many people may we not text? ─────────────────────────────── */

const settings = await suppressionCounts(messagingDb());   // the opt-outs screen
const dashboard = await readinessChecks();                 // the launch checklist
const truthSms = await count((q) => q.not("phone_e164", "is", null).is("opted_in_at", null));
const truthEmail = await count((q) => q.not("email", "is", null).is("opted_in_at", null));

measured("suppressed phones", truthSms);
measured("suppressed addresses", truthEmail);
ok("the opt-out screen and the database agree on phones",
   settings.sms === truthSms, `screen ${settings.sms} · table ${truthSms}`);
ok("the opt-out screen and the database agree on addresses",
   settings.email === truthEmail, `screen ${settings.email} · table ${truthEmail}`);
ok("the DASHBOARD and the opt-out screen agree on phones",
   dashboard.optOutPhones === settings.sms, `dashboard ${dashboard.optOutPhones} · screen ${settings.sms}`);
ok("the DASHBOARD and the opt-out screen agree on addresses",
   dashboard.optOutEmails === settings.email, `dashboard ${dashboard.optOutEmails} · screen ${settings.email}`);

/**
 * AND NEITHER COUNTS SOMEBODY WHO OPTED BACK IN.
 *
 * Rows are never deleted — START sets opted_in_at — so "every row" and "every
 * ACTIVE row" are different questions, and the launch check was asking the
 * wrong one. Only meaningful if such a row exists, so it says when it cannot
 * tell rather than passing.
 */
const optedBackIn = await count((q) => q.not("opted_in_at", "is", null));
if (optedBackIn === 0) {
  console.log(`  –  nobody has opted back in yet, so the opted_in_at filter is UNPROVEN here (0 rows)`);
} else {
  const everyRow = await count((q) => q);
  ok("the suppression figures exclude people who opted back in",
     settings.sms + settings.email < everyRow,
     `active ${settings.sms + settings.email} < all ${everyRow}, ${optedBackIn} opted back in`);
}

/* ── 2. How many workspaces are live? ────────────────────────────────── */

const wss = await activeWorkspaces();
measured("active workspaces", wss.length);
ok("the sidebar and the launch checklist agree on workspaces",
   wss.length === dashboard.activeWorkspaces, `sidebar ${wss.length} · checklist ${dashboard.activeWorkspaces}`);

/* ── 3. The board, per column AND per workspace ──────────────────────── */

const board = await loadBoard();
const boardTotal = Object.values(board.counts).reduce((a, b) => a + b, 0);
measured("conversations on the board", boardTotal);

const stateOf = async (build) => {
  const { count: n, error } = await build(sb.from("sms_conversations").select("*", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  return n ?? 0;
};
ok("the inbox column matches the conversations that are not ended",
   board.counts.inbox === await stateOf((q) => q.neq("state", "ended")),
   `board ${board.counts.inbox}`);
ok("the sold column matches the conversations that ended in success",
   board.counts.sold === await stateOf((q) => q.eq("state", "ended").eq("outcome", "success")),
   `board ${board.counts.sold}`);

/**
 * PER WORKSPACE, not just the total. Two workspaces wrong in opposite
 * directions add up to a correct grand total and two wrong screens.
 */
let perWorkspaceOff = 0;
for (const w of wss) {
  const one = await loadBoard(w.id);
  const real = await stateOf((q) => q.eq("workspace_id", w.id).neq("state", "ended"));
  if (one.counts.inbox !== real) {
    perWorkspaceOff++;
    console.log(`     ${w.name}: board ${one.counts.inbox} · table ${real}`);
  }
}
ok("every workspace's own inbox count matches the table",
   perWorkspaceOff === 0, `${wss.length} workspaces checked`);

/* ── 4. The rules screen against the rules table ─────────────────────── */

/**
 * MY FIRST VERSION OF THIS ASSERTED THE WRONG IDENTITY.
 *
 * It compared the screen against sms_class_a_rules.measured_breaches, which
 * is NULL for all 35 live rules — a column Kate's sheet carries and does not
 * fill. The screen counts FINDINGS. The probe was wrong, not the product, and
 * reporting it as a bug would have sent somebody looking for one.
 */
const overview = await loadRuleOverview();          // exactly what the screen calls
const live = overview.filter((r) => r.status === "live");
measured("live rules on the screen", live.length);

const findings = [];
for (let page = 0; ; page++) {
  const { data, error } = await sb.from("sms_example_findings")
    .select("code, kind").not("code", "is", null).order("id").range(page * 1000, page * 1000 + 999);
  if (error) throw new Error(error.message);
  if (!data.length) break;
  findings.push(...data);
  if (data.length < 1000) break;
}
measured("findings recorded against a rule", findings.length);

const screenTotal = live.reduce((n, r) => n + r.counts.fellShort, 0);
const tableTotal = findings.filter((f) => f.kind !== "did_well" && live.some((r) => r.code === f.code)).length;
ok("the rules screen's breach total matches the findings table",
   screenTotal === tableTotal, `screen ${screenTotal} · findings ${tableTotal}`);

// PER RULE, not just the total: two rules wrong in opposite directions sum right.
let ruleOff = 0;
for (const r of live) {
  const mine = findings.filter((f) => f.code === r.code && f.kind !== "did_well").length;
  if (mine !== r.counts.fellShort) { ruleOff++; console.log(`     ${r.code}: screen ${r.counts.fellShort} · findings ${mine}`); }
}
ok("and every rule's own count matches", ruleOff === 0, `${live.length} rules checked`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
