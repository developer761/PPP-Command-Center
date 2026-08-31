/**
 * Does the live database still contain everything the migrations declare?
 *
 * Catches a table/column deleted in the Supabase dashboard — the failure git
 * cannot see. Read-only: writes nothing, only probes for existence.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

const tables = new Map();   // table -> first migration that creates it
const columns = new Map();  // "table.col" -> migration

for (const f of files) {
  // Strip line comments, block comments and quoted strings FIRST. Parsing raw
  // source matched the word "won" inside "CREATE TABLE IF NOT EXISTS won't fix
  // it" in a comment — a phantom table. Never assert on unparsed source text.
  const sql = readFileSync(`${DIR}/${f}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
  for (const m of sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
    if (!tables.has(m[1])) tables.set(m[1], f);
  }
  // One ALTER can add MANY columns:
  //     ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT, ADD COLUMN IF NOT EXISTS b BOOL;
  // Matching "alter table <t> add column" only ever caught the FIRST — which
  // under-reported drift and made a wholly-unapplied migration look like a
  // single stray column. Split on statements, then scan each one.
  for (const stmt of sql.split(";")) {
    const t = /alter\s+table\s+(?:public\.)?"?([a-z0-9_]+)"?/i.exec(stmt);
    if (!t) continue;
    for (const c of stmt.matchAll(/add\s+column\s+if\s+not\s+exists\s+"?([a-z0-9_]+)"?/gi)) {
      const k = `${t[1]}.${c[1]}`;
      if (!columns.has(k)) columns.set(k, f);
    }
  }
  // A later migration may intentionally remove what an earlier one added —
  // migration 068 drops commercial_opportunities.location_short. That is the
  // schema working as designed, not drift.
  for (const m of sql.matchAll(/alter\s+table\s+(?:public\.)?"?([a-z0-9_]+)"?[\s\S]{0,200}?drop\s+column\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/gi)) {
    columns.delete(`${m[1]}.${m[2]}`);
  }
  for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
    tables.delete(m[1]);
  }
}

console.log(`Parsed ${files.length} migration files → ${tables.size} tables, ${columns.size} added columns\n`);

const missingT = [], missingC = [], odd = [];

for (const [t, f] of [...tables].sort()) {
  const { error } = await sb.from(t).select("*").limit(0);
  if (!error) continue;
  // PGRST205 is PostgREST's "not in the schema cache" — for a table declared in
  // a migration that means it was never applied, not that we failed to look.
  if (error.code === "42P01" || error.code === "PGRST205" || /does not exist/i.test(error.message)) missingT.push([t, f, error.message]);
  else odd.push([t, f, `${error.code}: ${error.message}`]);
}

for (const [k, f] of [...columns].sort()) {
  const [t, c] = k.split(".");
  if (missingT.some(([mt]) => mt === t)) continue; // table already reported
  const { error } = await sb.from(t).select(c).limit(0);
  if (!error) continue;
  if (error.code === "42703" || /column .* does not exist/i.test(error.message)) missingC.push([k, f, error.message]);
  else odd.push([k, f, `${error.code}: ${error.message}`]);
}

const line = (rows) => rows.map(([n, f, m]) => `   ✗ ${n}\n       declared in ${f}\n       ${m}`).join("\n");

console.log(missingT.length ? `MISSING TABLES (${missingT.length}):\n${line(missingT)}\n` : "TABLES: all present ✓");
console.log(missingC.length ? `MISSING COLUMNS (${missingC.length}):\n${line(missingC)}\n` : "COLUMNS: all present ✓");
if (odd.length) console.log(`\nCOULD NOT VERIFY (${odd.length}):\n${line(odd)}`);

process.exit(missingT.length || missingC.length ? 1 : 0);
