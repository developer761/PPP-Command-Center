"use client";

/**
 * R10.7 Interactive Field Ops Calendar — the one scheduling surface, fully
 * client-driven so it's snappy (no server round-trip per click). Day cells show
 * the PEOPLE scheduled + their times. Click a day to open the day panel (roster +
 * add form); click a name to open a right popup with that person's shift + LIVE
 * clock status. Add/remove go through /api/commercial/field-ops/assignment and
 * soft-refresh the grid. On-brand (blue/green/navy), mobile bottom-sheet.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import type { MonthDay, DayCrew } from "@/lib/commercial/field-ops/schedule";

type EmployeeOpt = { id: string; display_name: string; email: string | null };
type JobOpt = { id: string; name: string; job_code: string; customer_name: string | null; site_city: string | null };
type Opt = { value: string; label: string; hint?: string };
type Msg = { tone: "ok" | "err"; text: string } | null;

type PersonDetail = {
  employee_name: string | null;
  shifts: {
    assignment_id: string;
    job_name: string;
    job_code: string;
    prevailing_wage: boolean;
    site: string | null;
    start_time: string | null;
    end_time: string | null;
    scheduled_hours: number;
    note: string | null;
  }[];
  clock: { open: boolean; since: string | null; total_hours: number };
};

/* ── pure helpers ─────────────────────────────────────────────────────────── */
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
function dayHeading(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}
function fmtTime12(t: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  if (!m) return null;
  let h = Number(m[1]);
  const mm = m[2];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}
function fmtTimeShort(t: string | null): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  if (!m) return "";
  let h = Number(m[1]);
  const mm = m[2];
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return mm === "00" ? `${h}${ap}` : `${h}:${mm}${ap}`;
}
function fmtElapsed(sinceIso: string, nowMs: number): string {
  const ms = (nowMs || Date.now()) - Date.parse(sinceIso);
  if (ms < 0) return "0m";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHIP_CAP = 3;

/* ── main ─────────────────────────────────────────────────────────────────── */
export function FieldOpsCalendar({
  monthStart,
  grid,
  todayIso,
  employees,
  jobs,
}: {
  monthStart: string;
  grid: MonthDay[];
  todayIso: string;
  employees: EmployeeOpt[];
  jobs: JobOpt[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [addDay, setAddDay] = useState<string | null>(null);
  const [person, setPerson] = useState<{ employeeId: string; name: string; date: string } | null>(null);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [formKey, setFormKey] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  // A11y focus management for the day/person slide-out (R7-a11y #6): move focus
  // into the panel on open, restore it to the triggering element on close.
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!addDay) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      restoreFocusRef.current?.focus?.();
    };
  }, [addDay]);

  const prevMonth = addDays(monthStart, -1).slice(0, 7) + "-01";
  const [my, mm] = monthStart.split("-").map(Number);
  const nextMonth = `${new Date(Date.UTC(my, mm, 1)).toISOString().slice(0, 7)}-01`;
  function goMonth(month: string) {
    setAddDay(null);
    setPerson(null);
    setMsg(null);
    router.push(`/commercial/field-ops/calendar?month=${month}`, { scroll: false });
  }
  const dayCrew = (date: string): DayCrew[] => grid.find((d) => d.date === date)?.crew ?? [];

  useEffect(() => {
    if (!person) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [person]);

  // Escape closes the popup (person → back to day; day → close).
  useEffect(() => {
    if (!addDay && !person) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (person) setPerson(null);
      else {
        setAddDay(null);
        setMsg(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addDay, person]);

  useEffect(() => {
    if (!person) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(false);
    fetch(`/api/commercial/field-ops/person-day?employee_id=${person.employeeId}&date=${person.date}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch"))))
      .then((d) => {
        if (cancelled) return;
        if (d && d.ok) setDetail(d as PersonDetail);
        else setDetailError(true);
      })
      .catch(() => !cancelled && setDetailError(true))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [person]);

  function openDay(date: string) {
    setMsg(null);
    setPerson(null);
    setAddDay(date);
  }
  function openPerson(employeeId: string, name: string, date: string) {
    setAddDay(date);
    setPerson({ employeeId, name, date });
  }
  function closeAll() {
    setPerson(null);
    setAddDay(null);
    setMsg(null);
  }
  const refresh = () => startTransition(() => router.refresh());

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!addDay) return;
    const fd = new FormData(e.currentTarget);
    const body = {
      op: "upsert",
      job_id: String(fd.get("job_id") ?? ""),
      employee_id: String(fd.get("employee_id") ?? ""),
      work_date: addDay,
      start_time: String(fd.get("start_time") ?? ""),
      end_time: String(fd.get("end_time") ?? ""),
      note: String(fd.get("note") ?? ""),
    };
    if (!body.employee_id || !body.job_id) {
      setMsg({ tone: "err", text: "Pick a crew member and a work order." });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch("/api/commercial/field-ops/assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ tone: "err", text: d.detail || "Couldn't schedule — try again." });
      else {
        // Only claim "emailed" when the person actually has an email on file.
        const hasEmail = !!employees.find((emp) => emp.id === body.employee_id)?.email;
        setMsg({ tone: "ok", text: hasEmail ? "Scheduled — crew member emailed." : "Scheduled. No email on file, so they weren't notified — add one on the Crew page." });
        setFormKey((k) => k + 1);
        refresh();
      }
    } catch {
      setMsg({ tone: "err", text: "Network error — try again." });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(assignmentId: string) {
    setSaving(true);
    try {
      const r = await fetch("/api/commercial/field-ops/assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "delete", assignment_id: assignmentId }),
      });
      if (r.ok) {
        setPerson(null);
        setMsg({ tone: "ok", text: "Removed." });
        refresh();
      } else {
        const d = await r.json().catch(() => ({}));
        setMsg({ tone: "err", text: d.detail || "Couldn't remove — try again." });
      }
    } catch {
      setMsg({ tone: "err", text: "Network error — try again." });
    } finally {
      setSaving(false);
    }
  }

  const crewOptions: Opt[] = employees.map((e) => ({ value: e.id, label: e.display_name, hint: e.email ? undefined : "no email — won't be notified" }));
  const jobOptions: Opt[] = jobs.map((j) => ({ value: j.id, label: j.name, hint: [j.job_code, j.customer_name, j.site_city].filter(Boolean).join(" · ") }));
  const maxHead = Math.max(1, ...grid.map((d) => d.headcount));

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="inline-flex items-center rounded-lg border border-ppp-charcoal-200 overflow-hidden">
          <button onClick={() => goMonth(prevMonth)} className="px-3 py-2 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]" aria-label="Previous month">&larr;</button>
          <button onClick={() => { closeAll(); router.push("/commercial/field-ops/calendar", { scroll: false }); }} className="px-3 py-2 text-[12.5px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 border-x border-ppp-charcoal-200 min-h-[40px]">Today</button>
          <button onClick={() => goMonth(nextMonth)} className="px-3 py-2 text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[40px]" aria-label="Next month">&rarr;</button>
        </div>
        <h2 className="text-[15px] font-bold text-ppp-charcoal">{monthLabel(monthStart)}</h2>
        {pending && <span className="text-[11px] text-ppp-charcoal-400">updating…</span>}
        <span className="text-[11.5px] text-ppp-charcoal-400 ml-auto hidden sm:inline">Click a day to schedule · a name for details</span>
      </div>

      <div className="hidden sm:grid grid-cols-7 gap-1 mb-1">
        {DOW.map((d) => <div key={d} className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 text-center py-1">{d}</div>)}
      </div>

      {/* Month grid (desktop) */}
      <div className="hidden sm:grid grid-cols-7 gap-1">
        {grid.map((day) => {
          const isToday = day.date === todayIso;
          const isOpen = day.date === addDay;
          const heat = day.headcount > 0 ? Math.min(0.14, 0.03 + (day.headcount / maxHead) * 0.11) : 0;
          return (
            <div
              key={day.date}
              role="button"
              tabIndex={0}
              aria-label={`Schedule crew on ${dayHeading(day.date)}${day.headcount > 0 ? ` — ${day.headcount} scheduled` : ""}`}
              onClick={() => openDay(day.date)}
              onKeyDown={(e) => {
                // Only the cell itself, not a bubbled key from an inner crew button.
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  openDay(day.date);
                }
              }}
              className={`group cursor-pointer min-h-[110px] rounded-lg border p-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cc-brand-500 ${day.inMonth ? "bg-surface border-ppp-charcoal-100 hover:border-cc-brand-300" : "bg-ppp-charcoal-50/40 border-transparent"} ${isToday ? "ring-2 ring-cc-brand-400" : ""} ${isOpen ? "ring-2 ring-ppp-navy-500" : ""}`}
              style={day.headcount > 0 ? { backgroundColor: `rgba(43,170,225,${heat})` } : undefined}
            >
              <div className="flex items-center justify-between">
                <span className={`text-[12px] font-bold ${day.inMonth ? "text-ppp-charcoal" : "text-ppp-charcoal-400"}`}>{dayNum(day.date)}</span>
                {day.headcount > 0
                  ? <span className="text-[9.5px] font-bold text-cc-brand-700 bg-cc-brand-50 rounded-full px-1.5 py-0.5">{day.headcount}</span>
                  : day.inMonth && <span className="text-[13px] leading-none font-bold text-ppp-charcoal-300 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>+</span>}
              </div>
              <div className="mt-1 space-y-0.5">
                {day.crew.slice(0, CHIP_CAP).map((c, i) => (
                  <button
                    key={`${c.employee_id}-${c.job_id}-${i}`}
                    onClick={(e) => { e.stopPropagation(); openPerson(c.employee_id, c.name, day.date); }}
                    className="w-full text-left text-[10px] font-medium rounded px-1 py-0.5 truncate bg-cc-brand-50 text-cc-brand-800 hover:bg-cc-brand-100"
                  >
                    {c.name}{c.start ? ` · ${fmtTimeShort(c.start)}` : ""}{c.prevailing_wage ? " · PW" : ""}
                  </button>
                ))}
                {day.crew.length > CHIP_CAP && <div className="text-[9.5px] text-ppp-charcoal-400 px-1">+{day.crew.length - CHIP_CAP} more</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile agenda */}
      <div className="sm:hidden space-y-2">
        {grid.filter((d) => d.inMonth).map((day) => (
          <button key={day.date} onClick={() => openDay(day.date)} className={`w-full text-left bg-surface border rounded-lg p-3 ${day.date === addDay ? "border-ppp-navy-500" : "border-ppp-charcoal-100"}`}>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-bold text-ppp-charcoal">{new Date(day.date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}{day.date === todayIso && <span className="ml-1.5 text-[9px] font-bold uppercase text-cc-brand-700">today</span>}</span>
              {day.headcount > 0
                ? <span className="text-[10.5px] font-bold text-cc-brand-700 bg-cc-brand-50 rounded-full px-2 py-0.5">{day.headcount} on · {day.hours}h</span>
                : <span className="text-[11px] font-semibold text-cc-brand-700">+ schedule</span>}
            </div>
            {day.crew.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {day.crew.map((c, i) => <span key={`${c.employee_id}-${i}`} className="text-[10.5px] font-medium rounded px-1.5 py-0.5 bg-cc-brand-50 text-cc-brand-800">{c.name}{c.start ? ` ${fmtTimeShort(c.start)}` : ""}</span>)}
              </div>
            )}
          </button>
        ))}
      </div>

      {(addDay || person) && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-ppp-charcoal-900/30" onClick={closeAll} aria-hidden />
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={person ? "Crew member shift details" : "Schedule crew for the day"}
            onKeyDown={(e) => {
              // Trap Tab within the panel (a11y #5). Escape is handled globally.
              if (e.key !== "Tab") return;
              const foc = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
              ).filter((el) => el.offsetParent !== null);
              if (foc.length === 0) return;
              const first = foc[0];
              const last = foc[foc.length - 1];
              if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }}
            className="absolute inset-x-0 bottom-0 sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[440px] bg-surface border-t sm:border-t-0 sm:border-l border-ppp-charcoal-100 rounded-t-2xl sm:rounded-none shadow-xl flex flex-col max-h-[88vh] sm:max-h-none focus:outline-none"
          >
            {person ? (
              <PersonPanel person={person} detail={detail} loading={detailLoading} error={detailError} msg={msg} nowMs={nowMs} saving={saving} onBack={() => setPerson(null)} onClose={closeAll} onRemove={handleRemove} />
            ) : addDay ? (
              <DayPanel date={addDay} crew={dayCrew(addDay)} crewOptions={crewOptions} jobOptions={jobOptions} formKey={formKey} saving={saving} msg={msg} onClose={closeAll} onAdd={handleAdd} onOpenPerson={(id, name) => openPerson(id, name, addDay)} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── panels (module-level so they never remount mid-entry) ────────────────── */
function DayPanel({
  date, crew, crewOptions, jobOptions, formKey, saving, msg, onClose, onAdd, onOpenPerson,
}: {
  date: string;
  crew: DayCrew[];
  crewOptions: Opt[];
  jobOptions: Opt[];
  formKey: number;
  saving: boolean;
  msg: Msg;
  onClose: () => void;
  onAdd: (e: React.FormEvent<HTMLFormElement>) => void;
  onOpenPerson: (id: string, name: string) => void;
}) {
  const totalHours = crew.reduce((s, c) => s + c.hours, 0);
  return (
    <>
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-start justify-between gap-3 shrink-0">
        <div>
          <div className="text-[15px] font-bold text-ppp-charcoal">{dayHeading(date)}</div>
          <div className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">{crew.length === 0 ? "Nobody scheduled yet" : `${crew.length} on · ${totalHours}h scheduled`}</div>
        </div>
        <button onClick={onClose} className="text-ppp-charcoal-400 hover:text-ppp-charcoal text-xl leading-none px-1 min-h-[44px] inline-flex items-center" aria-label="Close">&times;</button>
      </div>

      <div className="overflow-y-auto p-4 space-y-4">
        {msg && <div role={msg.tone === "err" ? "alert" : "status"} aria-live={msg.tone === "err" ? "assertive" : "polite"} className={`rounded-lg px-3 py-2 text-[12.5px] ${msg.tone === "err" ? "bg-rose-50 border border-rose-200 text-rose-700" : "bg-ppp-green-50 border border-ppp-green-100 text-ppp-green-700"}`}>{msg.text}</div>}

        {crew.length > 0 && (
          <ul className="space-y-2">
            {crew.map((c, i) => (
              <li key={`${c.employee_id}-${c.job_id}-${i}`}>
                <button onClick={() => onOpenPerson(c.employee_id, c.name)} className="w-full text-left border border-ppp-charcoal-100 rounded-lg p-3 hover:border-cc-brand-300 hover:bg-cc-brand-50/30 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-ppp-charcoal truncate">{c.name}</span>
                    <span className="text-[11px] text-ppp-charcoal-500 shrink-0">{c.start ? `${fmtTime12(c.start)}${c.end ? ` – ${fmtTime12(c.end)}` : ""}` : `${c.hours}h`}</span>
                  </div>
                  <div className="text-[11.5px] text-ppp-charcoal-600 truncate mt-0.5">{c.job_name}{c.prevailing_wage && <span className="ml-1 text-[9px] font-bold bg-ppp-charcoal-100 text-ppp-navy rounded px-1">PW</span>}</div>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form key={formKey} onSubmit={onAdd} className="space-y-3 border-t border-ppp-charcoal-50 pt-4">
          <h3 className="text-[12px] font-bold uppercase tracking-wide text-ppp-charcoal-500">Add to this day</h3>
          {crewOptions.length === 0 ? (
            <p className="text-[12px] text-ppp-charcoal-500">No crew yet — <Link href="/commercial/field-ops/employees" className="font-semibold text-cc-brand-700 underline">add a crew member</Link> first.</p>
          ) : jobOptions.length === 0 ? (
            <p className="text-[12px] text-ppp-charcoal-500">No work orders yet — <Link href="/commercial/field-ops/jobs" className="font-semibold text-cc-brand-700 underline">add a work order</Link> first.</p>
          ) : (
            <>
              <label className="block"><span className={LABEL_CLS}>Crew member</span>
                <SearchableSelect name="employee_id" options={crewOptions} placeholder="Search crew…" ariaLabel="Crew member" />
              </label>
              <label className="block"><span className={LABEL_CLS}>Work order</span>
                <SearchableSelect name="job_id" options={jobOptions} placeholder="Search work orders…" ariaLabel="Work order" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block"><span className={LABEL_CLS}>Start time</span><input type="time" name="start_time" step={300} className={INPUT_CLS} /></label>
                <label className="block"><span className={LABEL_CLS}>End time</span><input type="time" name="end_time" step={300} className={INPUT_CLS} /></label>
              </div>
              <p className="text-[11px] text-ppp-charcoal-400 -mt-1">Hours come from start &amp; end. Leave both blank for a full 8h day.</p>
              <label className="block"><span className={LABEL_CLS}>Note for the crew (goes in their email)</span>
                <textarea name="note" rows={2} placeholder="Gate code 1234, park in rear lot…" className={INPUT_CLS} /></label>
              <button type="submit" disabled={saving} className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 disabled:opacity-60 min-h-[44px]">{saving ? "Scheduling…" : "Schedule & email"}</button>
            </>
          )}
        </form>
      </div>
    </>
  );
}

function PersonPanel({
  person, detail, loading, error, msg, nowMs, saving, onBack, onClose, onRemove,
}: {
  person: { employeeId: string; name: string; date: string };
  detail: PersonDetail | null;
  loading: boolean;
  error: boolean;
  msg: Msg;
  nowMs: number;
  saving: boolean;
  onBack: () => void;
  onClose: () => void;
  onRemove: (assignmentId: string) => void;
}) {
  const clock = detail?.clock;
  return (
    <>
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-start justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <button onClick={onBack} className="text-[11px] font-semibold text-cc-brand-700 hover:underline mb-0.5">&larr; {dayHeading(person.date)}</button>
          <div className="text-[15px] font-bold text-ppp-charcoal truncate">{person.name}</div>
        </div>
        <button onClick={onClose} className="text-ppp-charcoal-400 hover:text-ppp-charcoal text-xl leading-none px-1 min-h-[44px] inline-flex items-center" aria-label="Close">&times;</button>
      </div>

      <div className="overflow-y-auto p-4 space-y-4">
        {msg && msg.tone === "err" && <div role="alert" className="rounded-lg px-3 py-2 text-[12.5px] bg-rose-50 border border-rose-200 text-rose-700">{msg.text}</div>}
        {clock && (
          <div className={`rounded-lg px-3 py-2.5 text-[12.5px] flex items-center gap-2 ${clock.open ? "bg-ppp-green-50 border border-ppp-green-100 text-ppp-green-800" : "bg-ppp-charcoal-50 border border-ppp-charcoal-100 text-ppp-charcoal-600"}`}>
            <span aria-hidden className={`h-2 w-2 rounded-full shrink-0 ${clock.open ? "bg-ppp-green-500" : "bg-ppp-charcoal-300"}`} />
            {clock.open && clock.since
              ? <span><strong>Clocked in</strong> · {fmtElapsed(clock.since, nowMs)} so far{clock.total_hours > 0 ? ` (${clock.total_hours}h logged today)` : ""}</span>
              : clock.total_hours > 0
              ? <span><strong>Clocked out</strong> · {clock.total_hours}h logged today</span>
              : <span>Not clocked in yet</span>}
          </div>
        )}

        {error ? (
          <p className="text-[12.5px] text-rose-600">Couldn&rsquo;t load this shift — check your connection and reopen.</p>
        ) : loading && !detail ? (
          <p className="text-[12.5px] text-ppp-charcoal-400">Loading…</p>
        ) : detail && detail.shifts.length > 0 ? (
          <ul className="space-y-3">
            {detail.shifts.map((s) => (
              <li key={s.assignment_id} className="border border-ppp-charcoal-100 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{s.job_name}{s.prevailing_wage && <span className="ml-1 align-middle inline-flex items-center rounded px-1 text-[9px] font-bold bg-ppp-charcoal-100 text-ppp-navy">PW</span>}</div>
                    <div className="text-[11px] font-mono text-ppp-charcoal-500 truncate">{s.job_code}</div>
                  </div>
                  <button onClick={() => { if (window.confirm("Remove this shift? They'll be unscheduled and their clock-in reminder cancelled.")) onRemove(s.assignment_id); }} disabled={saving} className="inline-flex items-center text-[11px] font-semibold text-rose-600 hover:bg-rose-50 rounded-lg disabled:opacity-50 shrink-0 min-h-[44px] px-2 touch-manipulation">Remove</button>
                </div>
                <div className="text-[12px] text-ppp-charcoal-600 mt-1.5">{s.start_time ? `${fmtTime12(s.start_time)}${s.end_time ? ` – ${fmtTime12(s.end_time)}` : ""} · ` : ""}{s.scheduled_hours}h</div>
                {s.site && <div className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">{s.site}</div>}
                {s.note && <div className="text-[11.5px] text-ppp-charcoal-500 mt-1 italic">“{s.note}”</div>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-ppp-charcoal-500">No shift on this day.</p>
        )}
      </div>
    </>
  );
}
