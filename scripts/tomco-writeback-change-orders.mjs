/**
 * Stage 4: the change orders approved here that Salesforce has not got.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/tomco-writeback-change-orders.mjs            plan only
 *   …same… --apply                                            does it
 *
 * These are the last four reconciliation differences — $7,065.70 of real work
 * approved in the Command Center that Katie's Salesforce total does not include.
 *
 * WE NEVER WRITE A MONEY FIELD ON THE OPPORTUNITY
 *
 * `ChangeOrder__c` hangs off the WorkOrder, and `WorkOrder.TotalChangeOrder__c`
 * is a rollup over it which feeds `Quoted_Subtotal_with_Change_Order__c` and
 * then the opportunity. Proven in the sandbox 2026-10-14: one $1,111.11 change
 * order moved the work order from $12,345.67 to $13,456.78 on its own. So we
 * create the record and let the org do the arithmetic.
 *
 * 🔴 THE SYNTHETIC ROLLUP ROWS ARE NEVER PUSHED
 *
 * 18 of the 23 approved change orders here are titled "Approved change orders"
 * — rows the importer created to carry a Salesforce TOTAL across, not real
 * change orders. LMJ Cipla's single $31,127.09 row stands for SEVEN Salesforce
 * records. Pushing one would add money Salesforce already holds, to the tune of
 * $176,000 across the book. They are identified by title and skipped.
 *
 * AND "UNMAPPED MEANS NEW" IS WRONG
 *
 * An earlier draft of the plan said to push any approved change order with no
 * import-map row. Measured, Salesforce ALREADY HOLDS seven of those — including
 * McDonald's $1,150, which is Approved over there right now. So the test is
 * what Salesforce actually has on the work order, matched on amount, not what
 * our map remembers.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

/**
 * The reason code. Katie has not picked one yet — the four candidates are in
 * §2d of the plan — so this is the neutral one, and it is verified to be
 * accepted (sandbox, 2026-10-14). Salesforce's own default is "Client changed
 * mind", a claim about her GCs nothing here supports, which is why the field
 * is always sent rather than left to default.
 */
const REASON = "Scope change";

/**
 * Verified by experiment rather than assumed: written on a real sandbox change
 * order, "Approved" held, no flow rewrote it, and the rollup moved by exactly
 * the amount. "Approved-Auto" is the org-wide majority but is evidently set by
 * a flow on another path.
 */
const STATUS = "Approved";

/** Rows the importer invented to carry a total. Never real change orders. */
const ROLLUP_TITLE = /^approved change orders$/i;
const APPROVED_IN_SF = ["Approved", "Approved-Auto", "Legacy Import (Approved)"];

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
const { writeSf } = await import("@/lib/salesforce/writeback");
const conn = await getSalesforceClient();

const money = (c) => `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const cents = (d) => Math.round(Number(d ?? 0) * 100);

async function pageAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols);
    for (const c of order) q = q.order(c);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const map = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("commercial_import_map")
    .select("sf_id, row_id, entity")
    .eq("entity", "deal")
    .order("sf_id")
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  map.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const dealSf = new Map(map.map((r) => [r.row_id, r.sf_id]));

const cos = (
  await pageAll("commercial_change_orders", "id, opportunity_id, co_number, title, description, amount_cents, status, deleted_at", ["id"])
).filter((c) => !c.deleted_at && c.status === "approved");
const deals = await pageAll("commercial_opportunities", "id, title", ["id"]);
const nameOf = new Map(deals.map((d) => [d.id, d.title]));

console.log(`\n══ TOMCO WRITE-BACK · STAGE 4 (change orders) · ${APPLY ? "APPLYING" : "PLAN"} ══`);
console.log(`   ${conn.instanceUrl}`);
console.log(`   ${cos.length} approved change order(s) here · reason "${REASON}" · status "${STATUS}"\n`);

let created = 0, updated = 0, skipped = 0, failed = 0, blocked = 0;
for (const c of cos) {
  const job = String(nameOf.get(c.opportunity_id) ?? "?").slice(0, 30);
  const label = `${job.padEnd(30)} CO-${c.co_number} ${money(c.amount_cents).padStart(12)}`;

  if (ROLLUP_TITLE.test(String(c.title ?? ""))) { skipped++; continue; }

  const sfOpp = dealSf.get(c.opportunity_id);
  if (!sfOpp) { console.log(`   ⏭  ${label}  deal not in Salesforce`); skipped++; continue; }

  const wos = await conn.query(
    `SELECT Id, WorkOrderNumber FROM WorkOrder WHERE Opportunity__c = '${sfOpp}' AND Status != 'Canceled'`,
  );
  if (wos.records.length === 0) {
    /*
     * `ChangeOrder__c.WorkOrder__c` is required AND create-only, and this user
     * cannot create a Tomco WorkOrder — the record type reads available=false.
     * So a job with no live work order in Salesforce has nowhere to put it.
     */
    console.log(`   🔴 ${label}  no live work order in Salesforce — nothing to attach it to`);
    blocked++;
    continue;
  }
  const woIds = wos.records.map((w) => w.Id);
  const existing = await conn.query(
    `SELECT Id, Name, CostChange__c, Status__c FROM ChangeOrder__c WHERE WorkOrder__c IN ('${woIds.join("','")}')`,
  );
  const sameAmount = existing.records.filter((x) => cents(x.CostChange__c) === Number(c.amount_cents));

  if (sameAmount.length > 1) {
    // No key can tell "entered twice" from "two genuine COs for the same
    // amount", and that case is live in this data.
    console.log(`   ⏸  ${label}  ${sameAmount.length} Salesforce change orders at this amount — a person decides`);
    skipped++;
    continue;
  }

  if (sameAmount.length === 1) {
    const sf = sameAmount[0];
    if (APPROVED_IN_SF.includes(sf.Status__c)) { skipped++; continue; }
    console.log(`   ${APPLY ? "✅" : "·"} ${label}  ${sf.Name} ${sf.Status__c} → ${STATUS}`);
    if (APPLY) {
      /*
       * `ChangeOrder_AllowOnlyAuthorizedUsers` v3 is UPDATE-only and gates
       * exactly this. If the integration user is not authorised, this is where
       * it says so — which is worth finding out on two records rather than on a
       * nightly run.
       */
      const res = await writeSf(
        { sObject: "ChangeOrder__c", recordId: sf.Id, fields: { Status__c: STATUS } },
        { source: "tomco_writeback", deferCacheInvalidation: true, priorValues: { Status__c: sf.Status__c } },
      );
      if (!res.ok) { console.log(`        🔴 ${res.error}`); failed++; continue; }
      updated++;
    }
    continue;
  }

  // Not in Salesforce at all.
  console.log(`   ${APPLY ? "✅" : "·"} ${label}  "${String(c.title ?? "").slice(0, 26)}" → create on ${wos.records[0].WorkOrderNumber}`);
  if (APPLY) {
    const res = await conn.sobject("ChangeOrder__c").create({
      WorkOrder__c: wos.records[0].Id,
      CostChange__c: Number(c.amount_cents) / 100,
      Status__c: STATUS,
      ReasonForChange__c: REASON,
      Notes__c: [c.title, c.description].filter(Boolean).join(" — ").slice(0, 2000) || null,
    });
    if (!res.success) { console.log(`        🔴 ${JSON.stringify(res.errors ?? res)}`); failed++; continue; }
    console.log(`        ${res.id}`);
    created++;
  }
}

console.log(`\n── ${created} created · ${updated} updated · ${skipped} left alone · ${blocked} blocked · ${failed} failed ──`);
if (skipped) console.log(`   (the 18 "Approved change orders" rollup rows are among those left alone, deliberately)`);
if (!APPLY) console.log(`\n(plan only — nothing written. Re-run with --apply)\n`);
else {
  // The rollups are asynchronous; the reconciliation is the real check.
  console.log(`\nDone. The work-order rollups take a moment; confirm with the reconciliation.\n`);
}
