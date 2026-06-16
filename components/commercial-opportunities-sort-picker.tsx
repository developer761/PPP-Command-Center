"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Sort picker for /commercial/opportunities. Tiny client island so the
 * select auto-submits on change (no separate "Apply" button needed).
 * Pulls the current URL filters out of `useSearchParams` and overrides
 * the `sort` key — so picking a sort never wipes the user's search,
 * status, sources, hot, or stale filters.
 *
 * "recent" is the default; we drop the param to keep the URL clean.
 */
export default function CommercialOpportunitiesSortPicker({
  options,
  value,
}: {
  options: ReadonlyArray<{ key: string; label: string }>;
  value: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor="opp-sort" className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
        Sort
      </label>
      <select
        id="opp-sort"
        defaultValue={value}
        onChange={(e) => {
          const next = new URLSearchParams(sp.toString());
          const v = e.target.value;
          if (v && v !== "recent") next.set("sort", v);
          else next.delete("sort");
          const qs = next.toString();
          router.push(qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities");
        }}
        className="px-2 py-1 text-base sm:text-[12px] border border-ppp-charcoal-200 rounded-lg bg-white text-ppp-charcoal-700 font-medium focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-[36px]"
      >
        {options.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
