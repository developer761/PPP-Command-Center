"use client";

import { useState } from "react";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";

/**
 * Deal invoice builder (2026-08). One deal → one (or more) invoices; each
 * invoice can OPTIONALLY be broken into milestones (name · amount · due date ·
 * lien waiver). Flat mode = a single amount. Milestone mode = rows whose amounts
 * SUM to the invoice total, shown live at the TOP.
 *
 * Billing against a proposal autofills the total (flat) or shows the target +
 * "left to allocate" (milestones). A signed lien waiver can be attached per
 * milestone (or once for a flat invoice) right here, and always added later.
 *
 * Submits to the deal's server action; milestone rows post as contiguous
 * ms_name_i / ms_amount_i / ms_due_i / ms_waiver_i fields + ms_count + a mode
 * flag. Waiver files ride the submit (server-action body limit raised to 25 MB).
 */

type ProposalOpt = { id: string; label: string; totalCents: number; remainingCents: number };

const WAIVER_ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";

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
  returnTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  accountId: string;
  oppId: string;
  defaultTax: string;
  taxNote: string | null;
  proposals: ProposalOpt[];
  /** Where to land after create (+ on error). Lets the SAME builder live on the
   *  deal's Invoices tab AND its own page in the Invoices section, each
   *  returning to its own surface (not teleporting between them). */
  returnTo?: string;
}) {
  const [mode, setMode] = useState<"flat" | "milestones">("flat");
  const [flatAmount, setFlatAmount] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { name: "", amount: "", due: "" },
    { name: "", amount: "", due: "" },
  ]);
  const [proposalId, setProposalId] = useState("");

  const selectedProposal = proposals.find((p) => p.id === proposalId) ?? null;
  // Target = what's LEFT to bill on the proposal (contract − already billed), so
  // a 2nd/3rd progress invoice can't re-bill the whole contract (audit 3B).
  const targetDollars = selectedProposal ? selectedProposal.remainingCents / 100 : 0;

  const milestoneTotal = rows.reduce((s, r) => s + parseAmount(r.amount), 0);
  const flatTotal = parseAmount(flatAmount);
  const liveTotal = mode === "milestones" ? milestoneTotal : flatTotal;
  const filledRows = rows.filter((r) => parseAmount(r.amount) > 0).length;
  const remainingToAllocate = targetDollars > 0 ? Math.round((targetDollars - milestoneTotal) * 100) / 100 : 0;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow(prefillAmount?: number) {
    setRows((rs) => [...rs, { name: "", amount: prefillAmount && prefillAmount > 0 ? prefillAmount.toFixed(2) : "", due: "" }]);
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }
  function onPickProposal(id: string) {
    setProposalId(id);
    const prop = proposals.find((p) => p.id === id);
    // Flat: autofill the REMAINING to bill (user can still edit).
    if (prop && mode === "flat") setFlatAmount((prop.remainingCents / 100).toFixed(2));
  }

  return (
    <details className="group bg-ppp-blue-50/40 border border-ppp-blue-200 rounded-xl">
      <summary className="list-none cursor-pointer flex items-center gap-2 px-4 py-3 min-h-[44px] text-[13px] font-semibold text-ppp-blue-800 select-none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-45"><path d="M12 5v14 M5 12h14" /></svg>
        New invoice for this deal
      </summary>
      <form action={action} className="px-4 pb-4 pt-1 space-y-3.5">
        <input type="hidden" name="account_id" value={accountId} />
        <input type="hidden" name="opp_id" value={oppId} />
        <input type="hidden" name="mode" value={mode} />
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}

        {/* Running invoice total — always visible at the TOP. */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-ppp-blue-200 bg-surface px-4 py-2.5">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ppp-charcoal-500">Invoice total</div>
            <div className="font-condensed text-2xl font-black leading-none tabular-nums text-ppp-blue-800">{fmtUSD(liveTotal)}</div>
          </div>
          {mode === "milestones" && (
            <div className="text-right text-[11px] text-ppp-charcoal-500">
              {filledRows} milestone{filledRows === 1 ? "" : "s"}
              {defaultTax ? <div className="text-ppp-charcoal-400">before tax</div> : null}
            </div>
          )}
        </div>

        {/* Mode toggle — flat amount vs a milestone breakdown. */}
        <div className="inline-flex rounded-lg border border-ppp-blue-200 bg-surface p-0.5 text-[12px] font-semibold">
          {(["flat", "milestones"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded-md min-h-[44px] touch-manipulation transition-colors ${mode === m ? "bg-ppp-blue-600 text-white" : "text-ppp-charcoal-600 hover:text-ppp-charcoal"}`}
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
            <div className="sm:col-span-2">
              <label htmlFor="dni-waiver" className={LABEL_CLS}>Signed lien waiver (optional)</label>
              <input id="dni-waiver" name="flat_waiver" type="file" accept={WAIVER_ACCEPT} className="block w-full text-[12px] text-ppp-charcoal-600 file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border-0 file:text-[12px] file:font-semibold file:bg-ppp-blue-600 file:text-white hover:file:bg-ppp-blue-700 file:min-h-[40px] cursor-pointer" />
              <p className="text-[10.5px] text-ppp-charcoal-400 mt-1">You can also add it later from the invoice — waivers usually arrive after billing.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[11.5px] text-ppp-charcoal-500">
              Split this invoice into milestones — each with its own amount, due date and (optional) lien waiver. The amounts add up to the invoice total above.
            </p>
            {selectedProposal && (
              <div className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11.5px] ${Math.abs(remainingToAllocate) < 0.005 ? "border-emerald-200 bg-emerald-50/60 text-emerald-800" : "border-ppp-blue-200 bg-ppp-blue-50/60 text-ppp-charcoal-700"}`}>
                <span>
                  <strong className="tabular-nums">{fmtUSD(targetDollars)}</strong> left to bill on this proposal ·{" "}
                  {Math.abs(remainingToAllocate) < 0.005 ? "fully allocated" : remainingToAllocate > 0 ? <><strong className="tabular-nums">{fmtUSD(remainingToAllocate)}</strong> left to allocate</> : <><strong className="tabular-nums">{fmtUSD(-remainingToAllocate)}</strong> over</>}
                </span>
                {remainingToAllocate > 0.005 && (
                  <button type="button" onClick={() => addRow(remainingToAllocate)} className="shrink-0 font-semibold text-ppp-blue-700 hover:text-ppp-blue-800 min-h-[44px] px-1">Fill remaining →</button>
                )}
              </div>
            )}
            <input type="hidden" name="ms_count" value={rows.length} />
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="rounded-lg border border-ppp-blue-200/70 bg-surface p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[10.5px] font-bold uppercase tracking-wide text-ppp-blue-700">Milestone {i + 1}</span>
                    {rows.length > 1 && (
                      <button type="button" onClick={() => removeRow(i)} className="text-[11px] font-medium text-ppp-charcoal-400 hover:text-rose-700 min-h-[44px] px-1.5" aria-label={`Remove milestone ${i + 1}`}>Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_9rem] gap-2">
                    <input name={`ms_name_${i}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} maxLength={200} placeholder={`e.g. ${["Deposit", "Rough-in", "Final", "Retainage"][i] ?? "Milestone"}`} className={INPUT_CLS} />
                    <input name={`ms_amount_${i}`} value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} inputMode="decimal" placeholder="0.00" aria-label={`Milestone ${i + 1} amount`} className={INPUT_CLS} />
                    <input name={`ms_due_${i}`} value={r.due} onChange={(e) => setRow(i, { due: e.target.value })} type="date" aria-label={`Milestone ${i + 1} due date`} className={INPUT_CLS} />
                  </div>
                  <div className="mt-1.5">
                    <label htmlFor={`ms-waiver-${i}`} className="text-[10px] font-semibold text-ppp-charcoal-500">Signed lien waiver (optional)</label>
                    <input id={`ms-waiver-${i}`} name={`ms_waiver_${i}`} type="file" accept={WAIVER_ACCEPT} className="block w-full text-[11px] text-ppp-charcoal-500 file:mr-2 file:py-1.5 file:px-2.5 file:rounded-md file:border-0 file:text-[11px] file:font-semibold file:bg-ppp-charcoal-100 file:text-ppp-charcoal-700 hover:file:bg-ppp-charcoal-200 cursor-pointer mt-0.5" />
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => addRow()} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ppp-blue-700 hover:text-ppp-blue-800 min-h-[40px]">
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
              <select id="dni-prop" name="proposal_id" value={proposalId} onChange={(e) => onPickProposal(e.target.value)} className={SELECT_CLS} style={SELECT_BG_STYLE}>
                <option value="">— none —</option>
                {proposals.map((pr) => (
                  <option key={pr.id} value={pr.id}>{pr.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {taxNote && <p className="text-[10.5px] text-ppp-charcoal-500">{taxNote}</p>}

        {/* Create — right under everything, per Karan. */}
        <div className="flex items-center justify-between gap-3 flex-wrap border-t border-ppp-blue-200/60 pt-3">
          <div className="text-[12px] text-ppp-charcoal-600">
            <span className="font-semibold text-ppp-charcoal">Total </span>
            <span className="font-bold tabular-nums text-ppp-blue-800">{fmtUSD(liveTotal)}</span>
          </div>
          <PendingSubmitButton className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ppp-blue-600 text-white text-[13px] font-semibold hover:bg-ppp-blue-700 min-h-[44px] touch-manipulation disabled:opacity-60" pendingLabel="Creating…">
            Create invoice
          </PendingSubmitButton>
        </div>
      </form>
    </details>
  );
}
