#!/usr/bin/env node
/**
 * Every report a folder promises actually exists.
 *
 * Katie's go-live list, item 4: *"Double-check all reports are available."*
 * Folder membership is how a non-admin gets to a report, and the access rule
 * skips a key it does not recognise (`access-rule.ts`: "a retired key grants
 * nothing"). So a folder row pointing at a report that has since been renamed,
 * retired, or moved elsewhere is SILENT — the folder says 16 reports and hands
 * over 10, and nothing anywhere says which six went missing.
 *
 * Found seven live rows in exactly that state: Alex's Manager folder listed 22
 * reports and granted 15. Six of them (purchases-by-vendor, deposit-history,
 * labor-payments, reimbursements-out, sales-tax, balance-owed) are Mary's, and
 * they were moved under Accounting rather than deleted — so the rows are
 * pointing at real screens that simply are not "reports" any more.
 *
 * Nobody is blocked today because every one of those folders' members is an
 * admin, and an admin sees everything regardless. That is precisely why it
 * needed a check rather than a bug report: it is invisible until the day
 * somebody is not an admin.
 *
 *   node --env-file=.env.local scripts/check-report-folders.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Read the registry as SOURCE rather than importing it — this script runs
// under plain node with no TS loader, and REPORT_KEYS is a flat literal.
const src = readFileSync("lib/commercial/reports/registry.ts", "utf8");
const block = src.match(/export const REPORT_KEYS = \[([\s\S]*?)\] as const;/);
if (!block) {
  console.log("❌ Could not read REPORT_KEYS from the registry — has it been restructured?");
  process.exit(1);
}
const known = new Set([...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
if (known.size === 0) {
  // A zero-element scan is a fake pass. Say so rather than printing a tick.
  console.log("❌ Parsed the registry and found no report keys. Refusing to pass.");
  process.exit(1);
}

const { data: folders, error: fErr } = await sb
  .from("commercial_report_folders")
  .select("id, name")
  .is("deleted_at", null);
if (fErr) {
  console.log(`❌ Could not read folders: ${fErr.message}`);
  process.exit(1);
}
const { data: items, error: iErr } = await sb
  .from("commercial_report_folder_items")
  .select("folder_id, report_key");
if (iErr) {
  console.log(`❌ Could not read folder items: ${iErr.message}`);
  process.exit(1);
}

const byFolder = new Map(folders.map((f) => [f.id, { name: f.name, keys: [] }]));
for (const it of items) byFolder.get(it.folder_id)?.keys.push(it.report_key);

const problems = [];
for (const [, f] of byFolder) {
  const dead = f.keys.filter((k) => !known.has(k));
  if (dead.length) problems.push({ folder: f.name, listed: f.keys.length, dead });
}

console.log(
  `Checked ${folders.length} folders / ${items.length} assignments against ${known.size} registered reports.`,
);

if (problems.length === 0) {
  console.log("✅ Every report a folder promises exists.");
  process.exit(0);
}

console.log(`\n❌ ${problems.length} folder(s) promise reports that do not exist:\n`);
for (const p of problems) {
  console.log(`   ${p.folder} — lists ${p.listed}, grants ${p.listed - p.dead.length}`);
  console.log(`      dead: ${p.dead.join(", ")}`);
}
console.log(
  `\n   The access rule skips an unknown key silently, so a member of these folders\n` +
    `   sees fewer reports than the folder claims, with nothing saying which.\n` +
    `   Either register the key in lib/commercial/reports/registry.ts, or remove the row.`,
);
process.exit(1);
