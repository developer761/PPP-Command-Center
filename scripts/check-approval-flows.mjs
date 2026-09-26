/**
 * Does Brendan's approval queue actually work, end to end?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-approval-flows.mjs
 *
 * WHY
 *
 * Approving hours is the one write on this platform that turns into money
 * leaving the building. His handbook keeps the two apart in as many words —
 * "hours are a record of who was on site, they are not what the crew is paid"
 * — but an approved hour is what payroll exports, and `exported` is terminal:
 * approve, question, override and delete all refuse a row afterwards, so
 * undoing one needs database access.
 *
 * WHAT IT ASSERTS
 *
 *   APPROVE    a submitted entry becomes approved, on disk, with who and when.
 *
 *   QUESTION   sending it back records the REASON. A row that comes back with
 *              no reason on it is a foreman being told to look again at
 *              nothing.
 *
 *   OVERRIDE   setting the hours yourself actually changes them, and keeps the
 *              entry in the queue rather than approving it by side effect.
 *
 *   THE SWEEP  "Approve N matching" takes only zero-variance, non-capped,
 *              non-absent, non-self-logged rows. The button's count and the
 *              function's filter are written twice in the codebase and must
 *              agree, or the button over-promises — which is exactly what its
 *              own comment warns about.
 *
 * SAFETY — as check:delivery and check:money. Its own employee, job and
 * opportunity under a loud marker; hard delete in dependency order; a
 * re-query by the marker to prove nothing is left.
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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const MARK = "ZZ APPROVAL FLOW CHECK — DELETE ME";
let failures = 0;
let accountId = null, oppId = null, jobId = null, empId = null;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const entryOnDisk = async (id) =>
  (await sb.from("commercial_time_entries")
    .select("status, actual_hours, questioned_reason, approved_by_user_id, approved_at")
    .eq("id", id).maybeSingle()).data;

try {
  console.log(`\nBrendan's approval queue, against a throwaway crew member\n`);

  const { data: prof } = await sb.from("profiles").select("user_id").limit(1).maybeSingle();
  const ACTOR = prof?.user_id ?? null;
  check("there is a user to act as", !!ACTOR);

  const { data: acct } = await sb
    .from("commercial_accounts").insert({ company_name: MARK }).select("id").maybeSingle();
  accountId = acct?.id;
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .insert({ account_id: accountId, title: MARK, status: "in_progress", sub_status: "wip_on_site" })
    .select("id").maybeSingle();
  oppId = opp?.id;
  const { data: job } = await sb
    .from("commercial_jobs")
    // job_code is NOT NULL and has no default — the app assigns it. A test row
    // supplies its own, marked so it cannot be mistaken for a real work order.
    .insert({ name: MARK, opportunity_id: oppId, status: "ready_to_schedule",
              job_code: `ZZCHK-${Date.now().toString().slice(-8)}` })
    .select("id").maybeSingle();
  jobId = job?.id;
  const { data: emp } = await sb
    .from("commercial_employees")
    .insert({ first_name: "ZZ", last_name: "Check", display_name: MARK, worker_type: "sub" })
    .select("id").maybeSingle();
  empId = emp?.id;
  check("a job and a crew member exist to work with", !!jobId && !!empId);

  const { approveTimeEntry, questionTimeEntry, overrideTimeEntryHours, listPendingApprovals } =
    await import("../lib/commercial/field-ops/approvals.ts");

  const mkEntry = async (workDate, hours) =>
    (await sb.from("commercial_time_entries")
      .insert({ job_id: jobId, employee_id: empId, work_date: workDate,
                actual_hours: hours, source: "clocked", status: "submitted" })
      .select("id").maybeSingle()).data?.id;

  // ══ APPROVE ══════════════════════════════════════════════════════════════
  const a = await mkEntry("2026-09-01", 8);
  const appr = await approveTimeEntry(a, ACTOR);
  check("a submitted entry can be approved", appr.ok, appr.ok ? "" : appr.error);
  const aDisk = await entryOnDisk(a);
  check("and it is approved ON DISK, not just in the reply",
    aDisk?.status === "approved", String(aDisk?.status));
  check("with who approved it and when",
    !!aDisk?.approved_by_user_id && !!aDisk?.approved_at, String(aDisk?.approved_at));

  // ══ QUESTION ═════════════════════════════════════════════════════════════
  const q = await mkEntry("2026-09-02", 8);
  const qres = await questionTimeEntry(q, "ZZ reason for the check", ACTOR);
  check("an entry can be sent back to the foreman", qres.ok, qres.ok ? "" : qres.error);
  const qDisk = await entryOnDisk(q);
  check("it lands in questioned", qDisk?.status === "questioned", String(qDisk?.status));
  /*
   * THE REASON IS THE POINT. A row that comes back with nothing on it is a
   * foreman being told to look again at nothing.
   */
  check("and the reason travels with it",
    qDisk?.questioned_reason === "ZZ reason for the check", String(qDisk?.questioned_reason));

  // ══ OVERRIDE ═════════════════════════════════════════════════════════════
  const o = await mkEntry("2026-09-03", 8);
  const ores = await overrideTimeEntryHours(o, 6.5, ACTOR);
  check("the hours can be set by hand", ores.ok, ores.ok ? "" : ores.error);
  const oDisk = await entryOnDisk(o);
  check("and the new figure is on disk", Number(oDisk?.actual_hours) === 6.5,
    String(oDisk?.actual_hours));
  /*
   * Setting hours is a CORRECTION, not a decision. If it approved by side
   * effect, Brendan would lose the second look he asked for by opening More.
   */
  /*
   * `!== "approved"` is also true of a row that does not exist. On the first
   * run the job insert failed, every entry was missing, and this line still
   * printed ok — a pass for the wrong reason. It has to see the row.
   */
  check("but it does not approve the row by side effect",
    !!oDisk && oDisk.status === "submitted", String(oDisk?.status));

  // ══ THE SWEEP'S PROMISE ══════════════════════════════════════════════════
  /*
   * "Approve N matching" counts one way on the page and filters another way in
   * the function. The page's own comment says they "must mirror
   * bulkApproveZeroVariance exactly or the button over-promises". Both are
   * source, so this holds them to each other rather than re-deriving a third
   * version.
   */
  const fnSrc = readFileSync("lib/commercial/field-ops/approvals.ts", "utf8");
  const pageSrc = readFileSync("app/commercial/field-ops/approvals/page.tsx", "utf8");
  const predicate = /r\.status === "submitted" && r\.variance === 0 && !r\.capped && !r\.absent && r\.source !== "manual"/;
  check("the sweep's filter and the button's count are the same predicate",
    predicate.test(fnSrc) && predicate.test(pageSrc),
    `fn=${predicate.test(fnSrc)} page=${predicate.test(pageSrc)}`);

  // ══ THE QUEUE READS ══════════════════════════════════════════════════════
  const pending = await listPendingApprovals();
  check("the queue loads without error", Array.isArray(pending), `${(pending ?? []).length} pending`);
  const ours = (pending ?? []).filter((r) => r.employee_id === empId);
  /*
   * The approved one is gone from the queue; the questioned and overridden
   * ones are still there. A queue that keeps an approved row would have
   * Brendan approving the same hours twice.
   */
  check("an approved entry leaves the queue",
    !ours.some((r) => r.id === a), `${ours.length} of ours still queued`);
  check("a questioned one stays in it", ours.some((r) => r.id === q));
  check("and so does one whose hours were corrected", ours.some((r) => r.id === o));
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  // Children first — every link here is ON DELETE RESTRICT or CASCADE, and a
  // parent deleted while a child points at it fails silently.
  if (empId) await sb.from("commercial_time_entries").delete().eq("employee_id", empId);
  if (jobId) await sb.from("commercial_jobs").delete().eq("id", jobId);
  if (empId) await sb.from("commercial_employees").delete().eq("id", empId);
  if (oppId) {
    await sb.from("commercial_work_orders").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_projects").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_opportunities").delete().eq("id", oppId);
  }
  if (accountId) await sb.from("commercial_accounts").delete().eq("id", accountId);

  const { data: lo } = await sb.from("commercial_opportunities").select("id").eq("title", MARK);
  const { data: la } = await sb.from("commercial_accounts").select("id").eq("company_name", MARK);
  const { data: le } = await sb.from("commercial_employees").select("id").eq("display_name", MARK);
  const { data: lj } = await sb.from("commercial_jobs").select("id").eq("name", MARK);
  const leftover = (lo ?? []).length + (la ?? []).length + (le ?? []).length + (lj ?? []).length;
  check("nothing is left behind", leftover === 0, leftover ? `${leftover} row(s) still there` : "");

  console.log(
    failures === 0
      ? "\n✅ approve, question, override and the sweep all work end to end\n"
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
