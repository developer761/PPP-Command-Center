/**
 * A CONSENT VALUE SALESFORCE SENDS AND NOTHING HERE RECOGNISES.
 *
 *   node --env-file=.env.local scripts/check-sms-consent-values.mjs
 *
 * READ ONLY against the database. Writes nothing, and needs no Salesforce
 * credentials — the lead payloads are already stored in sf_lead_inbound, so
 * the live picklist can be read from what we have actually received.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * SMS_Opt_In__c is the field that decides whether somebody who asked us to
 * stop gets to stop. Two places compare against it, both with a literal:
 *
 *   the seeded exit rule   SMS_Opt_In__c equals ["Opt-Out"]
 *   outcomeForExit         optIn === "opt-out"   (records the exit as `lost`)
 *
 * If Salesforce renames that value — "Opted Out", "Opt Out", a new
 * "Opt-Out (Reply STOP)" — both comparisons silently stop matching. The
 * conversation then never exits and the lead keeps being chased, which is the
 * one failure in this system nobody is allowed to have. A picklist rename is
 * an afternoon's work in Setup and nothing in this repo would notice.
 *
 * check-sf-picklists covers the customer form's finish values and does not
 * look at the Lead at all.
 *
 * ── AND IT REPORTS THE CONSENT SPREAD ───────────────────────────────────
 *
 * Katie, 2026-10-08: "since we just split up SMS/Email consent, the consent
 * was recorded only for Emails... Moving forward, the actual consent will be
 * pushed to individual SMS / Email consent fields captured in Salesforce."
 *
 * So the field is about to start carrying real values where it has been null.
 * Printing the spread every run makes that transition visible rather than
 * something somebody discovers later: the entry rules carry NO consent
 * condition today, so what this field says is the difference between texting a
 * lead and not.
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

/**
 * Every value this codebase knows how to act on. A value Salesforce sends that
 * is not here is the finding — not a value here that Salesforce has not sent
 * yet, which is just a picklist entry nobody has used.
 */
const KNOWN = new Map([
  ["opt-out", "exits the conversation and records it as lost"],
  ["opt-in (verified)", "consent on file, verified"],
  ["opt-in (form)", "consent on file, from the web form"],
]);

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

const seen = new Map();
for (const r of rows) {
  const v = (r.payload ?? {}).SMS_Opt_In__c;
  const key = v === undefined || v === null || String(v).trim() === ""
    ? null
    : String(v).trim();
  if (key === null) { seen.set("(none recorded)", (seen.get("(none recorded)") ?? 0) + 1); continue; }
  seen.set(key, (seen.get(key) ?? 0) + 1);
}

console.log(`\nSMS CONSENT, as Salesforce has actually sent it — ${rows.length} leads\n`);
for (const [v, n] of [...seen].sort((a, b) => b[1] - a[1])) {
  const known = v === "(none recorded)" || KNOWN.has(v.toLowerCase());
  const pct = ((n / rows.length) * 100).toFixed(1);
  console.log(`  ${known ? "✓" : "✗"}  ${v.padEnd(24)} ${String(n).padStart(5)}  ${pct}%`
    + (known && v !== "(none recorded)" ? `   → ${KNOWN.get(v.toLowerCase())}` : ""));
}

const unknown = [...seen.keys()].filter((v) => v !== "(none recorded)" && !KNOWN.has(v.toLowerCase()));

/**
 * The exit path is the one that must never break, so it is named explicitly
 * rather than left to the reader to infer from the list above.
 */
const optOuts = [...seen].filter(([v]) => v.toLowerCase() === "opt-out").reduce((n, [, c]) => n + c, 0);
console.log(`\n  the exit rule matches "Opt-Out" exactly, and ${optOuts} lead(s) carry it`);
const none = seen.get("(none recorded)") ?? 0;
console.log(`  ${none} lead(s) have NO consent value, and the entry rules do not require one`);

if (unknown.length) {
  console.log(
    `\n✗  ${unknown.length} consent value(s) this codebase does not recognise:\n`
    + unknown.map((v) => `     "${v}"`).join("\n")
    + `\n\n   SMS_Opt_In__c decides whether somebody who asked us to stop gets to`
    + `\n   stop. The seeded exit rule compares the literal "Opt-Out" and`
    + `\n   outcomeForExit compares "opt-out" — a renamed or added value matches`
    + `\n   neither, the conversation never exits, and the lead keeps being`
    + `\n   chased. Decide what the new value means, then add it to KNOWN in`
    + `\n   this file AND to the exit rule if it is a form of opting out.\n`
  );
  process.exit(1);
}

console.log(`\nALL RECOGNISED — every consent value Salesforce has sent is one this code acts on.\n`);
process.exit(0);
