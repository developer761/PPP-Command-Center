/**
 * The same receipt, costed twice.
 *
 *   node --env-file=.env.local scripts/fix-duplicate-costs.mjs
 *       dry run — prints what it WOULD do, touches nothing
 *   node --env-file=.env.local scripts/fix-duplicate-costs.mjs --commit
 *
 * WHY
 *
 * The same dual-entry that duplicated the payments duplicated the costs. During
 * the transition Mary enters a receipt in Command Center AND in Salesforce; the
 * importer then brings Salesforce's copy across as a second row, because hers
 * carries no Salesforce id and nothing looked for one.
 *
 * Found 2026-10-13 by comparing job-by-job against Salesforce: 47 pairs, and on
 * 46 of them the two rows agree on vendor, amount, date and job — one carrying
 * Salesforce's TN- transaction number in its description, the other typed here
 * with none.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. `--reconcile` compares only MAPPED rows,
 * so these sit outside the comparison and the materials and labor totals tick
 * green while the book is wrong. They surface instead as the benign-looking
 * "130 cost(s) entered in Command Center" line. Job profitability on ten jobs
 * is understated right now — the cost is real but it is counted twice.
 *
 * WHICH ROW GOES, AND WHY IT IS THE OPPOSITE OF THE PAYMENTS FIX
 *
 * `fix-duplicate-payments.mjs` keeps the row a person typed, because a payment
 * carries their cheque reference and their deposited tick, and cannot be
 * re-imported. A cost is the other way round: the Salesforce-sourced row holds
 * the TN- number, the vendor link and the correct category, and the typed copy
 * holds strictly less. Keeping Salesforce's row is also what "1:1 with
 * Salesforce" means — the receipt is Salesforce's record, not new work done
 * here.
 *
 * The import-map row already points at the kept row, so nothing is re-pointed
 * and the next sync updates it exactly as before.
 *
 * REFUSES, rather than guessing:
 *   - any group that is not exactly one imported + one typed row
 *   - any pair whose VENDORS disagree (1 of the 47) — that is two receipts, or
 *     a miscategorised one, and only a person can say
 *   - any group where Salesforce does not actually hold fewer rows than we do
 */
import { createClient } from "@supabase/supabase-js";
import jsforce from "jsforce";
import { writeFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const money = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const day = (v) => String(v ?? "").slice(0, 10);
const norm = (v) => String(v ?? "").trim().toLowerCase();

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

async function mapFor(entity) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_import_map")
      .select("sf_id, row_id")
      .eq("entity", entity)
      .order("sf_id")
      .range(from, from + 999);
    if (error) throw new Error(`import map (${entity}): ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ── Salesforce, READ-ONLY ───────────────────────────────────────────────────
const { data: cred, error: ce } = await sb
  .from("system_credentials")
  .select("key, value")
  .in("key", ["sf_refresh_token", "sf_instance_url"]);
if (ce) throw new Error(ce.message);
const C = Object.fromEntries((cred ?? []).map((r) => [r.key, r.value]));
const conn = new jsforce.Connection({
  oauth2: {
    loginUrl: process.env.SF_LOGIN_URL,
    clientId: process.env.SF_CONSUMER_KEY,
    clientSecret: process.env.SF_CONSUMER_SECRET,
  },
  instanceUrl: C.sf_instance_url,
  refreshToken: C.sf_refresh_token,
});
await conn.oauth2.refreshToken(C.sf_refresh_token).then((r) => { conn.accessToken = r.access_token; });
// Salesforce is read-only here, and said so in code rather than in a comment.
const sobject = conn.sobject.bind(conn);
conn.sobject = (name) =>
  new Proxy(sobject(name), {
    get(t, k) {
      if (["create", "update", "upsert", "destroy", "delete", "insert"].includes(String(k))) {
        throw new Error(`refusing to ${String(k)} in Salesforce — this script is read-only`);
      }
      return t[k];
    },
  });

async function soql(q) {
  const out = [];
  let r = await conn.query(q);
  out.push(...r.records);
  while (!r.done) {
    r = await conn.queryMore(r.nextRecordsUrl);
    out.push(...r.records);
  }
  return out;
}

const TOMCO = "Corporate_Name__c='Tomco Painting'";
const wos = await soql(
  `SELECT Id, Opportunity__c FROM WorkOrder WHERE ${TOMCO} OR Opportunity__r.${TOMCO}`,
);
const oppOfWo = new Map(wos.map((w) => [w.Id, w.Opportunity__c]));
const tx = await soql(
  `SELECT Id, Amount__c, Date__c, WorkOrder__c, Opportunity__c FROM Transaction__c WHERE RecordType.DeveloperName IN ('Purchase','Payment_Out')`,
);

// ── Ours ────────────────────────────────────────────────────────────────────
const purchases = await all(
  "commercial_project_purchases",
  "id, opportunity_id, category, vendor, amount_cents, purchased_at, description, created_by_user_id, created_at, deleted_at",
);
const sfIdFor = new Map((await mapFor("purchase")).map((r) => [r.row_id, r.sf_id]));
const dealOfSf = new Map((await mapFor("deal")).map((r) => [r.sf_id, r.row_id]));
const deals = await all("commercial_opportunities", "id, title");
const nameOf = new Map(deals.map((d) => [d.id, d.title]));

/** How many cost transactions Salesforce holds at each (deal, amount, day). */
const sfCount = new Map();
for (const t of tx) {
  const sfOpp = t.Opportunity__c ?? oppOfWo.get(t.WorkOrder__c);
  const deal = dealOfSf.get(sfOpp);
  if (!deal) continue;
  const k = `${deal}|${Math.round(Number(t.Amount__c ?? 0) * 100)}|${day(t.Date__c)}`;
  sfCount.set(k, (sfCount.get(k) ?? 0) + 1);
}

const groups = new Map();
for (const p of purchases) {
  if (p.deleted_at) continue;
  const k = `${p.opportunity_id}|${p.amount_cents}|${day(p.purchased_at)}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}

const remove = [];
const refused = [];
for (const [k, rows] of groups) {
  if (rows.length < 2) continue;
  const imported = rows.filter((r) => sfIdFor.has(r.id));
  const typed = rows.filter((r) => !sfIdFor.has(r.id));
  const held = sfCount.get(k) ?? 0;

  if (imported.length !== 1 || typed.length !== 1) {
    refused.push({ rows, why: `${imported.length} imported / ${typed.length} typed — not the one-each shape` });
    continue;
  }
  if (rows.length <= held) {
    refused.push({ rows, why: `Salesforce holds ${held} transaction(s) here too — these are two real receipts` });
    continue;
  }
  if (norm(imported[0].vendor) !== norm(typed[0].vendor)) {
    refused.push({ rows, why: `vendors differ ("${imported[0].vendor}" vs "${typed[0].vendor}") — two receipts, or one miscategorised` });
    continue;
  }
  remove.push({ keep: imported[0], drop: typed[0], sfHeld: held });
}

console.log(`\nDuplicate costs — the same receipt entered in both systems\n`);
console.log(`  live purchases        : ${purchases.filter((p) => !p.deleted_at).length}`);
console.log(`  duplicate pairs found : ${remove.length + refused.length}\n`);

const byCat = {};
let total = 0;
for (const r of remove) {
  total += r.drop.amount_cents;
  const c = r.drop.category ?? "?";
  byCat[c] = (byCat[c] ?? 0) + r.drop.amount_cents;
}

console.log(`── WOULD REMOVE (${remove.length}) — the typed copy; Salesforce's row stays ──`);
for (const r of remove.sort((a, b) => b.drop.amount_cents - a.drop.amount_cents)) {
  console.log(
    `  ${money(r.drop.amount_cents).padStart(12)}  ${day(r.drop.purchased_at)}  ${String(r.drop.vendor ?? "-").slice(0, 22).padEnd(22)} ${String(nameOf.get(r.drop.opportunity_id)).slice(0, 32)}`,
  );
}
console.log(`\n  by category:`);
for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${c.padEnd(16)} ${money(v).padStart(13)}`);
}
console.log(`\n  cost this takes back out of the book: ${money(total)}`);

if (refused.length) {
  console.log(`\n── LEFT ALONE (${refused.length}) ──`);
  for (const r of refused) {
    console.log(`  ${money(r.rows[0].amount_cents)}  ${day(r.rows[0].purchased_at)}  ${String(nameOf.get(r.rows[0].opportunity_id)).slice(0, 34)}`);
    console.log(`     ${r.why}`);
  }
}

if (!COMMIT) {
  console.log(`\nDry run. Re-run with --commit to apply.\n`);
  process.exit(0);
}
if (remove.length === 0) {
  console.log(`\nNothing to remove.\n`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `/tmp/duplicate-costs-removed-${stamp}.json`;
writeFileSync(
  path,
  JSON.stringify(
    { removedAt: new Date().toISOString(), rows: remove.map((r) => ({ removed: r.drop, kept: r.keep.id, keptSalesforceId: sfIdFor.get(r.keep.id) })) },
    null,
    2,
  ),
);
console.log(`\nbackup written: ${path}`);

let done = 0;
for (const r of remove) {
  const { error } = await sb.from("commercial_project_purchases").delete().eq("id", r.drop.id);
  if (error) throw new Error(`remove ${r.drop.id}: ${error.message}`);
  done++;
}
console.log(`\n✅ ${done} duplicate cost(s) removed, ${money(total)} no longer counted twice.`);
console.log(`   Salesforce's rows kept, still mapped, so the next sync updates them as before.`);
console.log(`   Confirm with: node --env-file=.env.local scripts/import-tomco.mjs --reconcile\n`);
