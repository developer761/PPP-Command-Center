/**
 * A receipt typed in here weeks after the importer already brought it in.
 *
 *   node scripts/fix-back-entered-duplicates.mjs            dry run
 *   node scripts/fix-back-entered-duplicates.mjs --apply    executes
 *
 * The labor-payout duplicates (scripts/fix-duplicate-labor-payouts.mjs) were
 * machine-shaped: 35 pairs, one day apart, same worker, same cent. The non-labor
 * ones are not, and they split into two groups that must be treated differently.
 *
 * BACK-ENTERED — this script's scope. Our copy was created LONG AFTER the
 * purchase it records, and after Salesforce's copy already existed:
 *
 *     Bannett       Sherwin Williams    $28.17  purchased 09-04, ours created 10-08
 *     Station Yards Sherwin Williams $1,820.04  purchased 09-14, ours created 10-13
 *     LMJ Galil     Home Depot        $152.20  purchased 10-02, ours created 10-14
 *
 * Somebody worked back through a pile of receipts and entered ones the nightly
 * sync had already imported. The Station Yards row is the one Mary emailed about
 * ("one transaction or two?") — Salesforce holds it with the note "PPP charged
 * to Tomco acct. Reimbursement to…", so the answer is one, already recorded.
 *
 * NOT IN SCOPE — a purchase entered the day it happened, on a different day from
 * the Salesforce one:
 *
 *     AIREF #2      Sherwin Williams  $779.74  SF 09-25 · ours 09-28, same-day entry
 *     Water Lillies Home Depot         $30.36  SF 09-21 · ours 09-24, same-day entry
 *
 * Two Sherwin Williams runs three days apart at the identical amount is odd, but
 * a contemporaneous entry is what a REAL second purchase looks like, and this
 * script cannot tell the two apart. Left for a person deliberately. The money
 * check reports them and stays red until somebody decides — which is the correct
 * state for a question, rather than a guess dressed as a fix.
 *
 * WHICH SIDE GOES: the unmapped one, always. See rowToRemove() in
 * lib/commercial/import/near-miss.ts for why.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
/** How long after a purchase an entry stops looking contemporaneous. */
const BACK_ENTRY_DAYS = 7;

const env = Object.fromEntries(
  readFileSync(
    "/Users/karanmalhotra/Desktop/PPP/ppp-command-center/.env.local",
    "utf8",
  )
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const { findNearMissDuplicates, rowToRemove } = await import(
  "../lib/commercial/import/near-miss.ts"
);

const m = (c) =>
  `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const daysApart = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86_400_000;

async function pageAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols);
    for (const c of order) q = q.order(c);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const mapRows = await pageAll("commercial_import_map", "entity,row_id", ["sf_id", "entity"]);
const imported = new Set(
  mapRows.filter((r) => r.entity === "purchase").map((r) => r.row_id),
);
const purchases = await pageAll(
  "commercial_project_purchases",
  "id,opportunity_id,vendor,category,amount_cents,purchased_at,created_at,deleted_at,description",
  ["id"],
);
const deals = await pageAll("commercial_opportunities", "id,title", ["id"]);
const nameOf = new Map(deals.map((d) => [d.id, d.title]));
const rowById = new Map(purchases.map((r) => [r.id, r]));

const live = purchases.filter(
  (r) =>
    !r.deleted_at &&
    r.opportunity_id &&
    Number(r.amount_cents ?? 0) !== 0 &&
    !["labor", "employee_labor"].includes(r.category),
);
const { cross, same } = findNearMissDuplicates(
  live.map((r) => ({
    id: r.id,
    groupKey: `${r.opportunity_id}|${r.category}`,
    payee: r.vendor,
    amountCents: Number(r.amount_cents ?? 0),
    occurredAt: r.purchased_at,
    imported: imported.has(r.id),
  })),
);

const backEntered = [];
const contemporaneous = [];
for (const pair of cross) {
  const victim = rowToRemove(pair);
  if (!victim) continue;
  const row = rowById.get(victim.id);
  const lag = daysApart(row.created_at, row.purchased_at);
  (lag >= BACK_ENTRY_DAYS ? backEntered : contemporaneous).push({ row, pair, lag });
}

const describe = ({ row, pair, lag }) =>
  `${String(nameOf.get(row.opportunity_id) ?? "?").slice(0, 30).padEnd(30)} ` +
  `${String(row.vendor ?? "-").slice(0, 18).padEnd(18)} ${m(row.amount_cents).padStart(11)}  ` +
  `purchased ${String(row.purchased_at).slice(0, 10)}  ours created ${String(row.created_at).slice(0, 10)}  ` +
  `(${Math.round(lag)}d later, twin ${pair.daysApart}d apart)`;

console.log(`\n══ BACK-ENTERED COST DUPLICATES — ${APPLY ? "APPLYING" : "DRY RUN"} ══\n`);
console.log(`DELETE ${backEntered.length} row(s) entered ≥${BACK_ENTRY_DAYS}d after the purchase  ${m(backEntered.reduce((n, x) => n + Number(x.row.amount_cents ?? 0), 0))}`);
for (const x of backEntered.sort((a, b) => Number(b.row.amount_cents) - Number(a.row.amount_cents)))
  console.log(`   ✖  ${describe(x)}`);
console.log(`\nLEFT ALONE — ${contemporaneous.length} entered the same week as the purchase; a real second buy looks like this:`);
for (const x of contemporaneous) console.log(`   ?  ${describe(x)}`);
if (same.length) console.log(`\nAlso left alone: ${same.length} same-provenance pair(s) — both sides from one system, no key can decide.`);

if (!backEntered.length) {
  console.log(`\nNothing to do.\n`);
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n(dry run — nothing written. re-run with --apply)\n`);
  process.exit(0);
}

const now = new Date().toISOString();
for (const { row } of backEntered) {
  const { error } = await sb
    .from("commercial_project_purchases")
    .update({ deleted_at: now })
    .eq("id", row.id)
    .is("deleted_at", null);
  if (error) throw new Error(`delete ${row.id}: ${error.message}`);
}
console.log(`\n✅ deleted ${backEntered.length}. Re-run: npm run check:money\n`);
