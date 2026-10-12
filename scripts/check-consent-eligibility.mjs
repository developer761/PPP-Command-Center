/**
 * HOW MANY LEADS COULD WE ACTUALLY TEXT, UNDER EACH POLICY.
 *
 *   node --env-file=.env.local scripts/check-consent-eligibility.mjs
 *
 * READ ONLY. Writes nothing, needs no Salesforce credentials — the lead
 * payloads are already in sf_lead_inbound.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * SMS_REQUIRE_EXPRESS_CONSENT defaults to ON, which means a lead with no
 * recorded SMS consent is refused at enrolment. That is the right default —
 * the alternative is that flipping sending on texts everyone we never asked —
 * but it is only safe to leave ON if somebody knows what it costs.
 *
 * This prints that cost. Run it before deciding to relax the flag, and run it
 * again after Katie's Salesforce writeback goes live to watch the eligible
 * number climb.
 *
 * Measured 2026-10-10, before the writeback: 8 of 1,584.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/** Kept in step with lib/messaging/consent.ts. */
const EXPRESS = new Set(["opt-in (verified)", "opt-in (form)"]);
const OPTED_OUT = new Set(["opt-out"]);

const rows = [];
for (let p = 0; ; p++) {
  const { data, error } = await sb.from("sf_lead_inbound")
    .select("payload").order("id").range(p * 500, p * 500 + 499);
  if (error) {
    console.error(`COULD NOT CHECK: ${error.message}`);
    console.error("This is NOT a pass.");
    process.exit(2);
  }
  rows.push(...data);
  if (data.length < 500) break;
}

let express = 0, optedOut = 0, none = 0;
const bySource = new Map();
for (const r of rows) {
  const p = r.payload ?? {};
  const raw = p.SMS_Opt_In__c;
  const v = raw === undefined || raw === null || String(raw).trim() === "" ? null : String(raw).trim();
  const state = v === null ? "none"
    : OPTED_OUT.has(v.toLowerCase()) ? "opted_out"
    : EXPRESS.has(v.toLowerCase()) ? "express"
    : "none";
  if (state === "express") express++;
  else if (state === "opted_out") optedOut++;
  else none++;

  const src = String(p.LeadSource ?? "(none)").trim() || "(blank)";
  const b = bySource.get(src) ?? { express: 0, optedOut: 0, none: 0 };
  b[state === "opted_out" ? "optedOut" : state]++;
  bySource.set(src, b);
}

const total = rows.length;
const pct = (n) => `${((n / (total || 1)) * 100).toFixed(1)}%`;

console.log(`\nSMS CONSENT ELIGIBILITY — ${total} leads in sf_lead_inbound\n`);
console.log(`  express opt-in on file   ${String(express).padStart(6)}   ${pct(express)}`);
console.log(`  explicit opt-out         ${String(optedOut).padStart(6)}   ${pct(optedOut)}`);
console.log(`  nothing recorded         ${String(none).padStart(6)}   ${pct(none)}`);

console.log(`\n  ── what each policy admits ──`);
console.log(`  SMS_REQUIRE_EXPRESS_CONSENT on  (default)  ${String(express).padStart(6)} lead(s) may enrol`);
console.log(`  SMS_REQUIRE_EXPRESS_CONSENT=false          ${String(express + none).padStart(6)} lead(s) may enrol`);
console.log(`  (an explicit opt-out is refused either way)`);

console.log(`\n  ── by lead source ──`);
const sorted = [...bySource].sort((a, b) =>
  (b[1].express + b[1].none + b[1].optedOut) - (a[1].express + a[1].none + a[1].optedOut));
for (const [src, b] of sorted.slice(0, 12)) {
  const t = b.express + b.none + b.optedOut;
  console.log(`  ${src.padEnd(26).slice(0, 26)} ${String(t).padStart(5)} total   `
    + `${String(b.express).padStart(4)} opt-in   ${String(b.optedOut).padStart(3)} opt-out   `
    + `${String(b.none).padStart(5)} nothing`);
}

/**
 * Not a pass/fail check — there is no correct number here, only a number
 * somebody should have seen. Exits 0 so it can run alongside the other
 * checks without ever blocking a push.
 */
console.log(
  `\n  Nothing here is a failure. If the express number is near zero, the`
  + `\n  Salesforce SMS consent writeback is not flowing yet — Katie, 2026-10-08:`
  + `\n  "Moving forward, the actual consent will be pushed to individual SMS /`
  + `\n  Email consent fields captured in Salesforce." Until it does, leaving`
  + `\n  SMS_REQUIRE_EXPRESS_CONSENT on means almost nothing enrols, which is`
  + `\n  the safe failure and not a broken one.\n`
);
process.exit(0);
