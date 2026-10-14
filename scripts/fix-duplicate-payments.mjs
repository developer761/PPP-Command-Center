/**
 * The same cheque, banked twice — the twelve already in the book.
 *
 *   node --env-file=.env.local scripts/fix-duplicate-payments.mjs
 *       dry run — prints what it WOULD do, touches nothing
 *   node --env-file=.env.local scripts/fix-duplicate-payments.mjs --commit
 *
 * WHY
 *
 * During the dual run Mary records a payment here AND in Salesforce. The
 * importer then brings Salesforce's copy across as a NEW row, because the one
 * she typed carries no Salesforce id and nothing looked for one. Found
 * 2026-10-13 by `--reconcile`: 12 payments, $42,874.63 of cash counted twice,
 * ten of them carrying the same cheque number on both copies.
 *
 * It runs the dangerous way. Paid twice drives the balance negative, so the job
 * reads as settled, leaves AR, and nobody chases it.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO
 *
 * For each pair it keeps the row a PERSON typed and removes the importer's
 * copy, then re-points `commercial_import_map` at the kept row so the next sync
 * updates it instead of inserting a third.
 *
 * That direction is not arbitrary. The importer's copy is reproducible — it has
 * a Salesforce id and can be re-imported at any time. Mary's is not: delete it
 * and the only record of her having done the work is gone. So the recoverable
 * row is the one that goes.
 *
 * It will not touch a pair whose two copies name DIFFERENT cheque numbers. Two
 * cheques for the same amount on the same day is unusual, not impossible, and
 * merging them would lose real cash rather than duplicate it. Those are printed
 * for Mary.
 *
 * Every removed row is written to a JSON file first, in full, so it can be put
 * back by hand without re-running anything.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const money = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const day = (v) => String(v ?? "").slice(0, 10);
const ref = (v) => String(v ?? "").trim().toLowerCase();

async function all(table, columns, shape = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await shape(sb.from(table).select(columns).order("id").range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const payments = await all("commercial_invoice_payments", "*");
const mapRows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("commercial_import_map")
    .select("sf_id, row_id, updated_at")
    .eq("entity", "payment")
    .order("sf_id")
    .range(from, from + 999);
  if (error) throw new Error(`import map: ${error.message}`);
  mapRows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const sfIdFor = new Map(mapRows.map((m) => [m.row_id, m.sf_id]));

const invoices = await all("commercial_invoices", "id, invoice_number, opportunity_id, deleted_at");
const invById = new Map(invoices.map((i) => [i.id, i]));

/*
 * GROUPED BY JOB, NOT BY INVOICE.
 *
 * The first run of this script keyed on the invoice and cleared 10 pairs, then
 * `--reconcile` still showed J. Carleton Environmental Center $11,617.85 out.
 * Salesforce's invoice SF-00312838 covers the whole job; Mary also raised
 * INV-0027 here for the second half and recorded the payment against it. Same
 * amount, same day, same reference — two different invoices, so an
 * invoice-keyed group never put them side by side.
 *
 * Payments on a soft-deleted invoice are skipped: the platform stops counting
 * them with their parent, so they are not duplicated money and merging them
 * would be editing history for no gain.
 */
const groups = new Map();
for (const p of payments) {
  const inv = invById.get(p.invoice_id);
  if (!inv || inv.deleted_at) continue;
  const k = `${inv.opportunity_id}|${p.amount_cents}|${day(p.paid_at)}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}
const deals = await all("commercial_opportunities", "id, title");
const dealById = new Map(deals.map((d) => [d.id, d.title]));

const merges = [];
const conflicts = [];
const untouched = [];

for (const [, rows] of groups) {
  if (rows.length < 2) continue;
  const imported = rows.filter((p) => sfIdFor.has(p.id));
  const typed = rows.filter((p) => !sfIdFor.has(p.id));
  // Only the shape this was written for: exactly one of each. Anything else is
  // a situation nobody has looked at, so it is reported, never guessed at.
  if (imported.length !== 1 || typed.length !== 1) {
    untouched.push({ rows, why: `${imported.length} imported / ${typed.length} typed — not the one-each shape` });
    continue;
  }
  const a = ref(imported[0].reference), b = ref(typed[0].reference);
  const entry = { imported: imported[0], typed: typed[0], sfId: sfIdFor.get(imported[0].id) };
  /*
   * TWO INVOICES IS A DIFFERENT PROBLEM, AND REMOVING A PAYMENT MAKES IT WORSE.
   *
   * When both copies sit on the SAME invoice, dropping one restores the truth:
   * the invoice was paid once. When they sit on DIFFERENT invoices, the job has
   * been BILLED twice and the payment is only the symptom — J. Carleton
   * Environmental Center is invoiced $23,235.70 by Salesforce and another
   * $11,617.85 by INV-0027 raised here, for one $23,235.70 job.
   *
   * Remove the Salesforce-side payment there and the cash total comes out right
   * while SF-00312838 drops to half-paid — showing $11,617.85 owed that the
   * customer has already paid. That is not a fix; it moves the error from the
   * deposits into the receivables, which is exactly what happened the last time
   * a duplicate payment was deleted here.
   *
   * Which invoice is the real one is a question about what Mary intended, so it
   * is asked rather than assumed.
   */
  if (imported[0].invoice_id !== typed[0].invoice_id) {
    untouched.push({
      rows,
      why: "the two copies are on DIFFERENT invoices — the job is billed twice, so removing a payment would turn the double-count into a false receivable. Needs a decision on which invoice is right.",
    });
    continue;
  }
  if (a && b && a !== b) conflicts.push(entry);
  else merges.push(entry);
}

const describe = (p) => {
  const inv = invById.get(p.invoice_id);
  return `${String(dealById.get(inv?.opportunity_id) ?? "?").slice(0, 44)}  ${inv?.invoice_number ?? "?"}`;
};

console.log(`\nDuplicate payments — the same cheque banked twice\n`);
console.log(`  payments in the book : ${payments.length}`);
console.log(`  duplicate pairs      : ${merges.length + conflicts.length + untouched.length}\n`);

console.log(`── WOULD MERGE (${merges.length}) — keep what Mary typed, drop the importer's copy ──`);
let reclaimed = 0;
for (const e of merges) {
  reclaimed += e.imported.amount_cents;
  console.log(`  ${describe(e.typed)}  ${money(e.imported.amount_cents)}  ${day(e.typed.paid_at)}`);
  console.log(`     keep   ${e.typed.id}  ref=${e.typed.reference ?? "-"}  (typed here)`);
  console.log(`     remove ${e.imported.id}  ref=${e.imported.reference ?? "-"}  (from Salesforce ${e.sfId})`);
}
console.log(`\n  cash this takes back out of the book: ${money(reclaimed)}`);

if (conflicts.length) {
  console.log(`\n── LEFT ALONE (${conflicts.length}) — two different cheque numbers, needs Mary ──`);
  for (const e of conflicts) {
    console.log(`  ${describe(e.typed)}  ${money(e.imported.amount_cents)}  ${day(e.typed.paid_at)}`);
    console.log(`     typed here      ref=${e.typed.reference ?? "-"}`);
    console.log(`     from Salesforce ref=${e.imported.reference ?? "-"}`);
  }
}
if (untouched.length) {
  console.log(`\n── LEFT ALONE (${untouched.length}) — unexpected shape ──`);
  for (const u of untouched) console.log(`  ${describe(u.rows[0])}  ${money(u.rows[0].amount_cents)}  ${u.why}`);
}

if (!COMMIT) {
  console.log(`\nDry run. Re-run with --commit to apply.\n`);
  process.exit(0);
}

if (merges.length === 0) {
  console.log(`\nNothing to merge.\n`);
  process.exit(0);
}

// THE BACKUP COMES FIRST. Written before a single row is removed, holding the
// complete row, so putting one back needs no re-run and no Salesforce.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `/tmp/duplicate-payments-removed-${stamp}.json`;
writeFileSync(backup, JSON.stringify({
  removedAt: new Date().toISOString(),
  note: "Importer copies of payments Mary had already typed. The kept row's id is alongside each.",
  rows: merges.map((e) => ({ removed: e.imported, kept: e.typed.id, salesforceId: e.sfId })),
}, null, 2));
console.log(`\nbackup written: ${backup}`);

let done = 0;
for (const e of merges) {
  // Re-point the map FIRST. If anything fails after this, the worst case is a
  // map row pointing at Mary's payment and the duplicate still present — which
  // is the state we are already in, and a re-run fixes it. Deleting first and
  // failing here would leave an unmapped Salesforce payment that the next sync
  // inserts all over again.
  const { error: mapErr } = await sb
    .from("commercial_import_map")
    .update({ row_id: e.typed.id, notes: "Mary recorded this payment here as well; adopted her row and removed the importer's duplicate (2026-10-13)." })
    .eq("entity", "payment")
    .eq("sf_id", e.sfId);
  if (mapErr) throw new Error(`re-point map ${e.sfId}: ${mapErr.message}`);

  const { error: delErr } = await sb.from("commercial_invoice_payments").delete().eq("id", e.imported.id);
  if (delErr) throw new Error(`remove ${e.imported.id}: ${delErr.message}`);
  done++;
}

/*
 * RE-STAMP THE INVOICES THIS JUST TOUCHED.
 *
 * Removing a payment fires the invoice's recompute trigger, which moves
 * `commercial_invoices.updated_at`. The importer decides "did a person edit
 * this?" by comparing that against `commercial_import_map.updated_at` — so
 * without this, all ten invoices would read as hand-edited from now on and the
 * importer would quietly stop accepting Salesforce's updates for them. Silent,
 * permanent, and discovered months later.
 *
 * Only the invoices this script actually changed, for the reason the importer's
 * own restamp gives: claiming a row we did not write disarms the guard that
 * protects Mary's work.
 */
const touched = new Set(merges.map((e) => e.typed.invoice_id));
const fresh = await all("commercial_invoices", "id, updated_at");
let restamped = 0;
for (const inv of fresh) {
  if (!touched.has(inv.id)) continue;
  const { error } = await sb
    .from("commercial_import_map")
    .update({ updated_at: inv.updated_at })
    .eq("entity", "invoice")
    .eq("row_id", inv.id);
  if (error) throw new Error(`re-stamp invoice ${inv.id}: ${error.message}`);
  restamped++;
}
console.log(`   re-stamped ${restamped} invoice(s) the delete trigger touched, so they are not mistaken for hand-edits.`);
console.log(`\n✅ ${done} duplicate payment(s) removed, ${money(reclaimed)} no longer counted twice.`);
console.log(`   Mary's rows kept and now carry the Salesforce id, so the next sync updates them.`);
console.log(`   Re-run scripts/import-tomco.mjs --reconcile to confirm.\n`);
