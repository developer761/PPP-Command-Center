"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * R10.2 - Field Ops tab bar. Week Grid + Calendar + Board + Work Orders + Crew
 * are their own tabs under Field Ops (mirrors the Reports tab framework).
 */
const TABS = [
  { label: "Week Grid", href: "/commercial/field-ops/schedule" },
  { label: "Calendar", href: "/commercial/field-ops/calendar" },
  { label: "Job Board", href: "/commercial/field-ops/board" },
  { label: "Work Orders", href: "/commercial/field-ops/jobs" },
  { label: "Approvals", href: "/commercial/field-ops/approvals" },
  { label: "Crew", href: "/commercial/field-ops/employees" },
  { label: "Clock Station", href: "/commercial/field-ops/clock-station" },
];

export function FieldOpsTabs() {
  const pathname = usePathname();
  return (
    <div className="border-b border-ppp-charcoal-100 mb-4">
      <nav className="flex gap-1 overflow-x-auto -mb-px" aria-label="Field Ops">
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + "/");
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`shrink-0 px-3.5 py-2.5 text-[13px] font-semibold border-b-2 transition-colors min-h-[44px] inline-flex items-center ${
                active
                  ? "border-cc-brand-600 text-cc-brand-700"
                  : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-200"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
