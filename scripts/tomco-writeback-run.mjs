/**
 * Run the Tomco write-back.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/tomco-writeback-run.mjs                 plan only, writes nothing
 *   …same… --apply                                       does it
 *   …same… --apply --deal="MotorMindz"                   one deal, by title
 *
 * Stage 2 of docs/TOMCO_SF_WRITEBACK_PLAN.md: UPDATES ONLY. It will not create
 * an Opportunity, an Account or a Quote on a deal Salesforce has never seen —
 * `--inserts` is deliberately absent until Stage 3, because an insert is the
 * only action here that can put a second copy of a real sale into Katie's
 * total, and the two deals waiting on it can wait for a deliberate step.
 *
 * It writes to PRODUCTION Salesforce. Every write goes through `writeSf`, so
 * each one is retried on transport failures, logged to `sf_writes_audit` with
 * its prior value, and routed to the commercial Slack channel if Salesforce
 * rejects it.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--deal=")) ?? "").slice(7).replace(/^["']|["']$/g, "");

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
const { updateExisting } = await import("@/lib/salesforce/tomco-writeback");
const { derivedOppName } = await import("@/lib/commercial/opportunities/db");

const money = (c) => `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** Sold deals that ARE linked to Salesforce — the only ones this stage touches. */
const SOLD = ["pre_sale_closed", "pre_construction", "in_progress", "billing", "post_sale_closed"];

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

const deals = (
  await pageAll(
    "commercial_opportunities",
    "id, title, title_override, title_override_mode, client_name, property_street, status, sub_status, accepted_contract_cents, decided_at, account_id, deleted_at",
    ["id"],
  )
).filter(
  (d) => !d.deleted_at && SOLD.includes(d.status) && !(d.status === "pre_sale_closed" && d.sub_status !== "won"),
);

const map = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("commercial_import_map")
    .select("sf_id, row_id")
    .eq("entity", "deal")
    .order("sf_id")
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  map.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const sfIdOf = new Map(map.map((r) => [r.row_id, r.sf_id]));

const accts = await pageAll("commercial_accounts", "id, company_name", ["id"]);
const acctName = new Map(accts.map((a) => [a.id, a.company_name]));

const conn = await getSalesforceClient();
const ctx = { conn, actorUserId: null, apply: APPLY };

console.log(`\n══ TOMCO WRITE-BACK · STAGE 2 (updates only) · ${APPLY ? "APPLYING" : "PLAN"} ══`);
console.log(`   ${conn.instanceUrl}`);
if (ONLY) console.log(`   limited to deals matching "${ONLY}"`);

/*
 * WHAT THIS STAGE DELIBERATELY SKIPS.
 *
 * A linked deal already Closed Won at the right value needs nothing — 93 of the
 * 94 are in that state, and writing to them is not harmless: an update that
 * changes no field still enters every flow on the object, including the
 * unfiltered quota-points one. So they are counted, not touched.
 */
const todo = [];
let alreadyRight = 0;
for (const d of deals) {
  const sfId = sfIdOf.get(d.id);
  if (!sfId) continue; // unlinked — Stage 3's problem, or still in the queue
  const title = derivedOppName(d, d.account_id ? acctName.get(d.account_id) ?? null : null);
  if (ONLY && !title.toLowerCase().includes(ONLY.toLowerCase())) continue;
  todo.push({ deal: { id: d.id, title, accountName: d.account_id ? acctName.get(d.account_id) ?? null : null, contractCents: d.accepted_contract_cents, decidedAt: d.decided_at }, sfId });
}
console.log(`   ${todo.length} linked sold deal(s) in scope\n`);

const results = [];
for (const { deal, sfId } of todo) {
  // Read first so a no-op is recognised WITHOUT writing: an update that changes
  // nothing still runs every flow on the object.
  const r = await conn.query(
    `SELECT Id, StageName, Quote_Subtotal__c FROM Opportunity WHERE Id = '${sfId}'`,
  );
  const o = r.records?.[0];
  const contract = Math.round(Number(deal.contractCents ?? 0)) / 100;
  if (o && o.StageName === "Closed Won" && Math.abs(Number(o.Quote_Subtotal__c ?? 0) - contract) < 0.005) {
    alreadyRight++;
    continue;
  }
  const out = await updateExisting(ctx, deal, sfId);
  results.push(out);
  // A skipped deal must not wear the same tick as a written one — the run that
  // left 94 alone and wrote 2 printed 96 ticks, which reads as 96 writes.
  const icon =
    out.action === "failed" ? "🔴" : out.action === "skipped" ? "·" : APPLY ? "✅" : "·";
  console.log(`   ${icon} ${deal.title.slice(0, 46).padEnd(46)} ${money(deal.contractCents).padStart(13)}  ${sfId}`);
  for (const s of out.steps) console.log(`        ${s}`);
  if (out.error) console.log(`        error: ${out.error}`);
  for (const c of out.checks) console.log(`        ${c.ok ? "✅" : "🔴"} ${c.name}: ${c.detail}`);
}

/*
 * Count skips separately. The first version lumped them in with writes and
 * reported "21 would be written" when theanswer was three — the rest being
 * deals Salesforce has already won, which this stage deliberately leaves alone.
 * A summary that overstates what it is about to do is worse than no summary.
 */
const wrote = results.filter((r) => r.action === "updated" || r.action === "created").length;
const skipped = results.filter((r) => r.action === "skipped").length;
const failed = results.filter((r) => r.action === "failed").length;
console.log(
  `\n── ${alreadyRight + skipped} left alone (already won in Salesforce) · ` +
    `${wrote} ${APPLY ? "written" : "to write"} · ${failed} failed ──`,
);
const badChecks = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.dealTitle}: ${c.name} — ${c.detail}`));
if (badChecks.length) {
  console.log(`\n🔴 ${badChecks.length} read-back check(s) did not pass:`);
  for (const b of badChecks) console.log(`     ${b}`);
}
if (!APPLY) console.log(`\n(plan only — nothing written. Re-run with --apply)\n`);
else console.log(`\nDone. Confirm with the reconciliation.\n`);
