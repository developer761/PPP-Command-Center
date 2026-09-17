"use client";

import { useState } from "react";

/**
 * A checkbox that ticks NOW and tells the server afterwards.
 *
 * Karan 2026-09-17: "just make it simple checkboxes that are quick — this
 * Deposited button takes so long to load."
 *
 * The old control was a form posting to a server action that called
 * `revalidatePath`, so every tick re-ran the whole Accounting page — the
 * receivables report, the cost breakdown, the project rollups and 112 ledger
 * rows — before the tick appeared. Reconciling a month is thirty of those in a
 * row, each one waiting on a page rebuild.
 *
 * So the state lives here. The box flips on click, a small POST confirms it in
 * the background, and nothing re-renders. If the write fails the box flips back
 * and says so — a tick that silently did not save is worse than a slow one,
 * because the next person reads it as reconciled.
 */
export function DepositCheckbox({
  paymentId,
  initial,
  label = "Cleared",
}: {
  paymentId: string;
  initial: boolean;
  label?: string;
}) {
  const [on, setOn] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function flip() {
    if (busy) return;
    const next = !on;
    setOn(next);
    setFailed(false);
    setBusy(true);
    try {
      const res = await fetch("/api/commercial/payments/deposited", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId, deposited: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setOn(!next);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none min-h-[44px] sm:min-h-[28px]">
      <input
        type="checkbox"
        checked={on}
        onChange={flip}
        aria-label={`${label} — mark this payment as cleared the bank`}
        className="h-4 w-4 rounded border-ppp-charcoal-300 text-cc-brand-600 focus:ring-cc-brand-600/40 cursor-pointer"
      />
      <span className={`text-[11.5px] ${failed ? "text-rose-700 font-semibold" : on ? "text-emerald-700 font-semibold" : "text-ppp-charcoal-400"}`}>
        {failed ? "Didn't save" : on ? "Cleared" : ""}
      </span>
    </label>
  );
}
