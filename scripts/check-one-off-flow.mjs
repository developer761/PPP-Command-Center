/**
 * Does a one-off work order actually work, end to end?
 *
 * Karan 2026-09-17: "make sure like the one-off work order → auto-creates a
 * job/opp, tagged as one-off, this actually makes sense and the logic and flow
 * and everything is working properly."
 *
 * The point of creating the opportunity is that the job becomes BILLABLE and
 * COUNTABLE. So this does not check that three rows appeared — it checks the
 * four things that were impossible for a standalone job:
 *
 *   1. a purchase can be recorded against it,
 *   2. an invoice can be raised against it (the column is NOT NULL),
 *   3. its costs roll up,
 *   4. it is schedulable like any other job.
 *
 * Creates ONE CENT of test data against a loudly-named customer, verifies, then
 * hard-deletes everything it made and proves it is gone.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-one-off-flow.mjs
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const MARK = "ZZ ONE-OFF CHECK — DELETE ME";
let oppId = null;
let jobId = null;
let purchaseId = null;
let invoiceId = null;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  const { createOneOffWorkOrder, ONE_OFF_ACCOUNT_NAME } = await import("../lib/commercial/field-ops/one-off.ts");

  console.log("\nCreating a one-off work order\n");
  const res = await createOneOffWorkOrder({
    name: MARK,
    customerName: "Mrs Henderson",
    site_address: "21 Test Street",
    site_city: "Bellport",
    site_state: "NY",
    site_zip: "11713",
    target_start: "2026-09-23",
    target_end: "2026-09-24",
    estimated_labor_hours: 8,
    notes: "automated one-off flow check",
    actorUserId: null,
  });
  check("createOneOffWorkOrder returns ok", res.ok, res.ok ? "" : res.error);
  if (!res.ok) throw new Error(res.error);
  oppId = res.opportunityId;
  jobId = res.job.id;
  check("tagged as a one-off", res.tagged, res.tagged ? "" : "migration 20260917180000 not applied");

  // ── The opportunity carries the information, not just an id ──────────────
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", oppId)
    .maybeSingle();
  check("the opportunity exists", !!opp);
  check("it is in progress, not sitting in the bid pipeline", opp?.status === "in_progress", String(opp?.status));
  check("the customer is kept on the deal", opp?.client_name === "Mrs Henderson", String(opp?.client_name));
  check("the site address came across", opp?.property_street === "21 Test Street", String(opp?.property_street));
  check("the dates came across", opp?.proposed_start_at?.slice(0, 10) === "2026-09-23", String(opp?.proposed_start_at));

  const { data: acct } = await sb.from("commercial_accounts").select("company_name").eq("id", opp.account_id).maybeSingle();
  check("it hangs off the shared one-off account", acct?.company_name === ONE_OFF_ACCOUNT_NAME, String(acct?.company_name));

  // ── The job, and its link back ───────────────────────────────────────────
  const { data: job } = await sb.from("commercial_jobs").select("*").eq("id", jobId).maybeSingle();
  check("the work order exists", !!job);
  check("it is linked to the opportunity", job?.opportunity_id === oppId);
  check("it got an auto job code", !!job?.job_code, String(job?.job_code));
  check("it is schedulable", job?.status === "ready_to_schedule", String(job?.status));

  // ── 1. A purchase can be recorded. Impossible for a standalone job. ──────
  const { addPurchase, costBreakdownForProject } = await import("../lib/commercial/purchases/db.ts");
  const p = await addPurchase({
    opportunity_id: oppId,
    account_id: opp.account_id,
    category: "materials",
    vendor: MARK,
    amount_cents: 1,
    hours: null,
    purchased_at: "2026-09-23",
    description: "one-off flow check",
    reimburse_to: null,
    created_by_user_id: null,
  });
  check("a purchase can be recorded against it", p.ok, p.ok ? "" : p.error);
  if (p.ok) purchaseId = p.value.id;

  // ── 3. Costs roll up ─────────────────────────────────────────────────────
  const breakdown = await costBreakdownForProject(oppId);
  check("its costs roll up", (breakdown?.materials ?? 0) >= 1, `materials=${breakdown?.materials}`);

  // ── 2. An invoice can be raised. The column is NOT NULL. ─────────────────
  const { data: inv, error: invErr } = await sb
    .from("commercial_invoices")
    .insert({
      opportunity_id: oppId,
      account_id: opp.account_id,
      invoice_number: `ZZ-ONEOFF-${Date.now()}`,
      status: "draft",
      subtotal_cents: 1,
    })
    .select("id")
    .maybeSingle();
  check("an invoice can be raised against it", !!inv && !invErr, invErr?.message ?? "");
  if (inv) invoiceId = inv.id;

  // ── The project row costs and invoices hang off ──────────────────────────
  const { data: proj } = await sb.from("commercial_projects").select("id").eq("opportunity_id", oppId).maybeSingle();
  check("it has a project record", !!proj);

  // It ALSO gets a dashboard work order, via ensureWorkOrderForJob — so the
  // one-off appears on the deal's Work Orders tab like any other job rather
  // than only existing in Field Ops. This is the "has all the info" half.
  const { data: wo } = await sb
    .from("commercial_work_orders")
    .select("id")
    .eq("opportunity_id", oppId)
    .maybeSingle();
  check("it has a dashboard work order too", !!wo);

  // ── It behaves like any other job on the labor surfaces ──────────────────
  const { crewScheduleForOpp } = await import("../lib/commercial/field-ops/schedule.ts");
  const sched = await crewScheduleForOpp(oppId, "2026-09-17");
  check("the labor panel reads it without error", sched !== null && Array.isArray(sched.next));

  // ── The one-off account is reused, not duplicated ────────────────────────
  const { data: accts } = await sb
    .from("commercial_accounts")
    .select("id")
    .eq("company_name", ONE_OFF_ACCOUNT_NAME)
    .is("deleted_at", null);
  check("only ONE shared one-off account exists", (accts ?? []).length === 1, `${(accts ?? []).length} found`);
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  // Hard delete, in dependency order. A test row must never sit in the ledger
  // under a deleted_at that some future query forgets to filter.
  /**
   * ORDER MATTERS, and getting it wrong fails SILENTLY.
   *
   * The chain is job → work order → project → opportunity, every link ON DELETE
   * RESTRICT. Deleting the work order while the job still pointed at it simply
   * did nothing — PostgREST reports no rows affected, not an error — so the
   * project could not go, so the opportunity could not go, and the run left a
   * live opportunity on the book while reporting only "nothing is left behind"
   * as the failure. Children first, every time.
   */
  if (invoiceId) await sb.from("commercial_invoices").delete().eq("id", invoiceId);
  if (purchaseId) await sb.from("commercial_project_purchases").delete().eq("id", purchaseId);
  if (jobId) await sb.from("commercial_jobs").delete().eq("id", jobId);
  if (oppId) await sb.from("commercial_work_orders").delete().eq("opportunity_id", oppId);
  if (oppId) {
    await sb.from("commercial_projects").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_opportunities").delete().eq("id", oppId);
  }
  const { data: leftovers } = await sb.from("commercial_opportunities").select("id").eq("title", MARK);
  const { data: leftJobs } = await sb.from("commercial_jobs").select("id").eq("name", MARK);
  check("nothing is left behind", (leftovers ?? []).length === 0 && (leftJobs ?? []).length === 0);
  // The shared account is intentionally LEFT: it is real configuration once it
  // exists, and deleting it would make the next run create a second one.

  console.log(
    failures === 0
      ? "\n✅ a one-off work order creates a billable, countable job end to end"
      : `\n❌ ${failures} check(s) failed`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
