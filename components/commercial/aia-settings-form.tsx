"use client";

/**
 * Autosaving AIA "Application settings" (Karan #31). Period / original contract
 * / retainage / notes save on blur — no Save button. Money + retainage are
 * validated client-side (same rules as the server) so an invalid value can't
 * silently save as a coerced 0 / be dropped. Delete stays a separate, explicit
 * action (handled by the caller). Mirrors AiaLineRow's hardening.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { DateField } from "@/components/commercial/date-field";

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

export function AiaSettingsForm({
  appId,
  accountId,
  dealId,
  initial,
  saveAction,
}: {
  appId: string;
  accountId: string;
  dealId: string;
  initial: {
    period_from: string;
    period_to: string;
    original_contract: string;
    retainage_pct: string;
    notes: string;
  };
  saveAction: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [vals, setVals] = useState(initial);
  const dirty = useRef(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty.current || status === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [status]);

  const moneyBad = vals.original_contract.trim() !== "" && !MONEY_RE.test(vals.original_contract.trim());
  const retNum = vals.retainage_pct.trim() === "" ? 0 : Number(vals.retainage_pct);
  const retBad = vals.retainage_pct.trim() !== "" && (!Number.isFinite(retNum) || retNum < 0 || retNum > 100);

  function set<K extends keyof typeof vals>(k: K, v: string) {
    setVals((s) => ({ ...s, [k]: v }));
    dirty.current = true;
    if (status === "saved" || status === "error") setStatus("idle");
    setErrMsg(null);
  }

  function save() {
    if (moneyBad || retBad) {
      setStatus("error");
      setErrMsg(moneyBad ? "Contract must be a number with up to 2 decimals." : "Retainage must be 0–100%.");
      return;
    }
    dirty.current = false;
    setStatus("saving");
    setErrMsg(null);
    const fd = new FormData();
    fd.set("account_id", accountId);
    fd.set("opp_id", dealId);
    fd.set("app_id", appId);
    fd.set("period_from", vals.period_from);
    fd.set("period_to", vals.period_to);
    fd.set("original_contract", vals.original_contract);
    fd.set("retainage_pct", vals.retainage_pct);
    fd.set("notes", vals.notes);
    startTransition(async () => {
      try {
        const res = await saveAction(fd);
        if (res.ok) setStatus("saved");
        else {
          setStatus("error");
          setErrMsg(res.error ?? "Save failed.");
          dirty.current = true;
        }
      } catch {
        setStatus("error");
        setErrMsg("Save failed — check your connection.");
        dirty.current = true;
      }
    });
  }

  function onBlurCapture(e: React.FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    if (dirty.current) save();
  }

  const INPUT = "w-full px-3 py-2 text-base sm:text-sm bg-surface border rounded-lg focus:outline-none focus:ring-2 min-h-[44px]";
  const ok = "border-ppp-charcoal-200 focus:ring-cc-brand-600/30 focus:border-cc-brand-600";
  const bad = "border-rose-400 ring-1 ring-rose-300 focus:ring-rose-400";

  return (
    <div ref={rootRef} onBlur={onBlurCapture} className="px-4 pb-4 pt-1 grid sm:grid-cols-2 gap-3">
      <label className="block">
        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period from</span>
        <DateField value={vals.period_from} onValueChange={(v) => set("period_from", v)} placeholder="Pick a date" />
      </label>
      <label className="block">
        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period to</span>
        <DateField value={vals.period_to} onValueChange={(v) => set("period_to", v)} placeholder="Pick a date" />
      </label>
      <label className="block">
        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Original contract ($)</span>
        <input inputMode="decimal" value={vals.original_contract} onChange={(e) => set("original_contract", e.target.value)} className={`${INPUT} ${moneyBad ? bad : ok}`} aria-invalid={moneyBad} />
      </label>
      <label className="block">
        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Retainage (%)</span>
        <input inputMode="decimal" value={vals.retainage_pct} onChange={(e) => set("retainage_pct", e.target.value)} className={`${INPUT} ${retBad ? bad : ok}`} aria-invalid={retBad} />
      </label>
      <label className="block sm:col-span-2">
        <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Notes</span>
        <textarea rows={2} maxLength={4000} value={vals.notes} onChange={(e) => set("notes", e.target.value)} className={`${INPUT} ${ok} resize-y`} />
      </label>
      <div className="sm:col-span-2 flex items-center gap-2 min-h-[20px]" aria-live="polite">
        {status === "saving" && <span className="text-[11px] text-ppp-charcoal-400">Saving…</span>}
        {status === "saved" && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
            Saved
          </span>
        )}
        {status === "error" && (
          <span className="inline-flex items-center gap-2 text-[11px] text-rose-600">
            {errMsg}
            <button type="button" onClick={save} className="font-semibold underline underline-offset-2 min-h-[44px] px-1">Retry</button>
          </span>
        )}
        {status === "idle" && <span className="text-[11px] text-ppp-charcoal-400">Changes save automatically.</span>}
      </div>
    </div>
  );
}
