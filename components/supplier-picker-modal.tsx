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
  phoneOnly: boolean;
  phoneNumber: string | null;
  pickupDefault: boolean;
  isActive: boolean;
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
            className="shrink-0 h-11 w-11 sm:h-10 sm:w-10 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors flex items-center justify-center touch-manipulation"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-ppp-charcoal-100 shrink-0 flex items-center gap-2">
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
            className="flex-1 min-w-0 px-3 py-2 sm:py-1.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
          />
          {/* Katie 2026-06-10: admin needs a one-tap way to add a missing
              supplier without losing the in-flight order. New tab keeps the
              picker open + lets them come back and re-search. */}
          <a
            href="/dashboard/settings/suppliers?new=1"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 px-3 py-2 sm:py-1.5 text-xs sm:text-[11px] font-semibold uppercase tracking-wider rounded-lg border border-ppp-blue-200 bg-ppp-blue-50 text-ppp-blue-700 hover:bg-ppp-blue-100 active:bg-ppp-blue-100 transition-colors touch-manipulation"
            title="Open Settings → Suppliers in a new tab"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            Add
          </a>
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
                  <div>No active suppliers configured yet.</div>
                  <a
                    href="/dashboard/settings/suppliers?new=1"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-blue-200 bg-ppp-blue-50 text-xs font-semibold text-ppp-blue-700 hover:bg-ppp-blue-100 transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 5v14 M5 12h14" />
                    </svg>
                    Add a supplier
                  </a>
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
                  className={[
                    // Larger tap target on mobile (min-h 64px), normal on desktop.
                    "w-full text-left px-4 sm:px-5 py-3.5 sm:py-3 min-h-[64px] sm:min-h-0",
                    "hover:bg-ppp-blue-50/40 active:bg-ppp-blue-50 transition-colors touch-manipulation",
                    !s.isActive ? "opacity-70" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] sm:text-sm font-semibold text-ppp-charcoal flex items-center gap-1.5 flex-wrap leading-tight">
                        <span className="truncate">{s.name}</span>
                        {s.isBMRetailer && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-orange-50 text-ppp-orange-700 border border-ppp-orange-100">
                            BM
                          </span>
                        )}
                        {s.phoneOnly && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-blue-50 text-ppp-blue-700 border border-ppp-blue-100" title="Phone orders only — no email">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
                            </svg>
                            Phone
                          </span>
                        )}
                        {s.pickupDefault && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-charcoal-50 text-ppp-charcoal-700 border border-ppp-charcoal-100" title="Pickup is the default for this supplier">
                            Pickup
                          </span>
                        )}
                        {!s.isActive && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-charcoal-50 text-ppp-charcoal-500 border border-ppp-charcoal-100" title="Soft-retired in Settings. Still usable.">
                            Inactive
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] sm:text-[11px] text-ppp-charcoal-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {s.phoneOnly && s.phoneNumber ? (
                          <span className="font-mono text-ppp-blue-700">{s.phoneNumber}</span>
                        ) : (
                          <span className="truncate min-w-0">{s.orderEmail}</span>
                        )}
                        {s.pppAccountNumber && (
                          <>
                            <span>·</span>
                            <span className="font-mono">Acct {s.pppAccountNumber}</span>
                          </>
                        )}
                        {s.hasPickupLocations && !s.pickupDefault && (
                          <>
                            <span>·</span>
                            <span>Pickup configured</span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 text-ppp-blue text-lg leading-none" aria-hidden>→</span>
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
