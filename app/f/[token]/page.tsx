import { getEmployeeByToken, getEmployeeDay } from "@/lib/commercial/field-ops/clock";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { PainterClock } from "@/components/commercial/painter-clock";

export const dynamic = "force-dynamic";
export const metadata = { title: "My schedule", robots: { index: false } };

/**
 * R10.3 - the painter's personal magic-link page (public, no login). The URL
 * token identifies them; they see today's jobs and clock in/out. Lives at
 * /f/[token], outside the authed /commercial shell.
 */
export default async function PainterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const employee = await getEmployeeByToken(token);

  if (!employee) {
    return (
      <main className="min-h-screen bg-ppp-charcoal-50/40 flex items-center justify-center p-6">
        <div className="text-center max-w-sm space-y-3">
          <div>
            <div className="text-lg font-bold text-ppp-charcoal">This link isn&rsquo;t valid</div>
            <p className="text-[13px] text-ppp-charcoal-500 mt-1">Ask the office to resend your schedule link, or clock in on the shop tablet.</p>
          </div>
          <div className="border-t border-ppp-charcoal-100 pt-3">
            <div className="text-lg font-bold text-ppp-charcoal">Este enlace no funciona</div>
            <p className="text-[13px] text-ppp-charcoal-500 mt-1">Pide a la oficina que te reenvíe tu enlace, o marca entrada en la tableta del taller.</p>
          </div>
        </div>
      </main>
    );
  }

  const es = employee.preferred_language === "es";
  const today = todayEtIso();
  const day = await getEmployeeDay(employee.id, today);
  const dateLabel = new Date(today + "T12:00:00Z").toLocaleDateString(es ? "es-US" : "en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // What's NEXT, and WHAT the work is.
  //
  // This page only ever showed TODAY, so a crew member scheduled for tomorrow —
  // or any day but this one — read "Nothing scheduled for you today" and had no
  // way to tell that from a genuine gap in their week. And the scope selection
  // reached the work-order PDF and nowhere else, so they were told where and
  // when but never what (Karan, testing it himself 2026-08).
  const { listMyUpcomingShifts } = await import("@/lib/commercial/field-ops/schedule");
  const { getCrewScopeForJob } = await import("@/lib/commercial/work-orders/db");
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 21 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const upcoming = (await listMyUpcomingShifts(employee.id, today, horizon).catch(() => []))
    // Today is already covered by the clock card above.
    .filter((sh) => sh.work_date > today)
    .slice(0, 8);
  // One scope per job, not just the first. A painter split across two jobs in a
  // day saw only one of them and had no way to know the other existed — the
  // page simply didn't mention it. Deduped by job so a doubled assignment
  // doesn't print the same list twice.
  const scopesToday = (
    await Promise.all(
      Array.from(new Set(day.assignments.map((a) => a.job_id))).map(async (jobId) => ({
        jobId,
        // The job's own name, so two jobs in one day are tellable apart. Without
        // it a painter split across two sites saw two identical "Your work
        // today" headings over two bullet lists and no way to know which was
        // which.
        jobName: day.assignments.find((a) => a.job_id === jobId)?.job_name ?? null,
        scope: await getCrewScopeForJob(jobId).catch(() => null),
      }))
    )
  ).filter((x) => x.scope && x.scope.lines.length > 0) as Array<{
    jobId: string;
    jobName: string | null;
    scope: NonNullable<Awaited<ReturnType<typeof getCrewScopeForJob>>>;
  }>;

  return (
    <main className="min-h-screen bg-ppp-charcoal-50/40 py-6 px-4">
      <div className="max-w-md mx-auto space-y-4">
        <PainterClock token={token} firstName={employee.first_name} day={day} dateLabel={dateLabel} es={es} />

        {scopesToday.map(({ jobId, jobName, scope }) => (
          <section key={jobId} className="rounded-xl border border-ppp-charcoal-200 bg-white p-4">
            <h2 className="text-[13px] font-bold text-ppp-charcoal">
              {scopesToday.length > 1 && jobName
                ? `${jobName} — `
                : scope.areaLabel
                  ? `${scope.areaLabel} — `
                  : ""}
              {es ? "Tu trabajo hoy" : "Your work today"}
              {scope.isPartial && (
                <span className="font-normal text-ppp-charcoal-500">
                  {" "}
                  ({scope.lines.length} {es ? "de" : "of"} {scope.totalLines})
                </span>
              )}
            </h2>
            <ul className="mt-2 space-y-1.5 list-disc pl-5 text-[13px] text-ppp-charcoal-700">
              {scope.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            {scope.isPartial && (
              <p className="mt-2 text-[12px] font-semibold text-amber-800">
                {es
                  ? "Solo estos puntos — el resto esta en otra orden de trabajo."
                  : "These items only — the rest is on another work order."}
              </p>
            )}
          </section>
        ))}

        {upcoming.length > 0 && (
          <section className="rounded-xl border border-ppp-charcoal-200 bg-white p-4">
            <h2 className="text-[13px] font-bold text-ppp-charcoal">
              {es ? "Proximos dias" : "Coming up"}
            </h2>
            <ul className="mt-2 divide-y divide-ppp-charcoal-100">
              {upcoming.map((sh) => (
                <li key={sh.assignment_id} className="py-2 flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ppp-charcoal">
                      {new Date(sh.work_date + "T12:00:00Z").toLocaleDateString(es ? "es-US" : "en-US", {
                        timeZone: "UTC",
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="block text-[12px] text-ppp-charcoal-500 truncate">{sh.job_name}</span>
                  </span>
                  <span className="text-[12px] text-ppp-charcoal-500 tabular-nums shrink-0">
                    {sh.start_time ? sh.start_time.slice(0, 5) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
