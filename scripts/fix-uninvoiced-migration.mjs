/**
 * The migration invented invoices that Tomco never sent.
 *
 * Karan, 2026-09-17, looking at a job reading "Invoice SF-00287824 · Overdue ·
 * 203 days late": *"all these jobs, you made invoices for all the receivables,
 * but we didn't make invoices on Salesforce — the invoice would only be made
 * when we send payment."*
 *
 * He is right, and it is mine. `stageInvoices` creates ONE invoice per
 * Salesforce WORK ORDER, numbered SF-<work order>, issued on the job's start
 * date, with a due date DERIVED from the payment terms — a date that exists
 * nowhere in Salesforce. In Salesforce the balance lives on the work order; an
 * invoice is a document they raise when they bill. So every "past due" figure
 * in the platform — the Accounting tiles, AR aging, the dashboard work list,
 * the headline of Alex's report — was built on documents nobody ever sent.
 *
 * WHAT THIS DOES, and why it is two rules rather than one:
 *
 *   19 rows, $510,974.04 — never received a penny. Nothing was billed and
 *     nothing came in, so the invoice is pure fiction: back to DRAFT, with the
 *     invented issued and due dates cleared. Draft is not a billable status, so
 *     this money leaves "outstanding" and lands where it belongs — work that is
 *     earned and not yet billed.
 *
 *   16 rows, $858,070.33 — part-paid. $172,130.70 of $404,836.00 and the like.
 *     Money arrived, so somebody DID bill for it (through an AIA application,
 *     which is a separate ledger). Drafting these would hide real receivables
 *     and leave a draft carrying payments. They stay as they are, except the
 *     INVENTED DUE DATE goes: they are genuinely owed, but not late against a
 *     date nobody agreed.
 *
 * The 56 fully-paid rows are untouched. They are history, they reconcile, and
 * nothing about them is wrong.
 *
 * The reconciler is unaffected: it sums `balance_cents` across invoice rows
 * with no status filter, so ours-vs-Salesforce stays green. Verified before
 * running, not after.
 *
 *   node --env-file=.env.local scripts/fix-uninvoiced-migration.mjs           # dry run
 *   node --env-file=.env.local scripts/fix-uninvoiced-migration.mjs --commit
 *   node --env-file=.env.local scripts/fix-uninvoiced-migration.mjs --undo    # put it all back
 *
 * Every change is written to scripts/.uninvoiced-backup.json first, so --undo
 * restores the exact previous values rather than guessing them.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const UNDO = process.argv.includes("--undo");
const BACKUP = "scripts/.uninvoiced-backup.json";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

if (UNDO) {
  if (!existsSync(BACKUP)) {
    console.error(`No backup at ${BACKUP} — nothing to undo.`);
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(BACKUP, "utf8"));
  let n = 0;
  for (const r of rows) {
    const { error } = await sb
      .from("commercial_invoices")
      .update({ status: r.status, issued_at: r.issued_at, due_at: r.due_at })
      .eq("id", r.id);
    if (error) console.error("  failed", r.invoice_number, error.message);
    else n++;
  }
  console.log(`restored ${n} of ${rows.length} invoices`);
  process.exit(0);
}

const { data: all } = await sb
  .from("commercial_invoices")
  .select("id, invoice_number, status, issued_at, due_at, paid_cents, balance_cents, total_cents, notes")
  .is("deleted_at", null);

// ONLY rows this migration created. An invoice raised in the platform since
// go-live is a real document and must not be touched by a cleanup of mine.
const imported = (all ?? []).filter((i) => (i.notes || "").includes("Imported from Salesforce work order"));
const owed = imported.filter((i) => i.balance_cents > 0);
const neverPaid = owed.filter((i) => i.paid_cents === 0);
const partPaid = owed.filter((i) => i.paid_cents > 0);

console.log(`\n${imported.length} imported invoices · ${owed.length} still owed${COMMIT ? "" : "   (DRY RUN — nothing written)"}\n`);
console.log(`  → DRAFT, dates cleared   ${String(neverPaid.length).padStart(3)}  ${money(neverPaid.reduce((n, i) => n + i.balance_cents, 0))}   never received a penny`);
console.log(`  → due date cleared only  ${String(partPaid.length).padStart(3)}  ${money(partPaid.reduce((n, i) => n + i.balance_cents, 0))}   money already came in`);
console.log(`  → untouched              ${String(imported.length - owed.length).padStart(3)}  ${money(imported.filter((i) => i.balance_cents <= 0).reduce((n, i) => n + i.total_cents, 0))}   paid in full\n`);

for (const i of neverPaid.slice(0, 5)) {
  console.log(`   draft   ${i.invoice_number}  ${money(i.balance_cents).padStart(14)}  was due ${String(i.due_at).slice(0, 10)}`);
}
if (neverPaid.length > 5) console.log(`   …and ${neverPaid.length - 5} more`);

if (!COMMIT) {
  console.log("\nRe-run with --commit to apply.");
  process.exit(0);
}

// Back up exactly what is about to change, so --undo is real rather than a hope.
const touched = [...neverPaid, ...partPaid].map((i) => ({
  id: i.id,
  invoice_number: i.invoice_number,
  status: i.status,
  issued_at: i.issued_at,
  due_at: i.due_at,
}));
writeFileSync(BACKUP, JSON.stringify(touched, null, 2));
console.log(`\nbacked up ${touched.length} rows to ${BACKUP}`);

let drafted = 0;
for (const i of neverPaid) {
  const { error } = await sb
    .from("commercial_invoices")
    .update({ status: "draft", issued_at: null, due_at: null })
    .eq("id", i.id);
  if (error) console.error("  failed", i.invoice_number, error.message);
  else drafted++;
}

let dated = 0;
for (const i of partPaid) {
  const { error } = await sb.from("commercial_invoices").update({ due_at: null }).eq("id", i.id);
  if (error) console.error("  failed", i.invoice_number, error.message);
  else dated++;
}

console.log(`\n✅ ${drafted} back to draft · ${dated} had an invented due date removed`);
console.log("   Re-run the reconciler to confirm the money is unchanged.");
