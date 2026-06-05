"use client";

import { useEffect, useState } from "react";
import { useEscClose } from "@/lib/hooks/use-esc-close";

/**
 * Lightweight picker that lets workers manually choose a supplier when
 * the WO's paint colors don't have a manufacturer set on Salesforce, OR
 * when admin needs to send to a supplier the WO doesn't auto-detect.
 *
 * Lists admin-configured ACTIVE suppliers from supplier_settings (via
 * /api/suppliers/active). Click a supplier → pass back to caller which
 * opens the normal SupplierOrderModal flow with that supplier preselected.
 */

type ActiveSupplier = {
  accountId: string;
  name: string;
  orderEmail: string;
  pppAccountNumber: string | null;
  isBMRetailer: boolean;
  hasPickupLocations: boolean;
};

export default function SupplierPickerModal({
  onClose,
  onPick,
  excludeIds = [],
}: {
  onClose: () => void;
  onPick: (supplier: ActiveSupplier) => void;
  /** Suppliers already auto-detected from WO — hide from picker to avoid
   *  showing the same option twice. */
  excludeIds?: string[];
}) {
  const [suppliers, setSuppliers] = useState<ActiveSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Bumped by the Try-again button so the load effect re-runs cleanly with a
   *  fresh cancellation flag — simpler than tracking a separate fetch promise. */
  const [retryNonce, setRetryNonce] = useState(0);

  useEscClose(onClose);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/suppliers/active");
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setError(data.message ?? data.error ?? `HTTP ${res.status}`);
          return;
        }
        setSuppliers((data.suppliers ?? []) as ActiveSupplier[]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [retryNonce]);

  const filtered = suppliers
    .filter((s) => !excludeIds.includes(s.accountId))
    .filter((s) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.orderEmail.toLowerCase().includes(q);
    });

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-ppp-navy/40 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 w-full sm:max-w-md max-h-[80vh] bg-white border border-ppp-charcoal-100 rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-ppp-charcoal/20 overflow-hidden flex flex-col animate-fade-up">
        <div className="px-5 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3 className="text-base font-bold text-ppp-navy">Pick a supplier</h3>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              Order from any of your active suppliers.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 h-11 w-11 sm:h-9 sm:w-9 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors flex items-center justify-center touch-manipulation"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-ppp-charcoal-100 shrink-0">
          <input
            type="search"
            inputMode="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search suppliers…"
            // text-base on mobile prevents iOS zoom-on-focus.
            className="w-full px-3 py-2 sm:py-1.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-6 text-center text-sm text-ppp-charcoal-500">Loading suppliers…</div>
          )}
          {error && (
            <div className="p-6 text-center">
              <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
                Couldn&apos;t load suppliers: {error}
              </div>
              <button
                type="button"
                onClick={() => setRetryNonce((n) => n + 1)}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-orange-200 bg-white text-xs font-medium text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a9 9 0 1 1-3.51-7.13" /><path d="M21 3v6h-6" />
                </svg>
                Try again
              </button>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="p-6 text-center text-sm text-ppp-charcoal-500">
              {suppliers.length === 0 ? (
                <>
                  No active suppliers configured yet.<br />
                  <span className="text-[11px]">Admin can add them in <strong>Settings → Suppliers</strong>.</span>
                </>
              ) : (
                "No suppliers match the search."
              )}
            </div>
          )}
          <ul className="divide-y divide-ppp-charcoal-100">
            {filtered.map((s) => (
              <li key={s.accountId}>
                <button
                  type="button"
                  onClick={() => { onPick(s); onClose(); }}
                  className="w-full text-left px-5 py-3 hover:bg-ppp-charcoal-50/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-ppp-charcoal flex items-center gap-2 flex-wrap">
                        {s.name}
                        {s.isBMRetailer && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-orange-50 text-ppp-orange-700 border border-ppp-orange-100">
                            BM Retailer
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex flex-wrap items-center gap-x-2">
                        <span className="truncate">{s.orderEmail}</span>
                        {s.pppAccountNumber && (
                          <>
                            <span>·</span>
                            <span className="font-mono">Acct {s.pppAccountNumber}</span>
                          </>
                        )}
                        {s.hasPickupLocations && (
                          <>
                            <span>·</span>
                            <span>Pickup configured</span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 text-ppp-blue text-xs">→</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
