/**
 * Does every column the CODE selects actually exist in the database?
 *
 * check-schema-drift.mjs runs the other direction — migrations → DB, "did
 * someone delete a column the migrations declare". It cannot see the failure
 * that actually shipped on 2026-09-21:
 *
 *     .from("commercial_operating_company").select("email, reply_to_email")
 *
 * `reply_to_email` is not a column and no migration ever declared it. PostgREST
 * does not return the columns it recognises and skip the rest — it REJECTS THE
 * WHOLE SELECT. So `data` came back null, the caller read `company?.email`,
 * got undefined, and concluded the company had no sending address. Every
 * archived email was then labelled "Received", the Sent tab was permanently
 * empty, and the UI told the reader to fix it in a Settings field that does not
 * exist.
 *
 * Nothing failed loudly. No error surfaced, no test went red, the page rendered.
 * One typo produced a confident wrong answer for as long as anyone cared to
 * look.
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 * Finds every `.from("table")…select("a, b, c")` pair with LITERAL strings —
 * plus the `.eq`/`.order`/`.in`/… columns in the same chain, which fail the
 * request in exactly the same way —
 * then asks the live database to select those columns with `limit(0)` — no
 * rows read, no data moved, and it still fails on an unknown column. One query
 * per table; on failure it re-probes column by column to name the culprit.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 *
 * Selects built from a variable (`EMPLOYEE_COLS`, a template literal) are
 * SKIPPED and counted. A check that silently ignored them would report "all
 * clear" while covering a fraction of the code — the exact shape of fake pass
 * this repo has been bitten by before. The skipped count is printed every run.
 *
 * Usage:  node --env-file=.env.local scripts/check-selected-columns.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local (needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY)");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// ── 1. Walk the source ─────────────────────────────────────────────────────
// `scripts` is in here because the check missed the one place it mattered
// most. A sync script wrote `.select("id, name, …")` against
// commercial_accounts, whose column is `company_name` — PostgREST rejects the
// WHOLE select on one unknown column and returns null, which reads as "this GC
// has no record". In the app that shows up as an empty panel somebody
// complains about; in a script that writes to Salesforce it would have created
// a duplicate account in PPP's production org on every run, silently. The
// unattended writers need this check more than the screens do, not less.
const ROOTS = ["lib", "app", "components", "scripts"];
const files = [];
for (const root of ROOTS) {
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      // .mjs too — every script in scripts/ is one, so adding the directory
      // without adding the extension extended the scan by exactly nothing. It
      // reported a pass over the file I had just broken on purpose.
      else if (/\.(ts|tsx|mjs)$/.test(full)) files.push(full);
    }
  })(root);
}
if (files.length === 0) {
  // A zero-file scan reports a clean bill of health for nothing at all.
  console.error("no source files found — the walk is broken, refusing to report a pass");
  process.exit(1);
}

const usages = new Map(); // table -> Map(column -> "file:line")
const TABLE_NAMES = new Set();
let skipped = 0;
const skippedWhere = [];

for (const file of files) {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  // `.from("t")` then the NEXT `.select(...)` within a short window — the
  // chained-call shape used everywhere in this codebase.
  // The gap must not cross into ANOTHER chain. Without this guard, a
  // `.from("a").delete()` with no select reached forward and stole the next
  // statement's `.select(...)`, attributing invoice columns to
  // commercial_invoice_payments — 18 confident false positives on the first
  // run. Bar `.from(` and `;` inside the gap so a match stays in one chain.
  for (const m of src.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)((?:(?!\.from\(|;)[\s\S]){0,200}?)\.select\(/g)) {
    const table = m[1];
    TABLE_NAMES.add(table);
    if (!table.startsWith("commercial_") && !["profiles", "notifications"].includes(table)) continue;
    const after = src.slice(m.index + m[0].length);
    const lit = /^\s*"((?:[^"\\]|\\.)*)"/.exec(after) ?? /^\s*`([^`$]*)`/.exec(after);
    if (!lit) {
      skipped++;
      if (skippedWhere.length < 12) skippedWhere.push(`${file} → ${table}`);
      continue;
    }
    const cols = parseSelect(lit[1]);
    const line = src.slice(0, m.index).split("\n").length;
    if (!usages.has(table)) usages.set(table, new Map());
    for (const c of cols) if (!usages.get(table).has(c)) usages.get(table).set(c, `${file}:${line}`);

    // FILTER AND ORDER COLUMNS TOO.
    //
    // `.order("created_at")` on a table whose column is `at` fails exactly the
    // same way a bad select does — PostgREST rejects the request and the
    // caller gets null. Checking only `.select()` would have missed half of
    // the repairs bug: it named created_at in BOTH the select and the order,
    // and only the select was covered.
    //
    // Scanned from the end of the select to the end of the statement, so the
    // filters belong to this chain and not the next one.
    // Cut at the next `.from(` as well as the next `;`. Inside a Promise.all
    // there is NO semicolon between chains, so scanning to the next statement
    // let one query's filters be attributed to the previous query's table —
    // it reported commercial_opportunities.opportunity_id, which is really
    // the aia_applications filter sitting on the next line.
    const chainTail = after.slice(0, 600).split(";")[0].split(".from(")[0];
    for (const f of chainTail.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|order)\(\s*"([a-z0-9_]+)"/g)) {
      const col = f[1];
      if (!usages.get(table).has(col)) usages.get(table).set(col, `${file}:${line}`);
    }
  }
}

/** Top-level column names from a PostgREST select string.
 *  Drops embedded resources (`account:t!inner(col)`) — those name a TABLE,
 *  not a column of this one, and are verified by their own usage elsewhere. */
function parseSelect(raw) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    if (depth === 0) cur += ch;
  }
  out.push(cur);
  return out
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== "*")
    // `alias:column` → column ; an embedded resource left a bare alias → drop
    .map((s) => (s.includes(":") ? s.split(":").pop().trim() : s))
    .filter((s) => /^[a-z0-9_]+$/.test(s))
    .filter((s) => !s.startsWith("count"));
}

// ── 2. Ask the database ────────────────────────────────────────────────────
const problems = [];
let checkedPairs = 0;

for (const [table, colMap] of [...usages].sort()) {
  // An embedded resource written `alias:other_table(col)` leaves the TABLE
  // name behind after the parens are stripped. It is not a column of this
  // table and probing it produces a confident false positive — two of them on
  // the first clean run.
  const cols = [...colMap.keys()].filter((c) => !TABLE_NAMES.has(c)).sort();
  if (cols.length === 0) continue;
  checkedPairs += cols.length;
  const { error } = await sb.from(table).select(cols.join(",")).limit(0);
  if (!error) continue;
  if (/does not exist|schema cache|Could not find/i.test(error.message)) {
    // Narrow it down so the report names the column, not the table.
    for (const c of cols) {
      const { error: one } = await sb.from(table).select(c).limit(0);
      if (one) problems.push({ table, column: c, message: one.message, where: colMap.get(c) });
    }
  } else {
    problems.push({ table, column: "(whole select)", message: error.message });
  }
}

// ── 3. Report ──────────────────────────────────────────────────────────────
console.log(`Checked ${checkedPairs} column reference(s) across ${usages.size} table(s).`);
if (skipped > 0) {
  console.log(`\n⚠ ${skipped} select(s) are built from a variable and were NOT checked:`);
  for (const s of skippedWhere) console.log(`    ${s}`);
  if (skipped > skippedWhere.length) console.log(`    …and ${skipped - skippedWhere.length} more`);
  console.log(`  (stated rather than hidden — a check that quietly skips is a fake pass)`);
}
if (problems.length === 0) {
  console.log("\n✅ every literal column the code selects exists in the database");
  process.exit(0);
}
console.log(`\n❌ ${problems.length} column(s) the code selects do NOT exist:\n`);
for (const p of problems) {
  console.log(`   ${p.table}.${p.column}`);
  console.log(`      used at ${p.where ?? "(unknown)"}`);
  console.log(`      ${p.message.split("\n")[0]}`);
}
console.log(`\nPostgREST rejects the WHOLE select on an unknown column, so each of`);
console.log(`these makes its query return null — the caller then reads a missing`);
console.log(`value as "not set" and answers confidently wrong.`);
process.exit(1);
