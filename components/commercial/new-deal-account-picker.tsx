"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

/**
 * Karan 2026-07-09: account picker for the "New deal" slide-out on the
 * pipeline page.
 *
 * V1 used <datalist> — browser-native, which meant the dropdown was
 * that gray OS-chrome look that Karan hates. This version renders our
 * own filtered list panel underneath the input, styled to match the
 * rest of the platform.
 *
 * The visible input is the customer name; the selected UUID lives in a
 * hidden `account_id` field so the server action doesn't need to
 * change. Keyboard support: ↑↓ to move, Enter to select, Esc to close.
 */
type Account = { id: string; company_name: string };

export default function NewDealAccountPicker({ accounts }: { accounts: Account[] }) {
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = name.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return accounts.slice(0, 40);
    return accounts.filter((a) => a.company_name.toLowerCase().includes(q)).slice(0, 40);
  }, [accounts, q]);

  function pick(a: Account) {
    setName(a.company_name);
    setSelectedId(a.id);
    setOpen(false);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (open && matches[activeIdx]) {
        e.preventDefault();
        pick(matches[activeIdx]);
      }
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor="new-deal-account" className={LABEL_CLS}>
        Customer <span className="text-red-600">*</span>
      </label>
      <input
        id="new-deal-account"
        type="text"
        required
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSelectedId("");
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onInputKey}
        placeholder="Type a customer name…"
        autoComplete="off"
        className={INPUT_CLS}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      <input type="hidden" name="account_id" value={selectedId} />
      {open && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 left-0 right-0 max-h-64 overflow-y-auto bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl py-1"
        >
          {matches.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`px-3 py-2 text-sm cursor-pointer ${i === activeIdx ? "bg-cc-brand-50 text-ppp-charcoal" : "text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"}`}
            >
              {a.company_name}
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && q && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl px-3 py-3 text-[13px] text-ppp-charcoal-500">
          No customer matches “{name}”.
        </div>
      )}
      {name && !selectedId && !open && (
        <p className="text-[11px] text-red-600 mt-1">Pick one from the list.</p>
      )}
      {selectedId && (
        <p className="text-[11px] text-emerald-700 mt-1">✓ Customer selected.</p>
      )}
    </div>
  );
}
