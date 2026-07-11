"use client";

/**
 * Hover-card preview for account names. Karan 2026-07-11
 * signature-moments Tier 2: hovering any account name shows a small
 * popover with the company's key stats — no click needed. Zero-click
 * preview.
 *
 * Wrap any account name link with `<AccountHoverCard accountId={id}>`
 * and it will render a preview card on hover after a 250ms delay so
 * accidental hovers don't fire spurious API requests. Cached in a
 * shared Map keyed by account_id so returning to the same name doesn't
 * refetch.
 *
 * The card renders: avatar + company name + city/state + counts (open
 * bids, invoiced $, last-active). Data source:
 * `/api/commercial/account-summary/[id]` — single lightweight endpoint.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { accountColorTone } from "@/lib/commercial/account-tone";
import { relativeAgo } from "@/lib/commercial/dates";

type AccountSummary = {
  id: string;
  company_name: string;
  city: string | null;
  state: string | null;
  industry: string | null;
  open_bids_count: number;
  invoiced_cents: number;
  last_activity_at: string | null;
};

const cache = new Map<string, AccountSummary>();

export function AccountHoverCard({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<AccountSummary | null>(
    cache.get(accountId) ?? null
  );
  const [loading, setLoading] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scheduleOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      setVisible(true);
    }, 250);
  };

  const closeNow = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    setVisible(false);
  };

  useEffect(() => {
    if (!visible) return;
    if (cache.has(accountId)) {
      setData(cache.get(accountId)!);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/commercial/account-summary/${accountId}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) return;
        const body = (await res.json()) as AccountSummary;
        cache.set(accountId, body);
        setData(body);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          // Silent — hover preview is bestand won't block user flow.
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [visible, accountId]);

  const tone = accountColorTone(accountId);

  return (
    <span
      className="relative inline-block"
      onMouseEnter={scheduleOpen}
      onMouseLeave={closeNow}
      onFocus={scheduleOpen}
      onBlur={closeNow}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className="absolute z-40 top-full left-0 mt-2 w-64 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl overflow-hidden pointer-events-none"
        >
          <span className="block px-3 py-2.5 border-l-4" style={tone.border}>
            {loading && !data ? (
              <span className="block text-[12px] text-ppp-charcoal-500 italic">
                Loading preview…
              </span>
            ) : data ? (
              <>
                <span
                  className="block text-[13px] font-bold truncate"
                  style={tone.nameText}
                >
                  {data.company_name}
                </span>
                {(data.city || data.state) && (
                  <span className="block text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
                    {[data.city, data.state].filter(Boolean).join(", ")}
                  </span>
                )}
                <span className="block mt-2 text-[11.5px] text-ppp-charcoal-700 space-y-0.5">
                  <span className="block">
                    <strong>{data.open_bids_count}</strong> open bid
                    {data.open_bids_count === 1 ? "" : "s"}
                  </span>
                  {data.invoiced_cents > 0 && (
                    <span className="block">
                      <strong>${(data.invoiced_cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> invoiced
                    </span>
                  )}
                  <span className="block text-ppp-charcoal-500">
                    Active {relativeAgo(data.last_activity_at)}
                  </span>
                </span>
              </>
            ) : (
              <span className="block text-[12px] text-ppp-charcoal-500 italic">
                No preview available.
              </span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
