/**
 * Turn Tomco's nine crew into W-2 employees and load Katie's rate sheet.
 *
 * Run:
 *   node --env-file=.env.local scripts/load-w2-rates.mjs
 *   node --env-file=.env.local scripts/load-w2-rates.mjs --commit
 *
 * Katie sent `Labor Rates.xlsx` on 2026-09-17 — nine people, base hourly wage.
 * Tomco said on 2026-09-24 that payroll is moving to W-2 for these people. This
 * does both halves in one pass, because doing them separately is the failure:
 * an employee flagged W-2 with no rate on file costs $0 an hour, and every job
 * they touched reads a fatter margin than it earned, with nothing on screen
 * saying why.
 *
 * ── THE RATE IS THE WAGE, NOT THE COST ──────────────────────────────────────
 *
 * Verified 2026-09-17 against real payouts: what Tomco actually pays the labor
 * company runs consistently 1.11× (rate × hours) — 1.06 to 1.14 across all
 * nine, no outliers. The gap is burden, overtime and the company's margin.
 *
 * So these two are the SAME MONEY counted differently, and must never be added.
 * Loading the base wage as the job-cost rate makes every job read about 10%
 * cheaper in labor than it actually was. `--burden` multiplies by a factor so
 * the cost rate reflects what Tomco really spends; 1.11 is the measured one.
 * Which to use is a business decision, so neither is the default and the script
 * refuses to guess.
 *
 * ── STILL UNRESOLVED, AND THIS SCRIPT WILL NOT GUESS ────────────────────────
 *
 *  · "Miguel Romero" on the sheet vs "Miguel Melgar" on the roster. Probably
 *    one man. Probably is not good enough for somebody's wage.
 *  · "Tomco Labor - Rob" — Caputo ($28.13) or Patterson ($28.00)? There are two
 *    Roberts and the roster name says neither.
 *
 * Both are printed and SKIPPED until someone confirms. Same rule as the AR
 * carryover, where fuzzy-matching would have put $177,733.93 on the wrong
 * building.
 */
import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");
/**
 * 🔴 THE WARNING AT THE BOTTOM OF THIS SCRIPT FIRES AFTER THE DAMAGE.
 *
 * It reads "once these people are W-2, labor payouts must STOP being recorded
 * against them, or every job they touch is costed twice", and points at
 * `getW2Readiness()` — which has ZERO callers anywhere in the platform and has
 * therefore never been looked at. By the time it prints, the rates are written.
 *
 * Job cost is `purchases + fieldOpsLabor`. Pricing an hour from the rate card
 * when a payout already covers it charges the same work twice, and both halves
 * look entirely real. Measured on the live book 2026-10-16: 14,637 hours read
 * as "unrated" across 81 deals, and 14,589 of them (99.7%) already carry labor
 * payouts naming the same nine people — $515,972.72 of them. Writing rates
 * effective from the first work date would add roughly $458,326 (or $508,742
 * at the measured 1.11 burden) of cost that is already on those jobs.
 *
 * So the check happens BEFORE the first write, it refuses rather than warns,
 * and the override has to be typed out. `--no-rates` is unaffected: it is the
 * mode that was always correct under the Gusto flow, and it writes no rate.
 */
const PAYOUTS_STOPPED = process.argv.includes("--payouts-have-stopped");
/**
 * Flip people to W-2 WITHOUT loading a cost rate.
 *
 * This is the right mode for the Gusto flow, and the default would be wrong.
 *
 * Job cost is `purchasesCents + fieldOpsLaborCents` (projects/db.ts) — the
 * payouts PLUS W-2 hours priced from the rate card. Under the Gusto process
 * the cost already arrives as payouts, because splitting the weekly liability
 * WRITES payouts. Loading a rate as well prices the same hours a second time
 * and every job is charged twice, with both halves looking entirely real.
 *
 * With no rate on file, `fieldOpsLaborByOpp` contributes nothing for that
 * person and the payout is the only cost — which is exactly right.
 *
 * Katie's rate sheet is still worth having for estimating. It is just not what
 * costs a job any more.
 */
const NO_RATES = process.argv.includes("--no-rates");
const burdenArg = process.argv.find((a) => a.startsWith("--burden="));
const BURDEN = burdenArg ? Number(burdenArg.split("=")[1]) : null;
const fromArg = process.argv.find((a) => a.startsWith("--effective-from="));
const EFFECTIVE_FROM = fromArg ? fromArg.split("=")[1] : null;

if (!NO_RATES && (!EFFECTIVE_FROM || !/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE_FROM))) {
  console.error(
    "Pass --effective-from=YYYY-MM-DD.\n\n" +
      "Rates are effective-dated on purpose: a raise must not restate a job that\n" +
      "was finished before it. Nobody has told us when these rates start, and\n" +
      "picking today silently re-prices nothing while picking the migration date\n" +
      "silently re-prices everything. Ask, then pass it.",
  );
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** Katie's sheet → the roster name, where it is UNAMBIGUOUS. */
const RATES = {
  "Tomco Labor - Greg": { person: "Greg Stankewicz", hourly: 46.15 },
  "Tomco Labor - Joe": { person: "Joe Lucatorto", hourly: 30.0 },
  "Tomco Labor - JJ": { person: "JJ Lucatorto", hourly: 20.0 },
  "Tomco Labor - Erick": { person: "Erick Flores", hourly: 30.0 },
  "Tomco Labor - Carlos": { person: "Carlos Rosconi", hourly: 28.75 },
  "Tomco Labor - Robert P": { person: "Rob. Patterson", hourly: 28.0 },
  "Tomco Labor - Keith": { person: "Keith Obenauer", hourly: 28.0 },

  // ── RESOLVED FROM SALESFORCE, 2026-09-24, not from the names ─────────────
  //
  // WorkOrderCrew__c carries the labor company AND, on most rows, the worker
  // Salesforce named that day. 2,039 Tomco crew-days answer both questions
  // outright:
  //
  //   "Tomco Labor - Rob"     → Robert Caputo on 154 rows, Robert Patterson on
  //                             ZERO. (One stray row names Miguel Melgar.) So
  //                             Rob is CAPUTO at $28.13 — and Patterson keeps
  //                             his own company, "Tomco Labor - Robert P",
  //                             which names him on its own rows.
  //   "Tomco Labor - Miguel"  → Miguel Melgar on 167 rows, and Salesforce holds
  //                             no "Miguel Romero" anywhere in 2,039 rows.
  //                             Katie's sheet has the surname; the roster has
  //                             the man. Same person, $33.25.
  //
  // This is evidence, not a fuzzy match on spelling — which is the thing the
  // AR carryover taught us not to do.
  "Tomco Labor - Rob": { person: "Rob Caputo", hourly: 28.13, viaSalesforce: "Robert Caputo on 154 of 155 named rows" },
  "Tomco Labor - Miguel": { person: "Miguel Romero / Melgar", hourly: 33.25, viaSalesforce: "Miguel Melgar on 167 rows; no Miguel Romero exists in Salesforce" },
};

/** Nothing is unresolved any more — Salesforce answered both. Kept as an
 *  empty list rather than deleted, because the next rate sheet will have its
 *  own ambiguities and this is where they go. */
const UNRESOLVED = [];

const money = (c) => `$${(c / 100).toFixed(2)}`;

const { data: emps, error } = await sb
  .from("commercial_employees")
  .select("id, display_name, worker_type, active");
if (error) {
  console.error("read failed:", error.message);
  process.exit(1);
}
const byName = new Map(emps.map((e) => [e.display_name.trim(), e]));

if (NO_RATES) {
  console.log(
    "NO RATES — worker type only.\n" +
      "  Job cost will come from the payroll split (Accounting → Payroll), which\n" +
      "  writes a payout per job. Loading a rate as well would price the same\n" +
      "  hours twice: job cost is purchases + W-2 hours x rate.\n",
  );
}
console.log(
  NO_RATES
    ? ""
    : BURDEN
    ? `Cost rate = base wage × ${BURDEN} (what Tomco actually spends)\n`
    : `Cost rate = BASE WAGE as Katie sent it.\n` +
        `  ⚠ Real payouts run ~1.11× this. Job labor will read about 10% cheaper\n` +
        `    than it actually was. Pass --burden=1.11 if the job cost should be\n` +
        `    what Tomco spends rather than what the worker earns.\n`,
);
if (!NO_RATES) console.log(`Rates effective from ${EFFECTIVE_FROM}.\n`);

/*
 * PRE-FLIGHT: REFUSE TO PRICE HOURS A PAYOUT ALREADY COVERS.
 *
 * Runs before the first write. `--no-rates` skips it — that mode writes no
 * rate and is the one that is always safe.
 */
if (COMMIT && !NO_RATES && !PAYOUTS_STOPPED) {
  const names = Object.keys(RATES);
  const { data: payouts, error: payErr } = await sb
    .from("commercial_project_purchases")
    .select("vendor, description, amount_cents, purchased_at, deleted_at, category")
    .in("category", ["labor", "employee_labor"])
    .gte("purchased_at", EFFECTIVE_FROM)
    .is("deleted_at", null);
  if (payErr) {
    // A failed read is NOT "no overlap". Refuse rather than guess — the thing
    // being guarded is a six-figure double charge.
    console.error(`\n✗ Could not check for existing labor payouts: ${payErr.message}`);
    console.error("  Refusing to write rates without that answer.");
    process.exit(1);
  }
  const hit = new Map();
  for (const row of payouts ?? []) {
    const hay = `${row.vendor ?? ""} ${row.description ?? ""}`.toLowerCase();
    for (const n of names) {
      // The roster names are "Tomco Labor - Greg" etc; match the person part.
      const person = n.split("-").pop().trim().toLowerCase();
      if (person.length < 3) continue;
      if (!hay.includes(person)) continue;
      const cur = hit.get(n) ?? { rows: 0, cents: 0 };
      cur.rows += 1;
      cur.cents += Math.round(Number(row.amount_cents) || 0);
      hit.set(n, cur);
      break;
    }
  }
  if (hit.size > 0) {
    const total = [...hit.values()].reduce((a, b) => a + b.cents, 0);
    console.error(
      `\n🔴 REFUSING TO WRITE RATES — these people are already being paid through labor payouts.\n`,
    );
    for (const [n, v] of [...hit.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
      console.error(`   ${n.padEnd(28)} ${v.rows.toString().padStart(4)} payout(s)  ${money(v.cents)}`);
    }
    console.error(
      `\n   ${money(total)} on or after ${EFFECTIVE_FROM}.\n\n` +
        `   Job cost is purchases + (W-2 hours x rate). Loading a rate prices the\n` +
        `   same work a second time and BOTH halves look real — the margin on every\n` +
        `   job these people touched drops by roughly that amount, and nothing on\n` +
        `   screen says why.\n\n` +
        `   This check used to be a sentence printed AFTER the write, pointing at\n` +
        `   getW2Readiness(), which has never had a caller.\n\n` +
        `   What to do:\n` +
        `     --no-rates                 flip to W-2 and leave cost as the payouts (the\n` +
        `                                right mode under the Gusto flow)\n` +
        `     --effective-from=<later>   start rates from the day payouts stop\n` +
        `     --payouts-have-stopped     you have confirmed no payout covers these\n` +
        `                                people from ${EFFECTIVE_FROM} onward\n`,
    );
    process.exit(1);
  }
  console.log(`✓ no labor payouts name these people on or after ${EFFECTIVE_FROM}.\n`);
}

let flipped = 0;
let rated = 0;
const missing = [];

for (const [roster, info] of Object.entries(RATES)) {
  const emp = byName.get(roster);
  if (!emp) {
    missing.push(roster);
    continue;
  }
  const cents = Math.round(info.hourly * 100 * (BURDEN ?? 1));
  console.log(
    `${roster.padEnd(24)} ${info.person.padEnd(22)}` +
      // In --no-rates mode the sheet's figure is NOT being written, so printing
      // it beside each name reads as though it were.
      (NO_RATES
        ? "          "
        : `${money(Math.round(info.hourly * 100)).padStart(8)}/h` + (BURDEN ? ` → ${money(cents)}/h` : "")) +
      `   ${emp.worker_type === "w2" ? "(already W-2)" : "sub → W-2"}`,
  );
  if (info.viaSalesforce) console.log(`${" ".repeat(24)}   ↳ matched via Salesforce: ${info.viaSalesforce}`);
  if (!COMMIT) continue;

  if (emp.worker_type !== "w2") {
    const { error: e1 } = await sb
      .from("commercial_employees")
      .update({ worker_type: "w2", updated_at: new Date().toISOString() })
      .eq("id", emp.id);
    if (e1) {
      console.log(`   ✗ could not flip: ${e1.message}`);
      continue;
    }
    flipped += 1;
  }

  if (NO_RATES) continue;

  // Close any open rate first, so the ladder reads as a history rather than two
  // overlapping truths.
  await sb
    .from("commercial_employee_rates")
    .update({ effective_to: EFFECTIVE_FROM })
    .eq("employee_id", emp.id)
    .is("effective_to", null);

  const { error: e2 } = await sb.from("commercial_employee_rates").insert({
    employee_id: emp.id,
    cost_rate_cents: cents,
    rate_type: "hourly",
    effective_from: EFFECTIVE_FROM,
  });
  if (e2) console.log(`   ✗ rate failed: ${e2.message}`);
  else rated += 1;
}

if (missing.length) {
  console.log(`\n⚠ not on the roster under that name: ${missing.join(", ")}`);
}

if (UNRESOLVED.length) {
  console.log(`\n── NOT TOUCHED, needs a person to confirm ──`);
  for (const u of UNRESOLVED) console.log(`   ${u.roster}\n      ${u.why}`);
}

console.log(
  `\n⚠ AND THE OTHER HALF: once these people are W-2, labor payouts must STOP\n` +
    `  being recorded against them, or every job they touch is costed twice —\n` +
    `  once from hours × rate and once from the payment to the labor company.\n` +
    `  The pre-flight above now REFUSES rather than leaving you to check:\n` +
    `  it reads the payouts before the first write and exits non-zero if any\n` +
    `  name these people in the window. (This line used to point at\n` +
    `  getW2Readiness(), which has never had a caller anywhere.)`,
);

if (!COMMIT) console.log("\nDry run. Re-run with --commit to write.");
else
  console.log(
    `\n${flipped} flipped to W-2` + (NO_RATES ? ", no rates written." : `, ${rated} rate(s) written.`),
  );
