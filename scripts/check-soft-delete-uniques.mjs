/**
 * Does any UNIQUE constraint outlive the row it belongs to?
 *
 * On a table that soft-deletes (`deleted_at`), a plain `UNIQUE (a, b)` keeps
 * reserving its values after the row is gone from every screen. The user then
 * cannot re-use a value they just freed, and there is nothing on the page to
 * explain why — the row they are told conflicts with is invisible.
 *
 * Stephanie hit this twice in one morning on 2026-09-24:
 *
 *   "I deleted the AIA draft #1. Now trying to redraft AIA #1 and it is
 *    telling me I can't use #1 because it is reserved to a deleted AIA."
 *
 * She had deleted the draft to correct a sales-tax setting — the ordinary way
 * to fix a mistake before anything is sent to the GC. The first fix only made
 * the refusal honest; the real repair was a PARTIAL index
 * (`where deleted_at is null`) so a deleted row reserves nothing.
 *
 * This finds the rest of them before somebody else does.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 * Reads every migration, collects each table's columns and its UNIQUE
 * constraints / unique indexes, and reports any unique rule on a table that
 * has `deleted_at` and is not scoped `where deleted_at is null`.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 * It reads SQL text, not the live catalog, so a constraint altered by hand in
 * the Supabase editor and never written down is invisible to it. That gap is
 * printed every run rather than left implied.
 *
 * Not every hit is a bug. A unique rule that encodes an EXTERNAL fact — one
 * row per Salesforce id, one per email — is often right to outlive the row,
 * because re-importing the same source record should collide. The ones that
 * matter are user-chosen identifiers: numbers, codes, names. The report says
 * which it cannot tell apart rather than guessing.
 *
 * Usage:  node scripts/check-soft-delete-uniques.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (files.length === 0) {
  console.error("no migrations found — refusing to report a pass over nothing");
  process.exit(1);
}

/** table -> Set(column) */
const columns = new Map();
/** Names of constraints/indexes a later migration removed. */
const dropped = new Set();
/** {table, cols, where, file, kind} */
const uniques = [];

const addCol = (table, col) => {
  if (!columns.has(table)) columns.set(table, new Set());
  columns.get(table).add(col.toLowerCase());
};

for (const f of files) {
  const raw = readFileSync(join(DIR, f), "utf8");
  // Strip comments so a UNIQUE inside an explanation is not collected.
  const sql = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

  // ── CREATE TABLE bodies: columns + inline UNIQUE(...) ───────────────────
  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi,
  )) {
    const table = m[1].toLowerCase();
    const body = m[2];
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith(")")) continue;
      const colMatch = /^([a-z0-9_]+)\s+[a-z]/i.exec(t);
      if (colMatch && !/^(unique|primary|constraint|check|foreign|exclude)\b/i.test(t)) {
        addCol(table, colMatch[1]);
      }
      const u = /^unique\s*\(([^)]+)\)/i.exec(t);
      if (u) {
        const c = cols(u[1]);
        uniques.push({
          table,
          cols: c,
          where: null,
          file: f,
          kind: "table UNIQUE",
          // Postgres names an inline UNIQUE `{table}_{col}_{col}_key`. Without
          // that, a later `drop constraint` by its real name could not be
          // matched back, and this check kept reporting constraints that had
          // already been replaced — a false alarm is how a report stops being
          // read.
          name: implicitName(table, c),
        });
      }
    }
  }

  // ── ALTER TABLE ... ADD COLUMN ──────────────────────────────────────────
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:public\.)?([a-z0-9_]+)[\s\S]{0,200}?add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi,
  )) {
    addCol(m[1].toLowerCase(), m[2]);
  }

  // ── ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (...) ─────────────────────
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:public\.)?([a-z0-9_]+)[\s\S]{0,300}?add\s+constraint\s+([a-z0-9_]+)\s+unique\s*\(([^)]+)\)/gi,
  )) {
    uniques.push({
      table: m[1].toLowerCase(),
      cols: cols(m[3]),
      where: null,
      file: f,
      kind: "ADD CONSTRAINT",
      name: m[2].toLowerCase(),
    });
  }

  // ── CREATE UNIQUE INDEX ... [WHERE ...] ─────────────────────────────────
  for (const m of sql.matchAll(
    /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]+)\)([^;]*);/gi,
  )) {
    const tail = m[4] ?? "";
    const where = /where\s+([\s\S]+)/i.exec(tail);
    uniques.push({
      table: m[2].toLowerCase(),
      cols: cols(m[3]),
      where: where ? where[1].replace(/\s+/g, " ").trim() : null,
      file: f,
      kind: "unique index",
      name: m[1],
    });
  }

  // ── DROPs, so a constraint later replaced is not reported ───────────────
  for (const m of sql.matchAll(
    /drop\s+constraint\s+(?:if\s+exists\s+)?([a-z0-9_]+)/gi,
  )) {
    dropped.add(m[1].toLowerCase());
  }
  for (const m of sql.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
    dropped.add(m[1].toLowerCase());
  }
}

/** How Postgres names an inline UNIQUE: {table}_{col}_{col}_key. */
function implicitName(table, columnList) {
  return `${table}_${columnList.join("_")}_key`.toLowerCase();
}

function cols(raw) {
  return raw
    .split(",")
    .map((c) => c.trim().toLowerCase().replace(/\s+(asc|desc)$/i, ""))
    .filter(Boolean);
}

/**
 * Unique rules that are RIGHT to outlive their rows, with the reason.
 *
 * A check that reports known-good findings every run gets skimmed, and then
 * the real one is skimmed with it. Each entry here was read and judged; the
 * reason is recorded so the next person can disagree with it on the evidence
 * rather than re-deriving it.
 *
 * Keyed `table(col,col)`.
 */
const ACCEPTED = {
  "commercial_archived_emails(source_kind,source_id,message_id)":
    "an EXTERNAL fact — the provider's message id. Re-archiving the same email SHOULD collide, even if the earlier copy was deleted.",
  "commercial_invoices(invoice_number)":
    "assigned from a Postgres SEQUENCE (commercial_next_invoice_seq), which never reissues a number. Nobody re-uses an invoice number; a gap is normal accounting.",
  "commercial_proposals(proposal_seq)":
    "assigned from SEQUENCE commercial_proposal_seq by trigger (migration 069). Monotonic by design.",
  "commercial_accounts(account_seq)":
    "assigned from SEQUENCE commercial_account_seq by trigger (migration 070). Monotonic by design.",
  "commercial_opportunities(project_number)":
    "assigned from the per-year counter table commercial_project_number_counters (migration 046), which only increments. Monotonic by design.",
};

// ── Report ────────────────────────────────────────────────────────────────
const problems = [];
const accepted = [];
for (const u of uniques) {
  const tableCols = columns.get(u.table);
  if (!tableCols || !tableCols.has("deleted_at")) continue; // hard-deletes — fine
  if (u.where && /deleted_at\s+is\s+null/i.test(u.where)) continue; // already partial
  if (u.name && dropped.has(u.name)) continue; // replaced later
  const key = `${u.table}(${u.cols.join(",")})`;
  if (ACCEPTED[key]) {
    accepted.push({ key, why: ACCEPTED[key] });
    continue;
  }
  problems.push(u);
}

console.log(
  `Read ${files.length} migration(s): ${columns.size} table(s), ${uniques.length} unique rule(s).`,
);
console.log(
  `\n⚠ Reads migration SQL, not the live database. A constraint changed by hand in\n` +
    `  the Supabase editor and never written down is invisible here.`,
);

if (accepted.length > 0) {
  console.log(`\n${accepted.length} judged correct to outlive their rows:`);
  for (const a of accepted) console.log(`   ${a.key}\n      ${a.why}`);
}

if (problems.length === 0) {
  console.log(
    "\n✅ every unique rule on a soft-deleting table is either scoped to live rows\n" +
      "   or judged, in writing, to be right to outlive them",
  );
  process.exit(0);
}

console.log(
  `\n❌ ${problems.length} unique rule(s) on soft-deleting tables that outlive their rows:\n`,
);
for (const p of problems) {
  console.log(`   ${p.table} (${p.cols.join(", ")})`);
  console.log(`      ${p.kind} in ${p.file}`);
  console.log(
    `      delete a row and its ${p.cols.length === 1 ? "value" : "combination"} stays reserved — it cannot be used again`,
  );
}
console.log(
  `\nNot every one is a bug: a rule encoding an EXTERNAL fact (one row per\n` +
    `Salesforce id, one per email) is often right to outlive the row. The ones\n` +
    `that matter are user-chosen identifiers — numbers, codes, names — where\n` +
    `deleting and re-making is an ordinary correction.`,
);
process.exit(1);
