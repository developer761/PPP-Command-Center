"use client";

/**
 * R10.3 Painter clock - the mobile magic-link screen. One-tap Clock In / Clock
 * Out, big thumb targets, no login (the URL token is the auth). Built for
 * low-tech-comfort crew: minimal text, one obvious action.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EmployeeDay } from "@/lib/commercial/field-ops/clock";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

export function PainterClock({
  token,
  firstName,
  day,
  dateLabel,
}: {
  token: string;
  firstName: string;
  day: EmployeeDay;
  dateLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (payload: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/f/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...payload }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (json.ok) router.refresh();
      else setError(json.detail ?? "Something went wrong - try again.");
    } catch {
      setError("No connection - try again.");
    } finally {
      setBusy(false);
    }
  };

  const open = day.openPunch;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ppp-charcoal">Hi {firstName}</h1>
        <p className="text-[13px] text-ppp-charcoal-500">{dateLabel}</p>
      </div>

      {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700" role="alert">{error}</div>}

      {open ? (
        <div className="rounded-2xl bg-ppp-green-50 border border-ppp-green-100 p-5 text-center">
          <div className="text-[13px] font-semibold text-ppp-green-700">You&rsquo;re clocked in</div>
          <div className="text-lg font-bold text-ppp-charcoal mt-0.5">{open.job_name}</div>
          <div className="text-[12.5px] text-ppp-charcoal-500">since {fmtTime(open.clock_in_at)}</div>
          <button
            onClick={() => post({ action: "out" })}
            disabled={busy}
            className="mt-4 w-full inline-flex items-center justify-center rounded-xl bg-rose-600 text-white text-[16px] font-bold min-h-[60px] hover:bg-rose-700 disabled:opacity-60"
          >
            {busy ? "..." : "Clock Out"}
          </button>
        </div>
      ) : day.assignments.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-ppp-charcoal-100 p-6 text-center">
          <p className="text-[14px] font-semibold text-ppp-charcoal">Nothing scheduled for you today.</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Check with the office if that&rsquo;s not right.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-ppp-charcoal-400">Today&rsquo;s jobs</p>
          {day.assignments.map((a) => {
            const clocked = day.hoursByJob[a.job_id] ?? 0;
            return (
              <div key={a.assignment_id} className="rounded-2xl bg-surface border border-ppp-charcoal-100 p-4">
                <div className="text-[16px] font-bold text-ppp-charcoal">{a.job_name}{a.prevailing_wage && <span className="ml-1.5 text-[10px] font-bold text-amber-700">PW</span>}</div>
                {a.site && <div className="text-[12.5px] text-ppp-charcoal-500 mt-0.5">{a.site}</div>}
                <div className="text-[12px] text-ppp-charcoal-400 mt-0.5">
                  {a.scheduled_start_time ? `Start ${a.scheduled_start_time.slice(0, 5)} · ` : ""}{a.scheduled_hours}h scheduled{clocked > 0 ? ` · ${clocked.toFixed(2)}h clocked today` : ""}
                </div>
                <button
                  onClick={() => post({ action: "in", job_id: a.job_id, assignment_id: a.assignment_id })}
                  disabled={busy}
                  className="mt-3 w-full inline-flex items-center justify-center rounded-xl bg-cc-brand-600 text-white text-[16px] font-bold min-h-[56px] hover:bg-cc-brand-700 disabled:opacity-60"
                >
                  {busy ? "..." : "Clock In"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-ppp-charcoal-400 text-center pt-2">Precision Painting Plus / Tomco Painting</p>
    </div>
  );
}
