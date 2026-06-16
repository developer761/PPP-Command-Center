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
        className="appearance-none cursor-pointer pl-3 pr-9 py-2 text-base sm:text-[12px] border border-ppp-charcoal-200 rounded-xl bg-white text-ppp-charcoal-700 font-medium focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 hover:border-ppp-charcoal-300 min-h-[44px] sm:min-h-[36px] shadow-sm transition-colors bg-no-repeat"
        style={{
          backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`
          )}")`,
          backgroundPosition: "right 0.75rem center",
          backgroundSize: "12px 12px",
        }}
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
