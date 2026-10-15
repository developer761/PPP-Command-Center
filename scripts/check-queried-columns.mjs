#!/usr/bin/env node
/**
 * DOES THE CODE QUERY COLUMNS THAT EXIST?
 *
 *   npm run check:queried-columns
 *
 * READ ONLY, and offline — it reads migrations and source, never the database,
 * so it runs in gates.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * On 2026-10-14 the Settings → Health card built to answer Katie's question
 * — "are the customer's colors actually landing in Salesforce?" — was found
 * reading `sf_writes_audit.source` and `.written_at`. The table has
 * `triggered_by` and `attempted_at`, and the writer inserts `triggered_by`.
 *
 * So the query errored on every request, the catch turned it into a tidy
 * card, and the one check that existed to answer the launch question had
 * never answered it. A wrong column name is a string: invisible to tsc,
 * invisible to the unit suite, and invisible in the UI when a catch is
 * doing its job.
 *
 * `check:schema` already compares migrations against the live database.
 * This is the other direction — source against migrations — which is the
 * direction that bug travelled.
 *
 * ── DELIBERATELY CONSERVATIVE ───────────────────────────────────────────
 *
 * A noisy check gets switched off, so this only reports what it is sure of:
 *
 *   - tables whose CREATE TABLE is in supabase/migrations (anything else,
 *     including views and tables made in the dashboard, is skipped);
 *   - plain column references in .eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/
 *     .is/.in/.order and simple .select("a, b") lists;
 *   - it skips any select containing *, an embed (foreign-table expansion),
 *     an alias, a JSON path or a function call, because those are not plain
 *     column names and guessing would produce exactly the noise that makes
 *     a check worthless.
 *
 * It would rather miss something than cry wolf. It still catches the whole
 * class above.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * KNOWN, UNFIXED, AND NOT MINE TO FIX.
 *
 * Found by this check on the day it was written, in Messaging and Commercial
 * — other sessions own those files in this working tree. Listed rather than
 * silenced so the check can run in gates today.
 *
 * The list may only SHRINK. A reference that disappears has to come off this
 * list too, or the check fails: a baseline nobody prunes becomes a place
 * where bugs go to be forgotten.
 */
const BASELINE = new Set([
  "lib/messaging/training-import-write.ts::sms_sub_accounts.transcript",
  "scripts/check-selected-columns.mjs::commercial_operating_company.reply_to_email",
  "scripts/fix-attendance-duplicates.mjs::commercial_time_entries.entity",
]);

const MIG_DIR = "supabase/migrations";
const SRC_DIRS = ["app", "lib", "components", "scripts"];

/* ── 1. Columns each migration declares ──────────────────────────────── */

/** Strip comments and string literals so prose never looks like SQL. */
function scrubSql(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const columns = new Map(); // table -> Set(columns)

function addCol(table, col) {
  if (!columns.has(table)) columns.set(table, new Set());
  columns.get(table).add(col);
}

for (const f of readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = scrubSql(readFileSync(join(MIG_DIR, f), "utf8"));

  // CREATE TABLE [IF NOT EXISTS] [public.]name ( ...body... )
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = createRe.exec(sql))) {
    const table = m[1];
    // Balance parens from the opening one to get the body.
    let depth = 1;
    let i = createRe.lastIndex;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    const body = sql.slice(createRe.lastIndex, i - 1);
    // Split on top-level commas only.
    let d = 0;
    let cur = "";
    const parts = [];
    for (const ch of body) {
      if (ch === "(") d++;
      if (ch === ")") d--;
      if (ch === "," && d === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      // Skip table-level constraints.
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)\b/i.test(line)) continue;
      const col = line.match(/^"?([a-z0-9_]+)"?\s/i);
      if (col) addCol(table, col[1].toLowerCase());
    }
  }

  // ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] name
  const alterRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z0-9_]+)([\s\S]*?);/gi;
  while ((m = alterRe.exec(sql))) {
    const table = m[1];
    const rest = m[2];
    for (const a of rest.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
      addCol(table, a[1].toLowerCase());
    }
    for (const r of rest.matchAll(/RENAME\s+COLUMN\s+"?([a-z0-9_]+)"?\s+TO\s+"?([a-z0-9_]+)"?/gi)) {
      addCol(table, r[2].toLowerCase());
      columns.get(table)?.delete(r[1].toLowerCase());
    }
    for (const dcol of rest.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
      columns.get(table)?.delete(dcol[1].toLowerCase());
    }
  }
}

/* ── 2. Column references in source ──────────────────────────────────── */

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILTERS = "eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|order";
/** A plain column name — no JSON path, alias, function or embed. */
const PLAIN = /^[a-z0-9_]+$/i;

const problems = [];
let checkedRefs = 0;
let checkedFiles = 0;

for (const dir of SRC_DIRS) {
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(".from(")) continue;
    checkedFiles++;
    const fromRe = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/gi;
    let m;
    while ((m = fromRe.exec(src))) {
      const table = m[1].toLowerCase();
      const known = columns.get(table);
      if (!known || known.size === 0) continue; // not a migration-declared table

      // The chain: up to the next `.from(` or a blank line at lower indent.
      const nextFrom = src.indexOf(".from(", fromRe.lastIndex);
      const chain = src.slice(fromRe.lastIndex, nextFrom === -1 ? src.length : nextFrom).slice(0, 1200);

      const line = (idx) => src.slice(0, idx).split("\n").length;

      // .select("a, b, c")
      const sel = chain.match(/\.select\(\s*["'`]([^"'`]*)["'`]/);
      if (sel) {
        const body = sel[1];
        const simple =
          body.trim() !== "" &&
          !/[*(){}:!]/.test(body) &&
          !body.includes("->");
        if (simple) {
          for (const partRaw of body.split(",")) {
            const part = partRaw.trim();
            if (!part || !PLAIN.test(part)) continue;
            checkedRefs++;
            if (!known.has(part.toLowerCase())) {
              problems.push({ file, line: line(fromRe.lastIndex), table, col: part, where: "select" });
            }
          }
        }
      }

      // .eq("col", ...) and friends
      for (const f of chain.matchAll(new RegExp(`\\.(${FILTERS})\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi"))) {
        const col = f[2];
        if (!PLAIN.test(col)) continue;
        checkedRefs++;
        if (!known.has(col.toLowerCase())) {
          problems.push({ file, line: line(fromRe.lastIndex), table, col, where: `.${f[1]}()` });
        }
      }
    }
  }
}

/* ── 3. Report ───────────────────────────────────────────────────────── */

console.log(
  `\n  Tables declared in migrations: ${columns.size}` +
  `\n  Files containing a Supabase query: ${checkedFiles}` +
  `\n  Plain column references checked: ${checkedRefs}\n`
);

// An audit has to prove it measured something.
if (checkedRefs === 0) {
  console.error("  ✗  Checked zero column references — the parser is broken, not the code.\n");
  process.exit(1);
}

const key = (p) => `${p.file}::${p.table}.${p.col}`;
const fresh = problems.filter((p) => !BASELINE.has(key(p)));
const seen = new Set(problems.map(key));
const stale = [...BASELINE].filter((b) => !seen.has(b));

if (fresh.length > 0) {
  console.error(`  ✗  ${fresh.length} reference${fresh.length === 1 ? "" : "s"} to a column no migration declares:\n`);
  for (const p of fresh) {
    const near = [...(columns.get(p.table) ?? [])]
      .filter((c) => c.includes(p.col.slice(0, 4).toLowerCase()) || p.col.toLowerCase().includes(c.slice(0, 4)))
      .slice(0, 3);
    console.error(`     ${p.file}:${p.line}  ${p.table}.${p.col}  (${p.where})`);
    if (near.length) console.error(`        did you mean: ${near.join(", ")}`);
  }
  console.error(
    `\n  These are strings — tsc cannot see them and a try/catch will dress the\n` +
    `  failure up as a tidy error card. Fix the name, or add the column.\n`
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(`  ✗  ${stale.length} baselined reference${stale.length === 1 ? " is" : "s are"} gone — delete from BASELINE in this script:\n`);
  for (const b of stale) console.error(`     ${b}`);
  console.error(`\n  A baseline nobody prunes is where bugs go to be forgotten.\n`);
  process.exit(1);
}

console.log(
  `  ✓  Every checked column reference exists in the migrations` +
  (BASELINE.size > 0 ? `, apart from ${BASELINE.size} baselined and owned elsewhere:\n` : ".\n")
);
for (const b of BASELINE) console.log(`       · ${b}`);
console.log("");
process.exit(0);
