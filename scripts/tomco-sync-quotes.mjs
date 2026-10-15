/**
 * Sync the quote on the Tomco sales that have one approved and never synced.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/tomco-sync-quotes.mjs                 plan only
 *   …same… --apply                                     does it
 *
 * WHY THESE RECORDS ARE INCOMPLETE WITHOUT IT
 *
 * Katie, 2026-10-15: *"the order of operations should be: Account →
 * Opportunity → Quote w/ Line Items → Approve then Sync Quote and the
 * automation should handle it from there forward."* The write-back did
 * everything up to Approve and stopped, so four sales it created sit with an
 * Approved quote, no synced quote, no work order, and
 * `QuotedSubtotalWithChangeOrder__c` — the canonical PPP sales metric — at
 * NULL. The money is in `Quote_Subtotal__c` and nowhere her reports look.
 *
 * MEASURED, NOT ASSUMED: of 200 Tomco opportunities, all 85 with a synced quote
 * have a work order; of the 115 without one, 10% do. Syncing is what produces
 * the work order, and the work order is what a `ChangeOrder__c` attaches to —
 * `WorkOrder__c` is required and create-only, and this user cannot create a
 * Tomco work order. So without this, every change order approved on a deal we
 * created would be held with "no live work order in Salesforce" forever.
 *
 * `createNew` now does this step itself. This is the backfill for the records
 * created before it did.
 *
 * It syncs a quote and nothing else. One opportunity with two quotes is
 * refused rather than guessed at.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { getSalesforceClient } = await import("@/lib/salesforce/client");
const { writeSf } = await import("@/lib/salesforce/writeback");
const conn = await getSalesforceClient();

const all = async (soql) => {
  let r = await conn.query(soql);
  const out = [...r.records];
  while (!r.done) { r = await conn.queryMore(r.nextRecordsUrl); out.push(...r.records); }
  return out;
};

console.log(`\n══ TOMCO · SYNC QUOTE · ${APPLY ? "APPLYING" : "PLAN"} ══`);
console.log(`   ${conn.instanceUrl}\n`);

/*
 * SOLD DEALS ONLY. Syncing an open estimate's quote would create a work order
 * for work nobody has been awarded — the org treats a work order as a job to be
 * scheduled and costed, so that is not a harmless extra row.
 */
const opps = await all(
  `SELECT Id, Name, StageName, SyncedQuoteId, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c
     FROM Opportunity WHERE Corporate_Name__c = 'Tomco Painting' AND StageName = 'Closed Won' AND SyncedQuoteId = null`,
);
const wos = await all(`SELECT Id, Opportunity__c FROM WorkOrder WHERE Opportunity__c != null AND Status != 'Canceled'`);
const hasWo = new Set(wos.map((w) => w.Opportunity__c));

let synced = 0, refused = 0, noQuote = 0, already = 0, failed = 0;
for (const o of opps) {
  const label = String(o.Name).slice(0, 46).padEnd(46);

  /*
   * A deal that ALREADY has a work order needs nothing. Syncing it would copy
   * the quote's line items onto a job that is already costed and scheduled, to
   * fix a number that is not broken.
   */
  if (hasWo.has(o.Id)) {
    console.log(`   ·  ${label} already has a work order — left alone`);
    already++;
    continue;
  }

  const quotes = await all(`SELECT Id, Name, Status, Subtotal__c FROM Quote WHERE OpportunityId = '${o.Id}'`);
  const approved = quotes.filter((q) => q.Status === "Approved");
  if (quotes.length === 0) {
    console.log(`   🔴 ${label} no quote at all — nothing to sync (it needs one built first)`);
    noQuote++;
    continue;
  }
  if (approved.length !== 1) {
    console.log(
      `   ⏸  ${label} ${quotes.length} quote(s), ${approved.length} approved — a person picks which to sync`,
    );
    refused++;
    continue;
  }
  const q = approved[0];
  const canonical = o.QuotedSubtotalWithChangeOrder__c;
  console.log(
    `   ${APPLY ? "✅" : "·"} ${label} ${q.Name?.slice(0, 22).padEnd(22)} $${Number(q.Subtotal__c ?? 0).toFixed(2).padStart(10)}` +
      `  canonical total now: ${canonical == null ? "EMPTY" : `$${Number(canonical).toFixed(2)}`}`,
  );
  if (!APPLY) { synced++; continue; }

  // Through writeSf, so it is retried on transport failures, lands in
  // sf_writes_audit with its prior value, and reaches the commercial Slack
  // channel if Salesforce rejects it.
  const res = await writeSf(
    { sObject: "Opportunity", recordId: o.Id, fields: { SyncedQuoteId: q.Id } },
    { source: "tomco_writeback", priorValues: { SyncedQuoteId: null } },
  );
  if (!res.ok) { console.log(`        🔴 ${res.error}`); failed++; continue; }
  synced++;
}

if (APPLY && synced > 0) {
  // The work order is created by the org's own automation, which is not
  // instant. A check that runs too early reports a failure that is not one.
  console.log(`\n   waiting 20s for the org to create the work orders…`);
  await new Promise((r) => setTimeout(r, 20000));
  const after = await all(
    `SELECT Id, Name, SyncedQuoteId, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c
       FROM Opportunity WHERE Corporate_Name__c = 'Tomco Painting' AND StageName = 'Closed Won'`,
  );
  const wos2 = await all(
    `SELECT Id, WorkOrderNumber, Status, Opportunity__c, Quoted_Subtotal_with_Change_Order__c
       FROM WorkOrder WHERE Opportunity__c != null AND Status != 'Canceled'`,
  );
  const woOf = new Map(wos2.map((w) => [w.Opportunity__c, w]));
  console.log(`\n── read back ──`);
  for (const o of opps) {
    const now = after.find((a) => a.Id === o.Id);
    if (!now?.SyncedQuoteId) continue;
    const w = woOf.get(o.Id);
    const canon = now.QuotedSubtotalWithChangeOrder__c;
    console.log(
      `   ${String(o.Name).slice(0, 42).padEnd(42)} work order ${w ? `${w.WorkOrderNumber} ✅` : "none yet ⏳"}` +
        `  canonical ${canon == null ? "STILL EMPTY 🔴" : `$${Number(canon).toFixed(2)} ✅`}`,
    );
  }
}

console.log(
  `\n── ${APPLY ? `${synced} synced` : `${synced} to sync`} · ${already} already had a work order · ` +
    `${refused} refused (ambiguous) · ${noQuote} have no quote · ${failed} failed ──`,
);
if (!APPLY) console.log(`\n(plan only — nothing written. Re-run with --apply)\n`);
else console.log(`\nDone. Confirm with the reconciliation.\n`);
