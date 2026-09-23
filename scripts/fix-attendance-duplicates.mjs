/**
 * ONE-OFF CLEANUP — remove attendance rows duplicated by the crew-company fold.
 *
 * Run:
 *   node --env-file=.env.local scripts/fix-attendance-duplicates.mjs            # show
 *   node --env-file=.env.local scripts/fix-attendance-duplicates.mjs --commit   # delete
 *
 * WHAT HAPPENED, 2026-09-23
 *
 * Mary asked why each painter appears twice on the Attendance list — once as
 * "Greg Stankewicz" and once as "Tomco Labor - Greg". Salesforce records half
 * its attendance against the worker and half against the labor company he came
 * through, so the import created both and split his hours between them.
 *
 * Salesforce itself resolves the pairing: 929 rows name BOTH, and the mapping
 * is emphatic ("Tomco Labor - Rob" appears with Robert Caputo 155 times and
 * with anyone else once). So the import now folds a company onto that person.
 *
 * The fold was right; re-running it was not. The import's key for an
 * attendance row is `attday:{workOrder}|{who}|{date}` — it contains WHO. So
 * changing the attribution produced NEW keys rather than updating the existing
 * rows: 874 inserts alongside 875 originals that nothing then removed. Live
 * totals went from 15,280.00 hours to 22,001.50 — the same work counted twice,
 * on the screens Mary and payroll read.
 *
 * WHAT THIS DELETES
 *
 * Only rows whose import key still names a company that has since been folded
 * into a person. Those are the superseded originals; the correctly-attributed
 * copies are keyed `|crew:{person}|` and stay. Their `commercial_import_map`
 * entries go with them, so a later sync does not treat them as missing and
 * write them back.
 *
 * Deleting is the honest repair here — the rows are duplicates of rows that
 * still exist, created minutes earlier by a re-key, and while they sit there
 * every labor total on the platform is ~44% too high. It prints the arithmetic
 * before and after so the result is checkable rather than asserted.
 */
import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** The companies the import now folds into a person. Must match
 *  `crewCompanyWorker()` in import-tomco.mjs. */
const FOLDED = [
  "Tomco Labor - Greg",
  "Tomco Labor - Miguel",
  "Tomco Labor - Rob",
  "Tomco Labor - Joe",
  "Tomco Labor - JJ",
  "Tomco Labor - Erick",
  "Tomco Labor - Carlos",
  "Tomco Labor - Robert P",
  "LC Alex Steve Wagner",
];

const readAll = async (table, columns, shape = (q) => q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await shape(sb.from(table).select(columns).order("sf_id")).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
};

const totalHours = async () => {
  let sum = 0;
  let rows = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_time_entries")
      .select("actual_hours")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`hours: ${error.message}`);
    for (const t of data ?? []) sum += Number(t.actual_hours ?? 0);
    rows += (data ?? []).length;
    if (!data || data.length < 1000) break;
  }
  return { sum, rows };
};

const before = await totalHours();
console.log(`now: ${before.rows} time entries, ${before.sum.toFixed(2)} hours`);

const map = await readAll("commercial_import_map", "entity, sf_id, row_id", (q) => q.eq("entity", "attendance"));
const stale = map.filter((m) => FOLDED.some((c) => m.sf_id.includes(`|crewco:${c}|`)));

let staleHours = 0;
const ids = stale.map((m) => m.row_id);
for (let i = 0; i < ids.length; i += 200) {
  const { data, error } = await sb
    .from("commercial_time_entries")
    .select("id, actual_hours")
    .in("id", ids.slice(i, i + 200));
  if (error) throw new Error(`read: ${error.message}`);
  for (const t of data ?? []) staleHours += Number(t.actual_hours ?? 0);
}

console.log(`superseded (keyed to a folded company): ${stale.length} rows, ${staleHours.toFixed(2)} hours`);
console.log(`after removal: ${(before.sum - staleHours).toFixed(2)} hours`);

if (!COMMIT) {
  console.log("\nDry run. Re-run with --commit to delete.");
  process.exit(0);
}

let delRows = 0;
for (let i = 0; i < ids.length; i += 100) {
  const { error, count } = await sb
    .from("commercial_time_entries")
    .delete({ count: "exact" })
    .in("id", ids.slice(i, i + 100));
  if (error) throw new Error(`delete rows: ${error.message}`);
  delRows += count ?? 0;
}

let delMap = 0;
for (let i = 0; i < stale.length; i += 100) {
  const chunk = stale.slice(i, i + 100).map((m) => m.sf_id);
  const { error, count } = await sb
    .from("commercial_import_map")
    .delete({ count: "exact" })
    .eq("entity", "attendance")
    .in("sf_id", chunk);
  if (error) throw new Error(`delete map: ${error.message}`);
  delMap += count ?? 0;
}

const after = await totalHours();
console.log(`\ndeleted ${delRows} time entries and ${delMap} map entries`);
console.log(`now: ${after.rows} time entries, ${after.sum.toFixed(2)} hours`);
console.log(
  Math.abs(after.sum - (before.sum - staleHours)) < 0.01
    ? "✅ totals land exactly where the arithmetic said they would."
    : "⚠️  totals do NOT match the prediction — stop and look before trusting any labor figure."
);
