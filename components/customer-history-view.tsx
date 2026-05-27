"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtMoneyK } from "@/lib/format";

/**
 * Full customer history view — fetches /api/admin/customer/[accountId]
 * and renders the three-section layout: identity + lifetime card, WO
 * table, mail timeline.
 *
 * Defensive rendering: each section degrades to a skeleton / empty state
 * if data is missing. The endpoint enforces scope; UI doesn't need to.
 */

type Account = {
  id: string;
  name: string;
  type: string | null;
  email: string | null;
  phone: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  accountManagerId: string | null;
  primaryContact: string | null;
  totalLifetimeRevenue: number;
  totalRevenueCFY: number;
  isBMRetailer: boolean;
  isKeyRelationship: boolean;
  lastAppointment: string | null;
  lastWorkOrderCompleted: string | null;
};

type WorkOrder = {
  id: string;
  workOrderNumber: string | null;
  status: string | null;
  workTypeName: string | null;
  amount: number;
  ownerId: string | null;
  ownerName: string | null;
  closeDate: string | null;
  createdDate: string;
};

type MailEvent = {
  id: string;
  kind:
    | "form_sent" | "form_opened" | "form_submitted"
    | "order_sent" | "order_acknowledged" | "order_delivered"
    | "reply_in";
  at: string;
  workOrderId: string;
  workOrderNumber: string | null;
  who: string;
  label: string;
  detail: string | null;
  tone: "positive" | "neutral" | "warning";
};

type Summary = {
  workOrderCount: number;
  opportunityCount: number;
  visibleRevenue: number;
  eventCount: number;
  scopeNote: "admin_full" | "worker_filtered";
  hiddenWoCount: number;
};

const KIND_ICON: Record<MailEvent["kind"], string> = {
  form_sent: "📨",
  form_opened: "👁",
  form_submitted: "✓",
  order_sent: "📦",
  order_acknowledged: "🤝",
  order_delivered: "🚚",
  reply_in: "💬",
};

export default function CustomerHistoryView({ accountId }: { accountId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [events, setEvents] = useState<MailEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customer/${encodeURIComponent(accountId)}`);
      let data: {
        ok?: boolean; account?: Account; workOrders?: WorkOrder[];
        events?: MailEvent[]; summary?: Summary;
        warnings?: string[]; error?: string; message?: string;
      };
      try {
        data = await res.json();
      } catch {
        setError(`Server returned non-JSON (HTTP ${res.status})`);
        return;
      }
      if (!res.ok || !data.ok) {
        if (res.status === 404) {
          setError("Customer not found or you don't have access.");
        } else {
          setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        }
        return;
      }
      setAccount(data.account ?? null);
      setWorkOrders(data.workOrders ?? []);
      setEvents(data.events ?? []);
      setSummary(data.summary ?? null);
      setWarnings(data.warnings ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !account) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center text-sm text-ppp-charcoal-500">
        Loading customer history…
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-3 text-sm text-ppp-orange-700 flex items-start justify-between gap-3 flex-wrap">
        <span>{error}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="shrink-0 px-3 py-1 rounded-lg border border-ppp-orange-100 bg-white text-xs font-semibold text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!account || !summary) {
    return null;
  }

  const addressLine = [account.billingStreet, account.billingCity, account.billingState, account.billingPostalCode]
    .filter(Boolean).join(", ");
  const isRepeat = summary.workOrderCount > 1;

  return (
    <div className="space-y-5 animate-fade-up">
      {warnings && warnings.length > 0 && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-2.5 text-xs text-ppp-orange-700">
          ⚠ Some history data couldn&apos;t load — view may be incomplete. ({warnings.join("; ")})
        </div>
      )}

      {/* Header card — identity + lifetime stats + badges */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500">
              Customer
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-ppp-navy">{account.name}</h2>
            <div className="text-xs text-ppp-charcoal-500 mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {isRepeat && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-blue-50 text-ppp-blue-700 border border-ppp-blue-100">
                  Repeat · {summary.workOrderCount} projects
                </span>
              )}
              {account.isKeyRelationship && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-orange-50 text-ppp-orange-700 border border-ppp-orange-100">
                  Key relationship
                </span>
              )}
              {account.isBMRetailer && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-green-50 text-ppp-green-700 border border-ppp-green-100">
                  BM Retailer
                </span>
              )}
              {account.type && (
                <span>{account.type}</span>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-navy">
              {fmtMoneyK(Math.round(account.totalLifetimeRevenue / 1000))}
            </div>
            <div className="text-[11px] text-ppp-charcoal-500">Lifetime with PPP</div>
            {account.totalRevenueCFY > 0 && (
              <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                {fmtMoneyK(Math.round(account.totalRevenueCFY / 1000))} this fiscal year
              </div>
            )}
          </div>
        </div>

        {/* Contact + scope notes */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4 text-xs">
          {account.email && (
            <div className="text-ppp-charcoal-500">
              <span className="font-semibold text-ppp-charcoal">Email:</span>{" "}
              <a href={`mailto:${account.email}`} className="hover:text-ppp-blue hover:underline">
                {account.email}
              </a>
            </div>
          )}
          {account.phone && (
            <div className="text-ppp-charcoal-500">
              <span className="font-semibold text-ppp-charcoal">Phone:</span>{" "}
              <a href={`tel:${account.phone}`} className="hover:text-ppp-blue hover:underline">
                {account.phone}
              </a>
            </div>
          )}
          {addressLine && (
            <div className="text-ppp-charcoal-500 col-span-1 sm:col-span-2">
              <span className="font-semibold text-ppp-charcoal">Address:</span>{" "}
              {addressLine}
            </div>
          )}
          {account.primaryContact && (
            <div className="text-ppp-charcoal-500">
              <span className="font-semibold text-ppp-charcoal">Contact:</span>{" "}
              {account.primaryContact}
            </div>
          )}
          {(account.lastAppointment || account.lastWorkOrderCompleted) && (
            <div className="text-ppp-charcoal-500">
              <span className="font-semibold text-ppp-charcoal">Last activity:</span>{" "}
              {account.lastAppointment ?? account.lastWorkOrderCompleted}
            </div>
          )}
        </div>

        {summary.scopeNote === "worker_filtered" && summary.hiddenWoCount > 0 && (
          <div className="mt-4 bg-ppp-charcoal-50/40 border border-ppp-charcoal-100 rounded-lg px-3 py-2 text-[11px] text-ppp-charcoal-500">
            Showing only your work for this customer. {summary.hiddenWoCount} additional work order{summary.hiddenWoCount === 1 ? "" : "s"} owned by other reps {summary.hiddenWoCount === 1 ? "is" : "are"} hidden.
          </div>
        )}
      </div>

      {/* Work orders table */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
          <h3 className="text-sm font-bold text-ppp-charcoal">
            Work orders <span className="text-ppp-charcoal-500 font-normal">· {workOrders.length}</span>
          </h3>
        </div>
        {workOrders.length === 0 ? (
          <div className="p-8 text-center text-sm text-ppp-charcoal-500">
            No work orders yet for this customer.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-ppp-charcoal-50/40 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
                <tr>
                  <th className="text-left px-5 py-2.5">WO #</th>
                  <th className="text-left px-5 py-2.5">Type</th>
                  <th className="text-left px-5 py-2.5">Status</th>
                  <th className="text-left px-5 py-2.5">Owner</th>
                  <th className="text-right px-5 py-2.5">Amount</th>
                  <th className="text-right px-5 py-2.5">Close date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {workOrders.map((w) => (
                  <tr key={w.id} className="hover:bg-ppp-charcoal-50/30 transition-colors">
                    <td className="px-5 py-2.5">
                      <Link
                        href={`/dashboard/materials?wo=${encodeURIComponent(w.id)}`}
                        className="font-mono text-ppp-charcoal hover:text-ppp-blue hover:underline"
                      >
                        {w.workOrderNumber ?? w.id.slice(-6)}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-xs text-ppp-charcoal-500">{w.workTypeName ?? "—"}</td>
                    <td className="px-5 py-2.5 text-xs">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100">
                        {w.status ?? "—"}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-xs text-ppp-charcoal-500">{w.ownerName ?? "—"}</td>
                    <td className="px-5 py-2.5 text-right font-semibold text-ppp-charcoal">
                      {w.amount > 0 ? fmtMoneyK(Math.round(w.amount / 1000)) : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-right text-xs text-ppp-charcoal-500">
                      {w.closeDate ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Mail timeline */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-ppp-charcoal">
            Mail timeline <span className="text-ppp-charcoal-500 font-normal">· {events.length}</span>
          </h3>
          {workOrders.length > 0 && (
            <Link
              href={`/dashboard/inbox?wo=${encodeURIComponent(workOrders[0].id)}`}
              className="text-[11px] font-semibold text-ppp-blue hover:text-ppp-blue-700"
            >
              Open in Mail Hub →
            </Link>
          )}
        </div>
        {events.length === 0 ? (
          <div className="p-8 text-center text-sm text-ppp-charcoal-500">
            No mail history yet for this customer.
          </div>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {events.slice(0, 50).map((e) => {
              const dotTone =
                e.tone === "positive" ? "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100"
                : e.tone === "warning" ? "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100"
                : "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100";
              return (
                <li key={e.id} className="px-5 py-3 flex items-start gap-3 hover:bg-ppp-charcoal-50/30 transition-colors">
                  <span className={`shrink-0 h-6 w-6 rounded border flex items-center justify-center text-xs ${dotTone}`}>
                    {KIND_ICON[e.kind]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ppp-charcoal">{e.label}</div>
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>{e.who}</span>
                      {e.detail && (<><span>·</span><span className="truncate">{e.detail}</span></>)}
                      {e.workOrderNumber && (
                        <>
                          <span>·</span>
                          <Link
                            href={`/dashboard/materials?wo=${encodeURIComponent(e.workOrderId)}`}
                            className="font-mono hover:text-ppp-blue hover:underline"
                          >
                            WO #{e.workOrderNumber}
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 text-[10px] text-ppp-charcoal-500 tabular-nums">
                    {formatRelative(new Date(e.at))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {events.length > 50 && (
          <div className="px-5 py-3 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500 text-center">
            Showing 50 of {events.length} events. Older history available via Mail Hub.
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelative(date: Date): string {
  const ms = Date.now() - date.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
