/**
 * Put the shield back over the 35 invoices the uninvoiced migration edited.
 *
 * WHAT WENT WRONG. The importer protects a row a person has edited by comparing
 * the row's `updated_at` against `commercial_import_map.updated_at` — the moment
 * the importer itself last wrote it. Newer by more than a second means "a human
 * touched this", and Salesforce is not allowed to overwrite it.
 *
 * `stagePayments` ended with `restampEntity("invoice")`, which copied the
 * CURRENT `updated_at` of every imported invoice into the map. Its reason was
 * sound — inserting a payment fires the invoice's recompute trigger, so those
 * invoices look edited when they were only touched by our own write — but it
 * did it to all 1,100-odd invoices rather than the handful the trigger touched.
 *
 * So the 35 invoices fixed on 2026-09-17 — 19 never-paid ones set back to draft
 * ($510,974.04) and 16 part-paid ones with their due date cleared ($858,070.33),
 * which is what made our $1,369,044.37 match Salesforce — were marked as the
 * importer's own work. The next `--stage=invoices --commit` would have restored
 * Salesforce's version of all 35 and put the invoice fiction back, reporting a
 * clean sync while it did.
 *
 * `restampEntity` now takes the set of rows the stage actually wrote. This
 * script repairs the map rows that the blanket version already flattened, by
 * winding each one back behind its invoice's real `updated_at` so the guard
 * reads them as edited-by-a-person again.
 *
 * Verify afterwards with a DRY RUN of the invoices stage — it must report 35
 * rows KEPT:
 *   node --env-file=.env.local scripts/import-tomco.mjs --stage=invoices
 *
 *   node --env-file=.env.local scripts/reprotect-uninvoiced.mjs            # dry run
 *   node --env-file=.env.local scripts/reprotect-uninvoiced.mjs --commit
 */
import { readFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
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

const backup = JSON.parse(readFileSync("scripts/.uninvoiced-backup.json", "utf8"));
const ids = backup.map((b) => b.id);

const { data: invoices, error: invErr } = await sb
  .from("commercial_invoices")
  .select("id, invoice_number, status, due_at, updated_at")
  .in("id", ids);
if (invErr) throw new Error(invErr.message);

const { data: mapRows, error: mapErr } = await sb
  .from("commercial_import_map")
  .select("sf_id, entity, row_id, updated_at")
  .eq("entity", "invoice")
  .in("row_id", ids);
if (mapErr) throw new Error(mapErr.message);

const mapByRow = new Map((mapRows ?? []).map((m) => [m.row_id, m]));
const byId = new Map((invoices ?? []).map((i) => [i.id, i]));

// The guard's own rule, copied exactly: protected when the row is more than a
// second newer than the map. Anything else is unprotected.
const GUARD_MS = 1000;
const isProtected = (row, map) =>
  !!row && !!map && new Date(row.updated_at).getTime() - new Date(map.updated_at).getTime() > GUARD_MS;

const plan = [];
for (const b of backup) {
  const row = byId.get(b.id);
  const map = mapByRow.get(b.id);
  if (!row) {
    console.log(`  ?  ${b.invoice_number}: invoice not found`);
    continue;
  }
  if (!map) continue; // never imported — nothing for the importer to overwrite
  if (isProtected(row, map)) continue; // already safe
  // Wind the map back an hour behind the row. Any gap over the guard's second
  // restores protection; an hour is unambiguous in a log.
  const wound = new Date(new Date(row.updated_at).getTime() - 3600_000).toISOString();
  plan.push({ ...map, updated_at: wound, invoice_number: row.invoice_number, status: row.status });
}

console.log(`\n${backup.length} invoices from the uninvoiced migration${COMMIT ? "" : "   (DRY RUN)"}`);
console.log(`  already protected : ${backup.length - plan.length}`);
console.log(`  to re-protect     : ${plan.length}`);
for (const p of plan.slice(0, 6)) console.log(`     ${p.invoice_number}  (${p.status})`);
if (plan.length > 6) console.log(`     …and ${plan.length - 6} more`);

if (plan.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}
if (!COMMIT) {
  console.log("\nRe-run with --commit to apply.");
  process.exit(0);
}

for (let i = 0; i < plan.length; i += 200) {
  const chunk = plan.slice(i, i + 200).map(({ sf_id, entity, row_id, updated_at }) => ({ sf_id, entity, row_id, updated_at }));
  const { error } = await sb.from("commercial_import_map").upsert(chunk, { onConflict: "sf_id,entity" });
  if (error) throw new Error(error.message);
}

// Read it back rather than trusting the write — the whole point is the state of
// the guard, not the success of an upsert.
const { data: after } = await sb
  .from("commercial_import_map")
  .select("row_id, updated_at")
  .eq("entity", "invoice")
  .in("row_id", ids);
const afterByRow = new Map((after ?? []).map((m) => [m.row_id, m]));
const stillOpen = backup.filter((b) => {
  const row = byId.get(b.id);
  const map = afterByRow.get(b.id);
  return map && !isProtected(row, map);
});

console.log(`\n${plan.length} re-protected.`);
if (stillOpen.length) {
  console.log(`❌ ${stillOpen.length} still unprotected: ${stillOpen.map((s) => s.invoice_number).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("✅ all 35 read back as edited-here — Salesforce cannot overwrite them.");
  console.log("   Confirm: node --env-file=.env.local scripts/import-tomco.mjs --stage=invoices   (expect 35 KEPT)");
}
