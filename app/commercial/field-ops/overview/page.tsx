import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getFieldOpsOverview } from "@/lib/commercial/field-ops/overview";

export const dynamic = "force-dynamic";

function weekLabel(mondayIso: string): string {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const start = new Date(Date.UTC(y, m - 1, d));
  const fmt = (dt: Date) => dt.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function Kpi({ label, value, sub, tone = "brand" }: { label: string; value: string; sub?: string; tone?: "brand" | "navy" | "green" | "amber" }) {
  const valueTone = tone === "amber" ? "text-amber-700" : tone === "green" ? "text-ppp-green-700" : tone === "navy" ? "text-ppp-navy-700" : "text-cc-brand-700";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-400">{label}</div>
      <div className={`font-condensed text-3xl font-black tabular-nums mt-1 leading-none ${valueTone}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-ppp-charcoal-500 mt-1">{sub}</div>}
    </div>
  );
}

export default async function FieldOpsOverviewPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");

  const o = await getFieldOpsOverview();
  const clockedPct = o.scheduledHoursWeek > 0 ? Math.round((o.clockedHoursWeek / o.scheduledHoursWeek) * 100) : 0;

  return (
    <div className="pb-8">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Field Ops Overview</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">This week · {weekLabel(o.weekStart)}</p>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Kpi label="Scheduled this week" value={`${o.scheduledHoursWeek}h`} sub={`${o.crewScheduledWeek} crew scheduled`} />
        <Kpi label="Clocked this week" value={`${o.clockedHoursWeek}h`} sub={o.scheduledHoursWeek > 0 ? `${clockedPct}% of scheduled` : "—"} tone="navy" />
        <Kpi label="Approved this week" value={`${o.approvedHoursWeek}h`} sub="ready for payroll" tone="green" />
        <Kpi label="On today" value={`${o.crewOnToday}`} sub={`${o.jobsToday} work order${o.jobsToday === 1 ? "" : "s"} running`} />
      </div>

      {/* Needs attention */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <h2 className="text-[12px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-3">Needs attention</h2>
          <ul className="space-y-2">
            <li className="flex items-center justify-between">
              <span className="text-[13px] text-ppp-charcoal">Time to review</span>
              <Link href="/commercial/field-ops/approvals" className={`text-[13px] font-bold tabular-nums ${o.pendingApprovals > 0 ? "text-amber-700 hover:underline" : "text-ppp-charcoal-400"}`}>
                {o.pendingApprovals} {o.pendingApprovals > 0 ? "→" : ""}
              </Link>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-[13px] text-ppp-charcoal">Open work orders not yet scheduled</span>
              <Link href="/commercial/field-ops/jobs" className={`text-[13px] font-bold tabular-nums ${o.unscheduledOpenJobs > 0 ? "text-cc-brand-700 hover:underline" : "text-ppp-charcoal-400"}`}>
                {o.unscheduledOpenJobs} {o.unscheduledOpenJobs > 0 ? "→" : ""}
              </Link>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-[13px] text-ppp-charcoal">Work orders in progress</span>
              <span className="text-[13px] font-bold tabular-nums text-ppp-charcoal-600">{o.jobsInProgress}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-[13px] text-ppp-charcoal">Ready to schedule (backlog)</span>
              <span className="text-[13px] font-bold tabular-nums text-ppp-charcoal-600">{o.readyToSchedule}</span>
            </li>
          </ul>
        </div>

        {/* OT forecast */}
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <h2 className="text-[12px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-3">Overtime forecast</h2>
          {o.otForecast.length === 0 ? (
            <p className="text-[13px] text-ppp-charcoal-500">Nobody scheduled past 40h this week. 👍</p>
          ) : (
            <ul className="space-y-2">
              {o.otForecast.map((r) => (
                <li key={r.employee_id} className="flex items-center justify-between">
                  <span className="text-[13px] text-ppp-charcoal truncate">{r.name}</span>
                  <span className="text-[12.5px] font-bold tabular-nums text-amber-700">{r.scheduled}h <span className="text-[10.5px] font-semibold text-amber-600">(+{Math.round((r.scheduled - 40) * 4) / 4} OT)</span></span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10.5px] text-ppp-charcoal-400 mt-3">Scheduled hours over 40 in a Mon–Sun week bill at overtime. Trim before the week runs.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/commercial/field-ops/calendar" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Open the calendar</Link>
        <Link href="/commercial/field-ops/approvals" className="inline-flex items-center px-4 py-2 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]">Review time</Link>
      </div>
    </div>
  );
}
