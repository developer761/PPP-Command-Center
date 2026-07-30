"use client";

/**
 * Invoice create-form fields that know about the deal's proposals (Karan
 * 2026-07-30). Picking a proposal auto-fills BOTH the amount (remaining to
 * bill against that proposal) AND the "what this charge is for" description —
 * so billing a $12 proposal drops $12 + a sensible line into the form with one
 * click. The user can still edit either; we only auto-fill a field the user
 * hasn't hand-edited (dirty tracking), so we never clobber typed input.
 *
 * Owns three controlled inputs (description, proposal_id, amount) inside the
 * server <form> — their `name`s still submit to createInvoiceInlineAction.
 * The due-date + advanced fields stay server-rendered after this block.
 */
import { useRef, useState, type ReactNode } from "react";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";

export type ProposalBillingOption = {
  id: string;
  label: string;
  /** Remaining-to-bill against this proposal in cents (contract − already
   *  billed, clamped ≥ 0). Dollars string is derived for the amount field. */
  remainingCents: number;
  /** Suggested "what this charge is for" line for this proposal. */
  suggestedDescription: string;
};

const FIELD_LABEL = "block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5";
const TEXT_INPUT =
  "w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[44px] touch-manipulation bg-surface focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30";

function centsToInput(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "";
  return (cents / 100).toFixed(2);
}

export function ProposalBillingFields({
  oppId,
  options,
  defaultProposalId,
  dueDateNode,
}: {
  oppId: string;
  options: ProposalBillingOption[];
  defaultProposalId: string | null;
  /** Server-rendered due-date input, passed through so it sits in the amount
   *  grid without the client boundary needing `new Date()` (unavailable). */
  dueDateNode: ReactNode;
}) {
  const byId = new Map(options.map((o) => [o.id, o]));
  const initial = defaultProposalId && byId.has(defaultProposalId) ? defaultProposalId : "";
  const initialOpt = initial ? byId.get(initial)! : null;

  const [proposalId, setProposalId] = useState(initial);
  const [description, setDescription] = useState(initialOpt?.suggestedDescription ?? "");
  const [amount, setAmount] = useState(initialOpt ? centsToInput(initialOpt.remainingCents) : "");

  // Track whether the user hand-edited a field so auto-fill never clobbers it.
  const descDirty = useRef(false);
  const amtDirty = useRef(false);

  function onPickProposal(id: string) {
    setProposalId(id);
    const opt = id ? byId.get(id) : null;
    if (!descDirty.current) setDescription(opt?.suggestedDescription ?? "");
    if (!amtDirty.current) setAmount(opt ? centsToInput(opt.remainingCents) : "");
  }

  const selected = proposalId ? byId.get(proposalId) : null;

  return (
    <>
      <div>
        <label className={FIELD_LABEL} htmlFor={`inv-add-${oppId}-description`}>
          What this charge is for
        </label>
        <input
          id={`inv-add-${oppId}-description`}
          type="text"
          name="description"
          required
          maxLength={500}
          value={description}
          onChange={(e) => {
            descDirty.current = true;
            setDescription(e.target.value);
          }}
          placeholder="e.g. Progress payment 1 of 3 — Lobby repaint"
          className={TEXT_INPUT}
        />
      </div>

      <div>
        <label className={FIELD_LABEL} htmlFor={`inv-add-${oppId}-proposal`}>
          Bill against proposal <span className="font-normal text-ppp-charcoal-400">(optional)</span>
        </label>
        <select
          id={`inv-add-${oppId}-proposal`}
          name="proposal_id"
          value={proposalId}
          onChange={(e) => onPickProposal(e.target.value)}
          className={SELECT_CLS}
          style={SELECT_BG_STYLE}
        >
          <option value="">Not tied to a proposal</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        {selected && (
          <p className="mt-1 text-[10.5px] leading-snug text-ppp-charcoal-500">
            Auto-filled the amount + description from this proposal — edit either if this invoice is only part of it.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={FIELD_LABEL}>Amount</span>
          <input
            id={`inv-add-${oppId}-amount`}
            type="text"
            inputMode="decimal"
            name="amount"
            required
            value={amount}
            onChange={(e) => {
              amtDirty.current = true;
              setAmount(e.target.value);
            }}
            placeholder="0.00"
            className={`${TEXT_INPUT} tabular-nums`}
          />
        </label>
        {dueDateNode}
      </div>
    </>
  );
}
