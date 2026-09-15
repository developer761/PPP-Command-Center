/**
 * Print the vendor-directory seed from a Salesforce vendor export.
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs \
 *     scripts/build-commercial-vendor-seed.mjs ~/Desktop/PPP/tomco-sf-exports-2026-09-15/tomco_vendors_since_2025.csv
 *
 * Prints two things and writes NOTHING (no database, no files):
 *   1. the VALUES block for the seed INSERT in
 *      supabase/migrations/20260915191000_commercial_vendors.sql
 *   2. one line per SF row — seeded / merged / excluded, and why
 *
 * The cleaning rules live in lib/commercial/vendors/sf-seed.ts (tested). Re-run
 * this when Katie sends a newer export, and paste the VALUES into a NEW
 * migration — the seed is idempotent, so vendors already present are skipped.
 */
import { readFileSync } from "node:fs";
import { csvToRecords, cleanSfVendorExport, vendorSeedValuesSql } from "../lib/commercial/vendors/sf-seed.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: build-commercial-vendor-seed.mjs <export.csv>");
  process.exit(1);
}
const { vendors, decisions } = cleanSfVendorExport(csvToRecords(readFileSync(path, "utf8")));

console.log("-- VALUES --");
console.log(vendorSeedValuesSql(vendors));
console.log("\n-- DECISIONS --");
for (const d of decisions) {
  console.log(`${d.decision.padEnd(8)} | ${d.category.padEnd(19)} | ${d.sfName} (${d.sfAccountId}, ${d.totalSpend})${d.vendor && d.vendor !== d.sfName ? ` → ${d.vendor}` : ""} | ${d.reason}`);
}
const n = (k) => vendors.filter((v) => v.kind === k).length;
console.log(`\n${vendors.length} vendors: retail ${n("retail")}, labor ${n("labor")} · ${decisions.length} SF rows`);
