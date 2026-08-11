import { requireCrewEmployee, CrewPage, CrewEmpty } from "../crew-shell";
import { getMyHoursLog } from "@/lib/commercial/field-ops/hours-log";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { fmtEtDate } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

/** My Hours — this crew member's own scheduled-vs-worked. No company totals,
 *  no other people, no approval controls (those stay on the admin Hours Log). */
export default async function CrewHoursPage() {
  const gate = await requireCrewEmployee();
  if (!gate.ok) return gate.node;
  const { employee } = gate;

  const today = todayEtIso();
  // Trailing 4 weeks — what you'd check against a paycheque.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 28 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { days, totalScheduled, totalWorked } = await getMyHoursLog(employee.id, from, today);

  return (
    <CrewPage title="My hours" subtitle="The last four weeks.">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-ppp-charcoal-200 bg-surface px-4 py-3">
          <div className="text-[10.5px] font-bold uppercase tracking-wide text-ppp-charcoal-400">Scheduled</div>
          <div className="text-xl font-black text-ppp-charcoal tabular-nums mt-0.5">{totalScheduled}h</div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3">
          <div className="text-[10.5px] font-bold uppercase tracking-wide text-emerald-700">Worked</div>
          <div className="text-xl font-black text-emerald-800 tabular-nums mt-0.5">{totalWorked}h</div>
        </div>
      </div>

      {days.length === 0 ? (
        <CrewEmpty>No hours recorded in the last four weeks.</CrewEmpty>
      ) : (
        <ul className="divide-y divide-ppp-charcoal-100 rounded-xl border border-ppp-charcoal-200 bg-surface overflow-hidden">
          {days.map((d, i) => (
            <li key={`${d.work_date}-${d.job_name}-${i}`} className="px-4 py-2.5 flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ppp-charcoal">{fmtEtDate(d.work_date)}</div>
                <div className="text-[12px] text-ppp-charcoal-500 truncate">{d.job_name}</div>
              </div>
              <div className="text-[12.5px] tabular-nums shrink-0 text-right">
                <div className="text-ppp-charcoal-500">{d.scheduled_hours}h sched</div>
                <div className="font-bold text-ppp-charcoal">{d.worked_hours}h worked</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11.5px] text-ppp-charcoal-400">
        Something look wrong? Tell your foreman — hours are corrected on the office side.
      </p>
    </CrewPage>
  );
}
