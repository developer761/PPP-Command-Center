"use client";

/**
 * R10.1 Week Grid - Tomco's scheduling spreadsheet, upgraded. Employees across
 * the top (their column order), jobs down the left grouped by day (Mon-Sat),
 * hours in click-to-edit cells. Editing a cell upserts an assignment. Column
 * totals, week nav, Copy Week Forward, and copy-to-clipboard (for pasting into
 * an email/text). Admin manual-edit is inherent - every cell is editable.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WeekDay, WeekEmployee } from "@/lib/commercial/field-ops/schedule";

type JobOpt = { id: string; name: string; job_code: string; prevailing_wage: boolean };

function addDaysClient(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

export function WeekGrid({
  weekStart,
  days,
  employees,
  jobs,
  todayIso,
}: {
  weekStart: string;
  days: WeekDay[];
  employees: WeekEmployee[];
  jobs: JobOpt[];
  todayIso: string;
}) {
  const router = useRouter();
  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  // Editable state: hours[date][jobId][empId] = number. Plus per-day ordered job rows.
  const [hours, setHours] = useState<Record<string, Record<string, Record<string, number>>>>(() => {
    const h: Record<string, Record<string, Record<string, number>>> = {};
    for (const day of days) {
      h[day.date] = {};
      for (const row of day.rows) {
        h[day.date][row.job.id] = {};
        for (const [empId, cell] of Object.entries(row.cells)) h[day.date][row.job.id][empId] = cell.scheduled;
      }
    }
    return h;
  });
  const [dayJobs, setDayJobs] = useState<Record<string, string[]>>(() => {
    const dj: Record<string, string[]> = {};
    for (const day of days) dj[day.date] = day.rows.map((r) => r.job.id);
    return dj;
  });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const colTotal = useCallback(
    (empId: string) => {
      let t = 0;
      for (const date of Object.keys(hours)) for (const jid of Object.keys(hours[date])) t += hours[date][jid][empId] ?? 0;
      return t;
    },
    [hours]
  );
  const grand = employees.reduce((s, e) => s + colTotal(e.id), 0);

  const saveCell = useCallback(
    async (date: string, jobId: string, empId: string, val: number) => {
      setHours((prev) => {
        const next = { ...prev };
        next[date] = { ...(next[date] ?? {}) };
        next[date][jobId] = { ...(next[date][jobId] ?? {}) };
        next[date][jobId][empId] = val;
        return next;
      });
      try {
        await fetch("/api/commercial/field-ops/assignment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_id: jobId, employee_id: empId, work_date: date, hours: val }),
        });
      } catch {
        setFlash("Save failed - check your connection.");
      }
    },
    []
  );

  const addJobToDay = (date: string, jobId: string) => {
    if (!jobId) return;
    setDayJobs((prev) => {
      const cur = prev[date] ?? [];
      if (cur.includes(jobId)) return prev;
      return { ...prev, [date]: [...cur, jobId] };
    });
  };

  const copyWeekForward = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/commercial/field-ops/copy-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_start: weekStart }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; copied?: number };
      if (json.ok) {
        setFlash(`Copied ${json.copied ?? 0} assignment${json.copied === 1 ? "" : "s"} to next week.`);
        router.push(`/commercial/field-ops/schedule?week=${addDaysClient(weekStart, 7)}`);
      } else setFlash("Copy failed.");
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async () => {
    const lines: string[] = [`Schedule - week of ${prettyDate(weekStart)}`, ""];
    for (const date of Object.keys(hours)) {
      const rows = (dayJobs[date] ?? []).filter((jid) => employees.some((e) => (hours[date]?.[jid]?.[e.id] ?? 0) > 0));
      if (rows.length === 0) continue;
      lines.push(`${days.find((d) => d.date === date)?.label ?? ""} ${prettyDate(date)}`);
      for (const jid of rows) {
        const meta = jobsById.get(jid);
        const who = employees.filter((e) => (hours[date]?.[jid]?.[e.id] ?? 0) > 0).map((e) => `${e.display_name} ${hours[date][jid][e.id]}h`).join(", ");
        lines.push(`  ${meta?.name ?? jid}: ${who}`);
      }
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setFlash("Schedule copied to clipboard.");
    } catch {
      setFlash("Couldn't access the clipboard.");
    }
  };

  const gridCols = `minmax(180px,1fr) repeat(${employees.length}, 64px) 64px`;

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex items-center rounded-lg border border-ppp-charcoal-200 overflow-hidden">
          <button onClick={() => router.push(`/commercial/field-ops/schedule?week=${addDaysClient(weekStart, -7)}`)} className="px-3 py-2 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]" aria-label="Previous week">&larr;</button>
          <button onClick={() => router.push(`/commercial/field-ops/schedule`)} className="px-3 py-2 text-[12.5px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 border-x border-ppp-charcoal-200 min-h-[40px]">This week</button>
          <button onClick={() => router.push(`/commercial/field-ops/schedule?week=${addDaysClient(weekStart, 7)}`)} className="px-3 py-2 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]" aria-label="Next week">&rarr;</button>
        </div>
        <span className="text-[13px] font-bold text-ppp-charcoal">Week of {prettyDate(weekStart)} &ndash; {prettyDate(addDaysClient(weekStart, 5))}</span>
        <div className="flex-1" />
        <button onClick={copyToClipboard} className="px-3 py-2 rounded-lg border border-ppp-charcoal-200 text-[12.5px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[40px]">Copy to clipboard</button>
        <button onClick={copyWeekForward} disabled={busy} className="px-3 py-2 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700 disabled:opacity-50 min-h-[40px]">{busy ? "Copying…" : "Copy week forward"}</button>
      </div>

      {flash && <div className="mb-3 rounded-lg bg-ppp-navy-50 border border-ppp-navy-100 px-3 py-2 text-[12.5px] text-ppp-navy-700">{flash}</div>}

      {employees.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No crew yet</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Add crew first — they become the columns here. <a href="/commercial/field-ops/employees" className="font-semibold text-cc-brand-700 underline">Add crew</a></p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-ppp-charcoal-100 rounded-xl bg-surface">
          <div className="min-w-max">
            {/* Header */}
            <div className="grid sticky top-0 z-10 bg-ppp-charcoal-50 border-b border-ppp-charcoal-100" style={{ gridTemplateColumns: gridCols }}>
              <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Work order</div>
              {employees.map((e) => (
                <div key={e.id} className="px-1 py-2 text-[10.5px] font-bold text-ppp-charcoal-600 text-center truncate" title={e.display_name}>{e.display_name}</div>
              ))}
              <div className="px-1 py-2 text-[10.5px] font-bold text-ppp-charcoal-500 text-center">Tot</div>
            </div>

            {/* Days */}
            {days.map((day) => {
              const rows = dayJobs[day.date] ?? [];
              const isToday = day.date === todayIso;
              return (
                <div key={day.date}>
                  <div className={`grid border-b border-ppp-charcoal-100 ${isToday ? "bg-cc-brand-50" : "bg-ppp-charcoal-50/50"}`} style={{ gridTemplateColumns: gridCols }}>
                    <div className="px-3 py-1.5 text-[11.5px] font-bold text-ppp-charcoal">
                      {day.label} <span className="text-ppp-charcoal-400 font-normal">{prettyDate(day.date)}</span>
                      {isToday && <span className="ml-1.5 text-[9px] font-bold uppercase text-cc-brand-700">today</span>}
                    </div>
                    <div style={{ gridColumn: `span ${employees.length + 1}` }} className="px-2 py-1 flex items-center justify-end">
                      <select value="" onChange={(ev) => { addJobToDay(day.date, ev.target.value); ev.target.value = ""; }} className="text-[11px] text-cc-brand-700 bg-transparent font-semibold cursor-pointer outline-none">
                        <option value="">+ Add work order</option>
                        {jobs.filter((j) => !rows.includes(j.id)).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                      </select>
                    </div>
                  </div>
                  {rows.length === 0 ? (
                    <div className="px-3 py-2 text-[11.5px] text-ppp-charcoal-400 border-b border-ppp-charcoal-50">Nothing scheduled - use &ldquo;+ Add work order.&rdquo;</div>
                  ) : (
                    rows.map((jid) => {
                      const meta = jobsById.get(jid);
                      return (
                        <div key={`${day.date}-${jid}`} className="grid border-b border-ppp-charcoal-50 hover:bg-ppp-charcoal-50/40" style={{ gridTemplateColumns: gridCols }}>
                          <div className="px-3 py-1.5 text-[12px] font-medium text-ppp-charcoal truncate flex items-center gap-1">
                            {meta?.name ?? "(job)"}{meta?.prevailing_wage && <span className="text-[9px] font-bold text-amber-700">PW</span>}
                          </div>
                          {employees.map((e) => {
                            const v = hours[day.date]?.[jid]?.[e.id] ?? 0;
                            return (
                              <div key={e.id} className="border-l border-ppp-charcoal-50">
                                <input
                                  type="number"
                                  min={0}
                                  max={24}
                                  step={1}
                                  defaultValue={v > 0 ? v : ""}
                                  onBlur={(ev) => {
                                    const nv = ev.target.value === "" ? 0 : Number(ev.target.value);
                                    if (Number.isFinite(nv) && nv !== v) saveCell(day.date, jid, e.id, Math.max(0, Math.min(24, nv)));
                                  }}
                                  className="w-full h-9 text-center text-[12.5px] tabular-nums text-ppp-charcoal bg-transparent outline-none focus:bg-cc-brand-50 focus:ring-1 focus:ring-cc-brand-400 rounded"
                                  aria-label={`${meta?.name} - ${e.display_name} - ${day.date}`}
                                />
                              </div>
                            );
                          })}
                          <div className="border-l border-ppp-charcoal-100 flex items-center justify-center text-[11.5px] font-semibold text-ppp-charcoal-500 tabular-nums">
                            {employees.reduce((s, e) => s + (hours[day.date]?.[jid]?.[e.id] ?? 0), 0) || ""}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}

            {/* Column totals */}
            <div className="grid bg-ppp-charcoal-50 border-t-2 border-ppp-charcoal-200" style={{ gridTemplateColumns: gridCols }}>
              <div className="px-3 py-2 text-[11.5px] font-bold text-ppp-charcoal">Week total</div>
              {employees.map((e) => (
                <div key={e.id} className="py-2 text-center text-[12.5px] font-black text-ppp-charcoal tabular-nums">{colTotal(e.id) || "0"}</div>
              ))}
              <div className="py-2 text-center text-[12.5px] font-black text-cc-brand-700 tabular-nums">{grand || "0"}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
