"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FILTER_SEL } from "@/lib/ui/filter-chrome";
import {
  PAID_WITH_LABEL,
  RANGE_LABEL,
  ledgerQueryString,
  type LedgerQuery,
  type PaidWith,
  type RangePreset,
} from "@/lib/payments/ledger";

/**
 * The Payments tab's one filter row: period · paid with · real/test.
 *
 * Every choice becomes the page's query string (ledgerQueryString), so the
 * Export button — which reads the same string — always downloads exactly what
 * is on screen, and any view is a link you can send.
 */
export function PaymentsFilters({ q, showModeToggle }: { q: LedgerQuery; showModeToggle: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [custom, setCustom] = useState(q.preset === "custom");
  const [from, setFrom] = useState(q.preset === "custom" ? (q.from ?? "") : "");
  const [to, setTo] = useState(q.preset === "custom" ? (q.to ?? "") : "");

  const go = (over: Partial<LedgerQuery>) =>
    startTransition(() => router.push(`?${ledgerQueryString(q, over)}`, { scroll: false }));

  const onPeriod = (v: string) => {
    if (v === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    go({ preset: v as RangePreset });
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-2 transition-opacity ${pending ? "opacity-60" : ""}`}
      aria-busy={pending}
    >
      <label className="flex w-full sm:w-auto items-center gap-2 text-[12px] font-medium text-ppp-charcoal-600">
        <span className="shrink-0 w-16 sm:w-auto">Period</span>
        <select
          className={FILTER_SEL}
          value={custom ? "custom" : q.preset}
          onChange={(e) => onPeriod(e.target.value)}
        >
          {(Object.keys(RANGE_LABEL) as RangePreset[]).map((p) => (
            <option key={p} value={p}>
              {p === "custom" ? "Custom range…" : RANGE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      {custom && (
        <form
          className="flex w-full sm:w-auto items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go({ preset: "custom", from: from || null, to: to || null });
          }}
        >
          <input
            type="date"
            aria-label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={FILTER_SEL}
          />
          <span className="text-[12px] text-ppp-charcoal-500">to</span>
          <input
            type="date"
            aria-label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={FILTER_SEL}
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-ppp-navy text-white px-3 min-h-[44px] sm:min-h-[36px] text-[13px] font-semibold hover:bg-ppp-navy-900"
          >
            Apply
          </button>
        </form>
      )}

      <label className="flex w-full sm:w-auto items-center gap-2 text-[12px] font-medium text-ppp-charcoal-600">
        <span className="shrink-0 w-16 sm:w-auto">Paid with</span>
        <select
          className={FILTER_SEL}
          value={q.paidWith}
          onChange={(e) => go({ paidWith: e.target.value as PaidWith | "all" })}
        >
          <option value="all">Any method</option>
          {(Object.keys(PAID_WITH_LABEL) as PaidWith[]).map((w) => (
            <option key={w} value={w}>
              {PAID_WITH_LABEL[w]}
            </option>
          ))}
        </select>
      </label>

      {showModeToggle && (
        <div
          role="group"
          aria-label="Real or test payments"
          className="inline-flex rounded-lg border border-ppp-charcoal-200 bg-white p-0.5 sm:ml-auto"
        >
          {[
            { live: true, label: "Real" },
            { live: false, label: "Test" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={q.livemode === o.live}
              onClick={() => go({ livemode: o.live })}
              className={`rounded-md px-3 min-h-[44px] sm:min-h-[32px] text-[13px] font-semibold ${
                q.livemode === o.live ? "bg-ppp-navy text-white" : "text-ppp-charcoal-600 hover:text-ppp-navy"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
