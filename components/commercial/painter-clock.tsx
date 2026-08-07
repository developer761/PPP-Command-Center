"use client";

/**
 * R10.3 Painter clock - the mobile magic-link screen. One-tap Clock In / Clock
 * Out, big thumb targets, no login (the URL token is the auth). Built for
 * low-tech-comfort crew: minimal text, one obvious action. Bilingual (en/es)
 * off the crew member's preferred_language. Clock-OUT is guarded by a confirm
 * so a stray pocket-tap can't stop someone's pay.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EmployeeDay } from "@/lib/commercial/field-ops/clock";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}
function fmtHm(h: number, es: boolean): string {
  const mins = Math.round(h * 60);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  if (hh === 0) return `${mm} min`;
  return mm === 0 ? `${hh} h` : `${hh} h ${mm} min`;
}

export function PainterClock({
  token,
  firstName,
  day,
  dateLabel,
  es = false,
}: {
  token: string;
  firstName: string;
  day: EmployeeDay;
  dateLabel: string;
  es?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);

  const L = es
    ? {
        hi: `Hola ${firstName}`,
        clockedIn: "Estás trabajando",
        since: "desde",
        clockOut: "Marcar salida",
        confirmOut: "¿Marcar salida?",
        confirmYes: "Sí, marcar salida",
        cancel: "Cancelar",
        none: "No tienes trabajo hoy.",
        noneHint: "Habla con la oficina si no es correcto.",
        todaysJobs: "Trabajos de hoy",
        start: "Empieza",
        scheduled: "programado",
        clockedToday: "trabajado hoy",
        clockIn: "Marcar entrada",
        netErr: "Sin conexión — intenta otra vez.",
        genErr: "Algo salió mal — intenta otra vez.",
        alreadyIn: "Ya marcaste tu entrada — primero marca la salida.",
        notIn: "No has marcado tu entrada.",
      }
    : {
        hi: `Hi ${firstName}`,
        clockedIn: "You're clocked in",
        since: "since",
        clockOut: "Clock Out",
        confirmOut: "Clock out?",
        confirmYes: "Yes, clock out",
        cancel: "Cancel",
        none: "Nothing scheduled for you today.",
        noneHint: "Check with the office if that's not right.",
        todaysJobs: "Today's jobs",
        start: "Start",
        scheduled: "scheduled",
        clockedToday: "clocked today",
        clockIn: "Clock In",
        netErr: "No connection - try again.",
        genErr: "Something went wrong - try again.",
        alreadyIn: "You're already clocked in - clock out first.",
        notIn: "You're not clocked in.",
      };

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
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string; detail?: string };
      if (json.ok) {
        setConfirmOut(false);
        router.refresh();
      } else {
        // Map the server's machine code to a LOCALIZED string. Never surface the
        // server's English free-text as the primary message on a bilingual screen.
        const byCode: Record<string, string> = { already_clocked_in: L.alreadyIn, not_clocked_in: L.notIn };
        setError((json.code && byCode[json.code]) || L.genErr);
      }
    } catch {
      setError(L.netErr);
    } finally {
      setBusy(false);
    }
  };

  const open = day.openPunch;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ppp-charcoal">{L.hi}</h1>
        <p className="text-[13px] text-ppp-charcoal-500">{dateLabel}</p>
      </div>

      {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700" role="alert">{error}</div>}

      {open ? (
        <div role="status" aria-live="polite" className="rounded-2xl bg-ppp-green-50 border border-ppp-green-100 p-5 text-center">
          <div className="text-[13px] font-semibold text-ppp-green-700">{L.clockedIn}</div>
          <div className="text-lg font-bold text-ppp-charcoal mt-0.5">{open.job_name}</div>
          <div className="text-[12.5px] text-ppp-charcoal-500">{L.since} {fmtTime(open.clock_in_at)}</div>
          {confirmOut ? (
            <div className="mt-4 space-y-2">
              <div className="text-[14px] font-bold text-ppp-charcoal">{L.confirmOut}</div>
              <button
                onClick={() => post({ action: "out" })}
                disabled={busy}
                className="w-full inline-flex items-center justify-center rounded-xl bg-rose-600 text-white text-[16px] font-bold min-h-[60px] hover:bg-rose-700 disabled:opacity-60"
              >
                {busy ? "..." : L.confirmYes}
              </button>
              <button
                onClick={() => setConfirmOut(false)}
                disabled={busy}
                className="w-full inline-flex items-center justify-center rounded-xl border border-ppp-charcoal-200 text-ppp-charcoal-600 text-[15px] font-semibold min-h-[52px] hover:bg-ppp-charcoal-50 disabled:opacity-60"
              >
                {L.cancel}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmOut(true)}
              disabled={busy}
              className="mt-4 w-full inline-flex items-center justify-center rounded-xl bg-rose-600 text-white text-[16px] font-bold min-h-[60px] hover:bg-rose-700 disabled:opacity-60"
            >
              {L.clockOut}
            </button>
          )}
        </div>
      ) : day.assignments.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-ppp-charcoal-100 p-6 text-center">
          <p className="text-[14px] font-semibold text-ppp-charcoal">{L.none}</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">{L.noneHint}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-ppp-charcoal-400">{L.todaysJobs}</p>
          {day.assignments.map((a) => {
            const clocked = day.hoursByJob[a.job_id] ?? 0;
            return (
              <div key={a.assignment_id} className="rounded-2xl bg-surface border border-ppp-charcoal-100 p-4">
                <div className="text-[16px] font-bold text-ppp-charcoal">{a.job_name}{a.prevailing_wage && <span className="ml-1.5 align-middle inline-flex items-center rounded px-1 py-0.5 text-[10px] font-bold bg-ppp-charcoal-100 text-ppp-navy">PW</span>}</div>
                {a.site && <div className="text-[12.5px] text-ppp-charcoal-500 mt-0.5">{a.site}</div>}
                <div className="text-[12px] text-ppp-charcoal-400 mt-0.5">
                  {a.scheduled_start_time ? `${L.start} ${a.scheduled_start_time.slice(0, 5)} · ` : ""}{fmtHm(a.scheduled_hours, es)} {L.scheduled}{clocked > 0 ? ` · ${fmtHm(clocked, es)} ${L.clockedToday}` : ""}
                </div>
                <button
                  onClick={() => post({ action: "in", job_id: a.job_id, assignment_id: a.assignment_id })}
                  disabled={busy}
                  className="mt-3 w-full inline-flex items-center justify-center rounded-xl bg-cc-brand-600 text-white text-[16px] font-bold min-h-[56px] hover:bg-cc-brand-700 disabled:opacity-60"
                >
                  {busy ? "..." : L.clockIn}
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
