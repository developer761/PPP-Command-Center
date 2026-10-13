/**
 * Give back the cost categories the duplicate cleanup flattened.
 *
 *   node --env-file=.env.local scripts/restore-cost-categories.mjs
 *   node --env-file=.env.local scripts/restore-cost-categories.mjs --commit
 *
 * WHY
 *
 * `fix-duplicate-costs.mjs` kept the Salesforce-sourced row of each duplicated
 * receipt and dropped the typed copy, on the reasoning that the imported row
 * "carries the TN- number and the correct category". The first half is true.
 * The second half is backwards, and a review caught it:
 *
 *   `purchaseCategory()` only ever emits `materials | labor | other`. The
 *   typed rows carried the finer value a person chose.
 *
 * So 20 of the 46 pairs lost precision:
 *
 *   equipment      → materials    3 rows   (~$7.5k of Sunbelt Rentals plant)
 *   employee_labor → labor       17 rows   (~$11k of named-crew time)
 *
 * The money is right either way — this is job costing and gross margin BY
 * CATEGORY being coarser than it was. Equipment rental booked as paint reads
 * as a materials overrun on the AIREF and Water Lillies jobs.
 *
 * The backup holds the category of every deleted row, so the finer value is
 * recoverable. This reads it back and applies it to the kept row.
 *
 * Only ever makes a category MORE specific: it refuses to write `materials`
 * over `equipment`, so running it twice, or after someone has corrected a row
 * by hand, cannot undo their work.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const money = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** The coarse values the importer can produce — anything else is finer. */
const COARSE = new Set(["materials", "labor", "other"]);

const backups = readdirSync("/tmp").filter((f) => /^duplicate-costs-removed-.*\.json$/.test(f)).sort();
if (backups.length === 0) {
  console.error("No /tmp/duplicate-costs-removed-*.json backup found — nothing to restore from.");
  process.exit(1);
}
const path = `/tmp/${backups[backups.length - 1]}`;
const backup = JSON.parse(readFileSync(path, "utf8"));
console.log(`\nreading ${path} — ${backup.rows.length} removed row(s)\n`);

const keptIds = backup.rows.map((r) => r.kept);
const { data: kept, error } = await sb
  .from("commercial_project_purchases")
  .select("id, category, vendor, amount_cents, purchased_at, deleted_at")
  .in("id", keptIds);
if (error) throw new Error(error.message);
const keptById = new Map((kept ?? []).map((k) => [k.id, k]));

const planned = [];
const skipped = [];
for (const row of backup.rows) {
  const k = keptById.get(row.kept);
  if (!k) { skipped.push({ why: "kept row no longer exists", row }); continue; }
  if (k.deleted_at) { skipped.push({ why: "kept row has since been deleted", row }); continue; }
  const was = row.removed.category;
  if (!was || was === k.category) continue;
  // ONLY toward the finer value. Never write a coarse category over a specific
  // one somebody may have set by hand since.
  if (!COARSE.has(k.category)) { skipped.push({ why: `kept row is already specific (${k.category})`, row }); continue; }
  if (COARSE.has(was)) continue; // both coarse — nothing to gain
  planned.push({ id: k.id, from: k.category, to: was, vendor: k.vendor, amount: k.amount_cents, at: String(k.purchased_at).slice(0, 10) });
}

console.log(`── WOULD RESTORE (${planned.length}) ──`);
const moves = {};
for (const p of planned) {
  const key = `${p.from} → ${p.to}`;
  moves[key] = moves[key] ?? { n: 0, cents: 0 };
  moves[key].n++;
  moves[key].cents += p.amount;
  console.log(`  ${money(p.amount).padStart(12)}  ${p.at}  ${String(p.vendor ?? "-").slice(0, 24).padEnd(24)} ${p.from} → ${p.to}`);
}
console.log(`\n  summary:`);
for (const [k, v] of Object.entries(moves)) console.log(`    ${k.padEnd(32)} ${String(v.n).padStart(3)} rows  ${money(v.cents)}`);
if (skipped.length) {
  console.log(`\n── SKIPPED (${skipped.length}) ──`);
  for (const s of skipped) console.log(`  ${s.why}`);
}

if (!COMMIT) {
  console.log(`\nDry run. Re-run with --commit to apply.\n`);
  process.exit(0);
}
if (planned.length === 0) {
  console.log(`\nNothing to restore.\n`);
  process.exit(0);
}
let done = 0;
for (const p of planned) {
  const { error: e } = await sb
    .from("commercial_project_purchases")
    .update({ category: p.to })
    .eq("id", p.id);
  if (e) throw new Error(`restore ${p.id}: ${e.message}`);
  done++;
}
console.log(`\n✅ ${done} cost categor(ies) restored to what the person originally chose.\n`);
