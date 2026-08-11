import { requireCrewEmployee, CrewPage, CrewEmpty } from "../crew-shell";
import { listMyUpcomingShifts, listMyAbsences } from "@/lib/commercial/field-ops/schedule";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { fmtEtDate } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

/** My Schedule — this crew member's upcoming shifts only. Every query is
 *  scoped by employee_id in its WHERE clause (see listMyUpcomingShifts). */
export default async function CrewSchedulePage() {
  const gate = await requireCrewEmployee();
  if (!gate.ok) return gate.node;
  const { employee } = gate;

  const from = todayEtIso();
  // Six weeks out — far enough to plan around, short enough to stay one screen.
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 42 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [shifts, absences] = await Promise.all([
    listMyUpcomingShifts(employee.id, from, to),
    listMyAbsences(employee.id, from, to),
  ]);
  const offByDate = new Map(absences.map((a) => [a.work_date, a.reason]));

  return (
    <CrewPage title="My schedule" subtitle="Where you're working, and when.">
      {shifts.length === 0 ? (
        <CrewEmpty>
          Nothing scheduled in the next six weeks. Your foreman will add you as
          jobs get planned.
        </CrewEmpty>
      ) : (
        <ul className="space-y-2">
          {shifts.map((s) => {
            const off = offByDate.get(s.work_date);
            return (
              <li
                key={s.assignment_id}
                className={`rounded-xl border px-4 py-3 ${
                  off ? "border-amber-200 bg-amber-50/60" : "border-ppp-charcoal-200 bg-surface"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="text-[14px] font-bold text-ppp-charcoal">
                    {fmtEtDate(s.work_date)}
                  </span>
                  <span className="text-[12.5px] text-ppp-charcoal-500 tabular-nums">
                    {s.start_time ? s.start_time.slice(0, 5) : "—"}
                    {s.end_time ? `–${s.end_time.slice(0, 5)}` : ""}
                    {s.scheduled_hours > 0 ? ` · ${s.scheduled_hours}h` : ""}
                  </span>
                </div>
                <div className="text-[13px] font-semibold text-ppp-charcoal mt-0.5">{s.job_name}</div>
                {s.site && <div className="text-[12px] text-ppp-charcoal-500">{s.site}</div>}
                {s.note && (
                  <div className="text-[12px] text-ppp-charcoal-600 mt-1 whitespace-pre-wrap">{s.note}</div>
                )}
                {/* Marked off on a day you're also scheduled — surfaced rather
                    than silently showing the shift, so it gets sorted out. */}
                {off !== undefined && (
                  <div className="text-[11.5px] font-semibold text-amber-800 mt-1">
                    You&rsquo;re marked off this day{off ? ` — ${off}` : ""}. Check with your foreman.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </CrewPage>
  );
}
