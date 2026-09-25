/**
 * Load Katie's Salesforce suppression list into sms_opt_outs.
 *
 *   npm run import:optouts -- "/path/to/sf_optouts_suppression_points.csv"
 *   npm run import:optouts -- "/path/to/file.csv" --write
 *
 * DRY RUN BY DEFAULT. Nothing is written without --write, because this is the
 * table that decides whether PPP is allowed to text somebody.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────
 *
 * Katie, 2026-09-25, on how she pulled it from leads and contacts:
 *   Email_Opt_In__c = 'Opt-Out' OR HasOptedOutOfEmail = true  -> email
 *   SMS_Opt_In__c   = 'Opt-Out'                               -> sms
 *   DoNotCall       = true                                    -> voice
 *
 * This is the list gate-deps has been refusing every send without.
 *
 * ── VOICE IS SKIPPED ON PURPOSE ─────────────────────────────────────────
 *
 * Connect Hub never places a call, and the SMS suppression lookup matches on
 * phone_e164 without filtering channel. A DoNotCall row carrying a phone
 * would therefore stop us TEXTING somebody who only asked not to be phoned —
 * suppressing a customer who never asked us to. Those stay in Salesforce.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────
 *
 * Re-running is safe. A number or address already suppressed is left exactly
 * as it is: an existing row carries its own evidence (the words someone
 * actually sent), and overwriting that with "salesforce_import" would destroy
 * the better record. Somebody who has since opted back IN is never
 * re-suppressed by a re-run either.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { toE164 } from "../lib/messaging/phone.ts";

const path = process.argv[2];
const write = process.argv.includes("--write");
if (!path) {
  console.error('\n  Give me the CSV:\n    npm run import:optouts -- "/path/to/sf_optouts_suppression_points.csv"\n');
  process.exit(1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const rows = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
const header = rows[0].split(",").map((h) => h.trim().toLowerCase());
const at = { type: header.indexOf("type"), value: header.indexOf("value"), channel: header.indexOf("channel") };
if (at.value < 0 || at.channel < 0) {
  console.error("\n  Expected columns type,value,channel — got: " + header.join(",") + "\n");
  process.exit(1);
}

const phones = new Map();   // e164 -> original
const emails = new Map();   // lowercased -> original
const skipped = { voice: 0, unparseablePhone: [], badEmail: [], unknownChannel: 0 };

for (const line of rows.slice(1)) {
  const cells = line.split(",");
  const value = (cells[at.value] ?? "").trim();
  const channel = (cells[at.channel] ?? "").trim().toLowerCase();
  if (!value) continue;

  if (channel === "voice") { skipped.voice++; continue; }

  if (channel === "sms") {
    let e164 = null;
    try { e164 = toE164(value); } catch { e164 = null; }
    // A number that cannot be normalised is REPORTED, never guessed at. The
    // cost of getting one wrong is texting somebody who opted out.
    if (!e164) { skipped.unparseablePhone.push(value); continue; }
    if (!phones.has(e164)) phones.set(e164, value);
    continue;
  }

  if (channel === "email") {
    const e = value.toLowerCase();
    if (!EMAIL.test(e)) { skipped.badEmail.push(value); continue; }
    if (!emails.has(e)) emails.set(e, value);
    continue;
  }

  skipped.unknownChannel++;
}

console.log(`\nSALESFORCE SUPPRESSION LIST — ${path.split("/").pop()}\n`);
console.log(`  read:            ${rows.length - 1} rows`);
console.log(`  sms  (phones):   ${phones.size} unique`);
console.log(`  email:           ${emails.size} unique`);
console.log(`  voice skipped:   ${skipped.voice}  (Connect Hub never calls; see the header of this file)`);
if (skipped.unparseablePhone.length) {
  console.log(`  ⚠ ${skipped.unparseablePhone.length} phone(s) could not be read, NOT imported:`);
  for (const p of skipped.unparseablePhone.slice(0, 10)) console.log(`      ${JSON.stringify(p)}`);
}
if (skipped.badEmail.length) {
  console.log(`  ⚠ ${skipped.badEmail.length} address(es) did not look like email, NOT imported:`);
  for (const e of skipped.badEmail.slice(0, 10)) console.log(`      ${JSON.stringify(e)}`);
}
if (skipped.unknownChannel) console.log(`  ⚠ ${skipped.unknownChannel} row(s) had an unrecognised channel`);

// What is already there, so a re-run neither duplicates nor overwrites.
const existing = { phones: new Set(), emails: new Set() };
for (let page = 0; ; page++) {
  const { data, error } = await sb.from("sms_opt_outs")
    .select("phone_e164, email").order("id").range(page * 1000, page * 1000 + 999);
  if (error) { console.error("  could not read the existing list: " + error.message); process.exit(1); }
  if (!data.length) break;
  for (const r of data) {
    if (r.phone_e164) existing.phones.add(r.phone_e164);
    if (r.email) existing.emails.add(r.email.toLowerCase());
  }
  if (data.length < 1000) break;
}
console.log(`\n  already suppressed: ${existing.phones.size} phones, ${existing.emails.size} addresses`);

const newPhones = [...phones.keys()].filter((p) => !existing.phones.has(p));
const newEmails = [...emails.keys()].filter((e) => !existing.emails.has(e));
console.log(`  to insert:          ${newPhones.length} phones, ${newEmails.length} addresses`);

if (!write) {
  console.log("\n  DRY RUN. Nothing written. Re-run with --write to apply.\n");
  process.exit(0);
}

const now = new Date().toISOString();
const NOTE = "Salesforce opt-out pull, 2026-09-25 (Email_Opt_In__c / HasOptedOutOfEmail / SMS_Opt_In__c)";
const rowsFor = (list, kind) => list.map((v) => ({
  ...(kind === "sms" ? { phone_e164: v } : { email: v }),
  channel: kind,
  source: "salesforce_import",
  note: NOTE,
  opted_out_at: now,
}));

let inserted = 0, failed = 0;
const all = [...rowsFor(newPhones, "sms"), ...rowsFor(newEmails, "email")];
for (let i = 0; i < all.length; i += 500) {
  const batch = all.slice(i, i + 500);
  const { error } = await sb.from("sms_opt_outs").insert(batch);
  if (error) {
    // 23505 is a duplicate, which means somebody else suppressed it first and
    // is the outcome we wanted anyway. Anything else is reported loudly.
    if (error.code === "23505") { inserted += batch.length; continue; }
    failed += batch.length;
    console.log(`  ✗ batch ${i / 500 + 1}: ${error.code} ${error.message.slice(0, 120)}`);
    continue;
  }
  inserted += batch.length;
  process.stdout.write(`\r  inserted ${inserted} / ${all.length}`);
}
console.log("");

const { count } = await sb.from("sms_opt_outs")
  .select("*", { count: "exact", head: true }).is("opted_in_at", null);
console.log(`\n  ACTIVE suppressions now: ${count}`);
console.log(failed ? `  ${failed} row(s) failed — see above\n` : "  no failures\n");
process.exit(failed ? 1 : 0);
