"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * R10.7 - Field Ops tab bar. The interactive Calendar is the one scheduling
 * surface (Week Grid + Job Board retired). Overview leads with the week's KPIs.
 */
const TABS = [
  { label: "Overview", href: "/commercial/field-ops/overview" },
  { label: "Calendar", href: "/commercial/field-ops/calendar" },
  { label: "Work Orders", href: "/commercial/field-ops/jobs" },
  { label: "Status", href: "/commercial/field-ops/status" },
  { label: "Crew", href: "/commercial/field-ops/employees" },
  { label: "Approvals", href: "/commercial/field-ops/approvals" },
  { label: "Hours Log", href: "/commercial/field-ops/hours" },
  { label: "Payroll", href: "/commercial/field-ops/payroll" },
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
