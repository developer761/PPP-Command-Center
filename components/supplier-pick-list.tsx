"use client";

import { useEffect, useState } from "react";
import { rankVendors, vendorGroupLabel } from "@/lib/supplier-order/vendor-ranking";

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
  /** Two-letter state of this branch; null when nobody has told us. */
  state?: string | null;
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
  const [favorites, setFavorites] = useState<string[]>([]);
  /** The signed-in person's state — the list filters to it (Katie 2026-10-02).
   *  Null until loaded, and null for anyone whose state is unset, both of
   *  which show the whole list rather than none of it. */
  const [userState, setUserState] = useState<string | null>(null);

  // Separate from the vendor list on purpose — that one is global and cached,
  // this one is per-user and must not be. A failure here is silent: an
  // unsorted list is still a working list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/suppliers/favorites", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data?.favorites)) setFavorites(data.favorites);
        if (typeof data?.userState === "string" || data?.userState === null) setUserState(data.userState);
      } catch {
        /* the picker works unsorted */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleFavorite = async (accountId: string) => {
    const on = favorites.includes(accountId);
    // Optimistic: starring is a preference, and waiting on a round trip to
    // show a star is the kind of lag that makes people click twice.
    setFavorites((cur) => (on ? cur.filter((x) => x !== accountId) : [...cur, accountId]));
    try {
      await fetch("/api/suppliers/favorites", {
        method: on ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierAccountId: accountId }),
      });
    } catch {
      setFavorites((cur) => (on ? [...cur, accountId] : cur.filter((x) => x !== accountId)));
    }
  };

  useEffect(() => {
    let cancelled = false;
    // setState lives inside the async body, not the effect body — a synchronous
    // set here cascades an extra render on every mount.
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/suppliers/active", { cache: "no-store" });
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

  // Filtered to the person's state, favorites first (Katie 2026-10-02:
  // "NJ based guys see NJ Vendors, NY sees NY vendors … then they can utilize
  // the Favorites feature from that filtered list"). Applied after the search
  // so typing still searches within what they are allowed to see.
  const ranked = rankVendors({ vendors: filtered, favoriteIds: favorites, userState });

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
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded-lg border border-ppp-orange-100 bg-white text-xs font-medium text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors touch-manipulation"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12a9 9 0 1 1-3.51-7.13" /><path d="M21 3v6h-6" />
              </svg>
              Try again
            </button>
          </div>
        )}
        {/* Judged on `ranked`, NOT `filtered`. The state filter is applied after
            the search, so a person whose state matches no vendor had
            filtered.length > 0 and ranked.length === 0 — and fell through every
            branch below to render an empty box with no message at all.
            Reachable two ways: a two-letter typo ("NU" for "NJ"), and a real
            state we simply have no vendor in yet. */}
        {!loading && !error && ranked.length === 0 && (
          <div className="p-6 text-center text-sm text-ppp-charcoal-500">
            {suppliers.length > 0 && filtered.length > 0 ? (
              <>
                <div className="font-medium text-ppp-charcoal">
                  No vendors in {(userState ?? "").trim().toUpperCase() || "your state"}.
                </div>
                <div className="mt-1.5 leading-snug">
                  Your account is set to{" "}
                  <span className="font-semibold">{(userState ?? "").trim().toUpperCase()}</span>, and
                  every vendor we have is somewhere else. Check the state on your account &mdash;
                  or clear it to see all {suppliers.length}.
                </div>
                <a
                  href="/dashboard/account"
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] sm:min-h-0 rounded-lg border border-ppp-blue-200 bg-ppp-blue-50 text-xs font-semibold text-ppp-blue-700 hover:bg-ppp-blue-100 transition-colors touch-manipulation"
                >
                  Open account settings
                </a>
              </>
            ) : suppliers.length === 0 ? (
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
          {ranked.map(({ vendor: s, group }, i) => (
            <li key={s.accountId}>
              {/* A heading the first time each group appears. Only ever two or
                  three of these, and they are what make the reordering legible
                  rather than mysterious. */}
              {group !== ranked[i - 1]?.group && (
                <div className="px-4 sm:px-5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ppp-charcoal-500 bg-[var(--color-surface-muted)]">
                  {vendorGroupLabel(group, userState)}
                </div>
              )}
              <div className="flex items-stretch">
              <button
                type="button"
                onClick={() => onPick(s)}
                className={[
                  "w-full text-left px-4 sm:px-5 py-3.5 sm:py-3 min-h-[64px] sm:min-h-0",
                  "hover:bg-ppp-blue-50/40 active:bg-ppp-blue-50 transition-colors touch-manipulation",
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
                      {s.state && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-ppp-green-50 text-ppp-green-700 border border-ppp-green-100" title={`This branch is in ${s.state}`}>
                          {s.state}
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
              {/* OUTSIDE the pick button, not inside it — a star nested in the
                  row button would select the vendor as well as star it, and
                  nested interactive elements are invalid markup besides. */}
              <button
                type="button"
                onClick={() => toggleFavorite(s.accountId)}
                aria-pressed={favorites.includes(s.accountId)}
                aria-label={favorites.includes(s.accountId) ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
                title={favorites.includes(s.accountId) ? "Remove from your favorites" : "Add to your favorites"}
                className={`shrink-0 px-3 min-h-[44px] flex items-center text-lg leading-none touch-manipulation transition-colors ${
                  favorites.includes(s.accountId)
                    ? "text-ppp-orange-700 hover:text-ppp-orange-600"
                    : "text-ppp-charcoal-300 hover:text-ppp-charcoal-500"
                }`}
              >
                {favorites.includes(s.accountId) ? "★" : "☆"}
              </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
