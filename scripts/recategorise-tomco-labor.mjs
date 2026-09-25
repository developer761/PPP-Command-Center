#!/usr/bin/env node
/**
 * Move Tomco's own crew payouts from "Subcontract labor" to "Employee labor".
 *
 * Mary, 2026-09-24: *"Can you move Tomco labor entries from Sub to Employee
 * Labor? Or I can manually?"* — 782 rows by hand is not a reasonable answer.
 *
 * WHAT IT MOVES, AND WHAT IT DELIBERATELY DOES NOT. Only rows whose payee
 * begins "Tomco" — Tomco's own people, paid through their own labor entity.
 * Everything else on `labor` is genuine outside help and STAYS: Omar LI, the
 * "LC …" labor companies, Salinas. Those are the rows where the 1099-versus-W2
 * distinction actually bites, so sweeping them in would do the exact damage
 * Mary is asking to undo.
 *
 * SAFE BY DEFAULT. Prints the plan and changes nothing unless `--commit` is
 * passed. Every row is written with its before/after to `commercial_audit_log`,
 * so this is reversible — and the reversal is printed at the end.
 *
 *   node --env-file=.env.local scripts/recategorise-tomco-labor.mjs
 *   node --env-file=.env.local scripts/recategorise-tomco-labor.mjs --commit
 *
 * The money must not move. Only the heading it sits under changes, so the
 * total across both categories is asserted identical before and after; if it
 * is not, something matched that should not have and the script says so.
 */
import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const money = (c) =>
  `$${(Number(c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const FROM = "labor";
const TO = "employee_labor";
/** Tomco's own crew. Anchored at the start so "LC …" payees cannot match. */
const isOurs = (vendor) => /^tomco\b/i.test(String(vendor ?? "").trim());

/** PostgREST silently caps a select at 1000 rows. Read every page or the
 *  script quietly edits two thirds of the data and reports success. */
async function readAll() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_project_purchases")
      .select("id, category, vendor, amount_cents, purchased_at, opportunity_id, description")
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`read failed: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const before = await readAll();
const sumOf = (rows) => rows.reduce((n, r) => n + Number(r.amount_cents || 0), 0);

const targets = before.filter((r) => r.category === FROM && isOurs(r.vendor));
const staying = before.filter((r) => r.category === FROM && !isOurs(r.vendor));
const alreadyThere = before.filter((r) => r.category === TO);

console.log(`Read ${before.length} live purchase rows.\n`);
console.log(`MOVE  ${String(targets.length).padStart(4)} rows  ${money(sumOf(targets))}   Subcontract labor → Employee labor`);
console.log(`KEEP  ${String(staying.length).padStart(4)} rows  ${money(sumOf(staying))}   stays Subcontract labor (outside help)`);
console.log(`ALREADY ${String(alreadyThere.length).padStart(2)} rows  ${money(sumOf(alreadyThere))}   already Employee labor\n`);

console.log("Payees that MOVE:");
const byV = new Map();
for (const r of targets) {
  const v = byV.get(r.vendor) ?? { n: 0, c: 0 };
  v.n += 1;
  v.c += Number(r.amount_cents || 0);
  byV.set(r.vendor, v);
}
for (const [k, v] of [...byV].sort((a, b) => b[1].c - a[1].c))
  console.log(`   ${String(v.n).padStart(4)}  ${money(v.c).padStart(14)}  ${k}`);

console.log("\nPayees that STAY on Subcontract labor:");
const byS = new Map();
for (const r of staying) {
  const v = byS.get(r.vendor || "(blank)") ?? { n: 0, c: 0 };
  v.n += 1;
  v.c += Number(r.amount_cents || 0);
  byS.set(r.vendor || "(blank)", v);
}
for (const [k, v] of [...byS].sort((a, b) => b[1].c - a[1].c))
  console.log(`   ${String(v.n).padStart(4)}  ${money(v.c).padStart(14)}  ${k}`);

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing was changed. Re-run with --commit to apply.`);
  process.exit(0);
}

// ── Apply, one row at a time, each with an audit entry ────────────────────
const stamp = new Date().toISOString();
let done = 0;
const failures = [];
for (const r of targets) {
  const { error } = await sb
    .from("commercial_project_purchases")
    .update({ category: TO, updated_at: stamp })
    .eq("id", r.id)
    .eq("category", FROM); // nobody else has moved it since we read
  // supabase-js RESOLVES on failure rather than throwing, so this has to be
  // read. A try/catch here would catch nothing and report a clean run.
  if (error) {
    failures.push(`${r.id}: ${error.message}`);
    continue;
  }
  const { error: auditErr } = await sb.from("commercial_audit_log").insert({
    table_name: "commercial_project_purchases",
    row_id: r.id,
    action: "update",
    before_json: { category: FROM, vendor: r.vendor, amount_cents: r.amount_cents },
    after_json: { category: TO, vendor: r.vendor, amount_cents: r.amount_cents },
  });
  if (auditErr) failures.push(`${r.id}: audit — ${auditErr.message}`);
  done += 1;
}

// ── Prove it, by re-reading ───────────────────────────────────────────────
const after = await readAll();
const beforeBoth = sumOf(before.filter((r) => r.category === FROM || r.category === TO));
const afterBoth = sumOf(after.filter((r) => r.category === FROM || r.category === TO));
const afterMoved = after.filter((r) => r.category === TO);
const afterStaying = after.filter((r) => r.category === FROM);

console.log(`\nMoved ${done} of ${targets.length} rows.`);
console.log(`  Employee labor now:     ${String(afterMoved.length).padStart(4)} rows  ${money(sumOf(afterMoved))}`);
console.log(`  Subcontract labor now:  ${String(afterStaying.length).padStart(4)} rows  ${money(sumOf(afterStaying))}`);
console.log(
  `  Money across both:      ${money(beforeBoth)} → ${money(afterBoth)}  ${
    beforeBoth === afterBoth ? "✅ unchanged" : "❌ MOVED — investigate before trusting any report"
  }`,
);
const leftBehind = after.filter((r) => r.category === FROM && isOurs(r.vendor));
console.log(
  `  Tomco rows left on Subcontract labor: ${leftBehind.length} ${leftBehind.length === 0 ? "✅" : "❌"}`,
);
if (failures.length) {
  console.log(`\n❌ ${failures.length} problem(s):`);
  for (const f of failures.slice(0, 10)) console.log(`   ${f}`);
}
console.log(
  `\nTo undo: set category back to '${FROM}' for the ${done} ids logged in ` +
    `commercial_audit_log with action='update' at ${stamp}.`,
);
process.exit(failures.length || beforeBoth !== afterBoth || leftBehind.length ? 1 : 0);
