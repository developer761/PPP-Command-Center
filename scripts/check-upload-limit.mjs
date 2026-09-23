/**
 * Does storage actually accept what the app promises?
 *
 * Run: npm run check:upload-limit
 *
 * Three layers each hold an upload limit, and only one of them decides:
 *
 *   1. the app constant (MAX_UPLOAD_BYTES) — what the UI tells the user
 *   2. the bucket's own file_size_limit — visible in the Supabase dashboard
 *   3. the PROJECT-wide storage limit — invisible from the code, and it wins
 *
 * On 2026-09-23 those read 100 MB, 100 MB and 50 MB. Stephanie picked a 60 MB
 * bid set on a page that advertised 100, watched it fail, and was told "the
 * file is larger than the 100 MB limit". Nothing in the repo mentioned the
 * number that actually rejected her file.
 *
 * Reading configuration would not have caught it — the bucket says 100 to this
 * day. So this check UPLOADS: one object just under the advertised limit, which
 * must land, and one just over, which must be refused. Both are deleted
 * immediately. It is slow and it costs a few MB of transfer, and it is the only
 * version of this check that can actually fail.
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

/** Every bucket a person uploads into from the UI. */
const BUCKETS = ["commercial-documents", "commercial-opportunity-files", "commercial-account-docs"];

const MB = 1024 * 1024;
const pdf = (bytes) => {
  const b = Buffer.alloc(bytes, 0x20);
  Buffer.from("%PDF-1.4\n").copy(b, 0);
  return b;
};

const tryUpload = async (bucket, bytes) => {
  const path = `zz-limit-check/${Date.now()}-${bytes}.pdf`;
  const { error } = await sb.storage.from(bucket).upload(path, pdf(bytes), { contentType: "application/pdf" });
  if (!error) await sb.storage.from(bucket).remove([path]);
  return error?.message ?? null;
};

const problems = [];
let checked = 0;

console.log(`The app tells people it accepts ${MAX_UPLOAD_LABEL}. Testing that against storage.\n`);

for (const bucket of BUCKETS) {
  const { data: cfg } = await sb.storage.getBucket(bucket);
  if (!cfg) {
    problems.push(`${bucket}: bucket does not exist`);
    continue;
  }
  const bucketLimit = cfg.file_size_limit;
  checked += 1;

  // Just UNDER the advertised limit must land. If it doesn't, the app is
  // promising capacity the platform will not give — Stephanie's bug exactly.
  const justUnder = MAX_UPLOAD_BYTES - 5 * MB;
  const underErr = await tryUpload(bucket, justUnder);
  if (underErr) {
    problems.push(
      `${bucket}: the app advertises ${MAX_UPLOAD_LABEL} but a ${(justUnder / MB).toFixed(0)} MB upload was REFUSED (${underErr}). ` +
        `Bucket setting is ${bucketLimit == null ? "unset" : (bucketLimit / MB).toFixed(0) + " MB"}; the project-wide limit may be lower still.`
    );
  } else {
    console.log(`  ✓ ${bucket}: accepted ${(justUnder / MB).toFixed(0)} MB`);
  }

  // A bucket configured ABOVE the real ceiling is the trap that caused this:
  // the dashboard says one thing, uploads do another. Report it as a lie even
  // though nothing is broken today, because it is what future readers trust.
  if (bucketLimit != null && bucketLimit > MAX_UPLOAD_BYTES) {
    const overErr = await tryUpload(bucket, MAX_UPLOAD_BYTES + 10 * MB);
    if (overErr) {
      problems.push(
        `${bucket}: bucket is configured for ${(bucketLimit / MB).toFixed(0)} MB but storage refused ${(MAX_UPLOAD_BYTES / MB + 10).toFixed(0)} MB (${overErr}). ` +
          `The bucket setting is not the real limit — anyone reading it in the dashboard will believe a number that does not hold.`
      );
    }
  }
}

if (checked === 0) {
  console.error("\nno buckets were checked — refusing to report a pass");
  process.exit(1);
}

console.log("");
if (problems.length === 0) {
  console.log(`✅ storage accepts what the app promises (${MAX_UPLOAD_LABEL}), across ${checked} bucket(s).`);
} else {
  console.log(`❌ ${problems.length} disagreement(s) between what the app promises and what storage does:`);
  for (const p of problems) console.log(`   • ${p}`);
  console.log(
    "\n   To raise the real ceiling: Supabase dashboard → Storage → Settings →\n" +
      "   'Upload file size limit'. That is a PROJECT setting; the bucket limit\n" +
      "   cannot exceed it. Raise it there first, then MAX_UPLOAD_BYTES in\n" +
      "   lib/commercial/uploads/limits.ts, then re-run this check."
  );
  process.exit(1);
}
