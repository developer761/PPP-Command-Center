/**
 * Full local backup of the Commercial platform, before the wipe.
 *
 *   node --env-file=.env.local scripts/backup-commercial.mjs [dir]
 *
 * Writes, by default, to ~/Desktop/PPP/commercial-backup-<YYYY-MM-DD-HHMM>/:
 *   tables/<table>.json   every row of every commercial_* table
 *   tables/notifications-commercial.json
 *   files/<bucket>/<path> every stored file, folders and all
 *   MANIFEST.json         row counts, file counts, bytes, and anything that failed
 *
 * Read-only against the database. The manifest is the point: a backup nobody
 * counted is a promise, not a backup.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
const OUT = process.argv[2] || join(homedir(), "Desktop", "PPP", `commercial-backup-${stamp}`);
const BUCKETS = ["commercial-documents", "commercial-opportunity-files", "commercial-account-docs", "commercial-email-attachments", "commercial-brand-assets"];

/** Every commercial_* table the migrations create, read from the SQL itself. */
import { readdirSync, readFileSync } from "node:fs";
const migDir = join(process.cwd(), "supabase", "migrations");
const tables = new Set();
for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql"))) {
  const src = readFileSync(join(migDir, f), "utf8").replace(/--[^\n]*/g, "");
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(commercial_[a-z_]+)/gi)) {
    tables.add(m[1].toLowerCase());
  }
}

const manifest = { takenAt: new Date().toISOString(), database: url, tables: {}, files: {}, problems: [] };

async function dumpTable(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select("*").range(from, from + 999);
    if (error) {
      // A table that was dropped by a later migration is not a failure.
      if (/does not exist|schema cache/i.test(error.message)) return null;
      manifest.problems.push(`${table}: ${error.message}`);
      return null;
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const path = join(OUT, "tables", `${table}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2));
  return rows.length;
}

console.log(`Backing up to ${OUT}\n`);
let totalRows = 0;
for (const table of [...tables].sort()) {
  const n = await dumpTable(table);
  if (n === null) continue;
  manifest.tables[table] = n;
  totalRows += n;
  if (n > 0) console.log(`  ${String(n).padStart(5)}  ${table}`);
}

// The shared notifications table: only the Commercial rows.
{
  const { data, error } = await sb.from("notifications").select("*").like("kind", "commercial\\_%");
  if (error) manifest.problems.push(`notifications: ${error.message}`);
  else {
    writeFileSync(join(OUT, "tables", "notifications-commercial.json"), JSON.stringify(data ?? [], null, 2));
    manifest.tables["notifications (commercial kinds)"] = data?.length ?? 0;
    totalRows += data?.length ?? 0;
    console.log(`  ${String(data?.length ?? 0).padStart(5)}  notifications (commercial kinds)`);
  }
}

async function walk(bucket, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 100, offset });
    if (error) { manifest.problems.push(`${bucket}/${prefix}: ${error.message}`); return out; }
    if (!data?.length) break;
    for (const e of data) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null || e.id === undefined) out.push(...(await walk(bucket, path)));
      else out.push(path);
    }
    if (data.length < 100) break;
  }
  return out;
}

console.log("\nFiles:");
let totalFiles = 0;
let totalBytes = 0;
for (const bucket of BUCKETS) {
  const paths = await walk(bucket);
  let saved = 0;
  for (const p of paths) {
    const { data, error } = await sb.storage.from(bucket).download(p);
    if (error || !data) { manifest.problems.push(`${bucket}/${p}: ${error?.message ?? "no data"}`); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    const dest = join(OUT, "files", bucket, p);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    saved += 1;
    totalBytes += buf.byteLength;
  }
  manifest.files[bucket] = { found: paths.length, saved };
  totalFiles += saved;
  if (paths.length) console.log(`  ${String(saved).padStart(5)}/${paths.length}  ${bucket}`);
}

manifest.totals = { rows: totalRows, files: totalFiles, megabytes: +(totalBytes / 1024 / 1024).toFixed(1) };
writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

console.log(`\n${totalRows} rows · ${totalFiles} files · ${manifest.totals.megabytes} MB`);
if (manifest.problems.length) {
  console.log(`\n⚠ ${manifest.problems.length} problem(s) — see MANIFEST.json:`);
  for (const p of manifest.problems.slice(0, 10)) console.log(`   ${p}`);
  process.exit(1);
}
console.log(`\n✅ backup complete: ${OUT}`);
