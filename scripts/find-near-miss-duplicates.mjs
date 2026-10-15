/**
 * The same near-miss duplicate shape, swept across EVERY money table — not just
 * the labor payouts Mary noticed.
 *
 * The earlier de-dupe scripts (fix-duplicate-costs, fix-duplicate-payments)
 * matched on the EXACT day. The 35 labor pairs sat one day apart, so that class
 * of pair was invisible to them. Anything else one day apart is invisible too.
 */
import { readFileSync } from "node:fs";
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

const map = []; for (let f = 0; ; f += 1000) { const { data, error } = await sb.from("commercial_import_map").select("sf_id,entity,row_id").order("sf_id").order("entity").range(f, f + 999); if (error) throw new Error(error.message); map.push(...(data ?? [])); if (!data || data.length < 1000) break; }
const mappedBy = (ent) => new Set(map.filter((r) => r.entity === ent).map((r) => r.row_id));
const deals = await page("commercial_opportunities", "id,title", ["id"]);
const nameOf = new Map(deals.map((d) => [d.id, d.title]));

function sweep(label, rows, keyOf, dateOf, amtOf, mapped, describe) {
  const live = rows.filter((r) => !r.deleted_at);
  const g = new Map();
  for (const r of live) { const k = keyOf(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const cross = [], same = [];
  for (const [, rs] of g) {
    if (rs.length < 2) continue;
    const used = new Set();
    for (let i = 0; i < rs.length; i++) { if (used.has(i)) continue;
      for (let j = i + 1; j < rs.length; j++) { if (used.has(j)) continue;
        const d = days(dateOf(rs[i]), dateOf(rs[j]));
        if (d > 3) continue;
        used.add(i); used.add(j);
        const isCross = mapped.has(rs[i].id) !== mapped.has(rs[j].id);
        (isCross ? cross : same).push([rs[i], rs[j], d]);
        break; } }
  }
  const sum = (arr) => arr.reduce((n, [a]) => n + Number(amtOf(a) ?? 0), 0);
  const exactDay = [...cross, ...same].filter(([, , d]) => d === 0).length;
  console.log(`\n${label}  (${live.length} live rows)`);
  console.log(`   🔴 cross-provenance pairs (SF + CC):  ${String(cross.length).padStart(3)}   ${m(sum(cross))}`);
  console.log(`   ⚠️  same-provenance pairs:             ${String(same.length).padStart(3)}   ${m(sum(same))}`);
  console.log(`      (of all pairs, ${exactDay} are same-day — the rest the old exact-day scripts could not see)`);
  for (const [a, b, d] of [...cross, ...same].sort((x, y) => Number(amtOf(y[0])) - Number(amtOf(x[0]))).slice(0, 12))
    console.log(`      ${mapped.has(a.id) !== mapped.has(b.id) ? "🔴" : "⚠️ "} ${describe(a).padEnd(58)} ${m(amtOf(a)).padStart(12)}  ${d} day(s) apart`);
}

const purch = await page("commercial_project_purchases", "id,opportunity_id,vendor,category,amount_cents,purchased_at,deleted_at", ["id"]);
const pm = mappedBy("purchase");
const NONLABOR = purch.filter((r) => !["labor", "employee_labor"].includes(r.category));
sweep("── NON-LABOR COSTS (materials, equipment, subs…)", NONLABOR,
  (r) => `${r.opportunity_id}|${r.vendor}|${r.amount_cents}|${r.category}`, (r) => r.purchased_at, (r) => r.amount_cents, pm,
  (r) => `${String(nameOf.get(r.opportunity_id) ?? "?").slice(0, 26).padEnd(26)} ${String(r.vendor ?? "-").slice(0, 18).padEnd(18)} ${r.category}`);

let pays = []; try { pays = await page("commercial_invoice_payments", "id,invoice_id,amount_cents,paid_at,reference,recorded_by_user_id,voided_at", ["id"]); } catch { pays = (await page("commercial_invoice_payments", "id,invoice_id,amount_cents,paid_at,reference,recorded_by_user_id", ["id"])); }
const invs = await page("commercial_invoices", "id,opportunity_id,deleted_at", ["id"]);
const oppOfInv = new Map(invs.map((i) => [i.id, i.opportunity_id]));
/*
 * A PAYMENT ON A DELETED INVOICE IS NOT DOUBLE-COUNTED CASH.
 *
 * It reaches no money surface — the receivables report refuses a soft-deleted
 * parent, and `check:money` asserts that on 26 of them. But this sweep was
 * grouping on the DEAL, so a person's payment on an invoice they later deleted
 * paired with the importer's copy on the live one and came out as "🔴 2
 * cross-provenance pairs · $16,462.85". Both pairs were exactly that: J.
 * Carleton's $11,617.85 on deleted INV-0027 and Panera's $4,845.00 on a deleted
 * invoice, measured 2026-10-15.
 *
 * A report that says $16,000 of cash may be counted twice, when none of it is,
 * is worse than no report — the next real one is read as noise too.
 */
const deadInvoice = new Set(invs.filter((i) => i.deleted_at).map((i) => i.id));
const livePays = pays.filter((p) => !deadInvoice.has(p.invoice_id));
sweep("── INVOICE PAYMENTS (cash in)", livePays,
  (r) => `${oppOfInv.get(r.invoice_id)}|${r.amount_cents}`, (r) => r.paid_at, (r) => r.amount_cents, mappedBy("payment"),
  (r) => `${String(nameOf.get(oppOfInv.get(r.invoice_id)) ?? "?").slice(0, 26).padEnd(26)} ref=${String(r.reference ?? "-").slice(0, 12).padEnd(12)} ${r.recorded_by_user_id ? "person" : "import"}`);

const cos = await page("commercial_change_orders", "id,opportunity_id,amount_cents,status,created_at,deleted_at,title", ["id"]);
sweep("── CHANGE ORDERS", cos,
  (r) => `${r.opportunity_id}|${r.amount_cents}`, (r) => r.created_at, (r) => r.amount_cents, mappedBy("change_order"),
  (r) => `${String(nameOf.get(r.opportunity_id) ?? "?").slice(0, 26).padEnd(26)} ${String(r.title ?? "-").slice(0, 18).padEnd(18)} ${r.status}`);
