/**
 * The same work, invoiced twice.
 *
 *   node --env-file=.env.local scripts/fix-duplicate-invoices.mjs
 *       dry run — prints what it WOULD do, touches nothing
 *   node --env-file=.env.local scripts/fix-duplicate-invoices.mjs --commit
 *
 * WHY
 *
 * The dual-run duplicate, in its most expensive form. The migration imports ONE
 * invoice per job covering the whole contract; Tomco bills in stages. So when
 * the second progress payment comes due, an invoice gets raised here for it —
 * reasonably — not realising the imported one already covers the job.
 *
 * Two found, both on jobs Salesforce says are fully billed and fully paid:
 *
 *   J. Carleton Env. Center  INV-0027  $11,617.85  (voided 2026-10-13)
 *   J & L 303 Christopher    INV-0032   $5,165.63
 *
 * J & L is the clearer one, because a third copy makes the intent visible:
 * INV-0028 was raised at 13:39 and deleted, and INV-0032 raised at 16:30 the
 * same afternoon. Somebody noticed one copy and replaced it rather than
 * realising SF-00316954 was already there and already paid.
 *
 * WHY IT MATTERS. An unpaid duplicate sits in RECEIVABLES. It is Tomco chasing
 * a GC for money the GC has already sent — the one error that reaches the
 * customer.
 *
 * WHAT COUNTS AS A DUPLICATE HERE, and it is deliberately narrow:
 *
 *   · the job carries an invoice imported from Salesforce (`SF-` prefix), and
 *   · that imported invoice's balance is ZERO — Salesforce considers it settled
 *     — and Salesforce's own BalanceOwed__c agrees, and
 *   · a second invoice raised HERE has NO payments against it, and
 *   · its total exactly equals the imported one's, or the job's billed total
 *     exceeds what Salesforce says the whole contract is.
 *
 * Anything else is left alone. In particular an invoice raised here that has
 * been PAID is new billing, not a duplicate — DuCon's INV-0025 bills a real
 * change order and must survive.
 *
 * Soft delete, reversible, and every row is backed up first regardless.
 */
import { createClient } from "@supabase/supabase-js";
import jsforce from "jsforce";
import { writeFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const money = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const cents = (d) => {
  const n = Number(d ?? 0);
  return Number.isFinite(n) ? Math.sign(n) * Math.round(Math.abs(n) * 100) : 0;
};

async function all(table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ── Salesforce, read-only ───────────────────────────────────────────────────
const { data: cred, error: ce } = await sb
  .from("system_credentials").select("key, value").in("key", ["sf_refresh_token", "sf_instance_url"]);
if (ce) throw new Error(ce.message);
const C = Object.fromEntries((cred ?? []).map((r) => [r.key, r.value]));
const conn = new jsforce.Connection({
  oauth2: { loginUrl: process.env.SF_LOGIN_URL, clientId: process.env.SF_CONSUMER_KEY, clientSecret: process.env.SF_CONSUMER_SECRET },
  instanceUrl: C.sf_instance_url,
  refreshToken: C.sf_refresh_token,
});
await conn.oauth2.refreshToken(C.sf_refresh_token).then((r) => { conn.accessToken = r.access_token; });
const sobject = conn.sobject.bind(conn);
conn.sobject = (n) => new Proxy(sobject(n), {
  get(t, k) {
    if (["create", "update", "upsert", "destroy", "delete", "insert"].includes(String(k))) {
      throw new Error(`refusing to ${String(k)} in Salesforce — this script is read-only`);
    }
    return t[k];
  },
});
async function soql(q) {
  const out = []; let r = await conn.query(q); out.push(...r.records);
  while (!r.done) { r = await conn.queryMore(r.nextRecordsUrl); out.push(...r.records); }
  return out;
}

const TOMCO = "Corporate_Name__c='Tomco Painting'";
const wos = await soql(
  `SELECT Id, WorkOrderNumber, Opportunity__c, GrandTotal__c, TotalPaymentsIn__c, BalanceOwed__c FROM WorkOrder WHERE (${TOMCO} OR Opportunity__r.${TOMCO}) AND Status != 'Canceled'`,
);

const mapRows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("commercial_import_map").select("sf_id, entity, row_id").order("sf_id").order("entity").range(from, from + 999);
  if (error) throw new Error(error.message);
  mapRows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const dealOfSf = new Map(mapRows.filter((r) => r.entity === "deal").map((r) => [r.sf_id, r.row_id]));

const invoices = await all("commercial_invoices", "id, invoice_number, opportunity_id, subtotal_cents, total_cents, paid_cents, balance_cents, status, created_at, created_by_user_id, deleted_at");
const byDeal = new Map();
for (const i of invoices) {
  if (i.deleted_at) continue;
  if (!byDeal.has(i.opportunity_id)) byDeal.set(i.opportunity_id, []);
  byDeal.get(i.opportunity_id).push(i);
}
const deals = await all("commercial_opportunities", "id, title");
const nameOf = new Map(deals.map((d) => [d.id, d.title]));

const voidable = [];
const refused = [];
for (const w of wos) {
  const deal = dealOfSf.get(w.Opportunity__c);
  if (!deal) continue;
  const live = byDeal.get(deal) ?? [];
  const imported = live.filter((i) => String(i.invoice_number ?? "").startsWith("SF-"));
  const raisedHere = live.filter((i) => !String(i.invoice_number ?? "").startsWith("SF-"));
  if (imported.length !== 1 || raisedHere.length === 0) continue;

  const sfBalance = cents(w.BalanceOwed__c);
  const theirs = imported[0];
  // Salesforce must consider the job settled, and our imported copy agree.
  if (sfBalance !== 0 || Number(theirs.balance_cents) !== 0) {
    refused.push({ deal, why: `Salesforce balance ${money(sfBalance)}, imported invoice balance ${money(Number(theirs.balance_cents))} — not a settled job` });
    continue;
  }
  for (const mine of raisedHere) {
    if (Number(mine.paid_cents) > 0) {
      refused.push({ deal, inv: mine, why: `has ${money(Number(mine.paid_cents))} of payments — real billing, not a duplicate` });
      continue;
    }
    if (Number(mine.total_cents) !== Number(theirs.total_cents)) {
      refused.push({ deal, inv: mine, why: `${money(Number(mine.total_cents))} does not equal the imported ${money(Number(theirs.total_cents))}` });
      continue;
    }
    voidable.push({ deal, mine, theirs, wo: w.WorkOrderNumber, sfTotal: cents(w.GrandTotal__c), sfPaid: cents(w.TotalPaymentsIn__c) });
  }
}

console.log(`\nDuplicate invoices — the same work billed twice\n`);
console.log(`  jobs examined: ${wos.length}`);
console.log(`\n── WOULD VOID (${voidable.length}) ──`);
let total = 0;
for (const v of voidable) {
  total += Number(v.mine.total_cents);
  console.log(`  ${String(nameOf.get(v.deal)).slice(0, 44)}   WO ${v.wo}`);
  console.log(`     void   ${v.mine.invoice_number.padEnd(12)} ${money(Number(v.mine.total_cents))}  ${v.mine.status}  outstanding ${money(Number(v.mine.balance_cents))}  raised ${String(v.mine.created_at).slice(0, 10)}`);
  console.log(`     keep   ${v.theirs.invoice_number.padEnd(12)} ${money(Number(v.theirs.total_cents))}  paid in full`);
  console.log(`     Salesforce: billed ${money(v.sfTotal)} · collected ${money(v.sfPaid)} · owed $0.00`);
}
console.log(`\n  false receivable this clears: ${money(total)}`);
if (refused.length) {
  console.log(`\n── LEFT ALONE (${refused.length}) ──`);
  for (const r of refused) console.log(`  ${String(nameOf.get(r.deal)).slice(0, 44)}${r.inv ? ` ${r.inv.invoice_number}` : ""} — ${r.why}`);
}

if (!COMMIT) { console.log(`\nDry run. Re-run with --commit to apply.\n`); process.exit(0); }
if (voidable.length === 0) { console.log(`\nNothing to void.\n`); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `/tmp/duplicate-invoices-voided-${stamp}.json`;
writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), voided: voidable }, null, 2));
console.log(`\nbackup written: ${path}`);

for (const v of voidable) {
  const { error } = await sb.from("commercial_invoices").update({
    deleted_at: new Date().toISOString(),
    notes: `Voided ${new Date().toISOString().slice(0, 10)}: duplicate of ${v.theirs.invoice_number}, which already bills this job in full and is paid. Salesforce shows $0.00 owed.`,
  }).eq("id", v.mine.id);
  if (error) throw new Error(`void ${v.mine.invoice_number}: ${error.message}`);
}
console.log(`\n✅ ${voidable.length} duplicate invoice(s) voided, ${money(total)} of false receivable cleared.\n`);
