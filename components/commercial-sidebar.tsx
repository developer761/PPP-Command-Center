"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import PlatformSwitcher from "@/components/platform-switcher";

/**
 * New Platform sidebar — sibling to components/sidebar.tsx (Command Center).
 *
 * Phase 0 ships with just the structure: brand + section headers + the
 * bottom-left switcher block. Per-phase nav items unlock as their phases
 * ship (Accounts in Phase 1, Opportunities in Phase 2, etc.). Items
 * pointing at not-yet-built routes are marked disabled so users see what's
 * coming without 404s.
 *
 * Strict separation: this component MUST NOT import from `lib/salesforce/*`
 * or any Command Center derive layer — the New Platform is Postgres-native.
 */

type NavItem = {
  label: string;
  href: string;
  /** Phase N from the plan doc. Visible as a "Phase N" tag until shipped. */
  phase?: number;
  /** When true, render greyed-out + no Link — the route doesn't exist yet. */
  disabled?: boolean;
  icon: React.ReactNode;
};

type NavSection = { heading: string; items: NavItem[] };

const navSections: NavSection[] = [
  {
    heading: "Overview",
    items: [
      { label: "Dashboard", href: "/commercial", icon: <IconHome /> },
    ],
  },
  {
    heading: "Pipeline",
    items: [
      { label: "Accounts", href: "/commercial/accounts", phase: 1, disabled: true, icon: <IconBuilding /> },
      { label: "Opportunities", href: "/commercial/opportunities", phase: 2, disabled: true, icon: <IconTarget /> },
      { label: "Estimates", href: "/commercial/estimates", phase: 3, disabled: true, icon: <IconCalc /> },
    ],
  },
  {
    heading: "Projects",
    items: [
      { label: "Projects", href: "/commercial/projects", phase: 5, disabled: true, icon: <IconHardHat /> },
      { label: "Change Orders", href: "/commercial/change-orders", phase: 7, disabled: true, icon: <IconChangeOrder /> },
      { label: "Closeout", href: "/commercial/closeout", phase: 9, disabled: true, icon: <IconCheckSquare /> },
    ],
  },
  {
    heading: "Financials",
    items: [
      { label: "Billing", href: "/commercial/billing", phase: 8, disabled: true, icon: <IconDollar /> },
      { label: "Reports", href: "/commercial/reports", disabled: true, icon: <IconChart /> },
    ],
  },
];

type Props = {
  /** Set when the viewer also has Command Center access — only then is the
   *  switcher block at the bottom-left rendered. */
  showSwitcher: boolean;
  onNavigate?: () => void;
};

export default function CommercialSidebar({ showSwitcher, onNavigate }: Props) {
  const pathname = usePathname();

  return (
    <aside className="w-64 lg:w-64 h-full bg-white border-r border-ppp-charcoal-100 flex flex-col shrink-0">
      <div className="px-6 py-5 lg:py-6 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <Link href="/commercial" className="block" onClick={onNavigate}>
          <Image
            src="/brand/logo.svg"
            alt="Precision Painting Plus"
            width={180}
            height={60}
            priority
          />
          <div className="font-condensed mt-3 text-[11px] font-bold tracking-[0.18em] uppercase text-emerald-700">
            New Platform
          </div>
        </Link>
        {onNavigate && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Close menu"
            className="lg:hidden flex items-center justify-center h-11 w-11 rounded-lg text-ppp-charcoal-500 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {navSections.map((section, sectionIdx) => (
          <div key={section.heading} className={sectionIdx > 0 ? "mt-6" : ""}>
            <div className="font-condensed px-3 mb-2 text-[10px] font-semibold tracking-[0.18em] text-ppp-charcoal-500 uppercase">
              {section.heading}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  item.href === "/commercial"
                    ? pathname === "/commercial"
                    : pathname.startsWith(item.href);
                const baseClasses = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors";

                if (item.disabled) {
                  return (
                    <li key={item.href}>
                      <div className={`${baseClasses} text-ppp-charcoal-300 cursor-not-allowed select-none`} title={item.phase ? `Coming in Phase ${item.phase}` : "Coming soon"}>
                        <span className="text-ppp-charcoal-300">{item.icon}</span>
                        <span className="flex-1">{item.label}</span>
                        {item.phase != null && (
                          <span className="shrink-0 text-[9px] font-bold tracking-wider uppercase text-ppp-charcoal-500 bg-ppp-charcoal-50 px-1.5 py-0.5 rounded">
                            Phase {item.phase}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={`${baseClasses} ${active ? "bg-emerald-50 text-emerald-700" : "text-ppp-charcoal hover:bg-ppp-charcoal-50"}`}
                    >
                      <span className={active ? "text-emerald-700" : "text-ppp-charcoal-500"}>
                        {item.icon}
                      </span>
                      <span className="flex-1">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* Platform switcher — same shape + position as the Command Center
            sidebar: last item inside the nav block so it scrolls with the
            other items. Visible only to multi-platform users. */}
        {showSwitcher && (
          <div className="mt-6 pt-4 border-t border-ppp-charcoal-100">
            <div className="font-condensed px-3 mb-2 text-[10px] font-semibold tracking-[0.18em] text-ppp-charcoal-500 uppercase">
              Platforms
            </div>
            <PlatformSwitcher current="new_platform" />
          </div>
        )}
      </nav>

      <div className="px-6 py-4 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
        <div className="font-semibold text-ppp-charcoal">Phase 0 · Foundation</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
          Postgres-native
        </div>
      </div>
    </aside>
  );
}

/* Icons */
function IconHome() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9.5L12 3l9 6.5V21H3z M9 21V12h6v9" />
    </svg>
  );
}
function IconBuilding() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 22v-4h6v4 M8 6h2 M14 6h2 M8 10h2 M14 10h2 M8 14h2 M14 14h2" />
    </svg>
  );
}
function IconTarget() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
function IconCalc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M8 6h8 M8 10h2 M12 10h2 M16 10h0 M8 14h2 M12 14h2 M16 14h0 M8 18h8" />
    </svg>
  );
}
function IconHardHat() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 18a10 10 0 0 1 20 0 M10 6a2 2 0 0 1 4 0v6 M3 18h18 M3 22h18" />
    </svg>
  );
}
function IconChangeOrder() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13l3 3 5-5" />
    </svg>
  );
}
function IconCheckSquare() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}
function IconDollar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18 M7 14l4-4 4 4 5-5" />
    </svg>
  );
}
