/**
 * Stage 0 of the Tomco write-back: one sandbox sale, to settle what reading
 * cannot.
 *
 *   node scripts/tomco-writeback-stage0.mjs            resolve + plan, WRITES NOTHING
 *   node scripts/tomco-writeback-stage0.mjs --apply    create the records
 *   node scripts/tomco-writeback-stage0.mjs --cleanup  delete what this created
 *
 * WHAT IT IS FOR
 *
 * docs/TOMCO_SF_WRITEBACK_PLAN.md §2f rests on an assumption nobody has
 * verified: that approving and syncing a Quote makes
 * `Opportunity_WorkOrderWhenClosedWon` create the WorkOrder, its line items and
 * the Payment_Term__c rows. The data argues against it — all 100 Tomco work
 * orders in production were created by a person (Mary 69, Brendan 23, Katie 4,
 * Kate 4), zero Payment_Term__c rows exist on any of them, and 85 opportunities
 * already carry a SyncedQuoteId and produced none of it. Flow bodies return
 * INSUFFICIENT_ACCESS to this connection, so it cannot be settled by reading.
 *
 * Three conclusions hang on the answer: whether the money rollup ever runs,
 * whether a change order has a WorkOrder to attach to (its WorkOrder__c is
 * required and create-only, and this user cannot create a Tomco WorkOrder —
 * the record type reads available=false), and whether the customer-facing flows
 * fire at all.
 *
 * It also checks the two exclusions Katie made on 2026-10-13 — quota points and
 * the "Let's Get Started" email — rather than taking them on trust, because
 * neither filter is readable from here either.
 *
 * SAFETY
 *
 * Every write is refused unless the resolved instance URL contains ".sandbox.".
 * That check runs against the URL the org ITSELF returns after the token
 * exchange, not the one we asked for, so a mis-stored credential cannot route a
 * write to production. The production refresh token is never read by this file.
 */
import { readFileSync } from "node:fs";
import jsforce from "jsforce";

const APPLY = process.argv.includes("--apply");
const CLEANUP = process.argv.includes("--cleanup");
const STAMP = "CCC-STAGE0";

function envFrom(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

const HERE = "/Users/karanmalhotra/Desktop/PPP/ppp-command-center";
const env = envFrom(`${HERE}/.env.local`);
// The sandbox Connected App lives in the payments test project; this repo's
// .env.local only has production's.
const sbEnv = envFrom(`${HERE}/../ppp-cc-paytest/.env.local`);

const { createClient } = await import("@supabase/supabase-js");
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const { data: cred, error: credErr } = await supa
  .from("system_credentials")
  .select("key,value")
  .in("key", ["sandbox_sf_refresh_token", "sandbox_sf_instance_url"]);
if (credErr) throw new Error(`credential read failed: ${credErr.message}`);
const C = Object.fromEntries((cred ?? []).map((r) => [r.key, r.value]));
if (!C.sandbox_sf_refresh_token) throw new Error("no sandbox_sf_refresh_token stored — reconnect via /api/auth/salesforce-sandbox/login");

const conn = new jsforce.Connection({
  oauth2: {
    loginUrl: sbEnv.SF_SANDBOX_LOGIN_URL || "https://test.salesforce.com",
    clientId: sbEnv.SF_SANDBOX_CONSUMER_KEY,
    clientSecret: sbEnv.SF_SANDBOX_CONSUMER_SECRET,
  },
  instanceUrl: C.sandbox_sf_instance_url,
  refreshToken: C.sandbox_sf_refresh_token,
});
const refreshed = await conn.oauth2.refreshToken(C.sandbox_sf_refresh_token);
conn.accessToken = refreshed.access_token;
if (refreshed.instance_url) conn.instanceUrl = refreshed.instance_url;

/*
 * THE GUARD. Checked against what the org returned, and re-checked immediately
 * before the first write — a mistake here writes a fake sale into the org PPP
 * actually runs on.
 */
function assertSandbox(where) {
  const url = String(conn.instanceUrl ?? "");
  if (!url.includes(".sandbox.")) {
    console.error(`\n🔴 REFUSING (${where}): instance is ${url || "unknown"}, which is not a sandbox.\n`);
    process.exit(1);
  }
  return url;
}
const INSTANCE = assertSandbox("startup");

const soql = async (q) => {
  const out = [];
  let r = await conn.query(q);
  out.push(...r.records);
  while (!r.done) { r = await conn.queryMore(r.nextRecordsUrl); out.push(...r.records); }
  return out;
};
const money = (n) => `$${Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const line = (s = "") => console.log(s);

line(`\n══ TOMCO WRITE-BACK · STAGE 0 ══`);
line(`   org      ${INSTANCE}`);
line(`   mode     ${CLEANUP ? "CLEANUP" : APPLY ? "APPLY — will create records" : "DRY RUN — writes nothing"}`);
const who = await conn.identity();
line(`   as       ${who.username}`);

/* ─── cleanup ──────────────────────────────────────────────────────────── */
if (CLEANUP) {
  assertSandbox("cleanup");
  const opps = await soql(`SELECT Id, Name FROM Opportunity WHERE Name LIKE '${STAMP}%'`);
  if (opps.length === 0) { line(`\nNothing stamped ${STAMP} to remove.\n`); process.exit(0); }
  for (const o of opps) {
    const wos = await soql(`SELECT Id FROM WorkOrder WHERE Opportunity__c = '${o.Id}'`);
    for (const w of wos) { try { await conn.sobject("WorkOrder").destroy(w.Id); line(`   deleted WorkOrder ${w.Id}`); } catch (e) { line(`   could not delete WorkOrder ${w.Id}: ${e.message}`); } }
    const qs = await soql(`SELECT Id FROM Quote WHERE OpportunityId = '${o.Id}'`);
    for (const q of qs) { try { await conn.sobject("Quote").destroy(q.Id); line(`   deleted Quote ${q.Id}`); } catch (e) { line(`   could not delete Quote ${q.Id}: ${e.message}`); } }
    try { await conn.sobject("Opportunity").destroy(o.Id); line(`   deleted Opportunity ${o.Id} "${o.Name}"`); }
    catch (e) { line(`   could not delete Opportunity ${o.Id}: ${e.message}`); }
  }
  line(`\nDone.\n`);
  process.exit(0);
}

/* ─── resolve everything by NAME, never by a hardcoded id ──────────────── */
// Every id differs between sandbox and production — the Opportunity record
// type, the pricebook, the "Other" PricebookEntry and Brendan's user id are all
// different over here, which is exactly why the plan forbids constants.
line(`\n── resolving ──`);

const [oppRt] = await soql(
  `SELECT Id, Name, DeveloperName FROM RecordType WHERE SobjectType = 'Opportunity' AND (Name LIKE '%Tomco%' OR DeveloperName LIKE '%Tomco%') LIMIT 1`);
line(`   Opportunity record type   ${oppRt ? `${oppRt.Id}  "${oppRt.Name}"` : "🔴 none matching Tomco"}`);

const [book] = await soql(`SELECT Id, Name, IsActive FROM Pricebook2 WHERE Name = 'Tomco' AND IsActive = true LIMIT 1`);
line(`   Pricebook                 ${book ? `${book.Id}  "${book.Name}"` : "🔴 no active 'Tomco' pricebook"}`);

let pbe = null;
if (book) {
  [pbe] = await soql(
    `SELECT Id, UnitPrice, Product2Id, Product2.Name FROM PricebookEntry WHERE Pricebook2Id = '${book.Id}' AND Product2.Name = 'Other' AND IsActive = true LIMIT 1`);
}
line(`   "Other" PricebookEntry    ${pbe ? `${pbe.Id}  ${money(pbe.UnitPrice)}  product ${pbe.Product2Id}` : "🔴 not found in that book"}`);

const [owner] = await soql(
  `SELECT Id, Name, Username, IsActive FROM User WHERE IsActive = true AND (Name LIKE '%Tomco%' OR Username LIKE '%brendan%') ORDER BY Name LIMIT 1`);
line(`   Owner                     ${owner ? `${owner.Id}  ${owner.Name}` : "— will default to the running user"}`);

const [acct] = await soql(
  `SELECT Id, Name FROM Account WHERE Name LIKE '%PCCI%' OR Name LIKE '%LMJ%' ORDER BY Name LIMIT 1`);
line(`   Account to hang it on     ${acct ? `${acct.Id}  "${acct.Name}"` : "— none found; will create without one"}`);

const CONTRACT = 12345.67; // deliberately unmistakable in a report
const CLOSE = new Date().toISOString().slice(0, 10);
const NAME = `${STAMP} write-back probe ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

line(`\n── what it will create ──`);
line(`   Opportunity   "${NAME}"`);
line(`                 StageName=Closed Won · CloseDate=${CLOSE} · contract ${money(CONTRACT)}`);
line(`   Quote         Status=Approved, then synced onto the Opportunity`);
line(`   QuoteLineItem Quantity=1 · UnitPrice=${money(pbe?.UnitPrice ?? 500)} · PriceOverride__c=true · PriceOverrideAmount__c=${money(CONTRACT)}`);

if (!oppRt || !book || !pbe) {
  line(`\n🔴 Cannot proceed — something above did not resolve. Nothing written.\n`);
  process.exit(1);
}
if (!APPLY) {
  line(`\n(dry run — nothing written. Re-run with --apply)\n`);
  process.exit(0);
}

/* ─── the write ────────────────────────────────────────────────────────── */
assertSandbox("before first write");
line(`\n── writing ──`);

const oppPayload = {
  Name: NAME.slice(0, 120),
  StageName: "Closed Won",
  CloseDate: CLOSE,
  RecordTypeId: oppRt.Id,
  Pricebook2Id: book.Id,
  LeadSource: "Tomco",
  ...(acct ? { AccountId: acct.Id } : {}),
  ...(owner ? { OwnerId: owner.Id } : {}),
};
const oppRes = await conn.sobject("Opportunity").create(oppPayload);
if (!oppRes.success) { console.error(oppRes); process.exit(1); }
const oppId = oppRes.id;
line(`   Opportunity   ${oppId}`);

const quoteRes = await conn.sobject("Quote").create({
  Name: `${STAMP} quote`.slice(0, 255),
  OpportunityId: oppId,
  Pricebook2Id: book.Id,
  Status: "Draft",
});
if (!quoteRes.success) { console.error(quoteRes); process.exit(1); }
const quoteId = quoteRes.id;
line(`   Quote         ${quoteId}  (Draft)`);

const qliRes = await conn.sobject("QuoteLineItem").create({
  QuoteId: quoteId,
  PricebookEntryId: pbe.Id,
  Product2Id: pbe.Product2Id,
  Quantity: 1,
  UnitPrice: pbe.UnitPrice ?? 500,
  PriceOverride__c: true,
  PriceOverrideAmount__c: CONTRACT,
});
if (!qliRes.success) { console.error(qliRes); process.exit(1); }
line(`   QuoteLineItem ${qliRes.id}  override ${money(CONTRACT)}`);

// Approve, then sync — the two acts are separate, and the work-order flow is
// documented as requiring the SYNC, not the approval.
await conn.sobject("Quote").update({ Id: quoteId, Status: "Approved" });
line(`   Quote         → Approved`);
let syncError = null;
try {
  await conn.sobject("Opportunity").update({ Id: oppId, SyncedQuoteId: quoteId });
  line(`   Opportunity   → SyncedQuoteId set`);
} catch (e) {
  syncError = e.message;
  line(`   🔴 sync failed: ${e.message}`);
}

// Flows are asynchronous. Give them a moment before reading back.
await new Promise((r) => setTimeout(r, 8000));

/* ─── read back: the five questions ────────────────────────────────────── */
line(`\n══ WHAT ACTUALLY HAPPENED ══\n`);
let verdicts = [];
const V = (q, a, good) => { verdicts.push([q, a, good]); line(`   ${good === true ? "✅" : good === false ? "🔴" : "  "} ${q.padEnd(44)} ${a}`); };

const [opp] = await soql(
  `SELECT Id, Name, StageName, CloseDate, Amount, Quote_Subtotal__c, QuotedSubtotalWithChangeOrder__c, Corporate_Name__c, SyncedQuoteId, OwnerId, Owner.Name FROM Opportunity WHERE Id = '${oppId}'`);
const [quote] = await soql(
  `SELECT Id, Status, Subtotal__c, QuotedSubtotal__c, Tax, GrandTotal__c, IsSyncing FROM Quote WHERE Id = '${quoteId}'`);
const [qli] = await soql(
  `SELECT Id, TotalPrice__c, PriceOverride__c, PriceOverrideAmount__c FROM QuoteLineItem WHERE QuoteId = '${quoteId}'`);

V("1. quote line → TotalPrice__c", money(qli?.TotalPrice__c), Number(qli?.TotalPrice__c) === CONTRACT);
V("   Quote.Subtotal__c", money(quote?.Subtotal__c), Number(quote?.Subtotal__c) === CONTRACT);
V("   Quote.QuotedSubtotal__c", money(quote?.QuotedSubtotal__c), Number(quote?.QuotedSubtotal__c) === CONTRACT);
V("   Opportunity.Quote_Subtotal__c", money(opp?.Quote_Subtotal__c), Number(opp?.Quote_Subtotal__c) === CONTRACT);
V("   Opportunity.Amount", money(opp?.Amount), null);
V("   CO-inclusive total", opp?.QuotedSubtotalWithChangeOrder__c == null ? "NULL (as predicted)" : money(opp.QuotedSubtotalWithChangeOrder__c), null);

V("2. Corporate_Name__c", opp?.Corporate_Name__c ?? "NULL", opp?.Corporate_Name__c === "Tomco Painting");
V("   StageName held", opp?.StageName ?? "?", opp?.StageName === "Closed Won");
V("   CloseDate held", opp?.CloseDate ?? "?", opp?.CloseDate === CLOSE);
V("   Owner", opp?.Owner?.Name ?? "?", null);
V("   SyncedQuoteId", opp?.SyncedQuoteId ? "set" : syncError ? `FAILED — ${syncError}` : "null", !!opp?.SyncedQuoteId);

const wos = await soql(`SELECT Id, WorkOrderNumber, Status, CreatedById, Corporate_Name__c FROM WorkOrder WHERE Opportunity__c = '${oppId}'`);
V("3. WorkOrder created by the flow?", wos.length === 0 ? "NO — zero work orders" : `YES — ${wos.length}`, null);
for (const w of wos) line(`        ${w.WorkOrderNumber} ${w.Status} corporate=${w.Corporate_Name__c ?? "NULL"}`);

let terms = "n/a (no work order)";
if (wos.length > 0) {
  try {
    const t = await soql(`SELECT Id FROM Payment_Term__c WHERE WorkOrder__c = '${wos[0].Id}'`);
    terms = `${t.length}`;
  } catch (e) { terms = `could not query — ${e.message}`; }
}
V("   Payment_Term__c rows", terms, null);

let qp = "could not query";
try {
  const rows = await soql(`SELECT Id, Points__c FROM QuotaPoints__c WHERE Opportunity__c = '${oppId}'`);
  qp = rows.length === 0 ? "ZERO — exclusion holds" : `🔴 ${rows.length} row(s) — exclusion did NOT hold`;
  V("4. Quota points written?", qp, rows.length === 0);
} catch (e) {
  V("4. Quota points written?", `object not queryable here — ${e.errorCode ?? e.message}`, null);
}

try {
  const em = await soql(`SELECT Id, Subject, ToAddress FROM EmailMessage WHERE RelatedToId = '${oppId}'`);
  V("5. Email sent to anyone?", em.length === 0 ? "NONE — exclusion holds" : `🔴 ${em.length}`, em.length === 0);
  for (const e of em) line(`        "${e.Subject}" → ${e.ToAddress}`);
} catch (e) {
  V("5. Email sent to anyone?", `not queryable — ${e.errorCode ?? e.message}`, null);
}

line(`\n── what this settles ──`);
if (wos.length === 0) {
  line(`   The flow does NOT create the WorkOrder. §2f's assumption is wrong, and`);
  line(`   the change-order step (§2d) has no parent to attach to — ChangeOrder__c`);
  line(`   .WorkOrder__c is required and create-only. That half needs a decision`);
  line(`   from Katie before it can be built.`);
} else {
  line(`   The flow DOES create the WorkOrder, so §2f holds and the change-order`);
  line(`   step has its parent. The CO-inclusive total should populate too.`);
}
line(`\n   Records left in the sandbox for inspection. Remove with --cleanup.`);
line(`   Opportunity ${INSTANCE}/${oppId}\n`);

const bad = verdicts.filter(([, , g]) => g === false);
if (bad.length) {
  line(`🔴 ${bad.length} check(s) came back wrong:`);
  for (const [q, a] of bad) line(`     ${q.trim()} → ${a}`);
  line("");
}
