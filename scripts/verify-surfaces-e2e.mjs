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

/* ── 5. Kate's shipped corpus, against the numbers the spec quotes ────── */

/**
 * THE SPEC QUOTES BASELINES. THEY HAVE TO STILL BE TRUE.
 *
 * The Iteration 1 Build Spec states figures as acceptance criteria — "A13
 * opens to 192 defects and 77 good turns", "A44 carries 117 defects and 0
 * good turns", "A35 carries none of either". Those are computed on KATE'S
 * CORPUS: the 2,806 findings over 999 conversations imported 2026-09-24.
 *
 * `sms_example_findings` holds 3,002 findings over 1,055 conversations,
 * because three earlier batches (2026-09-15, -16 and -22) added 196 findings
 * from 56 OTHER conversations. Checked on 2026-09-26: those 56 do not overlap
 * Kate's 999 at all, so they are extra conversations rather than a double
 * import — nothing to clean up, but they must not be counted when the
 * question being asked is "does this match what Kate shipped?".
 *
 * A13 is the only rule in the spec's list that appears in both, which is why
 * it is the only one where the screen (206/107) and the spec (192/77)
 * disagree. Scoped to Kate's batch every figure matches exactly, which is
 * what proves the import faithful.
 *
 * Pinned here so a re-import, a stray insert or a changed `kind` mapping
 * fails loudly instead of quietly moving a number the spec is written
 * against.
 */
const findingsAll = [];
for (let page = 0; ; page++) {
  const { data, error } = await sb.from("sms_example_findings")
    .select("code, kind, created_at, example_id").order("id").range(page * 1000, page * 1000 + 999);
  if (error) throw new Error(error.message);
  if (!data.length) break;
  findingsAll.push(...data);
  if (data.length < 1000) break;
}
const KATE_BATCH = "2026-09-24";
const kate = findingsAll.filter((f) => (f.created_at ?? "").startsWith(KATE_BATCH));

measured("findings in Kate's shipped batch", kate.length, 2000);
ok("Kate's batch is the corpus the spec quotes: 999 conversations",
   new Set(kate.map((f) => f.example_id)).size === 999,
   `${new Set(kate.map((f) => f.example_id)).size}`);

const tally = (code) => ({
  d: kate.filter((f) => f.code === code && f.kind !== "did_well").length,
  g: kate.filter((f) => f.code === code && f.kind === "did_well").length,
});
for (const [code, wantD, wantG] of [
  ["A13", 192, 77],   // the spec's worked example
  ["A44", 117, 0],    // a degenerate shape the spec names
  ["A40", 3, 61],
  ["A35", 0, 0],      // never exercised — must render, not error
  ["A45", 0, 0],      // Hatch had no such capability
]) {
  const t = tally(code);
  ok(`${code} matches the spec's baseline`, t.d === wantD && t.g === wantG,
     `spec ${wantD}/${wantG} · Kate's batch ${t.d}/${t.g}`);
}

/**
 * AND THE SCREEN KNOWS IT IS SHOWING MORE THAN THAT.
 *
 * Not a failure — the extra conversations are real. It is reported so nobody
 * reads a screen figure as the spec's figure. The Rule Hub has no corpus
 * filter yet; when it gets one, this is the number it should default to.
 */
const extra = findingsAll.length - kate.length;
console.log(`  i  the rules screen counts ${findingsAll.length} findings over ` +
  `${new Set(findingsAll.map((f) => f.example_id)).size} conversations — ` +
  `${extra} more than Kate's corpus, from ${new Set(findingsAll.filter((f) => !(f.created_at ?? "").startsWith(KATE_BATCH)).map((f) => f.example_id)).size} other conversations`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
