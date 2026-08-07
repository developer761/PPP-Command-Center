"use client";

/**
 * R10.3 Clock Station - the shop-tablet backup for when a painter's magic link
 * fails. Runs on a logged-in staff device; the painter proves who they are with
 * a 4-digit PIN, picks their job, and clocks in/out. Auto-returns to the picker
 * after each action so the next person can use it.
 */

import { useState } from "react";
import type { EmployeeDay } from "@/lib/commercial/field-ops/clock";

type Emp = { id: string; display_name: string; has_pin: boolean };

export function ClockStation({ employees }: { employees: Emp[] }) {
  const [sel, setSel] = useState<Emp | null>(null);
  const [pin, setPin] = useState("");
  const [day, setDay] = useState<EmployeeDay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = () => {
    setSel(null);
    setPin("");
    setDay(null);
    setError(null);
  };

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/commercial/field-ops/kiosk-clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: sel?.id, pin, ...payload }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; day?: EmployeeDay; detail?: string };
      if (!res.ok || !json.ok) {
        setError(json.detail ?? "Something went wrong.");
        return null;
      }
      return json;
    } catch {
      setError("No connection.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const enterPin = async () => {
    const r = await post({ action: "day" });
    if (r?.day) setDay(r.day);
  };
  const clockIn = async (job_id: string, assignment_id: string) => {
    const r = await post({ action: "in", job_id, assignment_id });
    if (r?.ok) { setDone(`${sel?.display_name} clocked in`); setTimeout(() => { setDone(null); reset(); }, 1800); }
  };
  const clockOut = async () => {
    const r = await post({ action: "out" });
    if (r?.ok) { setDone(`${sel?.display_name} clocked out`); setTimeout(() => { setDone(null); reset(); }, 1800); }
  };

  if (done) {
    return (
      <div role="status" aria-live="polite" className="max-w-sm mx-auto text-center py-16">
        <div className="mx-auto mb-4 inline-flex items-center justify-center h-16 w-16 rounded-full bg-ppp-green-50 text-ppp-green-700">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
        </div>
        <p className="text-lg font-bold text-ppp-charcoal">{done}</p>
      </div>
    );
  }

  // Step 1 — pick your name
  if (!sel) {
    return (
      <div className="max-w-lg mx-auto">
        <p className="text-[13px] text-ppp-charcoal-500 mb-3 text-center">Tap your name to clock in or out.</p>
        {employees.filter((e) => e.has_pin).length === 0 ? (
          <div className="text-center text-[13px] text-ppp-charcoal-500 bg-surface border border-ppp-charcoal-100 rounded-xl py-8">No crew have a PIN yet. Set one on the Crew page.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {employees.filter((e) => e.has_pin).map((e) => (
              <button key={e.id} onClick={() => setSel(e)} className="min-h-[64px] rounded-xl bg-surface border border-ppp-charcoal-200 text-[15px] font-bold text-ppp-charcoal hover:border-cc-brand-400 hover:bg-cc-brand-50">{e.display_name}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Step 2 — PIN
  if (!day) {
    return (
      <div className="max-w-xs mx-auto text-center">
        <button onClick={reset} className="inline-flex items-center min-h-[44px] px-2 -ml-2 text-[12px] font-semibold text-ppp-charcoal-500 mb-3 touch-manipulation">&larr; Back</button>
        <p className="text-[15px] font-bold text-ppp-charcoal mb-3">{sel.display_name} — enter your PIN</p>
        <input
          type="password"
          aria-label="Enter your 4-digit PIN"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          autoFocus
          className="w-40 mx-auto text-center text-3xl tracking-[0.5em] font-bold rounded-xl border-2 border-ppp-charcoal-200 py-3 outline-none focus:border-cc-brand-500"
        />
        {error && <div role="alert" className="text-[13px] text-rose-600 mt-2">{error}</div>}
        <button onClick={enterPin} disabled={busy || pin.length !== 4} className="mt-4 w-full inline-flex items-center justify-center rounded-xl bg-cc-brand-600 text-white text-[16px] font-bold min-h-[56px] hover:bg-cc-brand-700 disabled:opacity-50">{busy ? "…" : "Enter"}</button>
      </div>
    );
  }

  // Step 3 — clock
  const open = day.openPunch;
  return (
    <div className="max-w-sm mx-auto">
      <button onClick={reset} className="inline-flex items-center min-h-[44px] px-2 -ml-2 text-[12px] font-semibold text-ppp-charcoal-500 mb-3 touch-manipulation">&larr; Not you? Go back</button>
      {error && <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700 mb-3">{error}</div>}
      {open ? (
        <div className="rounded-2xl bg-ppp-green-50 border border-ppp-green-100 p-5 text-center">
          <div className="text-[13px] font-semibold text-ppp-green-700">Clocked in on</div>
          <div className="text-lg font-bold text-ppp-charcoal">{open.job_name}</div>
          <button onClick={clockOut} disabled={busy} className="mt-4 w-full inline-flex items-center justify-center rounded-xl bg-rose-600 text-white text-[16px] font-bold min-h-[60px] hover:bg-rose-700 disabled:opacity-60">{busy ? "…" : "Clock Out"}</button>
        </div>
      ) : day.assignments.length === 0 ? (
        <div className="text-center bg-surface border border-ppp-charcoal-100 rounded-2xl p-6">
          <p className="text-[14px] font-semibold text-ppp-charcoal">Nothing scheduled today.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {day.assignments.map((a) => (
            <div key={a.assignment_id} className="rounded-2xl bg-surface border border-ppp-charcoal-100 p-4">
              <div className="text-[16px] font-bold text-ppp-charcoal">{a.job_name}{a.prevailing_wage && <span className="ml-1.5 text-[10px] font-bold bg-ppp-charcoal-100 text-ppp-navy rounded px-1">PW</span>}</div>
              {a.site && <div className="text-[12.5px] text-ppp-charcoal-500">{a.site}</div>}
              <button onClick={() => clockIn(a.job_id, a.assignment_id)} disabled={busy} className="mt-3 w-full inline-flex items-center justify-center rounded-xl bg-cc-brand-600 text-white text-[16px] font-bold min-h-[56px] hover:bg-cc-brand-700 disabled:opacity-60">{busy ? "…" : "Clock In"}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
