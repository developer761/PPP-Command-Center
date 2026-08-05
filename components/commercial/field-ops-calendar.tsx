"use client";

/**
 * R10.7 Interactive Field Ops Calendar — the one scheduling surface. Month grid
 * with per-day jobs + headcount + a capacity heat tint. Click any day to open
 * the day panel (URL ?day=) and place crew on work orders with times + a note.
 * On-brand chips (no rainbow), month nav, today. Mobile: scrollable agenda list.
 */

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { MonthDay } from "@/lib/commercial/field-ops/schedule";

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dayNum(iso: string): number {
  return Number(iso.slice(8, 10));
}
function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}

// Curated on-brand chip tints — stable per job, never a rainbow.
const CHIP_TONES = [
  "bg-cc-brand-50 text-cc-brand-700",
  "bg-ppp-navy-50 text-ppp-navy-700",
  "bg-ppp-green-50 text-ppp-green-700",
  "bg-ppp-blue-50 text-ppp-blue-700",
  "bg-emerald-50 text-emerald-700",
];
function chipTone(jobId: string): string {
  let h = 0;
  for (let i = 0; i < jobId.length; i++) h = (h * 31 + jobId.charCodeAt(i)) >>> 0;
  return CHIP_TONES[h % CHIP_TONES.length];
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function FieldOpsCalendar({
  monthStart,
  grid,
  todayIso,
  openDay,
}: {
  monthStart: string;
  grid: MonthDay[];
  todayIso: string;
  openDay?: string;
}) {
  const router = useRouter();
  const prevMonth = useMemo(() => addDays(monthStart, -1).slice(0, 7) + "-01", [monthStart]);
  const nextMonth = useMemo(() => {
    const [y, m] = monthStart.split("-").map(Number);
    return `${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)}-01`;
  }, [monthStart]);
  const maxHead = Math.max(1, ...grid.map((d) => d.headcount));

  const goMonth = (month: string) => router.push(`/commercial/field-ops/calendar?month=${month}`, { scroll: false });
  const goToday = () => router.push(`/commercial/field-ops/calendar`, { scroll: false });
  // Open the day panel — keep the current month in the URL so closing returns here.
  const open = (date: string) => router.push(`/commercial/field-ops/calendar?month=${monthStart}&day=${date}`, { scroll: false });

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="inline-flex items-center rounded-lg border border-ppp-charcoal-200 overflow-hidden">
          <button onClick={() => goMonth(prevMonth)} className="px-3 py-2 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]" aria-label="Previous month">&larr;</button>
          <button onClick={goToday} className="px-3 py-2 text-[12.5px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 border-x border-ppp-charcoal-200 min-h-[40px]">Today</button>
          <button onClick={() => goMonth(nextMonth)} className="px-3 py-2 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]" aria-label="Next month">&rarr;</button>
        </div>
        <h2 className="text-[15px] font-bold text-ppp-charcoal">{monthLabel(monthStart)}</h2>
        <span className="text-[11.5px] text-ppp-charcoal-400 ml-auto hidden sm:inline">Click a day to schedule crew</span>
      </div>

      {/* Weekday header */}
      <div className="hidden sm:grid grid-cols-7 gap-1 mb-1">
        {DOW.map((d) => <div key={d} className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 text-center py-1">{d}</div>)}
      </div>

      {/* Month grid (desktop) */}
      <div className="hidden sm:grid grid-cols-7 gap-1">
        {grid.map((day) => {
          const isToday = day.date === todayIso;
          const isOpen = day.date === openDay;
          const heat = day.headcount > 0 ? Math.min(0.14, 0.03 + (day.headcount / maxHead) * 0.11) : 0;
          return (
            <button
              key={day.date}
              onClick={() => open(day.date)}
              className={`group text-left min-h-[104px] rounded-lg border p-1.5 transition-colors ${day.inMonth ? "bg-surface border-ppp-charcoal-100 hover:border-cc-brand-300" : "bg-ppp-charcoal-50/40 border-transparent"} ${isToday ? "ring-2 ring-cc-brand-400" : ""} ${isOpen ? "ring-2 ring-ppp-navy-500" : ""}`}
              style={day.headcount > 0 ? { backgroundColor: `rgba(43,170,225,${heat})` } : undefined}
            >
              <div className="flex items-center justify-between">
                <span className={`text-[12px] font-bold ${day.inMonth ? "text-ppp-charcoal" : "text-ppp-charcoal-400"}`}>{dayNum(day.date)}</span>
                {day.headcount > 0
                  ? <span className="text-[9.5px] font-bold text-cc-brand-700 bg-cc-brand-50 rounded-full px-1.5 py-0.5">{day.headcount} on</span>
                  : day.inMonth && <span className="text-[13px] leading-none font-bold text-ppp-charcoal-300 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>+</span>}
              </div>
              <div className="mt-1 space-y-0.5">
                {day.jobs.slice(0, 3).map((j) => (
                  <div key={j.id} className={`text-[10px] font-medium rounded px-1 py-0.5 truncate ${chipTone(j.id)}`}>{j.name}{j.prevailing_wage ? " · PW" : ""}</div>
                ))}
                {day.jobs.length > 3 && <div className="text-[9.5px] text-ppp-charcoal-400 px-1">+{day.jobs.length - 3} more</div>}
              </div>
            </button>
          );
        })}
      </div>

      {/* Mobile: agenda list — every in-month day is tappable to schedule */}
      <div className="sm:hidden space-y-2">
        {grid.filter((d) => d.inMonth).map((day) => {
          const isToday = day.date === todayIso;
          return (
            <button key={day.date} onClick={() => open(day.date)} className={`w-full text-left bg-surface border rounded-lg p-3 ${day.date === openDay ? "border-ppp-navy-500" : "border-ppp-charcoal-100"}`}>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-ppp-charcoal">{new Date(day.date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}{isToday && <span className="ml-1.5 text-[9px] font-bold uppercase text-cc-brand-700">today</span>}</span>
                {day.headcount > 0
                  ? <span className="text-[10.5px] font-bold text-cc-brand-700 bg-cc-brand-50 rounded-full px-2 py-0.5">{day.headcount} on · {day.hours}h</span>
                  : <span className="text-[11px] font-semibold text-cc-brand-700">+ schedule</span>}
              </div>
              {day.jobs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {day.jobs.map((j) => <span key={j.id} className={`text-[10.5px] font-medium rounded px-1.5 py-0.5 ${chipTone(j.id)}`}>{j.name}</span>)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
