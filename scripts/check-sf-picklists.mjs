/**
 * Can Salesforce actually STORE every finish the picker offers?
 *
 * `WorkOrderLineItem.Finish*__c` are picklists with `restricted: true`. A value
 * the app offers but the picklist does not hold is not a cosmetic mismatch —
 * Salesforce REJECTS the write, so the colors silently fail to land. There are
 * already 5 INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST rows in sf_writes_audit.
 *
 * Nothing else can see this. The unit suite is credential-free, so it can check
 * that the picker and the allowlist agree with each other while both disagree
 * with Salesforce — which is exactly the shape of the bug.
 *
 * Read-only: describes, compares, writes nothing.
 */
import { createClient } from "@supabase/supabase-js";
import jsforce from "jsforce";
import { readFileSync } from "node:fs";
import { finishOptionsFor, PAINT_LINES } from "../lib/customer-form/material-types.ts";
import { normalizeFinishToSf } from "../lib/customer-form/surface-mapping.ts";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

// Mirrors FINISH_OPTIONS in components/customer-form-view.tsx.
const BASE = ["Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss", "Gloss", "High-Gloss"];
/**
 * Every product the picker can show, in every scope it can show it — a product
 * whose interior and exterior lists differ has to be checked BOTH ways or the
 * unstorable value hides in the branch that was not walked. SW Super Paint is
 * exactly that: "Velvet" only appears interior, "High-Gloss" only exterior.
 */
const SCOPES = [null, "interior", "exterior"];
const PRODUCTS = [
  ...PAINT_LINES.map((l) => l.value),
  // Legacy finish-bearing values still valid on older work orders.
  "Ultra Spec Exterior Soft Gloss",
  "Aura Bath & Spa Matte",
  // The stain branch, which is why any of this exists (Katie item 19).
  "Arborcoat Semi-Transparent Stain",
  null,
];

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: cred } = await sb.from("system_credentials").select("*");
const get = (k) => cred.find((r) => (r.key ?? r.name ?? "").includes(k))?.value;
const conn = new jsforce.Connection({
  oauth2: { loginUrl: env.SF_LOGIN_URL, clientId: env.SF_CONSUMER_KEY, clientSecret: env.SF_CONSUMER_SECRET },
});
const rr = await conn.oauth2.refreshToken(get("refresh"));
conn.accessToken = rr.access_token;
conn.instanceUrl = rr.instance_url ?? get("instance");

const desc = await conn.sobject("WorkOrderLineItem").describe();
const finishFields = desc.fields.filter((f) => /^Finish/i.test(f.name) && f.picklistValues?.length);
if (finishFields.length === 0) {
  console.log("  ⚠ No Finish*__c picklists found — the describe returned nothing to check.");
  console.log("  Treat this as INCONCLUSIVE, not a pass.");
  process.exit(1);
}

let checked = 0, rejected = 0, unwritten = 0;
const problems = [];

for (const product of PRODUCTS) {
 for (const scope of SCOPES) {
  const offered = finishOptionsFor(BASE, product, scope);
  // Skip the scoped repeat when it adds nothing (product has one flat list).
  if (scope !== null && offered.join("|") === finishOptionsFor(BASE, product, null).join("|")) continue;
  const notes = [];
  for (const label of offered) {
    checked++;
    const sfValue = normalizeFinishToSf(label);
    if (sfValue === null) {
      unwritten++;
      notes.push(`${label} → not written to Salesforce (no picklist value)`);
      continue;
    }
    const rejects = finishFields.filter(
      (f) => !f.picklistValues.some((v) => v.active && v.value === sfValue)
    );
    if (rejects.length) {
      rejected++;
      notes.push(`${label} → "${sfValue}" REJECTED by ${rejects.map((r) => r.name).join(", ")}`);
      problems.push(`${product ?? "(no product)"}: ${label} → "${sfValue}" not on ${rejects.map((r) => r.name).join(", ")}`);
    }
  }
  const label = `${product ?? "(no product)"}${scope ? ` [${scope}]` : ""}`;
  console.log(`  ${label.padEnd(42)} ${String(offered.length).padStart(2)} offered${notes.length ? "" : "   ✓"}`);
  for (const n of notes) console.log(`       · ${n}`);
 }
}

console.log(`\n  CHECKED ${checked} picker option(s) against ${finishFields.length} live restricted picklist(s).`);
console.log(`  ${rejected} would be rejected · ${unwritten} deliberately not written.`);
if (checked < 20) {
  console.log(`\n  ⚠ Only ${checked} options checked — too few. INCONCLUSIVE.`);
  process.exit(1);
}
if (problems.length) {
  console.log(`\n  ${problems.length} OPTION(S) SALESFORCE WILL REJECT:`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  process.exit(1);
}
console.log("  ✅ every offered finish is a value Salesforce accepts.");
