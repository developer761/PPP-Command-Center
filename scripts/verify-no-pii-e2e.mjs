/**
 * Every text column in the messaging schema, swept for customer data.
 *
 * ── WHY THIS DISCOVERS COLUMNS INSTEAD OF LISTING THEM ──────────────────
 *
 * Three PII misses in one session, all the same shape: scrub the field I was
 * thinking about, miss the one beside it.
 *
 *   transcript scrubbed, turn_text not      256 rows, 143 addresses
 *   turn_text fixed, `what` not             113 rows, 73 addresses
 *   and before both, scrub() returning an object so the check never ran
 *
 * A hand-written list of columns would have had exactly the same blind spot,
 * because the blind spot IS the list. So this reads one row per table, takes
 * whatever string columns actually exist, and scans all of them. A column
 * added next month is covered the day it appears, without anybody
 * remembering to add it here.
 *
 * Nothing is written. It reads, reports, and exits non-zero on a finding.
 */
import { createClient } from "@supabase/supabase-js";
import { residualPii, suspectedNames } from "../lib/messaging/pii.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/**
 * Tables that can hold something a customer typed, or something quoting it.
 *
 * Listed because a table is a deliberate thing to add; columns are not, and
 * columns are where the misses happened.
 */
/**
 * DISCOVERED, not listed.
 *
 * The first version of this file named eight tables. There are thirty-one.
 * It was blind to twenty-three of them, which is the same blind spot as a
 * hand-written column list one level up — and I only found it by sweeping
 * for write paths that store prose and noticing sms_training_example_tags
 * has a `note` column that was never being read.
 *
 * PostgREST publishes its schema at the root, so the list comes from the
 * database. A table added next month is covered the day it appears.
 */
async function discoverTables() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
  const res = await fetch(base, {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY },
  });
  if (!res.ok) throw new Error(`could not read the schema: ${res.status}`);
  const spec = await res.json();
  const all = Object.keys(spec.definitions ?? spec.components?.schemas ?? {});
  return all.filter((t) => /^(sms_|sf_)/.test(t)).sort();
}

/**
 * Columns that legitimately hold a real phone number or address, because that
 * IS the column's job.
 *
 * Kept narrow and per-table on purpose. "phone" anywhere would have excused
 * a leak in a column that happened to be named well.
 */
const BY_DESIGN = new Set([
  // The live conversation. These columns exist to hold contact details.
  "sms_conversations.customer_phone",
  "sms_conversations.customer_email",
  "sms_conversations.customer_address",
  "sms_conversations.customer_zip",
  "sms_conversations.customer_name",
  "sms_opt_outs.phone_e164",
  "sms_opt_outs.email",
  "sms_opt_outs.inbound_body",  // the words they opted out with, kept as evidence
  "sms_messages.body",          // the live thread, not the training corpus
  "sms_messages.subject",
  "sms_drafts.body",            // a reply about to be sent to that customer
  "sms_campaign_steps.body",    // merge fields resolve at send time
  "sms_campaign_steps.subject",
  // The raw Salesforce lead queue. It IS the contact record, and routing
  // reads it. Nothing here reaches a model.
  "sf_lead_inbound.payload",
  "sf_lead_inbound.phone_e164",
  "sf_lead_inbound.email",
  // PPP's own numbers, in operator notes about which Hatch line is which.
  "sms_sub_accounts.notes",
  "sms_sub_accounts.phone_e164",
  "sms_sub_accounts.reply_to_email",
  "sms_sub_accounts.origination_identity",
  // PPP staff, not customers. Linking a Salesforce user to a login is the
  // entire purpose of this table.
  "sf_user_links.login_email",
  "sf_user_links.sf_user_email",
]);

/**
 * Kate's own teaching examples, which are supposed to be in the prompt.
 *
 * "Is 516-784-6046 and tom@x.com still the best contact?" is what teaches the
 * read-back shape, and scrubbing it would remove the lesson.
 *
 * KEYED BY TABLE, ROW AND COLUMN, and the first version was not. It excused
 * the CODE — A22 and A13 — in every table it looked at, so roughly 270
 * findings rows carrying those rule ids were never scanned at all. Proved by
 * planting a phone number and an address in a findings row and watching the
 * sweep report ALL CLEAN twice.
 *
 * An allowlist that excuses more than the thing it was written for is how a
 * check stops checking, quietly, while still printing a tick.
 */
const ALLOWED = new Set([
  "sms_class_a_rules.A22.rule_card",
  "sms_class_a_rules.A13.rule_card",
]);

/** Exactly a UUID, nothing else in the string. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Paged, and ORDERED — which this did not do, and the omission made the whole
 * sweep worthless.
 *
 * PostgREST with .range() and no .order() has no stable sort, so page two is
 * not reliably the rows page one did not return. Rows get skipped. Proved by
 * planting a phone number and an address in a findings row and watching this
 * report ALL CLEAN.
 *
 * A check that cannot fail is worse than no check, because it is believed.
 */
const page = async (table, cols, key) => {
  const out = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from(table).select(cols).order(key).range(p * 1000, p * 1000 + 999);
    if (error) return { error };
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
};

let findings = 0, scanned = 0, columns = 0;

console.log("\nPII SWEEP — every text column, discovered not listed\n");

const TABLES = await discoverTables();
console.log(`  ${TABLES.length} tables in the schema\n`);

for (const table of TABLES) {
  // One row, to learn the shape. A table with no rows has nothing to leak.
  const { data: probe, error: probeErr } = await sb.from(table).select("*").limit(1);
  if (probeErr) { console.log(`  ${table.padEnd(26)} skipped (${probeErr.code})`); continue; }
  if (!probe?.length) { console.log(`  ${table.padEnd(26)} empty`); continue; }

  const textCols = Object.entries(probe[0])
    .filter(([k, v]) => typeof v === "string" || v === null)
    .map(([k]) => k)
    .filter((k) => !BY_DESIGN.has(`${table}.${k}`));
  if (!textCols.length) { console.log(`  ${table.padEnd(26)} no text columns`); continue; }

  const key = "code" in probe[0] ? "code" : "id" in probe[0] ? "id" : Object.keys(probe[0])[0];
  // pii_scrubbed=false means the row was DELIBERATELY held back: the importer
  // could not clear it and withdrew it, and retrieval filters on that flag in
  // the query. Such a row still contains what it contains, and that is the
  // guard doing its job rather than a leak. Counted separately, because a
  // check that always fails is a check nobody reads.
  const quarantinable = textCols.includes("pii_scrubbed") || "pii_scrubbed" in probe[0];
  const rows = await page(table, [key, ...textCols, quarantinable ? "pii_scrubbed" : null].filter(Boolean).join(", "), key);
  if (rows.error) { console.log(`  ${table.padEnd(26)} could not read: ${rows.error.message}`); continue; }

  const hits = {};
  let quarantined = 0;
  for (const r of rows) {
    if (quarantinable && r.pii_scrubbed === false) { quarantined++; continue; }
    for (const c of textCols) {
      const v = r[c];
      if (typeof v !== "string" || !v) continue;
      // A UUID is not a phone number, and the phone pattern is deliberately
      // loose enough to think it is: cb580320-6511-4e3a-b8dc-62bfcf2b7176 has
      // digit groups in all the right places. Skipped by SHAPE rather than by
      // column name, so a customer's number sitting in a column that happens
      // to be called id would still be caught.
      if (UUID.test(v)) continue;
      if (ALLOWED.has(`${table}.${r[key]}.${c}`)) continue;
      scanned++;
      const pii = residualPii(v);
      const names = suspectedNames(v, ["Emily", "Emma", "Sarah"])
        .filter((n) => !["Human", "Customer"].includes(n));
      if (!pii.length && !names.length) continue;
      hits[c] ??= { n: 0, kinds: new Set(), sample: "" };
      hits[c].n++;
      for (const k of pii) hits[c].kinds.add(k);
      if (names.length) hits[c].kinds.add("name");
      if (!hits[c].sample) hits[c].sample = `${r[key]}: ${v.slice(0, 90)}`;
    }
  }

  columns += textCols.length;
  const bad = Object.keys(hits).length;
  const held = quarantined ? ` · ${quarantined} quarantined` : "";
  if (!bad) {
    console.log(`  ✓ ${table.padEnd(26)} ${String(rows.length).padStart(5)} rows · ${textCols.length} text columns · clean${held}`);
  } else {
    for (const [c, h] of Object.entries(hits)) {
      findings += h.n;
      console.log(`  ✗ ${table}.${c} — ${h.n} row(s) carry ${[...h.kinds].join(", ")}`);
      console.log(`      ${h.sample}`);
    }
  }
}

console.log(`\n  ${columns} text columns scanned, ${scanned} values read`);
console.log(findings ? `\nFAILURES — ${findings} value(s) carry customer data\n` : "\nALL CLEAN\n");
process.exit(findings ? 1 : 0);
