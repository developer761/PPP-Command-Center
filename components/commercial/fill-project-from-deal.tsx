"use client";

/**
 * "Fill PROJECT from deal" button for the proposal editor Header block.
 *
 * Karan 2026-07-20: Alex was retyping the deal's name + address into
 * the PROJECT block every time — even though the parent account might
 * have multiple deals with structured client_name + property fields
 * already filled out. This button gives him a one-click autofill:
 *
 *   - Single deal in the account → renders as a plain button
 *     ("Refill from Karan · Distills, NY 11746")
 *   - Multiple deals → renders as a dropdown, click a deal name to
 *     autofill project_name + project_address on the editor
 *   - Zero deals → doesn't render (edge case, shouldn't happen since
 *     the proposal IS under a deal)
 *
 * Writes directly to the DOM inputs so the change is picked up by any
 * autosave wrapper on the parent form.
 */

import { useEffect, useRef, useState } from "react";

export type FillableDeal = {
  id: string;
  label: string;   // "Karan · Distills, NY 11746" — display in dropdown
  projectName: string;
  projectAddress: string;
};

export function FillProjectFromDeal({
  deals,
  projectNameInputId,
  projectAddressInputId,
}: {
  deals: FillableDeal[];
  projectNameInputId: string;
  projectAddressInputId: string;
}) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function setInput(id: string, value: string) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.value = value;
    // Fire input + change so autosave listeners react.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function apply(deal: FillableDeal) {
    setInput(projectNameInputId, deal.projectName);
    setInput(projectAddressInputId, deal.projectAddress);
    setOpen(false);
    setFlash(deal.label);
    setTimeout(() => setFlash(null), 2500);
  }

  if (deals.length === 0) return null;

  if (deals.length === 1) {
    const only = deals[0];
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => apply(only)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-semibold text-cc-brand-800 bg-cc-brand-50 border border-cc-brand-200 hover:bg-cc-brand-100 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 4v16 M4 12h16" />
          </svg>
          Refill from {only.label}
        </button>
        {flash && (
          <span className="text-[11px] text-emerald-700" role="status">
            Filled from {flash}.
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-semibold text-cc-brand-800 bg-cc-brand-50 border border-cc-brand-200 hover:bg-cc-brand-100 focus:outline-none focus:ring-2 focus:ring-cc-brand-500/40"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 4v16 M4 12h16" />
        </svg>
        Fill PROJECT from another deal ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-40 left-0 mt-1 w-72 max-w-[90vw] rounded-lg border border-ppp-charcoal-200 bg-white shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-ppp-charcoal-100 text-[11px] font-semibold uppercase tracking-widest text-ppp-charcoal-500">
            {deals.length} deals in this account
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {deals.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => apply(d)}
                  className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-cc-brand-50 focus:outline-none focus:bg-cc-brand-50 border-b border-ppp-charcoal-100 last:border-b-0"
                >
                  <div className="font-semibold text-ppp-charcoal truncate">
                    {d.projectName || "(no name)"}
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 truncate">
                    {d.projectAddress || "(no address)"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {flash && (
        <span className="ml-2 text-[11px] text-emerald-700" role="status">
          Filled from {flash}.
        </span>
      )}
    </div>
  );
}
