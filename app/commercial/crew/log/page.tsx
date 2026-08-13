import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireCrewEmployee, CrewPage, CrewEmpty } from "../crew-shell";
import {
  getDailyLog,
  submitDailyHours,
  submitDailyAbsence,
  ABSENCE_TYPES,
} from "@/lib/commercial/field-ops/daily-log";
import { SubmitButton } from "@/components/commercial/submit-button";
import { etTodayIso, relativeAgoEt } from "@/lib/date-et";

/**
 * Today's log — the painter's own hours, in one tap.
 *
 * Karan's spec (R10.4): *"speed is the whole game — >30s and it won't happen
 * daily, regressing to 'every cell = 8'."* A daily log nobody fills in is
 * worse than none, because it looks like data.
 *
 * So the normal day is: open the link, see the job you were scheduled on with
 * your scheduled hours already in the box, press Confirm. You only touch a
 * number when the day didn't go to plan, and "I wasn't there" is one tap too —
 * because if absence is slower than attendance, it gets recorded as zero hours
 * worked, which reads as someone who showed up and did nothing.
 *
 * Mobile-FIRST, not mobile-tolerant: this is used on a phone, outdoors, with
 * paint on your hands. Big targets, one column, no dropdowns to hunt through.
 */

export const dynamic = "force-dynamic";

async function confirmHoursAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { getEmployeeForUser } = await import("@/lib/commercial/crew-access");
  const employee = await getEmployeeForUser(user.id);
  // Your own hours or nobody's. The employee comes from the SESSION, never
  // from the form — a posted employee_id would let anyone file time against
  // anyone else.
  if (!employee) redirect("/commercial/crew");

  const jobId = String(formData.get("job_id") ?? "");
  const workDate = String(formData.get("work_date") ?? "");
  const hours = Number(String(formData.get("hours") ?? "0"));
  const res = await submitDailyHours({
    employeeId: employee.id,
    jobId,
    workDate,
    hours,
    actorUserId: user.id,
  });
  redirect(res.ok ? "/commercial/crew/log?saved=1" : `/commercial/crew/log?error=${encodeURIComponent(res.error)}`);
}

async function absenceAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { getEmployeeForUser } = await import("@/lib/commercial/crew-access");
  const employee = await getEmployeeForUser(user.id);
  if (!employee) redirect("/commercial/crew");

  const res = await submitDailyAbsence({
    employeeId: employee.id,
    workDate: String(formData.get("work_date") ?? ""),
    type: String(formData.get("type") ?? ""),
    actorUserId: user.id,
  });
  revalidatePath("/commercial/crew/log");
  redirect(res.ok ? "/commercial/crew/log?saved=1" : `/commercial/crew/log?error=${encodeURIComponent(res.error)}`);
}

export default async function CrewDailyLogPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; d?: string }>;
}) {
  const gate = await requireCrewEmployee();
  if (!gate.ok) return gate.node;
  const { employee } = gate;

  const sp = await searchParams;
  const today = etTodayIso();
  // Yesterday is reachable, because the honest time to fill this in is often
  // the next morning. Anything older goes through a scheduler — a painter
  // editing last week's hours is what the approval step exists to prevent.
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const workDate = sp.d === yesterday ? yesterday : today;
  const log = await getDailyLog(employee.id, workDate);

  return (
    <CrewPage title={workDate === today ? "Today's hours" : "Yesterday's hours"}>
      <div className="space-y-3">
        {sp.error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13.5px] text-rose-800">
            {sp.error}
          </div>
        )}
        {sp.saved === "1" && !sp.error && (
          <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-800">
            <strong className="font-semibold">Saved.</strong> Your scheduler will review it.
          </div>
        )}

        {/* Yesterday is one tap away, and only two days are ever offered. */}
        <div className="flex items-center gap-1.5">
          <Link
            href="/commercial/crew/log"
            aria-current={workDate === today ? "page" : undefined}
            className={`flex-1 text-center px-3 rounded-xl text-[13px] font-bold min-h-[48px] inline-flex items-center justify-center border ${
              workDate === today
                ? "bg-cc-brand-600 text-white border-cc-brand-600"
                : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200"
            }`}
          >
            Today
          </Link>
          <Link
            href={`/commercial/crew/log?d=${yesterday}`}
            aria-current={workDate === yesterday ? "page" : undefined}
            className={`flex-1 text-center px-3 rounded-xl text-[13px] font-bold min-h-[48px] inline-flex items-center justify-center border ${
              workDate === yesterday
                ? "bg-cc-brand-600 text-white border-cc-brand-600"
                : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200"
            }`}
          >
            Yesterday
          </Link>
        </div>

        {log.absence && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-[13.5px] text-amber-900">
            <strong className="font-semibold">
              Marked {ABSENCE_TYPES.find((t) => t.value === log.absence!.type)?.label.toLowerCase() ?? "away"}.
            </strong>{" "}
            Nothing else to do for this day. Worked after all? Enter hours below and it will be sorted out on review.
          </div>
        )}

        {log.jobs.length === 0 ? (
          <CrewEmpty>
            <p className="font-semibold text-[14px] text-ppp-charcoal">Nothing scheduled for you.</p>
            <p className="mt-1 text-[13px] text-ppp-charcoal-500 leading-relaxed">
              If you worked anyway, tell your foreman and they can add the job — then it will show up
              here to confirm.
            </p>
          </CrewEmpty>
        ) : (
          log.jobs.map((j) => (
            <div
              key={j.jobId}
              className="rounded-xl border border-ppp-charcoal-100 bg-surface px-4 py-3.5"
            >
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="text-[14.5px] font-bold text-ppp-charcoal">{j.jobName}</span>
                {j.scheduledHours > 0 ? (
                  <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
                    scheduled {j.scheduledHours}h
                  </span>
                ) : (
                  <span className="text-[12px] text-amber-700">not scheduled</span>
                )}
              </div>

              {j.locked ? (
                <p className="mt-2 text-[13px] text-emerald-800">
                  <strong className="font-semibold">{j.enteredHours}h approved.</strong> Ask your
                  scheduler if this needs changing.
                </p>
              ) : (
                <form action={confirmHoursAction} className="mt-2.5 flex items-end gap-2">
                  <input type="hidden" name="job_id" value={j.jobId} />
                  <input type="hidden" name="work_date" value={workDate} />
                  <label className="flex-1">
                    <span className="block text-[11.5px] font-semibold text-ppp-charcoal-600 mb-1">
                      Hours worked
                    </span>
                    <input
                      name="hours"
                      type="number"
                      inputMode="decimal"
                      step="0.5"
                      min="0"
                      max="24"
                      // Pre-filled with what was PLANNED. Confirming it is the
                      // one-tap path; it is a convenience, not an assertion.
                      defaultValue={j.enteredHours ?? j.scheduledHours}
                      className="w-full rounded-xl border border-ppp-charcoal-200 bg-surface px-3 py-2.5 text-base tabular-nums min-h-[52px]"
                    />
                  </label>
                  <SubmitButton
                    pendingLabel="Saving…"
                    className="inline-flex items-center justify-center px-5 rounded-xl bg-cc-brand-600 text-white text-[14px] font-bold min-h-[52px]"
                  >
                    {j.entryStatus ? "Update" : "Confirm"}
                  </SubmitButton>
                </form>
              )}

              {j.entryStatus && !j.locked && (
                <p className="mt-2 text-[12px] text-ppp-charcoal-500">
                  {j.enteredHours}h submitted — waiting on your scheduler.
                </p>
              )}
            </div>
          ))
        )}

        {/* Absence has to be as fast as attendance, or it never gets used. */}
        {!log.absence && (
          <details className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
            <summary className="list-none cursor-pointer px-4 py-3.5 min-h-[52px] flex items-center text-[13.5px] font-semibold text-ppp-charcoal">
              I wasn&rsquo;t working this day
            </summary>
            <div className="px-4 pb-3.5 grid grid-cols-2 gap-2">
              {ABSENCE_TYPES.map((t) => (
                <form key={t.value} action={absenceAction}>
                  <input type="hidden" name="work_date" value={workDate} />
                  <input type="hidden" name="type" value={t.value} />
                  <SubmitButton
                    pendingLabel="Saving…"
                    className="w-full inline-flex items-center justify-center px-3 rounded-xl border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-ppp-charcoal-700 min-h-[52px]"
                  >
                    {t.label}
                  </SubmitButton>
                </form>
              ))}
            </div>
          </details>
        )}

        <p className="text-[11.5px] text-ppp-charcoal-400 text-center pt-1">
          {workDate === today ? "Today" : relativeAgoEt(`${workDate}T12:00:00Z`)} · {workDate}
        </p>
      </div>
    </CrewPage>
  );
}
