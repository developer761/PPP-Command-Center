"use client";

/**
 * Reports framework tab bar (R4) — one row across the top of every
 * /commercial/reports/* page so each report is a tab. Add a report by adding
 * a route + an entry here.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const REPORTS: { href: string; label: string }[] = [
  { href: "/commercial/reports/pipeline", label: "Pipeline" },
  { href: "/commercial/reports/job-costs", label: "Job costs" },
  { href: "/commercial/reports/ar-aging", label: "AR Aging" },
  { href: "/commercial/reports/win-loss", label: "Win / Loss" },
];

export function ReportTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-ppp-charcoal-100 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {REPORTS.map((r) => {
        const active = pathname.startsWith(r.href);
        return (
          <Link
            key={r.href}
            href={r.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 px-3 py-2 text-[13px] font-semibold border-b-2 min-h-[44px] inline-flex items-center touch-manipulation transition-colors ${
              active
                ? "border-cc-brand-600 text-ppp-charcoal"
                : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-200"
            }`}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
