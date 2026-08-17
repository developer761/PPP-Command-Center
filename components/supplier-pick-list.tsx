"use client";

import { useEffect, useState } from "react";

/**
 * The active-supplier list, with no modal chrome around it.
 *
 * Kate round-3 #18 asked for vendor selection to become "a pick list on that
 * same page, rather than a separate pop-up" — the pop-up was one of the things
 * that opened wherever the page happened to be scrolled (#21). Extracted from
 * supplier-picker-modal.tsx so the modal and the order builder share one
 * implementation instead of drifting.
 */

export type ActiveSupplier = {
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

export default function SupplierPickList({
  onPick,
  excludeIds = [],
}: {
  onPick: (supplier: ActiveSupplier) => void;
  excludeIds?: string[];
}) {
  const [suppliers, setSuppliers] = useState<ActiveSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // setState lives inside the async body, not the effect body — a synchronous
    // set here cascades an extra render on every mount.
    (async () => {
      setLoading(true);
      setError(null);
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
    <div>
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center gap-2">
        <input
          type="search"
          inputMode="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search suppliers…"
          className="flex-1 min-w-0 px-3 py-2 sm:py-1.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
        <a
          href="/dashboard/settings/suppliers?new=1"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 px-3 py-2 sm:py-1.5 text-xs sm:text-[11px] font-semibold uppercase tracking-wider rounded-lg border border-ppp-blue-200 bg-ppp-blue-50 text-ppp-blue-700 hover:bg-ppp-blue-100 transition-colors touch-manipulation"
          title="Open Settings → Suppliers in a new tab"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          Add
        </a>
      </div>

      <div className="max-h-[26rem] overflow-y-auto">
        {loading && <div className="p-6 text-center text-sm text-ppp-charcoal-500">Loading suppliers…</div>}
        {error && (
          <div className="p-6 text-center">
            <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
              Couldn&apos;t load suppliers: {error}
            </div>
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded-lg border border-ppp-orange-200 bg-white text-xs font-medium text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors touch-manipulation"
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
                onClick={() => onPick(s)}
                className={[
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
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-blue-50 text-ppp-blue-700 border border-ppp-blue-100" title="Phone orders only — no email">
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
  );
}
