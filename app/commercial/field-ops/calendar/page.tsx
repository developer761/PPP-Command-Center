import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  getMonthOverview,
  getDaySchedule,
  upsertAssignment,
  deleteAssignmentById,
  todayEtIso,
  fmtTime12,
} from "@/lib/commercial/field-ops/schedule";
import { listEmployees } from "@/lib/commercial/field-ops/employees";
import { listJobs } from "@/lib/commercial/field-ops/jobs";
import { FieldOpsCalendar } from "@/components/commercial/field-ops-calendar";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { UUID_RE } from "@/lib/commercial/uuid";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");
  return user.id;
}

function backTo(month: string, day?: string, extra?: string): string {
  const q = new URLSearchParams({ month });
  if (day) q.set("day", day);
  if (extra) q.set("msg", extra);
  return `/commercial/field-ops/calendar?${q.toString()}`;
}

async function addAssignmentAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const month = String(formData.get("month") ?? "");
  const work_date = String(formData.get("work_date") ?? "");
  const employee_id = String(formData.get("employee_id") ?? "");
  const job_id = String(formData.get("job_id") ?? "");
  const start_time = String(formData.get("start_time") ?? "");
  const end_time = String(formData.get("end_time") ?? "");
  const note = String(formData.get("note") ?? "");
  if (!DATE_RE.test(work_date) || !UUID_RE.test(employee_id) || !UUID_RE.test(job_id)) {
    redirect(backTo(month, work_date, "Pick a crew member and a work order."));
  }
  const res = await upsertAssignment({ job_id, employee_id, work_date, start_time, end_time, note, actor_user_id: userId });
  revalidatePath("/commercial/field-ops/calendar");
  if (!res.ok) redirect(backTo(month, work_date, res.error));
  redirect(backTo(month, work_date, "added"));
}

async function removeAssignmentAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const month = String(formData.get("month") ?? "");
  const work_date = String(formData.get("work_date") ?? "");
  const assignment_id = String(formData.get("assignment_id") ?? "");
  if (UUID_RE.test(assignment_id)) await deleteAssignmentById(assignment_id, userId);
  revalidatePath("/commercial/field-ops/calendar");
  redirect(backTo(month, work_date, "removed"));
}

function fmtDayHeading(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

export default async function FieldOpsCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; day?: string; msg?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const anchor = DATE_RE.test(sp.month ?? "") ? sp.month! : todayEtIso();
  const { monthStart, grid } = await getMonthOverview(anchor);
  const openDay = DATE_RE.test(sp.day ?? "") ? sp.day! : undefined;

  // Pickers + the open day's roster only load when a day is open.
  const [employees, jobs, daySchedule] = openDay
    ? await Promise.all([listEmployees(), listJobs(), getDaySchedule(openDay)])
    : [[], [], []];

  const crewOptions = employees.map((e) => ({ value: e.id, label: e.display_name, hint: e.email ? undefined : "no email — won't be notified" }));
  const jobOptions = jobs.map((j) => ({ value: j.id, label: j.name, hint: [j.job_code, j.customer_name, j.site_city].filter(Boolean).join(" · ") }));
  const dayTotalHours = daySchedule.reduce((s, a) => s + a.scheduled_hours, 0);
  const msg = sp.msg;
  const isError = msg && msg !== "added" && msg !== "removed";

  return (
    <div className="pb-8">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Calendar</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Click any day to put crew on a work order — set their hours and a note, and they&rsquo;re emailed automatically.</p>
      </div>

      <FieldOpsCalendar monthStart={monthStart} grid={grid} todayIso={todayEtIso()} openDay={openDay} />

      {/* Day panel — URL-driven slide-out (right on desktop, bottom sheet on mobile) */}
      {openDay && (
        <div className="fixed inset-0 z-40">
          <Link href={backTo(monthStart)} className="absolute inset-0 bg-ppp-charcoal-900/30" aria-label="Close" scroll={false} />
          <div className="absolute inset-x-0 bottom-0 sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[420px] bg-surface border-t sm:border-t-0 sm:border-l border-ppp-charcoal-100 rounded-t-2xl sm:rounded-none shadow-xl flex flex-col max-h-[88vh] sm:max-h-none">
            {/* Header */}
            <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-start justify-between gap-3 shrink-0">
              <div>
                <div className="text-[15px] font-bold text-ppp-charcoal">{fmtDayHeading(openDay)}</div>
                <div className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">{daySchedule.length === 0 ? "Nobody scheduled yet" : `${daySchedule.length} on · ${dayTotalHours}h scheduled`}</div>
              </div>
              <Link href={backTo(monthStart)} scroll={false} className="text-ppp-charcoal-400 hover:text-ppp-charcoal text-xl leading-none px-1 min-h-[44px] inline-flex items-center" aria-label="Close">&times;</Link>
            </div>

            <div className="overflow-y-auto p-4 space-y-4">
              {msg && (
                <div className={`rounded-lg px-3 py-2 text-[12.5px] ${isError ? "bg-rose-50 border border-rose-200 text-rose-700" : "bg-ppp-green-50 border border-ppp-green-100 text-ppp-green-700"}`}>
                  {msg === "added" ? "Scheduled — crew member emailed." : msg === "removed" ? "Removed." : msg}
                </div>
              )}

              {/* Existing roster */}
              {daySchedule.length > 0 && (
                <ul className="space-y-2">
                  {daySchedule.map((a) => (
                    <li key={a.assignment_id} className="border border-ppp-charcoal-100 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{a.employee_name}</div>
                          <div className="text-[11.5px] text-ppp-charcoal-600 truncate">{a.job_name}{a.prevailing_wage && <span className="ml-1 text-[9px] font-bold text-amber-700">PW</span>}</div>
                          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                            {a.start_time ? `${fmtTime12(a.start_time)}${a.end_time ? ` – ${fmtTime12(a.end_time)}` : ""} · ` : ""}{a.scheduled_hours}h
                          </div>
                          {a.note && <div className="text-[11px] text-ppp-charcoal-500 mt-1 italic">“{a.note}”</div>}
                        </div>
                        <form action={removeAssignmentAction}>
                          <input type="hidden" name="month" value={monthStart} />
                          <input type="hidden" name="work_date" value={openDay} />
                          <input type="hidden" name="assignment_id" value={a.assignment_id} />
                          <button type="submit" className="text-[11px] font-semibold text-rose-600 hover:text-rose-700 shrink-0 min-h-[44px] px-1" aria-label={`Remove ${a.employee_name}`}>Remove</button>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add form */}
              <form action={addAssignmentAction} className="space-y-3 border-t border-ppp-charcoal-50 pt-4">
                <input type="hidden" name="month" value={monthStart} />
                <input type="hidden" name="work_date" value={openDay} />
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-ppp-charcoal-500">Add to this day</h3>

                {crewOptions.length === 0 ? (
                  <p className="text-[12px] text-ppp-charcoal-500">No crew yet — <Link href="/commercial/field-ops/employees" className="font-semibold text-cc-brand-700 underline">add a crew member</Link> first.</p>
                ) : jobOptions.length === 0 ? (
                  <p className="text-[12px] text-ppp-charcoal-500">No work orders yet — <Link href="/commercial/field-ops/jobs" className="font-semibold text-cc-brand-700 underline">add a work order</Link> first.</p>
                ) : (
                  <>
                    <label className="block"><span className={LABEL_CLS}>Crew member</span>
                      <SearchableSelect name="employee_id" options={crewOptions} placeholder="Search crew…" required ariaLabel="Crew member" />
                    </label>
                    <label className="block"><span className={LABEL_CLS}>Work order</span>
                      <SearchableSelect name="job_id" options={jobOptions} placeholder="Search work orders…" required ariaLabel="Work order" />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block"><span className={LABEL_CLS}>Start time</span>
                        <input type="time" name="start_time" className={INPUT_CLS} /></label>
                      <label className="block"><span className={LABEL_CLS}>End time</span>
                        <input type="time" name="end_time" className={INPUT_CLS} /></label>
                    </div>
                    <p className="text-[11px] text-ppp-charcoal-400 -mt-1">Hours are figured from start &amp; end. Leave both blank for a full 8h day.</p>
                    <label className="block"><span className={LABEL_CLS}>Note for the crew (goes in their email)</span>
                      <textarea name="note" rows={2} placeholder="Gate code 1234, park in rear lot…" className={INPUT_CLS} /></label>
                    <button type="submit" className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Schedule &amp; email</button>
                  </>
                )}
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
