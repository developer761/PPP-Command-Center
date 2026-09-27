/**
 * Does clocking in and out actually work, end to end?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-clock-flows.mjs
 *
 * WHY
 *
 * This is the only write on the platform made by somebody who is not sitting
 * at a desk. A painter taps a PIN on a tablet on site, and what comes out the
 * far end is a time entry that Brendan approves and payroll exports. Nobody
 * checks it on the way past — there is no screen between the tap and the
 * ledger.
 *
 * WHAT IT ASSERTS
 *
 *   IN         a punch opens, against the right job, and the day shows it.
 *   OUT        the punch closes, the span becomes hours, and a time entry
 *              exists for Brendan to approve.
 *   DOUBLE-IN  clocking in twice does not open two punches.
 *   OUT-FIRST  clocking out when you never clocked in is refused, by name.
 *   TERMINATED a deactivated worker cannot book hours. The code's own comment
 *              says why this matters: deactivating somebody kills their magic
 *              link, their login and their schedule, but the shop-floor PIN
 *              kept working — so a terminated painter could walk up to the
 *              tablet and book payroll hours dated after their last day.
 *
 * SAFETY — its own employee, job and opportunity under a loud marker, hard
 * deleted in dependency order, then a re-query by the marker to prove nothing
 * is left. Never a real crew member: an orphaned punch against a real painter
 * is payroll.
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

const MARK = "ZZ CLOCK FLOW CHECK — DELETE ME";
let failures = 0;
let accountId = null, oppId = null, jobId = null, empId = null;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  console.log(`\nClocking in and out, against a throwaway crew member\n`);

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
    .insert({ name: MARK, opportunity_id: oppId, status: "ready_to_schedule",
              job_code: `ZZCLK-${Date.now().toString().slice(-8)}` })
    .select("id").maybeSingle();
  jobId = job?.id;
  const { data: emp } = await sb
    .from("commercial_employees")
    .insert({ first_name: "ZZ", last_name: "Clock", display_name: MARK,
              worker_type: "sub", active: true })
    .select("id").maybeSingle();
  empId = emp?.id;
  check("a job and a crew member exist to clock against", !!jobId && !!empId);

  const { clockIn, clockOut, getEmployeeDay } = await import("../lib/commercial/field-ops/clock.ts");

  // ══ CLOCKING OUT WITHOUT CLOCKING IN ═════════════════════════════════════
  const early = await clockOut({ employee_id: empId, source: "kiosk" });
  check("clocking out when you never clocked in is refused",
    !early.ok && early.code === "not_clocked_in", early.ok ? "it was allowed" : early.error);

  // ══ IN ═══════════════════════════════════════════════════════════════════
  const inRes = await clockIn({ employee_id: empId, job_id: jobId, source: "kiosk" });
  check("a painter can clock in", inRes.ok, inRes.ok ? "" : inRes.error);

  const { data: openPunch } = await sb
    .from("commercial_time_punches")
    .select("id, job_id, clock_in_at, clock_out_at")
    .eq("employee_id", empId).is("clock_out_at", null).maybeSingle();
  check("a punch is open on disk", !!openPunch && !openPunch.clock_out_at);
  check("and it is against the right job", openPunch?.job_id === jobId);

  const today = new Date().toISOString().slice(0, 10);
  const day = await getEmployeeDay(empId, today);
  check("their day shows them clocked in", !!day?.openPunch, JSON.stringify(day?.openPunch ?? null).slice(0, 60));

  // ══ DOUBLE IN ════════════════════════════════════════════════════════════
  /*
   * Two open punches would double-count the same hour into payroll, and the
   * painter has no way to see that it happened.
   */
  const again = await clockIn({ employee_id: empId, job_id: jobId, source: "kiosk" });
  const { data: openCount } = await sb
    .from("commercial_time_punches").select("id")
    .eq("employee_id", empId).is("clock_out_at", null);
  check("clocking in twice does not open a second punch",
    (openCount ?? []).length === 1, `${(openCount ?? []).length} open · ${again.ok ? "allowed" : again.error}`);

  // ══ OUT ══════════════════════════════════════════════════════════════════
  /*
   * A REALISTIC SPAN FIRST.
   *
   * Hours are rounded to the nearest quarter, so a punch that opens and closes
   * in the same second rounds to 0.00 — and a zero-hour day deliberately
   * writes no time entry at all. The first run of this script clocked out
   * instantly, saw no entry, and looked like a severe bug: a painter's day
   * vanishing between the tablet and payroll.
   *
   * It was the test that was wrong. Backdating the punch gives the flow
   * something real to round, which is the case that actually matters.
   */
  await sb.from("commercial_time_punches")
    .update({ clock_in_at: new Date(Date.now() - 8 * 3_600_000).toISOString() })
    .eq("id", openPunch.id);

  const outRes = await clockOut({ employee_id: empId, source: "kiosk" });
  check("they can clock out", outRes.ok, outRes.ok ? "" : outRes.error);

  const { data: closed } = await sb
    .from("commercial_time_punches")
    .select("id, clock_in_at, clock_out_at").eq("employee_id", empId).limit(1).maybeSingle();
  check("the punch is closed on disk", !!closed?.clock_out_at, String(closed?.clock_out_at));

  /*
   * THE WHOLE POINT. A punch nobody turns into a time entry is a day the
   * painter worked and nobody pays them for.
   */
  const { data: entries } = await sb
    .from("commercial_time_entries")
    .select("id, actual_hours, status, source").eq("employee_id", empId);
  check("a time entry exists for Brendan to approve",
    (entries ?? []).length >= 1, `${(entries ?? []).length} entries`);
  if ((entries ?? []).length) {
    check("it carries the hours actually worked",
      Number(entries[0].actual_hours) === 8, `${entries[0].actual_hours}h`);
    check("it is marked as clocked, not hand-typed",
      entries[0].source === "clocked", String(entries[0].source));
    check("and it is waiting on a human, not pre-approved",
      entries[0].status === "submitted", String(entries[0].status));
  }

  const dayAfter = await getEmployeeDay(empId, today);
  check("their day no longer shows an open punch", !dayAfter?.openPunch);

  // ══ A TERMINATED WORKER ══════════════════════════════════════════════════
  await sb.from("commercial_employees").update({ active: false }).eq("id", empId);
  const afterTermination = await clockIn({ employee_id: empId, job_id: jobId, source: "kiosk" });
  check("a deactivated worker cannot clock in on the shop-floor PIN",
    !afterTermination.ok, afterTermination.ok ? "IT WAS ALLOWED" : afterTermination.error);
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  if (empId) {
    await sb.from("commercial_time_punches").delete().eq("employee_id", empId);
    await sb.from("commercial_time_entries").delete().eq("employee_id", empId);
    await sb.from("commercial_assignments").delete().eq("employee_id", empId);
  }
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
      ? "\n✅ clocking in and out works end to end, and refuses what it should\n"
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
