"use client";

import { useState } from "react";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";

/**
 * Deal invoice builder (2026-08). One deal → one (or more) invoices; each
 * invoice can OPTIONALLY be broken into milestones (name · amount · due date),
 * each of which later gets its own lien waiver. Flat mode = a single amount.
 * Milestone mode = rows whose amounts SUM to the invoice total, shown live.
 *
 * Submits to the deal's server action; milestone rows post as contiguous
 * ms_name_i / ms_amount_i / ms_due_i fields + ms_count + a mode flag.
 */

type ProposalOpt = { id: string; label: string };

function parseAmount(s: string): number {
  const n = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fmtUSD(dollars: number): string {
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

type Row = { name: string; amount: string; due: string };

export function DealInvoiceBuilder({
  action,
  accountId,
  oppId,
  defaultTax,
  taxNote,
  proposals,
}: {
  action: (formData: FormData) => void | Promise<void>;
  accountId: string;
  oppId: string;
  defaultTax: string;
  taxNote: string | null;
  proposals: ProposalOpt[];
}) {
  const [mode, setMode] = useState<"flat" | "milestones">("flat");
  const [flatAmount, setFlatAmount] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { name: "", amount: "", due: "" },
    { name: "", amount: "", due: "" },
  ]);

  const milestoneTotal = rows.reduce((s, r) => s + parseAmount(r.amount), 0);
  const flatTotal = parseAmount(flatAmount);
  const liveTotal = mode === "milestones" ? milestoneTotal : flatTotal;
  const filledRows = rows.filter((r) => parseAmount(r.amount) > 0).length;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { name: "", amount: "", due: "" }]);
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }

  return (
    <details className="group bg-cc-brand-50/40 border border-cc-brand-200 rounded-xl">
      <summary className="list-none cursor-pointer flex items-center gap-2 px-4 py-3 min-h-[44px] text-[13px] font-semibold text-cc-brand-800 select-none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-45"><path d="M12 5v14 M5 12h14" /></svg>
        New invoice for this deal
      </summary>
      <form action={action} className="px-4 pb-4 pt-1 space-y-3.5">
        <input type="hidden" name="account_id" value={accountId} />
        <input type="hidden" name="opp_id" value={oppId} />
        <input type="hidden" name="mode" value={mode} />

        {/* Mode toggle — flat amount vs a milestone breakdown. */}
        <div className="inline-flex rounded-lg border border-cc-brand-200 bg-surface p-0.5 text-[12px] font-semibold">
          {(["flat", "milestones"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded-md min-h-[36px] touch-manipulation transition-colors ${mode === m ? "bg-cc-brand-600 text-white" : "text-ppp-charcoal-600 hover:text-ppp-charcoal"}`}
            >
              {m === "flat" ? "One amount" : "Break into milestones"}
            </button>
          ))}
        </div>

        {mode === "flat" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor="dni-desc" className={LABEL_CLS}>What this invoice bills for</label>
              <input id="dni-desc" name="description" required maxLength={500} placeholder="e.g. Progress payment — Phase 1 lobby repaint" className={INPUT_CLS} />
            </div>
            <div>
              <label htmlFor="dni-amount" className={LABEL_CLS}>Amount</label>
              <input id="dni-amount" name="amount" required inputMode="decimal" value={flatAmount} onChange={(e) => setFlatAmount(e.target.value)} placeholder="0.00" className={INPUT_CLS} />
            </div>
            <div>
              <label htmlFor="dni-due" className={LABEL_CLS}>Due date</label>
              <input id="dni-due" name="due_at" type="date" className={INPUT_CLS} />
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[11.5px] text-ppp-charcoal-500">
              Split this invoice into milestones — each with its own amount and due date. You&rsquo;ll upload a lien waiver per milestone once it&rsquo;s billed. The amounts add up to the invoice total.
            </p>
            <input type="hidden" name="ms_count" value={rows.length} />
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="rounded-lg border border-cc-brand-200/70 bg-surface p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[10.5px] font-bold uppercase tracking-wide text-cc-brand-700">Milestone {i + 1}</span>
                    {rows.length > 1 && (
                      <button type="button" onClick={() => removeRow(i)} className="text-[11px] font-medium text-ppp-charcoal-400 hover:text-rose-700 min-h-[32px] px-1.5" aria-label={`Remove milestone ${i + 1}`}>Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_9rem] gap-2">
                    <input name={`ms_name_${i}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} maxLength={200} placeholder={`e.g. ${["Deposit", "Rough-in", "Final", "Retainage"][i] ?? "Milestone"}`} className={INPUT_CLS} />
                    <input name={`ms_amount_${i}`} value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} inputMode="decimal" placeholder="0.00" aria-label={`Milestone ${i + 1} amount`} className={INPUT_CLS} />
                    <input name={`ms_due_${i}`} value={r.due} onChange={(e) => setRow(i, { due: e.target.value })} type="date" aria-label={`Milestone ${i + 1} due date`} className={INPUT_CLS} />
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addRow} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[40px]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14 M5 12h14" /></svg>
              Add milestone
            </button>
          </div>
        )}

        {/* Shared: tax + optional proposal link. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="dni-tax" className={LABEL_CLS}>Tax %</label>
            <input id="dni-tax" name="tax_pct" inputMode="decimal" defaultValue={defaultTax} placeholder="0" className={INPUT_CLS} />
          </div>
          {proposals.length > 0 && (
            <div>
              <label htmlFor="dni-prop" className={LABEL_CLS}>Bill against proposal (optional)</label>
              <select id="dni-prop" name="proposal_id" defaultValue="" className={SELECT_CLS} style={SELECT_BG_STYLE}>
                <option value="">— none —</option>
                {proposals.map((pr) => (
                  <option key={pr.id} value={pr.id}>{pr.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {taxNote && <p className="text-[10.5px] text-ppp-charcoal-500">{taxNote}</p>}

        {/* Live total + create — the invoice button sits right under the
            milestones, per Karan. */}
        <div className="flex items-center justify-between gap-3 flex-wrap border-t border-cc-brand-200/60 pt-3">
          <div className="text-[12px] text-ppp-charcoal-600">
            <span className="font-semibold text-ppp-charcoal">Invoice total </span>
            <span className="font-bold tabular-nums text-cc-brand-800">{fmtUSD(liveTotal)}</span>
            {mode === "milestones" && (
              <span className="text-ppp-charcoal-400"> · {filledRows} milestone{filledRows === 1 ? "" : "s"}{defaultTax ? " · before tax" : ""}</span>
            )}
          </div>
          <PendingSubmitButton className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation disabled:opacity-60" pendingLabel="Creating…">
            Create invoice
          </PendingSubmitButton>
        </div>
      </form>
    </details>
  );
}
