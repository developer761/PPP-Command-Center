import { requireCrewEmployee, CrewPage, CrewEmpty } from "../crew-shell";
import { listMyUpcomingShifts } from "@/lib/commercial/field-ops/schedule";
import { todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { fmtEtDate } from "@/lib/commercial/invoices/format";

export const dynamic = "force-dynamic";

/**
 * My Jobs — the jobs this crew member is on, derived from their own
 * assignments. Read-only and deliberately money-free: no pricing, no proposal
 * totals, no account P&L. "What am I painting, and where."
 */
export default async function CrewJobsPage() {
  const gate = await requireCrewEmployee();
  if (!gate.ok) return gate.node;
  const { employee } = gate;

  const today = todayEtIso();
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const shifts = await listMyUpcomingShifts(employee.id, today, to);

  // Collapse to one row per job, carrying the soonest shift — the shift list is
  // already scoped to this employee, so the job set is theirs by construction.
  const byJob = new Map<string, { name: string; site: string | null; next: string; shifts: number }>();
  for (const s of shifts) {
    const cur = byJob.get(s.job_id);
    if (!cur) byJob.set(s.job_id, { name: s.job_name, site: s.site, next: s.work_date, shifts: 1 });
    else {
      cur.shifts += 1;
      if (s.work_date < cur.next) cur.next = s.work_date;
    }
  }
  const jobs = Array.from(byJob.values()).sort((a, b) => a.next.localeCompare(b.next));

  return (
    <CrewPage title="My jobs" subtitle="What you're on over the next few months.">
      {jobs.length === 0 ? (
        <CrewEmpty>You&rsquo;re not on any upcoming jobs yet.</CrewEmpty>
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.name + j.next} className="rounded-xl border border-ppp-charcoal-200 bg-surface px-4 py-3">
              <div className="text-[14px] font-bold text-ppp-charcoal">{j.name}</div>
              {j.site && <div className="text-[12.5px] text-ppp-charcoal-500 mt-0.5">{j.site}</div>}
              <div className="text-[12px] text-ppp-charcoal-500 mt-1">
                Next: <strong className="text-ppp-charcoal">{fmtEtDate(j.next)}</strong>
                {j.shifts > 1 ? ` · ${j.shifts} shifts scheduled` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </CrewPage>
  );
}
