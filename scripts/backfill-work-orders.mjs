/**
 * Give the already-won deals the work order they never got.
 *
 *   node --env-file=.env.local scripts/backfill-work-orders.mjs
 *       dry run — prints what it WOULD create, touches nothing
 *   node --env-file=.env.local scripts/backfill-work-orders.mjs --commit
 *
 * WHY
 *
 * Mary, 2026-10-13: *"I am not seeing some Opportunities in the Attendance
 * drop-down box. Cummins and Motormindz are examples."*
 *
 * The Attendance picker lists WORK ORDERS — hours are logged against a job, not
 * a deal. All 92 migrated jobs have one because the importer builds a job per
 * Salesforce work order. A deal won HERE got a project and no job, leaving it
 * won, carrying money, and invisible to Field Ops.
 *
 * `changeOpportunityStatus` now creates one on the win, which closes this for
 * every future sale — but only on the TRANSITION. A deal that was already won
 * when that shipped never fires it, so this walks the ones already in that
 * state.
 *
 * It is the same code path, not a second copy: it calls
 * `ensureWorkOrderForWonOpportunity`, so the rules about what counts as won,
 * what to name the job, and what not to schedule live in exactly one place.
 *
 * Safe to re-run. The ensure refuses any deal that already owns a live job.
 */
import { createClient } from "@supabase/supabase-js";

const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DELIVERY = ["pre_construction", "in_progress", "billing"];

const { data: opps, error } = await sb
  .from("commercial_opportunities")
  .select("id, title, status, sub_status, client_name, account_id, property_street, property_city, property_state, property_zip")
  .is("deleted_at", null)
  .is("archived_at", null);
if (error) throw new Error(error.message);

const { data: jobs, error: je } = await sb
  .from("commercial_jobs")
  .select("opportunity_id, deleted_at");
if (je) throw new Error(je.message);
const hasJob = new Set((jobs ?? []).filter((j) => !j.deleted_at).map((j) => j.opportunity_id));

const candidates = (opps ?? []).filter((o) => {
  const won = (o.status === "pre_sale_closed" && o.sub_status === "won") || DELIVERY.includes(o.status);
  return won && !hasJob.has(o.id);
});

console.log(`\nWon deals with no work order\n`);
console.log(`  deals examined : ${(opps ?? []).length}`);
console.log(`  need one       : ${candidates.length}\n`);
for (const o of candidates) {
  const addr = [o.property_street, o.property_city, o.property_state, o.property_zip].filter(Boolean).join(", ");
  console.log(`  ${String(o.title).slice(0, 48).padEnd(48)} ${o.status}/${o.sub_status}`);
  console.log(`     customer ${o.client_name ?? "(none)"}`);
  console.log(`     site     ${addr || "(no address on the deal)"}`);
  if (!o.account_id) console.log(`     ⚠️  no account — the ensure will refuse this one`);
}

if (!COMMIT) {
  console.log(`\nDry run. Re-run with --commit to create them.\n`);
  process.exit(0);
}
if (candidates.length === 0) {
  console.log(`\nNothing to create.\n`);
  process.exit(0);
}

/*
 * Imported here rather than at the top: the module is `server-only`, and
 * loading it is what pulls in the app's own db client. Doing it after the dry
 * run means a rehearsal never touches that machinery at all.
 */
const { ensureWorkOrderForWonOpportunity } = await import(
  "/Users/karanmalhotra/Desktop/PPP/ppp-command-center/lib/commercial/field-ops/ensure-work-order.ts"
);

let made = 0;
for (const o of candidates) {
  const res = await ensureWorkOrderForWonOpportunity(o.id, { actingUserId: null });
  if (!res.ok) {
    console.log(`  ❌ ${o.title}: ${res.error}`);
    continue;
  }
  if (!res.created) {
    console.log(`  — ${o.title}: ${res.reason}`);
    continue;
  }
  made++;
  console.log(`  ✅ ${o.title} → ${res.jobCode}`);
}
console.log(`\n${made} work order(s) created. They appear in Attendance immediately.\n`);
