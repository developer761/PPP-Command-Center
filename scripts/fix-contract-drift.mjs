/**
 * One deal's accepted contract disagrees with its own project and with
 * Salesforce.
 *
 *   node --env-file=.env.local scripts/fix-contract-drift.mjs
 *   node --env-file=.env.local scripts/fix-contract-drift.mjs --commit
 *
 * WHY
 *
 * A deal carries its contract figure in two places and they are allowed to
 * drift: `commercial_projects.contract_base_cents` (set once at award, never
 * recomputed) and `commercial_opportunities.accepted_contract_cents` (snapshot
 * of the winning proposal). The displayed ladder prefers the opportunity's.
 *
 * AIREF Building #1 — Bellport, found 2026-10-13:
 *
 *   Salesforce  Quoted_Subtotal_with_Change_Order__c   $286,695.00
 *   project     contract_base_cents                    $286,695.00   ✅ agrees
 *   deal        accepted_contract_cents                $283,082.00   ❌ $3,613 low
 *
 * Two against one, and the odd one out is the one every screen reads. The
 * reconcile could not see it, because it compares `accepted_contract_cents`
 * against Salesforce — so it was validating the wrong number against itself
 * and reporting the RIGHT one as the difference.
 *
 * This only ever moves a deal's figure TOWARD its project and Salesforce when
 * those two already agree with each other. It refuses every other shape: if
 * the project and Salesforce disagree, nobody here knows which is right.
 *
 * NOT FIXED HERE, because they are documents the GC already holds — raise with
 * Stephanie:
 *
 *   · AIREF #1 applications #2 and #3 are PAID and #5 is submitted, all frozen
 *     at the low $283,082.00. The "Original Contract Sum" line on certificates
 *     already sent is $3,613 under the contract.
 *   · LMJ Water Lilies Post Fire applications #2 and #3 (both submitted) froze
 *     $28,906.13 — the contract INCLUDING $2,325.78 of sales tax — against a
 *     $26,580.35 contract. Application #1 took the pre-tax figure, so the
 *     certificates disagree with each other. #3 also carries 0% retainage
 *     where #1 and #2 carry 5%.
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
  `SELECT Id, WorkOrderNumber, Opportunity__c, Quoted_Subtotal_with_Change_Order__c FROM WorkOrder WHERE (${TOMCO} OR Opportunity__r.${TOMCO}) AND Status != 'Canceled'`,
);
const mapRows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("commercial_import_map").select("sf_id, entity, row_id").eq("entity", "deal").order("sf_id").range(from, from + 999);
  if (error) throw new Error(error.message);
  mapRows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const dealOfSf = new Map(mapRows.map((r) => [r.sf_id, r.row_id]));

const deals = await all("commercial_opportunities", "id, title, accepted_contract_cents, deleted_at");
const dealById = new Map(deals.map((d) => [d.id, d]));
const projects = await all("commercial_projects", "opportunity_id, contract_base_cents, deleted_at");
const projOf = new Map(projects.filter((p) => !p.deleted_at).map((p) => [p.opportunity_id, p]));
const cos = await all("commercial_change_orders", "opportunity_id, amount_cents, status, deleted_at");
const coOf = new Map();
for (const c of cos) {
  if (c.deleted_at || c.status !== "approved") continue;
  coOf.set(c.opportunity_id, (coOf.get(c.opportunity_id) ?? 0) + Number(c.amount_cents ?? 0));
}

const planned = [];
const refused = [];
for (const w of wos) {
  const id = dealOfSf.get(w.Opportunity__c);
  const deal = id ? dealById.get(id) : null;
  if (!deal || deal.deleted_at) continue;
  const proj = projOf.get(id);
  if (!proj) continue;
  const sf = cents(w.Quoted_Subtotal_with_Change_Order__c);
  const base = Number(proj.contract_base_cents ?? 0);
  const accepted = Number(deal.accepted_contract_cents ?? 0);
  const co = coOf.get(id) ?? 0;
  if (accepted === base) continue;                       // already agree
  // The project and Salesforce must agree with each other before this touches
  // anything — two independent sources saying the same number is the only
  // evidence here that the third one is the mistake.
  if (base !== sf) {
    refused.push({ deal, why: `project ${money(base)} and Salesforce ${money(sf)} disagree — nobody here knows which is right` });
    continue;
  }
  // A deal whose accepted figure differs only by change orders raised here is
  // not drift; that is the ladder working.
  if (accepted + co === base || accepted === base + co) {
    refused.push({ deal, why: `the ${money(Math.abs(base - accepted))} difference is approved change orders` });
    continue;
  }
  planned.push({ deal, from: accepted, to: base, sf, wo: w.WorkOrderNumber });
}

console.log(`\nDeals whose accepted contract disagrees with their project AND Salesforce\n`);
console.log(`  jobs examined: ${wos.length}`);
console.log(`\n── WOULD CORRECT (${planned.length}) ──`);
for (const p of planned) {
  console.log(`  ${String(p.deal.title).slice(0, 44)}   WO ${p.wo}`);
  console.log(`     accepted_contract_cents  ${money(p.from)} → ${money(p.to)}`);
  console.log(`     project ${money(p.to)} · Salesforce ${money(p.sf)}  (both already agree)`);
}
if (refused.length) {
  console.log(`\n── LEFT ALONE (${refused.length}) ──`);
  for (const r of refused) console.log(`  ${String(r.deal.title).slice(0, 44)} — ${r.why}`);
}

if (!COMMIT) { console.log(`\nDry run. Re-run with --commit to apply.\n`); process.exit(0); }
if (planned.length === 0) { console.log(`\nNothing to correct.\n`); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `/tmp/contract-drift-${stamp}.json`;
writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), planned }, null, 2));
console.log(`\nbackup written: ${path}`);
for (const p of planned) {
  const { error } = await sb.from("commercial_opportunities").update({ accepted_contract_cents: p.to }).eq("id", p.deal.id);
  if (error) throw new Error(`${p.deal.title}: ${error.message}`);
}
console.log(`\n✅ ${planned.length} contract figure(s) corrected to match the project and Salesforce.`);
console.log(`   The AIA certificates already issued still carry the old sum — that is Stephanie's call.\n`);
