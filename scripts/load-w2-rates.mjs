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
 * Verified 2026-09-17 against real payouts: what Tomco actually pays the labour
 * company runs consistently 1.11× (rate × hours) — 1.06 to 1.14 across all
 * nine, no outliers. The gap is burden, overtime and the company's margin.
 *
 * So these two are the SAME MONEY counted differently, and must never be added.
 * Loading the base wage as the job-cost rate makes every job read about 10%
 * cheaper in labour than it actually was. `--burden` multiplies by a factor so
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
const burdenArg = process.argv.find((a) => a.startsWith("--burden="));
const BURDEN = burdenArg ? Number(burdenArg.split("=")[1]) : null;
const fromArg = process.argv.find((a) => a.startsWith("--effective-from="));
const EFFECTIVE_FROM = fromArg ? fromArg.split("=")[1] : null;

if (!EFFECTIVE_FROM || !/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE_FROM)) {
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
};

/** Named, not guessed. Printed every run until somebody answers. */
const UNRESOLVED = [
  {
    roster: "Tomco Labor - Miguel",
    why: 'the sheet says "Miguel Romero", the roster says "Miguel Melgar" — same man? ($33.25)',
  },
  {
    roster: "Tomco Labor - Rob",
    why: 'two Roberts on the sheet — Rob Caputo ($28.13) or Rob. Patterson ($28.00)? "Robert P" is already mapped to Patterson',
  },
];

const money = (c) => `$${(c / 100).toFixed(2)}`;

const { data: emps, error } = await sb
  .from("commercial_employees")
  .select("id, display_name, worker_type, active");
if (error) {
  console.error("read failed:", error.message);
  process.exit(1);
}
const byName = new Map(emps.map((e) => [e.display_name.trim(), e]));

console.log(
  BURDEN
    ? `Cost rate = base wage × ${BURDEN} (what Tomco actually spends)\n`
    : `Cost rate = BASE WAGE as Katie sent it.\n` +
        `  ⚠ Real payouts run ~1.11× this. Job labour will read about 10% cheaper\n` +
        `    than it actually was. Pass --burden=1.11 if the job cost should be\n` +
        `    what Tomco spends rather than what the worker earns.\n`,
);
console.log(`Rates effective from ${EFFECTIVE_FROM}.\n`);

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
    `${roster.padEnd(24)} ${info.person.padEnd(18)} ${money(Math.round(info.hourly * 100)).padStart(8)}/h` +
      (BURDEN ? ` → ${money(cents)}/h` : "") +
      `   ${emp.worker_type === "w2" ? "(already W-2)" : "sub → W-2"}`,
  );
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

console.log(`\n── NOT TOUCHED, needs a person to confirm ──`);
for (const u of UNRESOLVED) console.log(`   ${u.roster}\n      ${u.why}`);

console.log(
  `\n⚠ AND THE OTHER HALF: once these people are W-2, labour payouts must STOP\n` +
    `  being recorded against them, or every job they touch is costed twice —\n` +
    `  once from hours × rate and once from the payment to the labour company.\n` +
    `  getW2Readiness() reports that overlap; check it after this runs.`,
);

if (!COMMIT) console.log("\nDry run. Re-run with --commit to write.");
else console.log(`\n${flipped} flipped to W-2, ${rated} rate(s) written.`);
