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
      { label: "Accounts", href: "/commercial/accounts", icon: <IconBuilding /> },
      { label: "Opportunities", href: "/commercial/opportunities", icon: <IconTarget /> },
      // Estimates entry removed 2026-06-24 — Phase 3 ships invoicing
      // without estimates first (Karan: "i dont thinkw e need the
      // estimates for right now"). We may add it back as Phase 3.5 if
      // Alex asks for "what we quoted vs billed" history.
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
      // Bumped from phase 8 → 3 on 2026-06-24 when invoicing moved
      // ahead in the roadmap. Stays disabled until Phase 3 ships; the
      // disabled state still surfaces the link so Alex sees what's
      // coming next.
      { label: "Invoices", href: "/commercial/invoices", phase: 3, disabled: true, icon: <IconDollar /> },
    ],
  },
  // NEW Reports group — promoted out of "Financials" (win/loss is sales
  // effectiveness, not financial). First entry = Win/Loss Debrief reports
  // (Karan 2026-06-24). Future reports (Revenue, Project Margin, Pipeline
  // Velocity, Salesperson Scorecard) land here as they ship.
  {
    heading: "Reports",
    items: [
      { label: "Win/Loss", href: "/commercial/reports/win-loss", icon: <IconChart /> },
      // Revenue dashboard ships with Phase 3 invoicing. Disabled until
      // then so Alex sees what's coming.
      { label: "Revenue", href: "/commercial/reports/revenue", phase: 3, disabled: true, icon: <IconChart /> },
    ],
  },
  // Settings sits at the bottom of the nav (after the workflow groups).
  // Karan 2026-06-23: moved here from a top-of-sidebar slot next to
  // Dashboard so it doesn't compete with workflow links for attention.
  // Karan 2026-06-24: added Competitors (admin-only dictionary for the
  // Win/Loss Debrief typeahead — merge/retire duplicates).
  {
    heading: "Settings",
    items: [
      { label: "Setup Health", href: "/commercial/settings/health", icon: <IconHeart /> },
      { label: "Competitors", href: "/commercial/settings/competitors", icon: <IconUsers /> },
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
    // Same white/clean shape as the PPP CC sidebar. Red is the ACCENT
    // (active pill background + logo tag), not the whole chrome.
    // Karan 2026-07-01: "do the same format as PPP command center just
    // like different colors, red and blue for the commercial side."
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
          <div className="mt-3 inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cc-brand-600" />
            <span className="font-condensed text-[10px] font-bold tracking-[0.16em] text-cc-brand-700 uppercase leading-tight">
              Commercial<br />Command Center
            </span>
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
                      <div className={`${baseClasses} text-ppp-charcoal-400 cursor-not-allowed select-none`} title={item.phase ? `Coming in Phase ${item.phase}` : "Coming soon"}>
                        <span className="text-ppp-charcoal-300">{item.icon}</span>
                        <span className="flex-1">{item.label}</span>
                        {item.phase != null && (
                          <span className="shrink-0 text-[9px] font-bold tracking-wider uppercase text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 px-1.5 py-0.5 rounded">
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
                      className={[
                        baseClasses,
                        active
                          ? "bg-cc-brand-50 text-cc-brand-700"
                          : "text-ppp-charcoal hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-50",
                      ].join(" ")}
                    >
                      <span className={active ? "text-cc-brand-600" : "text-ppp-charcoal-500"}>
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
        <div className="font-semibold text-ppp-charcoal">Phase 3 · Invoicing</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-cc-brand-500 animate-pulse" aria-hidden />
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

function IconUsers() {
  // Two-figure silhouette — competitor dictionary (groups of organizations).
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconHeart() {
  // Heart-pulse — represents health-check/monitoring without using the
  // generic "gear" icon other settings rows often share. Communicates
  // "platform vitals" at a glance.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      <polyline points="3.5 12 8 12 10 9 14 15 16 12 20.5 12" />
    </svg>
  );
}
