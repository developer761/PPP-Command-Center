/**
 * Three data-entry errors in AIA payments, found by reconciling against
 * Salesforce job by job on 2026-10-13.
 *
 *   node --env-file=.env.local scripts/fix-aia-payment-errors.mjs
 *       dry run — prints what it WOULD do, touches nothing
 *   node --env-file=.env.local scripts/fix-aia-payment-errors.mjs --commit
 *
 * WHY
 *
 * Once invoice payments AND AIA payments are both counted, 88 of Tomco's 93
 * jobs match Salesforce to the cent. (Reconcile compares only invoice payments,
 * which is why its headline "collected" looks $800k short — AIA billing is
 * invisible to it by construction, not by mistake.) These are three of the five
 * jobs that genuinely did not match, and all three are typing mistakes:
 *
 *   1. THE BANNETT GROUP — $18,000.00 of money that was never received.
 *      Two identical $9,000.00 payments on 2026-09-30, same reference 530810,
 *      entered 84 seconds apart (16:19:39 and 16:21:03) — a double submit. The
 *      real payment was $9,500.00 and was entered separately two days later.
 *      Salesforce has only ever held $9,500.00 for that date.
 *
 *   2. GREEN LEAF FW WEBB — $60.00, transposed digits.
 *      Salesforce $6,600.00, here $6,660.00, on 2026-03-04.
 *
 *   3. AIREF BUILDING #3 — $0.01.
 *      Salesforce $43,252.08, here $43,252.07, on 2026-08-27. Corrected because
 *      "ties to the cent" has to mean the cent.
 *
 * NOT TOUCHED, deliberately:
 *   - Ascent-400, $75.00: two copies with DIFFERENT cheque numbers (974104 vs
 *     974107). Might be two real payments; only the bookkeeper can say.
 *   - DuCon TENANT, $865.57: not an error. INV-0025 was raised here for the
 *     ScuffX change order and paid — real billing Salesforce never saw.
 *
 * Each change is pinned to the exact row it expects. If the data has moved
 * since this was written, that step SKIPS rather than guessing.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const money = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const day = (v) => String(v ?? "").slice(0, 10);

/** The live AIA payments on one job, by its Salesforce work order number. */
async function paymentsFor(woNumber) {
  const { data: j, error: je } = await sb
    .from("commercial_jobs")
    .select("opportunity_id")
    .eq("job_code", `SF-${woNumber}`)
    .limit(1);
  if (je) throw new Error(je.message);
  const oppId = j?.[0]?.opportunity_id;
  if (!oppId) throw new Error(`no job SF-${woNumber}`);

  const { data: apps, error: ae } = await sb
    .from("commercial_aia_applications")
    .select("id, application_number, deleted_at")
    .eq("opportunity_id", oppId);
  if (ae) throw new Error(ae.message);

  const out = [];
  for (const a of apps ?? []) {
    if (a.deleted_at) continue;
    const { data: p, error: pe } = await sb
      .from("commercial_aia_payments")
      .select("*")
      .eq("application_id", a.id);
    if (pe) throw new Error(pe.message);
    for (const x of p ?? []) out.push({ ...x, application_number: a.application_number });
  }
  return out;
}

const planned = [];

// ── 1. Bannett Group: both $9,000.00 rows on 2026-09-30 are phantom ─────────
{
  const rows = await paymentsFor("00292951");
  const bogus = rows.filter((r) => r.amount_cents === 900_000 && day(r.paid_at) === "2026-09-30");
  if (bogus.length !== 2) {
    console.log(`⚠️  Bannett: expected 2 × $9,000.00 on 2026-09-30, found ${bogus.length} — SKIPPED.`);
  } else {
    for (const r of bogus) planned.push({ kind: "delete", row: r, why: "Bannett $9,000 double-submit" });
  }
}

// ── 2. Green Leaf: $6,660.00 → $6,600.00 ────────────────────────────────────
{
  const rows = await paymentsFor("00275012");
  const typo = rows.filter((r) => r.amount_cents === 666_000 && day(r.paid_at) === "2026-03-04");
  if (typo.length !== 1) {
    console.log(`⚠️  Green Leaf: expected 1 × $6,660.00 on 2026-03-04, found ${typo.length} — SKIPPED.`);
  } else {
    planned.push({ kind: "correct", row: typo[0], to: 660_000, why: "Green Leaf transposed digits" });
  }
}

// ── 3. AIREF #3: $43,252.07 → $43,252.08 ────────────────────────────────────
{
  const rows = await paymentsFor("00287823");
  const offByOne = rows.filter((r) => r.amount_cents === 4_325_207 && day(r.paid_at) === "2026-08-27");
  if (offByOne.length !== 1) {
    console.log(`⚠️  AIREF #3: expected 1 × $43,252.07 on 2026-08-27, found ${offByOne.length} — SKIPPED.`);
  } else {
    planned.push({ kind: "correct", row: offByOne[0], to: 4_325_208, why: "AIREF #3 one cent" });
  }
}

console.log(`\nAIA payment corrections — ${planned.length} row(s)\n`);
let removed = 0;
let adjusted = 0;
for (const p of planned) {
  if (p.kind === "delete") {
    removed += p.row.amount_cents;
    console.log(`  DELETE  ${money(p.row.amount_cents)}  ${day(p.row.paid_at)}  app#${p.row.application_number}  ref=${p.row.reference ?? "-"}  — ${p.why}`);
  } else {
    adjusted += p.to - p.row.amount_cents;
    console.log(`  CORRECT ${money(p.row.amount_cents)} → ${money(p.to)}  ${day(p.row.paid_at)}  app#${p.row.application_number}  — ${p.why}`);
  }
}
console.log(`\n  cash removed   ${money(removed)}`);
console.log(`  cash adjusted  ${money(adjusted)}`);

if (!COMMIT) {
  console.log(`\nDry run. Re-run with --commit to apply.\n`);
  process.exit(0);
}
if (planned.length === 0) {
  console.log(`\nNothing to do.\n`);
  process.exit(0);
}

// The backup comes first, holding each complete row, so any of this can be put
// back by hand without re-deriving it.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `/tmp/aia-payment-corrections-${stamp}.json`;
writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), planned }, null, 2));
console.log(`\nbackup written: ${path}`);

for (const p of planned) {
  if (p.kind === "delete") {
    const { error } = await sb.from("commercial_aia_payments").delete().eq("id", p.row.id);
    if (error) throw new Error(`delete ${p.row.id}: ${error.message}`);
  } else {
    const { error } = await sb.from("commercial_aia_payments").update({ amount_cents: p.to }).eq("id", p.row.id);
    if (error) throw new Error(`correct ${p.row.id}: ${error.message}`);
  }
}

console.log(`\n✅ applied. Confirm with:`);
console.log(`   node --env-file=.env.local scripts/import-tomco.mjs --reconcile\n`);
