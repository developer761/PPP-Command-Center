"use client";

/**
 * <NewProposalPicker> — client-side account → deal picker for starting
 * a proposal without navigating first.
 *
 * Karan 2026-07-15: /commercial/proposals used to say "Pick a deal to
 * start a proposal →" and dump you back on /commercial/accounts. This
 * picker collapses that flow: type an account name (or scroll), then
 * pick which of that customer's active deals to build a proposal for.
 * The picker jumps straight to /commercial/accounts/[id]/deals/[dealId]/proposal/new,
 * which is the same route the account-scoped "Start proposal" button
 * uses — so bump-forward + hydrate + everything works unchanged.
 *
 * Two modes:
 * - `mode="global"` — used on /commercial/proposals. Shows account
 *   picker + then that account's deals.
 * - `mode="account"` — used on an account detail page. Account is
 *   pre-selected + hidden; only shows the deal list.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type PickerAccount = {
  id: string;
  company_name: string;
};

export type PickerDeal = {
  id: string;
  account_id: string;
  display_name: string; // derivedOppName result
  status: string;
};

type Props = {
  accounts: PickerAccount[];
  deals: PickerDeal[];
  /** When set, hides the account picker and hard-scopes to this
   *  account. Used on account-detail pages. */
  lockedAccountId?: string;
  /** Text on the primary CTA button that opens the popover. */
  buttonLabel?: string;
  className?: string;
};

export default function NewProposalPicker({
  accounts,
  deals,
  lockedAccountId,
  buttonLabel = "+ New proposal",
  className = "",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pickedAccount, setPickedAccount] = useState<string | null>(
    lockedAccountId ?? null
  );
  const [accountQuery, setAccountQuery] = useState("");
  const [dealQuery, setDealQuery] = useState("");
  const [pending, setPending] = useState(false);

  const accountsById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a] as const)),
    [accounts]
  );

  const filteredAccounts = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    const rows = q
      ? accounts.filter((a) => a.company_name.toLowerCase().includes(q))
      : accounts;
    return rows.slice(0, 20);
  }, [accounts, accountQuery]);

  const dealsForAccount = useMemo(() => {
    if (!pickedAccount) return [];
    const rows = deals.filter((d) => d.account_id === pickedAccount);
    const q = dealQuery.trim().toLowerCase();
    return q
      ? rows.filter((d) => d.display_name.toLowerCase().includes(q))
      : rows;
  }, [deals, pickedAccount, dealQuery]);

  const start = (dealId: string) => {
    if (!pickedAccount || pending) return;
    setPending(true);
    router.push(
      `/commercial/accounts/${pickedAccount}/deals/${dealId}/proposal/new`
    );
  };

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[40px] shadow-sm"
      >
        <span>{buttonLabel}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop closes the popover */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label="Start a new proposal"
            className="absolute right-0 top-full mt-1 z-40 w-[340px] max-w-[calc(100vw-24px)] bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-ppp-charcoal-100">
              <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700">
                Start proposal
              </div>
              <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
                {lockedAccountId
                  ? "Pick which deal this proposal is for."
                  : pickedAccount
                    ? `Pick the deal for ${accountsById.get(pickedAccount)?.company_name ?? ""}.`
                    : "Pick the customer, then the deal."}
              </p>
            </div>

            {/* Step 1 — account picker (hidden when locked) */}
            {!lockedAccountId && !pickedAccount && (
              <div className="p-3 space-y-2">
                <input
                  type="text"
                  autoFocus
                  value={accountQuery}
                  onChange={(e) => setAccountQuery(e.target.value)}
                  placeholder="Search customers…"
                  className="w-full px-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[40px]"
                />
                <ul className="max-h-64 overflow-y-auto divide-y divide-ppp-charcoal-100 border border-ppp-charcoal-100 rounded-lg">
                  {filteredAccounts.length === 0 ? (
                    <li className="px-3 py-3 text-[12px] text-ppp-charcoal-500 italic text-center">
                      No customers match.
                    </li>
                  ) : (
                    filteredAccounts.map((a) => {
                      const dealCount = deals.filter((d) => d.account_id === a.id).length;
                      return (
                        <li key={a.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setPickedAccount(a.id);
                              setDealQuery("");
                            }}
                            disabled={dealCount === 0}
                            className={`w-full text-left px-3 py-2 min-h-[40px] flex items-center justify-between gap-2 ${
                              dealCount === 0
                                ? "text-ppp-charcoal-300 cursor-not-allowed"
                                : "hover:bg-ppp-charcoal-50 text-ppp-charcoal-800"
                            }`}
                          >
                            <span className="text-[13px] font-medium truncate">
                              {a.company_name}
                            </span>
                            <span className="text-[10px] text-ppp-charcoal-500 tabular-nums shrink-0">
                              {dealCount} deal{dealCount === 1 ? "" : "s"}
                            </span>
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
                <p className="text-[11px] text-ppp-charcoal-400">
                  Customers with no open deals are grayed out.
                </p>
              </div>
            )}

            {/* Step 2 — deal picker */}
            {pickedAccount && (
              <div className="p-3 space-y-2">
                {!lockedAccountId && (
                  <button
                    type="button"
                    onClick={() => setPickedAccount(null)}
                    className="text-[11px] text-cc-brand-700 hover:text-cc-brand-800 font-medium inline-flex items-center gap-1"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M19 12H5" />
                      <path d="m12 19-7-7 7-7" />
                    </svg>
                    Change customer
                  </button>
                )}
                <input
                  type="text"
                  autoFocus
                  value={dealQuery}
                  onChange={(e) => setDealQuery(e.target.value)}
                  placeholder="Search deals…"
                  className="w-full px-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[40px]"
                />
                <ul className="max-h-64 overflow-y-auto divide-y divide-ppp-charcoal-100 border border-ppp-charcoal-100 rounded-lg">
                  {dealsForAccount.length === 0 ? (
                    <li className="px-3 py-3 text-[12px] text-ppp-charcoal-500 italic text-center">
                      No open deals on this customer.
                    </li>
                  ) : (
                    dealsForAccount.map((d) => (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => start(d.id)}
                          disabled={pending}
                          className="w-full text-left px-3 py-2 min-h-[44px] hover:bg-ppp-charcoal-50 disabled:opacity-50 flex items-center justify-between gap-2"
                        >
                          <span className="text-[13px] font-medium text-ppp-charcoal-800 truncate">
                            {d.display_name}
                          </span>
                          <span className="text-[10px] text-ppp-charcoal-500 uppercase tracking-wider shrink-0">
                            {d.status.replaceAll("_", " ")}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                {pending && (
                  <p className="text-[11px] text-cc-brand-700 font-medium">Opening editor…</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
