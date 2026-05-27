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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => {
      const hay = `${c.name} ${c.ownerName ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [customers, search]);

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
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or rep…"
            className="w-full pl-7 pr-3 py-1.5 text-xs border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
          />
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-500 pointer-events-none"
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
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
                  const isRepeat = c.woCount > 1;
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
