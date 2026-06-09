"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { fmtMoneyK } from "@/lib/format";

/**
 * Client-side searchable customer list. Server pre-rendered the list with
 * server-side scope filtering — this component just adds search + filter
 * affordances.
 */

type CustomerListRow = {
  accountId: string | null;
  name: string;
  woCount: number;
  oppCount: number;
  totalAmount: number;
  lastActivity: string | null;
  ownerName: string | null;
};

export default function CustomersIndexView({
  customers,
  isAdmin,
}: {
  customers: CustomerListRow[];
  isAdmin: boolean;
}) {
  const [search, setSearch] = useState("");

  // Pre-lowercase a parallel `hay` string per customer so per-keystroke
  // filtering is one `.includes()` per row instead of rebuilding the
  // concat + .toLowerCase() every keystroke. At admin-scope (5-10K
  // customers), this saves the per-keystroke string allocation. Index
  // is recomputed only when the customers array identity changes.
  const index = useMemo(
    () => customers.map((c) => ({ row: c, hay: `${c.name} ${c.ownerName ?? ""}`.toLowerCase() })),
    [customers]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return index.filter((entry) => entry.hay.includes(q)).map((entry) => entry.row);
  }, [index, customers, search]);

  if (customers.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-500 flex items-center justify-center text-2xl mb-3">👥</div>
        <h3 className="text-base font-bold text-ppp-charcoal">No customers yet</h3>
        <p className="text-xs text-ppp-charcoal-500 mt-2 max-w-md mx-auto">
          {isAdmin
            ? "Once Salesforce has work orders or opportunities, customers will appear here."
            : "You don't own any work orders yet. Once your first deal lands, the customer will show up here."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Header strip — count + search */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-ppp-charcoal-500">
          <strong className="text-ppp-charcoal">{visible.length}</strong>
          {search ? ` of ${customers.length}` : ""} customer{customers.length === 1 ? "" : "s"}
        </div>
        <div className="relative flex-1 min-w-[180px] max-w-md w-full">
          <input
            type="search"
            inputMode="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or rep…"
            // text-base on mobile to prevent iOS auto-zoom; tighter on desktop.
            className="w-full pl-8 pr-3 py-2 sm:py-1.5 text-base sm:text-xs border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
          />
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ppp-charcoal-500 pointer-events-none"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center text-sm text-ppp-charcoal-500">
          No customers match the search.
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          {/* DESKTOP: 6-col table (≥640px). Hides on mobile because the table
              would force horizontal scroll at 375px — workers were having to
              swipe sideways to find the "Last activity" column. */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ppp-charcoal-50/40 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
                <tr>
                  <th className="text-left px-5 py-2.5">Customer</th>
                  <th className="text-left px-5 py-2.5">Owner</th>
                  <th className="text-right px-5 py-2.5">WOs</th>
                  <th className="text-right px-5 py-2.5">Opps</th>
                  <th className="text-right px-5 py-2.5">Total</th>
                  <th className="text-right px-5 py-2.5">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {visible.slice(0, 200).map((c) => {
                  const href = c.accountId ? `/dashboard/customer/${encodeURIComponent(c.accountId)}` : null;
                  // Repeat = 2+ separate projects (opportunities), not 2+ WOs
                  // from one project that got split into walls/trim/deck.
                  const isRepeat = c.oppCount > 1;
                  return (
                    <tr key={`${c.accountId}::${c.name}`} className="hover:bg-ppp-charcoal-50/30 transition-colors">
                      <td className="px-5 py-2.5">
                        {href ? (
                          <Link href={href} className="font-medium text-ppp-charcoal hover:text-ppp-blue hover:underline">
                            {c.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-ppp-charcoal">{c.name}</span>
                        )}
                        {isRepeat && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-blue-50 text-ppp-blue-700 border border-ppp-blue-100">
                            Repeat
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-xs text-ppp-charcoal-500">{c.ownerName ?? "—"}</td>
                      <td className="px-5 py-2.5 text-right text-xs text-ppp-charcoal">{c.woCount}</td>
                      <td className="px-5 py-2.5 text-right text-xs text-ppp-charcoal-500">{c.oppCount}</td>
                      <td className="px-5 py-2.5 text-right font-semibold text-ppp-charcoal">
                        {c.totalAmount > 0 ? fmtMoneyK(Math.round(c.totalAmount / 1000)) : "—"}
                      </td>
                      <td className="px-5 py-2.5 text-right text-xs text-ppp-charcoal-500">
                        {c.lastActivity ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* MOBILE: card list (<640px). One card per customer with the
              high-value fields surfaced and metadata stacked below. Each
              card is a full-width tap target → customer detail page.
              Round 4 mobile audit (2026-06-05) flagged the table's
              min-w-[640px] as a horizontal-scroll trap. */}
          <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
            {visible.slice(0, 200).map((c) => {
              const href = c.accountId ? `/dashboard/customer/${encodeURIComponent(c.accountId)}` : null;
              const isRepeat = c.oppCount > 1;
              const inner = (
                <div className="px-4 py-3 active:bg-ppp-charcoal-50/40 transition-colors min-h-[64px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-ppp-charcoal truncate">
                          {c.name}
                        </span>
                        {isRepeat && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-blue-50 text-ppp-blue-700 border border-ppp-blue-100">
                            Repeat
                          </span>
                        )}
                      </div>
                      {c.ownerName && (
                        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
                          {c.ownerName}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold text-sm text-ppp-charcoal">
                        {c.totalAmount > 0 ? fmtMoneyK(Math.round(c.totalAmount / 1000)) : "—"}
                      </div>
                      <div className="text-[10px] text-ppp-charcoal-500">
                        {c.woCount} WO{c.woCount === 1 ? "" : "s"} · {c.oppCount} opp{c.oppCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                  {c.lastActivity && (
                    <div className="text-[11px] text-ppp-charcoal-500 mt-1.5">
                      Last activity: {c.lastActivity}
                    </div>
                  )}
                </div>
              );
              return (
                <li key={`m::${c.accountId}::${c.name}`}>
                  {href ? (
                    <Link href={href} className="block">{inner}</Link>
                  ) : inner}
                </li>
              );
            })}
          </ul>

          {visible.length > 200 && (
            <div className="px-5 py-3 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500 text-center">
              Showing first 200 of {visible.length}. Refine your search to see more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
