/**
 * Link the change orders that are ALREADY in both systems.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/tomco-link-change-orders.mjs            plan only
 *   …same… --apply                                       writes the links
 *
 * WHY THIS HAS TO RUN ONCE, BEFORE THE NEXT IMPORT
 *
 * `stageChangeOrders` carries Salesforce's per-job `TotalChangeOrder__c` into
 * the migrated "Approved change orders" rollup row. That total now includes
 * real change orders that exist here as their own rows — so without a link
 * saying "this part of Salesforce's total is already a change order here", the
 * importer folds the same money in a second time.
 *
 * Measured on 2026-10-15: Green Leaf — FW Webb showed $18,800.00 in Salesforce
 * against an $18,250.00 rollup row and a $550.00 "Drip Caps" change order. The
 * next nightly run would have moved that rollup to $18,800 and billed the GC's
 * contract $550 twice.
 *
 * All five hand-typed approved change orders in the Command Center are already
 * in Salesforce — Mary and Stephanie entered them in both systems during the
 * dual run. This links them, by AMOUNT, on the job's own work orders. Two at
 * the same amount on one job is refused, because no key can tell "entered
 * twice" from "two genuine change orders for the same amount".
 *
 * It writes nothing to Salesforce. Only `commercial_import_map` rows.
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

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { getSalesforceClient } = await import("@/lib/salesforce/client");
const { CO_MAP_ENTITY, ROLLUP_TITLE, APPROVED_IN_SF } = await import("@/lib/salesforce/tomco-changeorder");
const conn = await getSalesforceClient();

const money = (c) => `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const cents = (d) => Math.round(Number(d ?? 0) * 100);

const map = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await sb
    .from("commercial_import_map")
    .select("sf_id, entity, row_id")
    .order("sf_id")
    .order("entity")
    .range(f, f + 999);
  if (error) throw new Error(error.message);
  map.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const dealSf = new Map(map.filter((m) => m.entity === "deal").map((m) => [m.row_id, m.sf_id]));
const rollupRows = new Set(map.filter((m) => m.entity === "change_order").map((m) => m.row_id));
const linked = new Set(map.filter((m) => m.entity === CO_MAP_ENTITY).map((m) => m.row_id));

const { data: cos, error: coErr } = await sb
  .from("commercial_change_orders")
  .select("id, opportunity_id, co_number, title, amount_cents, status, deleted_at");
if (coErr) throw new Error(coErr.message);
const { data: deals } = await sb.from("commercial_opportunities").select("id, title");
const nameOf = new Map((deals ?? []).map((d) => [d.id, d.title]));

/*
 * Real change orders only: not deleted, approved, and NOT one of the migrated
 * rollup rows. A rollup row stands for a Salesforce total — LMJ Cipla's single
 * row stands for seven records — so linking one would be a lie about what it is.
 */
const real = (cos ?? []).filter(
  (c) => !c.deleted_at && c.status === "approved" && !rollupRows.has(c.id) && !ROLLUP_TITLE.test(String(c.title ?? "")),
);

console.log(`\n══ LINK EXISTING CHANGE ORDERS · ${APPLY ? "APPLYING" : "PLAN"} ══`);
console.log(`   ${conn.instanceUrl}`);
console.log(`   ${real.length} real approved change order(s) here · ${linked.size} already linked\n`);

let willLink = 0, done = 0, already = 0, refused = 0, absent = 0;
for (const c of real) {
  const job = String(nameOf.get(c.opportunity_id) ?? "?").slice(0, 34);
  const label = `${job.padEnd(34)} CO-${c.co_number} ${money(c.amount_cents).padStart(12)}`;

  if (linked.has(c.id)) { already++; continue; }

  const sfOpp = dealSf.get(c.opportunity_id);
  if (!sfOpp) { console.log(`   ·  ${label}  the deal is not in Salesforce`); absent++; continue; }

  const wos = await conn.query(
    `SELECT Id, WorkOrderNumber FROM WorkOrder WHERE Opportunity__c = '${sfOpp}' AND Status != 'Canceled'`,
  );
  if (!wos.records.length) { console.log(`   ·  ${label}  no live work order in Salesforce`); absent++; continue; }
  const woIds = wos.records.map((w) => w.Id);
  const sfCos = await conn.query(
    `SELECT Id, Name, CostChange__c, Status__c FROM ChangeOrder__c WHERE WorkOrder__c IN ('${woIds.join("','")}')`,
  );
  const same = sfCos.records.filter((x) => cents(x.CostChange__c) === Number(c.amount_cents));

  if (same.length === 0) { console.log(`   ·  ${label}  not in Salesforce — the write-back will create it`); absent++; continue; }
  if (same.length > 1) {
    console.log(`   ⏸  ${label}  ${same.length} Salesforce change orders at this amount — a person decides`);
    refused++;
    continue;
  }
  const sf = same[0];
  const counted = APPROVED_IN_SF.includes(sf.Status__c);
  console.log(`   ${APPLY ? "✅" : "·"} ${label}  ${sf.Name} (${sf.Status__c}${counted ? "" : " — NOT counted by the rollup"})`);
  willLink++;
  if (!APPLY) continue;

  const { error } = await sb.from("commercial_import_map").upsert(
    {
      sf_id: sf.Id,
      entity: CO_MAP_ENTITY,
      row_id: c.id,
      notes: "the same change order in both systems, linked 2026-10-15 so the importer stops double-counting it",
      // Epoch, like every row this feature writes: it makes `editedHere()`
      // read the Command Center row as human-edited, so Salesforce never
      // stamps over it.
      updated_at: new Date(0).toISOString(),
    },
    { onConflict: "sf_id,entity" },
  );
  if (error) { console.log(`        🔴 ${error.message}`); continue; }
  done++;
}

console.log(
  `\n── ${APPLY ? `${done} linked` : `${willLink} to link`} · ${already} already linked · ` +
    `${refused} refused (ambiguous) · ${absent} not in Salesforce ──`,
);
if (!APPLY) console.log(`\n(plan only — nothing written. Re-run with --apply)\n`);
else console.log(`\nDone. Re-run the importer's change-order stage without --commit to see the new figures.\n`);
