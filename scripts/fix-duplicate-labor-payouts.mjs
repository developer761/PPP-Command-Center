/**
 * Mary's duplicate payouts — the correct side of each pair, and nothing else.
 *
 *   node <this file>            dry run, prints the plan, writes nothing
 *   node <this file> --apply    executes it
 *
 * THE DUPLICATE: a person entered a labor payout in the Command Center, and the
 * same payout was already in Salesforce, and the importer brought the Salesforce
 * copy in too. The pair is one day apart (CC 09-22/09-24/10-07, Salesforce
 * 09-23/10-06), same deal, same worker, same amount to the cent.
 *
 * WHY THE DATE WINDOW AND NOT THE AMOUNT ALONE: keying on (deal, worker, amount)
 * and ignoring the date reports 107 groups / $83,531.51 — because a sub on a
 * fixed weekly rate earns the SAME amount every week, so four $1,987.22 rows for
 * Greg on four different weeks look identical and are four real paychecks. The
 * same mistake the payment matcher made. Pairs must be CLOSE IN TIME.
 *
 * WHICH SIDE GOES: the Command-Center row, never the Salesforce-imported one.
 * The imported row carries the import-map row that ties the two systems
 * together — Mary deleted six of those by hand this morning and it took COST
 * reconciliation from 1:1 to four jobs short by $3,638.80. Deleting the unmapped
 * copy removes the double-count and leaves the tie intact.
 */
import { readFileSync } from "node:fs";
const APPLY = process.argv.includes("--apply");
const env = Object.fromEntries(
  readFileSync("/Users/karanmalhotra/Desktop/PPP/ppp-command-center/.env.local", "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const m = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400e3);
async function page(t, c, ord) { const o = []; for (let f = 0; ; f += 1000) { let q = sb.from(t).select(c); for (const k of ord) q = q.order(k); const { data, error } = await q.range(f, f + 999); if (error) throw new Error(`${t}: ${error.message}`); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; }

const p = await page("commercial_project_purchases", "id,opportunity_id,vendor,category,amount_cents,purchased_at,deleted_at,payroll_period_id", ["id"]);
const deals = await page("commercial_opportunities", "id,title", ["id"]);
const nameOf = new Map(deals.map((d) => [d.id, d.title]));
const map = []; for (let f = 0; ; f += 1000) { const { data, error } = await sb.from("commercial_import_map").select("sf_id,entity,row_id").order("sf_id").order("entity").range(f, f + 999); if (error) throw new Error(error.message); map.push(...(data ?? [])); if (!data || data.length < 1000) break; }
const sfImported = new Set(map.filter((r) => r.entity === "purchase").map((r) => r.row_id));

// ── STEP 1: the six SF-imported rows Mary deleted that must come back.
const restore = p.filter((r) => r.deleted_at && sfImported.has(r.id)
  && r.deleted_at >= new Date(Date.now() - 7 * 86400e3).toISOString());

// ── STEP 2: the Command-Center copy of each live cross-provenance pair.
const LABORISH = new Set(["labor", "employee_labor"]);
// A restored row is live again for pairing purposes.
const restoreIds = new Set(restore.map((r) => r.id));
const live = p.filter((r) => (!r.deleted_at || restoreIds.has(r.id)) && LABORISH.has(r.category));
const groups = new Map();
for (const r of live) { const k = `${r.opportunity_id}|${r.vendor}|${r.amount_cents}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

const del = []; const ambiguous = [];
for (const [, rows] of groups) {
  if (rows.length < 2) continue;
  const used = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(j)) continue;
      if (days(rows[i].purchased_at, rows[j].purchased_at) > 3) continue;
      used.add(i); used.add(j);
      const a = rows[i], b = rows[j];
      if (sfImported.has(a.id) === sfImported.has(b.id)) { ambiguous.push([a, b]); break; }
      del.push(sfImported.has(a.id) ? b : a);
      break;
    }
  }
}

console.log(`\n══ DUPLICATE LABOR PAYOUTS — ${APPLY ? "APPLYING" : "DRY RUN"} ══\n`);
console.log(`STEP 1 — RESTORE ${restore.length} Salesforce-imported rows deleted this week  ${m(restore.reduce((n,r)=>n+Number(r.amount_cents??0),0))}`);
for (const r of restore) console.log(`   ↩  ${String(nameOf.get(r.opportunity_id)??"?").slice(0,30).padEnd(30)} ${String(r.vendor).slice(0,20).padEnd(20)} ${m(r.amount_cents).padStart(11)}  ${String(r.purchased_at).slice(0,10)}`);
console.log(`\nSTEP 2 — DELETE ${del.length} Command-Center duplicates  ${m(del.reduce((n,r)=>n+Number(r.amount_cents??0),0))}`);
for (const r of del.sort((a,b)=>Number(b.amount_cents)-Number(a.amount_cents))) console.log(`   ✖  ${String(nameOf.get(r.opportunity_id)??"?").slice(0,30).padEnd(30)} ${String(r.vendor).slice(0,20).padEnd(20)} ${m(r.amount_cents).padStart(11)}  ${String(r.purchased_at).slice(0,10)}  ${r.category}`);
if (ambiguous.length) {
  console.log(`\n🔴 ${ambiguous.length} SAME-PROVENANCE pair(s) — NOT TOUCHED, a human decides:`);
  for (const [a,b] of ambiguous) console.log(`   ?  ${String(nameOf.get(a.opportunity_id)??"?").slice(0,30).padEnd(30)} ${String(a.vendor).slice(0,20).padEnd(20)} ${m(a.amount_cents).padStart(11)}  ${String(a.purchased_at).slice(0,10)} + ${String(b.purchased_at).slice(0,10)}  both ${sfImported.has(a.id)?"SF-imported":"CC-entered"}`);
}
console.log(`\nNET EFFECT on job costs: ${m(restore.reduce((n,r)=>n+Number(r.amount_cents??0),0) - del.reduce((n,r)=>n+Number(r.amount_cents??0),0))}`);
console.log(`NET EFFECT on COST reconciliation: +${m(restore.reduce((n,r)=>n+Number(r.amount_cents??0),0))} — the restored rows`);
console.log(`  carry the import-map row the recon counts, so this is the amount the COST`);
console.log(`  dimension is currently short. Deleting the unmapped copies moves it by $0.`);

if (!APPLY) { console.log(`\n(dry run — nothing written. re-run with --apply)\n`); process.exit(0); }

const now = new Date().toISOString();
for (const r of restore) {
  const { error } = await sb.from("commercial_project_purchases").update({ deleted_at: null }).eq("id", r.id);
  if (error) throw new Error(`restore ${r.id}: ${error.message}`);
}
for (const r of del) {
  const { error } = await sb.from("commercial_project_purchases").update({ deleted_at: now }).eq("id", r.id).is("deleted_at", null);
  if (error) throw new Error(`delete ${r.id}: ${error.message}`);
}
console.log(`\n✅ restored ${restore.length}, deleted ${del.length}. Re-run the reconciliation.\n`);
