"use client";

/**
 * Client component for the batch invoice creator at
 * /commercial/invoices/new. Manages an unbounded list of invoice rows,
 * each with:
 *   - Core: description, amount, due date, PO
 *   - Optional details (progressive-disclosure): payment terms, tax %,
 *     customer message (shown on PDF), internal notes
 *
 * Karan 2026-07-07: replaced the 3-row pre-fill with a single starter
 * row + "Add invoice" button that supports unlimited rows. Each row
 * has a "More details ▾" toggle so the surface stays quiet by default
 * but recovers all the fields from the invoice detail form.
 *
 * The parent (server component) reads formData entries named
 * `row-<idx>-<field>` on submit; idx doesn't have to be contiguous
 * (we use monotonic IDs) — the server picks up whatever's present.
 */

import { useState, useMemo, useEffect, useRef } from "react";
import { INPUT_CLS, LABEL_CLS, TEXTAREA_CLS } from "@/lib/commercial/form-classnames";

type Row = {
  id: number;
  suggestedDue: string;
  suggestedDescription: string;
};

function suggestDue(daysOut: number): string {
  const d = new Date(Date.now() + daysOut * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export default function BatchInvoiceRows() {
  const [rows, setRows] = useState<Row[]>([
    { id: 1, suggestedDue: suggestDue(30), suggestedDescription: "Progress payment #1" },
  ]);
  // Which row indexes have the "More details" panel open. Set of ids.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const nextId = useMemo(() => Math.max(0, ...rows.map((r) => r.id)) + 1, [rows]);
  // Focus + scroll the newly-added row's description input. Audit finding:
  // on mobile especially, appending a row past the fold left users hunting.
  const [focusRowId, setFocusRowId] = useState<number | null>(null);
  const rowRefs = useRef<Map<number, HTMLInputElement | null>>(new Map());
  useEffect(() => {
    if (focusRowId === null) return;
    const el = rowRefs.current.get(focusRowId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Small delay so the scroll animation lands before the caret jumps.
      const t = setTimeout(() => el.focus({ preventScroll: true }), 200);
      return () => clearTimeout(t);
    }
  }, [focusRowId]);

  const addRow = () => {
    const nextNum = rows.length + 1;
    const newId = nextId;
    setRows((prev) => [
      ...prev,
      {
        id: newId,
        suggestedDue: suggestDue(30 * nextNum),
        suggestedDescription: `Progress payment #${nextNum}`,
      },
    ]);
    setFocusRowId(newId);
  };

  const removeRow = (id: number) => {
    if (rows.length <= 1) return; // keep at least one row
    setRows((prev) => prev.filter((r) => r.id !== id));
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleDetails = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <ul className="divide-y divide-ppp-charcoal-100">
        {rows.map((row, position) => {
          const isOpen = expanded.has(row.id);
          const rowKey = row.id;
          return (
            <li key={rowKey} className="p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-cc-brand-100 text-cc-brand-700 text-[11px] font-bold">
                    {position + 1}
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                    Invoice #{position + 1}
                  </span>
                </div>
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(row.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[36px] touch-manipulation"
                    aria-label={`Remove invoice ${position + 1}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M18 6L6 18 M6 6l12 12" />
                    </svg>
                    Remove
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3">
                <div className="sm:col-span-6">
                  <label htmlFor={`row-${rowKey}-description`} className={LABEL_CLS}>
                    Description
                  </label>
                  <input
                    id={`row-${rowKey}-description`}
                    name={`row-${rowKey}-description`}
                    type="text"
                    maxLength={200}
                    defaultValue={row.suggestedDescription}
                    placeholder="What is this bill for?"
                    className={INPUT_CLS}
                    ref={(el) => {
                      rowRefs.current.set(rowKey, el);
                    }}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`row-${rowKey}-amount`} className={LABEL_CLS}>
                    Amount ($)
                  </label>
                  <input
                    id={`row-${rowKey}-amount`}
                    name={`row-${rowKey}-amount`}
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    className={INPUT_CLS}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`row-${rowKey}-due_at`} className={LABEL_CLS}>
                    Due date
                  </label>
                  <input
                    id={`row-${rowKey}-due_at`}
                    name={`row-${rowKey}-due_at`}
                    type="date"
                    defaultValue={row.suggestedDue}
                    className={INPUT_CLS}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`row-${rowKey}-po_number`} className={LABEL_CLS}>
                    PO # (optional)
                  </label>
                  <input
                    id={`row-${rowKey}-po_number`}
                    name={`row-${rowKey}-po_number`}
                    type="text"
                    maxLength={80}
                    className={INPUT_CLS}
                  />
                </div>
              </div>

              {/* More details toggle — collapsed by default so the row
                  stays quiet. Progressive-disclosure surface for terms,
                  tax %, message-to-customer, and internal notes. */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleDetails(row.id)}
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-blue-700 hover:text-blue-900 min-h-[32px] touch-manipulation"
                  aria-expanded={isOpen}
                  aria-controls={`row-${rowKey}-details`}
                >
                  <span aria-hidden className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}>
                    ▸
                  </span>
                  {isOpen ? "Hide details" : "More details (notes, terms, tax, message)"}
                </button>
                {isOpen && (
                  <div id={`row-${rowKey}-details`} className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`row-${rowKey}-payment_terms`} className={LABEL_CLS}>
                        Payment terms
                      </label>
                      <input
                        id={`row-${rowKey}-payment_terms`}
                        name={`row-${rowKey}-payment_terms`}
                        type="text"
                        maxLength={60}
                        placeholder="Net 30"
                        className={INPUT_CLS}
                      />
                    </div>
                    <div>
                      <label htmlFor={`row-${rowKey}-tax_pct`} className={LABEL_CLS}>
                        Tax % (flat)
                      </label>
                      <input
                        id={`row-${rowKey}-tax_pct`}
                        name={`row-${rowKey}-tax_pct`}
                        type="text"
                        inputMode="decimal"
                        pattern="[0-9.]*"
                        placeholder="0"
                        className={INPUT_CLS}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor={`row-${rowKey}-customer_message`} className={LABEL_CLS}>
                        Message to customer
                      </label>
                      <textarea
                        id={`row-${rowKey}-customer_message`}
                        name={`row-${rowKey}-customer_message`}
                        rows={2}
                        maxLength={1000}
                        placeholder="Optional — appears above line items on the customer's copy."
                        className={TEXTAREA_CLS}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor={`row-${rowKey}-notes`} className={LABEL_CLS}>
                        Internal notes
                      </label>
                      <textarea
                        id={`row-${rowKey}-notes`}
                        name={`row-${rowKey}-notes`}
                        rows={2}
                        maxLength={2000}
                        placeholder="Never on the customer copy."
                        className={TEXTAREA_CLS}
                      />
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="px-4 py-3 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/40 flex items-center justify-between gap-2 flex-wrap">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-cc-brand-200 bg-white text-cc-brand-700 text-[13px] font-semibold hover:bg-cc-brand-50 min-h-[44px] touch-manipulation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          Add another invoice
        </button>
        <span className="text-[11px] text-ppp-charcoal-500">
          {rows.length} row{rows.length === 1 ? "" : "s"} · empty rows are skipped on submit
        </span>
      </div>
    </>
  );
}
