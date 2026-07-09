"use client";

import { useMemo, useRef, useState } from "react";

/**
 * Karan 2026-07-08: account picker for the "New deal" slide-out on the
 * pipeline page.
 *
 * The dumb server-only approach ({option value=uuid}) doesn't work as
 * autocomplete — browsers filter <datalist> options on `value`, not on
 * `label`. So typing a customer name would never match anything.
 *
 * Fix: the visible input is the human-readable company name, backed by
 * a <datalist> of all names. On every keystroke we look up the id
 * corresponding to that name and stash it in a hidden field named
 * `account_id` — which is what the server action reads. Case-
 * insensitive match; ties broken by the first row in the accounts
 * array (order comes from listCommercialAccounts which alphabetizes).
 */
export default function NewDealAccountPicker({
  accounts,
}: {
  accounts: { id: string; company_name: string }[];
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const idForName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) {
      const key = a.company_name.trim().toLowerCase();
      if (!map.has(key)) map.set(key, a.id);
    }
    return map;
  }, [accounts]);

  const trimmed = name.trim().toLowerCase();
  const resolvedId = idForName.get(trimmed) ?? "";

  return (
    <div>
      <label htmlFor="new-deal-account" className="block text-xs font-semibold text-ppp-charcoal-700 mb-1">
        Customer <span className="text-red-600">*</span>
      </label>
      <input
        id="new-deal-account"
        ref={inputRef}
        list="new-deal-accounts-list"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Type a customer name…"
        autoComplete="off"
        className="w-full rounded-lg border border-ppp-charcoal-200 bg-white px-3 py-2 text-sm text-ppp-charcoal placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-cc-brand-500 focus:border-cc-brand-500 min-h-[44px]"
      />
      <datalist id="new-deal-accounts-list">
        {accounts.map((a) => (
          <option key={a.id} value={a.company_name} />
        ))}
      </datalist>
      <input type="hidden" name="account_id" value={resolvedId} />
      {name && !resolvedId && (
        <p className="text-[11px] text-red-600 mt-1">
          No customer matches “{name}” — pick one from the list.
        </p>
      )}
      {resolvedId && (
        <p className="text-[11px] text-emerald-700 mt-1">✓ Customer selected.</p>
      )}
    </div>
  );
}
