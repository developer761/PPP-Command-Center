"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { SCORECARD_PERIOD_OPTIONS, type ScorecardPeriodKey } from "@/lib/fiscal-year";

/**
 * Scorecard period switch (Katie 2026-05-29) — Prior Quarter (default) /
 * Current Quarter / Prior FY / Current FY. Updates the ?scPeriod= URL param,
 * preserving any existing params (view_as / scope), so the server component
 * re-derives the scorecard for the chosen period.
 */
export default function ScorecardPeriodPicker({ value }: { value: ScorecardPeriodKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(sp.toString());
    params.set("scPeriod", e.target.value);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <label className="inline-flex flex-col items-end gap-0.5">
      <span className="font-condensed text-xs uppercase tracking-wide text-ppp-charcoal-500">
        Scorecard period
      </span>
      <select
        value={value}
        onChange={onChange}
        className="text-base sm:text-xs font-medium text-ppp-navy bg-white border border-ppp-charcoal-200 rounded-md px-2 py-2.5 sm:py-1 min-h-[44px] sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-ppp-blue-100 cursor-pointer touch-manipulation"
      >
        {SCORECARD_PERIOD_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
