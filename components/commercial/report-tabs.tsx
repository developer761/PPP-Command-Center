"use client";

/**
 * Reports framework tab bar (R4) — one row across the top of every
 * /commercial/reports/* page so each report is a tab. Add a report by adding
 * a route + an entry here.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const REPORTS: { href: string; label: string; exact?: boolean; adminOnly?: boolean }[] = [
  // Overview is the index — exact-match only, else it'd read active on every
  // sub-report (they all start with /commercial/reports).
  { href: "/commercial/reports", label: "Overview", exact: true },
  { href: "/commercial/reports/pipeline", label: "Pipeline" },
  { href: "/commercial/reports/job-costs", label: "Job costs" },
  { href: "/commercial/reports/geography", label: "Geography" },
  { href: "/commercial/reports/ar-aging", label: "AR Aging" },
  { href: "/commercial/reports/win-loss", label: "Win / Loss" },
  // These exist as routes and are linked from the Reports index, but were
  // missing here — so opening one rendered a tab bar with no tab marked
  // current, and no way back to the ones that were listed.
  { href: "/commercial/reports/cash-flow", label: "Cash flow" },
  { href: "/commercial/reports/change-orders", label: "Change orders" },
  { href: "/commercial/reports/labor", label: "Labor" },
  // Estimator self-gates to admin / account_manager and redirects everyone else,
  // so it must only appear as a tab for those roles — otherwise a sales rep taps
  // it and is bounced out of Reports entirely (audit D12).
  { href: "/commercial/reports/estimator", label: "Estimator", adminOnly: true },
  // NOTE: no "Revenue" tab. That route is a redirect stub kept only so old
  // bookmarks land on the Dashboard (Revenue & P&L moved there) — linking it as
  // a tab ejected the user out of Reports on tap (audit D12).
];

export function ReportTabs({ canSeeEstimator = false }: { canSeeEstimator?: boolean }) {
  const pathname = usePathname();
  const reports = REPORTS.filter((r) => !r.adminOnly || canSeeEstimator);
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-ppp-charcoal-100 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {reports.map((r) => {
        const active = r.exact ? pathname === r.href : pathname.startsWith(r.href);
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
