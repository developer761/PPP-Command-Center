/**
 * The other half of the Commercial wipe: the FILES.
 *
 * scripts/wipe-commercial-data.sql empties the tables, but SQL cannot reach
 * Storage — so the proposals, signed contracts, audit trails and plan sets stay
 * in their buckets, orphaned from rows that no longer exist. This removes them.
 *
 * DRY RUN BY DEFAULT. It lists what it would delete and stops:
 *
 *   node --env-file=.env.local scripts/wipe-commercial-storage.mjs
 *
 * Add --confirm to actually delete. There is no undo:
 *
 *   node --env-file=.env.local scripts/wipe-commercial-storage.mjs --confirm
 *
 * commercial-brand-assets is NOT touched: the operating company's logo and
 * Brendan's signature live there, and the SQL keeps the row that points at them.
 */
import { createClient } from "@supabase/supabase-js";

const CONFIRM = process.argv.includes("--confirm");

/** Buckets holding per-job files. Brand assets are setup, not data. */
const BUCKETS = [
  "commercial-documents",
  "commercial-opportunity-files",
  "commercial-account-docs",
  "commercial-email-attachments",
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY needed).");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** Every object path in a bucket, walking folders (list() is one level). */
async function walk(bucket, prefix = "") {
  const found = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 100, offset });
    if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
    if (!data?.length) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder has no id; a file does.
      if (entry.id === null || entry.id === undefined) found.push(...(await walk(bucket, path)));
      else found.push({ path, size: entry.metadata?.size ?? 0 });
    }
    if (data.length < 100) break;
    offset += data.length;
  }
  return found;
}

let total = 0;
let bytes = 0;
let removed = 0;

for (const bucket of BUCKETS) {
  let files;
  try {
    files = await walk(bucket);
  } catch (err) {
    console.error(`  ${bucket}: could not list — ${err instanceof Error ? err.message : err}`);
    continue;
  }
  total += files.length;
  bytes += files.reduce((n, f) => n + Number(f.size || 0), 0);
  console.log(`${bucket}: ${files.length} file(s)`);
  for (const f of files.slice(0, 5)) console.log(`    ${f.path}`);
  if (files.length > 5) console.log(`    …and ${files.length - 5} more`);

  if (CONFIRM && files.length) {
    // remove() takes at most 1000 paths per call.
    for (let i = 0; i < files.length; i += 500) {
      const batch = files.slice(i, i + 500).map((f) => f.path);
      const { error } = await sb.storage.from(bucket).remove(batch);
      if (error) console.error(`    delete failed: ${error.message}`);
      else removed += batch.length;
    }
    // Say what is actually left, rather than trusting the delete call.
    const left = await walk(bucket).catch(() => []);
    console.log(`    → ${left.length} file(s) left in ${bucket}`);
  }
}

console.log(
  CONFIRM
    ? `\nDeleted ${removed} of ${total} file(s).`
    : `\nDRY RUN — ${total} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB would be deleted. Re-run with --confirm.`
);
