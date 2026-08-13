import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { todayEtIso, mondayOf, monthStartOf, addDaysIso } from "@/lib/commercial/field-ops/schedule";
import { getHoursLog } from "@/lib/commercial/field-ops/hours-log";

export const dynamic = "force-dynamic";
const BASE = "/commercial/field-ops/hours";

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

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
type Range = "today" | "week" | "month" | "custom";

// Resolve the [from, to] window (inclusive, ET) from the chosen preset. Custom
// falls back to "this week" if either date is missing/malformed or inverted.
function resolveRange(range: Range, from?: string, to?: string): { from: string; to: string; label: string } {
  const today = todayEtIso();
  if (range === "today") return { from: today, to: today, label: fmtDay(today) };
  if (range === "month") {
    const start = monthStartOf(today);
    const end = addDaysIso(monthStartOf(addDaysIso(start, 32)), -1);
    return { from: start, to: end, label: monthLabel(start) };
  }
  if (range === "custom" && from && to && ISO_RE.test(from) && ISO_RE.test(to) && from <= to) {
    return { from, to, label: `${fmtDay(from)} – ${fmtDay(to)}` };
  }
  // week (default)
  const mon = mondayOf(today);
  const sun = addDaysIso(mon, 6);
  return { from: mon, to: sun, label: `${fmtDay(mon)} – ${fmtDay(sun)}` };
}

function fmtDay(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}
const fmtH = (h: number) => `${h % 1 === 0 ? h : h.toFixed(2).replace(/0$/, "")}h`;

export default async function FieldOpsHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const range: Range = sp.range === "today" || sp.range === "month" || sp.range === "custom" ? sp.range : "week";
  const { from, to, label } = resolveRange(range, sp.from, sp.to);
  const { rows, totalScheduled, totalWorked } = await getHoursLog(from, to);

  const PRESETS: { key: Range; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This week" },
    { key: "month", label: "This month" },
  ];

  return (
    <div className="pb-8 max-w-3xl">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Hours Log</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Hours each crew member worked, broken down by work order. Pulled from the same clocked/approved actuals as Payroll.</p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {PRESETS.map((p) => {
          const active = range === p.key;
          return (
            <Link
              key={p.key}
              href={`${BASE}?range=${p.key}`}
              className={`px-3 min-h-[44px] inline-flex items-center rounded-lg text-[12.5px] font-semibold border ${
                active ? "border-cc-brand-500 bg-cc-brand-50 text-cc-brand-700" : "border-ppp-charcoal-100 text-ppp-charcoal-600 hover:border-ppp-charcoal-200"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
        <form action={BASE} method="get" className="flex items-center gap-1.5 ml-auto">
          <input type="hidden" name="range" value="custom" />
          <input type="date" name="from" defaultValue={range === "custom" ? from : ""} aria-label="From date" className="min-h-[44px] rounded-lg border border-ppp-charcoal-100 px-2 text-base sm:text-[12.5px] text-ppp-charcoal" />
          <span className="text-ppp-charcoal-400 text-[12px]">–</span>
          <input type="date" name="to" defaultValue={range === "custom" ? to : ""} aria-label="To date" className="min-h-[44px] rounded-lg border border-ppp-charcoal-100 px-2 text-base sm:text-[12.5px] text-ppp-charcoal" />
          <button type="submit" className="px-3 min-h-[44px] inline-flex items-center rounded-lg text-[12.5px] font-semibold bg-cc-brand-600 text-white hover:bg-cc-brand-700">Go</button>
        </form>
      </div>

      {/* Range + total summary */}
      <div className="flex items-center justify-between bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3 mb-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-400">Showing</div>
          <div className="text-[13.5px] font-semibold text-ppp-charcoal">{label}</div>
        </div>
        <div className="text-right">
          <div className="font-condensed text-2xl font-black text-ppp-charcoal tabular-nums leading-none">{fmtH(totalWorked)} <span className="text-ppp-charcoal-400 font-bold text-base">worked</span></div>
          <div className="text-[11px] text-ppp-charcoal-400 mt-0.5">{fmtH(totalScheduled)} scheduled · {rows.length} {rows.length === 1 ? "crew member" : "crew members"}</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">Nothing in this window</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">No crew scheduled, clocked, or marked off in this range. Try a wider range, or check the <Link href="/commercial/field-ops/approvals" className="font-semibold text-cc-brand-700 hover:underline">Approvals</Link> queue.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.employee_id} className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
              <div className="flex items-center justify-between gap-3 min-w-0">
                <span className="text-[14px] font-bold text-ppp-charcoal truncate min-w-0">{r.employee_name}</span>
                <span className="shrink-0 text-right">
                  <span className="font-condensed text-lg font-black text-ppp-charcoal tabular-nums">{fmtH(r.worked_hours)}</span>
                  <span className="text-[11px] text-ppp-charcoal-400"> worked</span>
                  <span className="block text-[11px] text-ppp-charcoal-400 tabular-nums leading-none -mt-0.5">{fmtH(r.scheduled_hours)} scheduled</span>
                </span>
              </div>
              {r.absences.length > 0 && (
                <div className="mt-2 text-[11.5px] text-amber-700 leading-snug">
                  Off: {r.absences.map((a) => `${a.reason}${a.hours != null ? ` (${fmtH(a.hours)})` : ""} · ${new Date(a.work_date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}`).join(" · ")}
                </div>
              )}
              {r.jobs.length > 0 && (
                <ul className="mt-2.5 space-y-1 border-t border-ppp-charcoal-50 pt-2.5">
                  <li className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-300">
                    <span>Work order</span>
                    <span className="shrink-0 tabular-nums">sched · worked</span>
                  </li>
                  {r.jobs.map((j) => (
                    <li key={j.job_id} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span className="text-ppp-charcoal-600 truncate min-w-0">
                        {j.job_name}
                        {j.job_code && <span className="text-ppp-charcoal-400 font-mono text-[11px]"> · {j.job_code}</span>}
                      </span>
                      <span className="text-ppp-charcoal-500 tabular-nums shrink-0">{fmtH(j.scheduled_hours)} · <span className="font-semibold text-ppp-charcoal-700">{fmtH(j.worked_hours)}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
