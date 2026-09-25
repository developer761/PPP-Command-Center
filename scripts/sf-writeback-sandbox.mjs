/**
 * Rehearse the Salesforce write-back, end to end, in the sandbox.
 *
 * Creates the chain Katie specified — Account → Opportunity → Quote →
 * QuoteLineItem → Status = Approved → sync — for ONE real Command Center deal,
 * then reads it all back and checks the money arrived intact.
 *
 * Run:
 *   node --env-file=.env.local --import ./scripts/ts-resolve-register.mjs \
 *     scripts/sf-writeback-sandbox.mjs --deal=<uuid>            # rehearse
 *   …same, plus --commit                                        # actually write
 *
 * Two rules this script exists to hold, both named after the person who found
 * the failure the hard way:
 *
 * STEPHANIE'S RULE — one number, one source. The contract pushed to Salesforce
 * is `contractValueCents()`, the platform's own definition, imported rather
 * than re-derived. A sync that computed its own base + change orders would be
 * her bug again, except split across two systems where neither side can see the
 * disagreement. And the check at the end compares the number that came BACK,
 * because "we sent the right value" is not evidence that Salesforce stored it.
 *
 * MARY'S RULE — if a person can't see it, it doesn't exist. Every record this
 * creates is printed with its Salesforce id and a clickable URL, every failure
 * says which record and why, and the summary states plainly whether the money
 * matched. A sync whose state lives only in a log is a feature nobody can
 * operate: she could not find attendance because nothing on her screen pointed
 * at it, and a silent background job is the same problem wearing a server.
 *
 * SAFETY. Sandbox only — it refuses to run against anything that isn't
 * `.sandbox.my.salesforce.com`. Dry run unless --commit. One deal per run.
 */

import jsforce from "jsforce";
import { createClient } from "@supabase/supabase-js";
import { contractValueCents } from "../lib/commercial/projects/contract-value.ts";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const dealArg = (args.find((a) => a.startsWith("--deal=")) ?? "").split("=")[1];

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const ok = (s) => `  ✓ ${s}`;
const bad = (s) => `  ✗ ${s}`;

async function main() {
  if (!dealArg) throw new Error("pass --deal=<commercial_opportunities.id>");

  // ── The Command Center side: what SHOULD end up in Salesforce ────────────
  const sb = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false },
  });
  const { data: deal } = await sb
    .from("commercial_opportunities")
    .select("id, title, title_override, title_override_mode, status, sub_status, decided_at, account_id, accepted_contract_cents")
    .eq("id", dealArg)
    .is("deleted_at", null)
    .maybeSingle();
  if (!deal) throw new Error(`no live deal ${dealArg}`);
  // `company_name`, not `name`. A column that does not exist rejects the WHOLE
  // select and comes back null, which reads exactly like "this GC has no
  // record" — and the first version of this script had a `?? "Unknown GC"`
  // fallback that turned the error into a plausible-looking account name. The
  // error is checked instead of defaulted: a sync that invents a customer name
  // would create a duplicate GC in PPP's org on every run.
  const { data: account, error: accountErr } = await sb
    .from("commercial_accounts")
    .select("id, company_name, billing_street, billing_city, billing_state, billing_zip, phone")
    .eq("id", deal.account_id)
    .maybeSingle();
  if (accountErr) throw new Error(`account read failed: ${accountErr.message}`);
  if (!account) throw new Error(`deal ${deal.id} has no live account — refusing to invent one`);

  // Stephanie's rule: the platform's own number, not this script's idea of it.
  const contractCents = await contractValueCents(deal.id);
  // The nickname goes on the END of the name unless the deal says replace.
  // `title_override || title` is a hard-coded replace, and this one writes to
  // SALESFORCE — a name shortened here is a name PPP reads back as the truth.
  const nickname = (deal.title_override ?? "").trim();
  const typed = (deal.title ?? "").trim();
  const dealName =
    (nickname && (deal.title_override_mode ?? "append") !== "append"
      ? nickname
      : nickname
        ? `${typed} - ${nickname}`.replace(/^ - /, "")
        : typed) || "Untitled";

  console.log("Command Center says:");
  console.log(`  deal      ${dealName}`);
  console.log(`  account   ${account.company_name}`);
  console.log(`  contract  ${money(contractCents)}   (contractValueCents — base + net approved COs)`);
  console.log(`  base only ${money(Number(deal.accepted_contract_cents ?? 0))}   ← what a naive sync would have sent`);
  if (contractCents <= 0) throw new Error("contract is 0 — pick a deal with a contract");

  // ── Salesforce ───────────────────────────────────────────────────────────
  const conn = new jsforce.Connection({
    loginUrl: process.env.SF_SANDBOX_LOGIN_URL ?? "https://test.salesforce.com",
    version: "60.0",
  });
  await conn.login(need("SF_SANDBOX_USERNAME"), need("SF_SANDBOX_PASSWORD") + need("SF_SANDBOX_TOKEN"));
  if (!/\.sandbox\.my\.salesforce\.com/i.test(conn.instanceUrl)) {
    throw new Error(`refusing to run against ${conn.instanceUrl} — this script is sandbox-only`);
  }
  const url = (id) => `${conn.instanceUrl}/lightning/r/${id}/view`;
  console.log(`\nSalesforce: ${conn.instanceUrl}${COMMIT ? "" : "   (DRY RUN — nothing will be written)"}`);

  // Record types BY NAME. Their ids differ between sandbox and production, and
  // two of the four happen to match, which is what makes a hardcoded table look
  // like it works right up until it writes into the wrong record type.
  const rtId = async (sobject, name) => {
    const d = await conn.sobject(sobject).describe();
    const hit = d.recordTypeInfos.find((r) => r.name === name && r.available);
    if (!hit) throw new Error(`${sobject}: no available record type named "${name}"`);
    return hit.recordTypeId;
  };
  const [accountRt, oppRt, quoteRt] = await Promise.all([
    rtId("Account", "Tomco"),
    rtId("Opportunity", "Tomco"),
    rtId("Quote", "Tomco Quote"),
  ]);
  console.log(ok(`record types resolved by name: Account ${accountRt}, Opportunity ${oppRt}, Quote ${quoteRt}`));

  // The Tomco pricebook and its generic "Other" entry — the line the contract
  // rides on. Looked up, never hardcoded, for the same reason as record types.
  const pbe = await conn.query(
    "SELECT Id, Pricebook2Id, Product2Id, UnitPrice FROM PricebookEntry " +
      "WHERE Pricebook2.Name = 'Tomco' AND Product2.Name = 'Other' AND IsActive = true LIMIT 1"
  );
  if (pbe.totalSize === 0) throw new Error("no active 'Other' pricebook entry in the Tomco pricebook");
  const entry = pbe.records[0];
  console.log(ok(`pricebook entry ${entry.Id} (Tomco / Other, list ${money(Math.round(entry.UnitPrice * 100))})`));

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const marker = `[CCC SYNC TEST ${stamp}]`;

  const plan = {
    account: {
      Name: `${account.company_name} ${marker}`,
      RecordTypeId: accountRt,
      BillingStreet: account.billing_street,
      BillingCity: account.billing_city,
      BillingState: account.billing_state,
      BillingPostalCode: account.billing_zip,
    },
    opportunity: {
      Name: `${dealName} ${marker}`,
      RecordTypeId: oppRt,
      StageName: "Closed Won",
      // Katie, 2026-09-22: "the Close Date should be the date created (in
      // Salesforce)" — for a rehearsal the deal's own decision date is the
      // closest real equivalent.
      CloseDate: (deal.decided_at ?? new Date().toISOString()).slice(0, 10),
      Pricebook2Id: entry.Pricebook2Id,
    },
    quote: {
      Name: `${dealName} ${marker}`,
      RecordTypeId: quoteRt,
      Pricebook2Id: entry.Pricebook2Id,
      Status: "Draft", // approved in its own step — sync can't precede Approved
    },
    line: {
      PricebookEntryId: entry.Id,
      Product2Id: entry.Product2Id,
      Quantity: 1,
      UnitPrice: entry.UnitPrice,
      // THE CONTRACT. Not Quantity × UnitPrice — that product of two
      // placeholders is the decoy number this org carries in `TotalPrice`.
      PriceOverride__c: true,
      PriceOverrideAmount__c: contractCents / 100,
      AreaLabel__c: "Commercial",
    },
  };

  if (!COMMIT) {
    console.log("\nWould create:");
    for (const [k, v] of Object.entries(plan)) console.log(`  ${k}: ${JSON.stringify(v)}`);
    console.log("\nDry run. Re-run with --commit to write.");
    return;
  }

  // ── Write, one record at a time, checking each ───────────────────────────
  const created = [];
  const create = async (sobject, body, label) => {
    const res = await conn.sobject(sobject).create(body);
    if (!res.success) throw new Error(`${label}: ${JSON.stringify(res.errors)}`);
    created.push({ sobject, id: res.id, label });
    console.log(ok(`${label} ${res.id}  ${url(res.id)}`));
    return res.id;
  };

  const accountId = await create("Account", plan.account, "Account");
  const oppId = await create("Opportunity", { ...plan.opportunity, AccountId: accountId }, "Opportunity");
  const quoteId = await create("Quote", { ...plan.quote, OpportunityId: oppId }, "Quote");
  await create("QuoteLineItem", { ...plan.line, QuoteId: quoteId }, "QuoteLineItem");

  // Katie: "Quote created with quote line item, Status = Approved, then Sync.
  // Sync can't come before Approved or it won't work." Two separate writes, in
  // that order, on purpose.
  const appr = await conn.sobject("Quote").update({ Id: quoteId, Status: "Approved" });
  if (!appr.success) throw new Error(`approve quote: ${JSON.stringify(appr.errors)}`);
  console.log(ok("quote approved"));

  const sync = await conn.sobject("Opportunity").update({ Id: oppId, SyncedQuoteId: quoteId });
  if (!sync.success) throw new Error(`sync quote: ${JSON.stringify(sync.errors)}`);
  console.log(ok("quote synced to the opportunity"));

  // ── Read it BACK. Sending the right number is not evidence. ──────────────
  const [oppBack, quoteBack, lineBack, woBack] = await Promise.all([
    conn.query(
      `SELECT Id, Name, StageName, CloseDate, Amount, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c, TotalAmount__c, SyncedQuoteId FROM Opportunity WHERE Id = '${oppId}'`
    ),
    conn.query(`SELECT Id, Status, Subtotal, TotalPrice, GrandTotal__c FROM Quote WHERE Id = '${quoteId}'`),
    conn.query(
      `SELECT Id, Quantity, UnitPrice, TotalPrice, TotalPrice__c, PriceOverride__c, PriceOverrideAmount__c FROM QuoteLineItem WHERE QuoteId = '${quoteId}'`
    ),
    conn.query(
      `SELECT Id, WorkOrderNumber, Status, QuotedSubtotal__c, Quoted_Subtotal_with_Change_Order__c FROM WorkOrder WHERE Opportunity__c = '${oppId}'`
    ),
  ]);

  const o = oppBack.records[0];
  const q = quoteBack.records[0];
  const l = lineBack.records[0];
  const w = woBack.records[0] ?? null;

  console.log("\nRead back from Salesforce:");
  console.log(`  quote status              ${q.Status}`);
  console.log(`  line TotalPrice__c        ${money(Math.round((l.TotalPrice__c ?? 0) * 100))}   ← the contract`);
  console.log(`  line TotalPrice           ${money(Math.round((l.TotalPrice ?? 0) * 100))}   ← DECOY (qty × unit price)`);
  console.log(`  opp QuotedSubtotalWithCO  ${money(Math.round((o.QuotedSubtotalWithChangeOrder__c ?? 0) * 100))}`);
  console.log(`  opp Amount                ${money(Math.round((o.Amount ?? 0) * 100))}   ← DECOY`);
  console.log(`  work order                ${w ? `${w.WorkOrderNumber} · ${w.Status} · ${money(Math.round((w.QuotedSubtotal__c ?? 0) * 100))}` : "none created"}`);

  // ── The check ────────────────────────────────────────────────────────────
  const cmp = (label, gotDollars) => {
    const got = Math.round((gotDollars ?? 0) * 100);
    const same = got === contractCents;
    console.log(same ? ok(`${label} matches (${money(got)})`) : bad(`${label} is ${money(got)}, expected ${money(contractCents)}`));
    return same;
  };
  console.log("\nDoes Salesforce hold the same contract the platform does?");
  const checks = [
    cmp("quote line TotalPrice__c", l.TotalPrice__c),
    cmp("opportunity QuotedSubtotalWithChangeOrder__c", o.QuotedSubtotalWithChangeOrder__c),
  ];
  if (w) checks.push(cmp("work order QuotedSubtotal__c", w.QuotedSubtotal__c));

  console.log("\nCreated (open any of these to inspect):");
  for (const c of created) console.log(`  ${c.label.padEnd(14)} ${c.id}  ${url(c.id)}`);
  console.log(`\nAll records are named "${marker}" so they can be found and cleaned up.`);

  if (checks.every(Boolean)) console.log("\nRESULT: the money survived the round trip.");
  else {
    console.log("\nRESULT: MISMATCH — the money did not survive. Nothing above is safe to ship.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exitCode = 1;
});
