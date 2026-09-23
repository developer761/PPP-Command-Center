/**
 * Does storage actually accept what the app promises?
 *
 * Run: npm run check:upload-limit
 *
 * Three layers hold an upload limit and only one of them decides:
 *
 *   1. the app constant (MAX_UPLOAD_BYTES) — what the UI tells the user
 *   2. each bucket's file_size_limit — what the Supabase dashboard shows
 *   3. the PROJECT-wide limit — invisible from the code, and it wins
 *
 * On 2026-09-23 those read 100 MB, 100 MB and 50 MB. Stephanie picked a 60 MB
 * bid set on a page advertising 100, watched it fail, and was told "the file is
 * larger than the 100 MB limit". Nothing in the repo named the number that
 * actually refused her file. Reading configuration would not have caught it —
 * the bucket said 100 the whole time.
 *
 * HOW THE PROJECT CEILING IS MEASURED, without moving 500 MB up the wire:
 * Supabase refuses to set a BUCKET limit above the project limit, so a binary
 * search over `updateBucket` on a scratch bucket prices the ceiling exactly and
 * costs no transfer at all. Then one real upload — comfortably above the old
 * 50 MB ceiling — proves the path works end to end rather than only on paper.
 *
 * WHAT THIS DOES NOT PROVE: that a file at the full advertised limit uploads.
 * That would mean pushing ~500 MB on every run. The ceiling check covers the
 * limit itself; the real upload covers the plumbing. Stated rather than left
 * for a reader to assume — a check whose blind spots aren't written down gets
 * trusted for things it never tested.
 */
import { createClient } from "@supabase/supabase-js";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "../lib/commercial/uploads/limits.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Run with --env-file=.env.local (needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY)");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const MB = 1024 * 1024;
/** Every bucket a person uploads into from the UI. */
const BUCKETS = ["commercial-documents", "commercial-opportunity-files", "commercial-account-docs"];
/** Above the 50 MB ceiling that caused this, small enough to run often. */
const REAL_UPLOAD_MB = 60;

const problems = [];

// ── 1. The project ceiling, priced without transferring anything ───────────
const PROBE = "zz-upload-limit-probe";
await sb.storage.deleteBucket(PROBE).catch(() => {});
const { error: mkErr } = await sb.storage.createBucket(PROBE, { public: false });
if (mkErr) {
  console.error(`could not create the probe bucket (${mkErr.message}) — refusing to report a pass`);
  process.exit(1);
}
let lo = 1;
let hi = 60 * 1024; // 60 GB, well past any plan
while (lo < hi) {
  const mid = Math.floor((lo + hi + 1) / 2);
  const { error } = await sb.storage.updateBucket(PROBE, { fileSizeLimit: mid * MB });
  if (error) hi = mid - 1;
  else lo = mid;
}
await sb.storage.deleteBucket(PROBE).catch(() => {});
const ceilingMB = lo;
console.log(`Project ceiling:  ${ceilingMB} MB (${(ceilingMB / 1024).toFixed(2)} GB)`);
console.log(`App advertises:   ${MAX_UPLOAD_LABEL}\n`);

if (MAX_UPLOAD_BYTES > ceilingMB * MB) {
  problems.push(
    `the app advertises ${MAX_UPLOAD_LABEL} but the project ceiling is ${ceilingMB} MB — ` +
      `every upload between those two numbers will be accepted by the picker and refused by storage. ` +
      `This is exactly the shape of the bug this check exists for.`
  );
}

// ── 2. No bucket may undercut the promise ──────────────────────────────────
for (const bucket of BUCKETS) {
  const { data: cfg } = await sb.storage.getBucket(bucket);
  if (!cfg) {
    problems.push(`${bucket}: bucket does not exist`);
    continue;
  }
  const limit = cfg.file_size_limit;
  if (limit != null && limit < MAX_UPLOAD_BYTES) {
    problems.push(
      `${bucket}: configured for ${(limit / MB).toFixed(0)} MB, under the ${MAX_UPLOAD_LABEL} the app advertises.`
    );
  } else {
    console.log(`  ✓ ${bucket}: ${limit == null ? "no bucket limit" : (limit / MB).toFixed(0) + " MB"}`);
  }
}

// ── 3. One real upload, so the plumbing is tested and not just the numbers ─
const body = Buffer.alloc(REAL_UPLOAD_MB * MB, 0x20);
Buffer.from("%PDF-1.4\n").copy(body, 0);
const path = `zz-limit-check/${Date.now()}-${REAL_UPLOAD_MB}mb.pdf`;
const { error: upErr } = await sb.storage
  .from(BUCKETS[0])
  .upload(path, body, { contentType: "application/pdf" });
if (upErr) {
  problems.push(`${BUCKETS[0]}: a real ${REAL_UPLOAD_MB} MB upload was REFUSED (${upErr.message}).`);
} else {
  await sb.storage.from(BUCKETS[0]).remove([path]);
  console.log(`  ✓ ${BUCKETS[0]}: a real ${REAL_UPLOAD_MB} MB file uploaded and was removed`);
}

console.log("");
if (problems.length === 0) {
  console.log(`✅ storage accepts what the app promises (${MAX_UPLOAD_LABEL}).`);
  console.log(
    `   Tested: the ceiling (${ceilingMB} MB), every bucket's limit, and one real ${REAL_UPLOAD_MB} MB upload.\n` +
      `   NOT tested: an upload at the full ${MAX_UPLOAD_LABEL} — that would move half a gigabyte per run.`
  );
} else {
  console.log(`❌ ${problems.length} disagreement(s) between what the app promises and what storage does:`);
  for (const p of problems) console.log(`   • ${p}`);
  console.log(
    "\n   The project ceiling lives in the Supabase dashboard → Storage → Settings →\n" +
      "   'Global file size limit'. A bucket cannot exceed it, and a spend cap can\n" +
      "   hold it below what that field says. Raise it there first, then\n" +
      "   MAX_UPLOAD_BYTES in lib/commercial/uploads/limits.ts, then re-run this."
  );
  process.exit(1);
}
