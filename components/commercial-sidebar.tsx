"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
  /** Only render for platform admins (e.g. Access — user provisioning). */
  adminOnly?: boolean;
  icon: React.ReactNode;
};

/** A collapsible parent that nests leaf items (e.g. "Delivery Tools" wraps the
 *  six post-contract production tools so Post-Contract reads as 3 rows, not 9). */
type NavGroup = {
  group: string;
  icon: React.ReactNode;
  items: NavItem[];
};

type NavEntry = NavItem | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return (e as NavGroup).group !== undefined;
}

type NavSection = { heading: string; items: NavEntry[] };

// Shared row geometry for every nav row (leaf, group header, disabled). min-h
// clears the 44px mobile tap-target floor; desktop keeps its tighter rhythm.
const NAV_ROW =
  "flex items-center gap-3 px-3 py-2 lg:py-2.5 min-h-[44px] lg:min-h-0 rounded-lg text-sm font-medium transition-colors touch-manipulation";

const navSections: NavSection[] = [
  {
    heading: "Overview",
    items: [
      { label: "Dashboard", href: "/commercial", icon: <IconHome /> },
      { label: "Notifications", href: "/commercial/notifications", icon: <IconBell /> },
    ],
  },
  // Karan 2026-07-09 Phase A / 07-10 Phase A.2: post-meeting restructure.
  // Two-lobe platform — Pre-Contract (sell + build proposal) vs
  // Post-Contract (deliver + bill). Labels match Brendan's email verbatim.
  // Project + Submittals + Closeout ship in Phases H, I, L. Product /
  // Exclusions libraries ship in Phases D, E.
  {
    heading: "Pre-Contract",
    items: [
      { label: "Accounts", href: "/commercial/accounts", icon: <IconBuilding /> },
      { label: "Opportunities", href: "/commercial/opportunities", icon: <IconTarget /> },
      { label: "Proposals", href: "/commercial/proposals", icon: <IconChart /> },
      { label: "Products", href: "/commercial/pre-job/products", icon: <IconDollar /> },
      { label: "Exclusions", href: "/commercial/pre-job/exclusions", icon: <IconCheckSquare /> },
    ],
  },
  {
    heading: "Post-Contract",
    items: [
      // Karan 2026-07-29: Projects is the hub, Invoices second. RUX-1 (2026-08):
      // the six production tools were 6 flat rows crowding this section (8 total)
      // — collapsed under a "Delivery Tools" group so Post-Contract reads as 3
      // rows. The group auto-opens when one of its tools (or a tool detail page)
      // is active. Canonical tool order: Work Order → Submittals → Change Orders
      // → AIA → Costs → Closeout (production sequence).
      { label: "Projects", href: "/commercial/projects", icon: <IconHardHat /> },
      { label: "Invoices", href: "/commercial/invoices", icon: <IconDollar /> },
      {
        group: "Delivery Tools",
        icon: <IconTools />,
        items: [
          { label: "Work Orders", href: "/commercial/post-job/work-orders", icon: <IconClipboard /> },
          { label: "Submittals", href: "/commercial/post-job/submittals", icon: <IconChangeOrder /> },
          { label: "Change Orders", href: "/commercial/post-job/change-orders", icon: <IconRefresh /> },
          { label: "AIA Billing", href: "/commercial/post-job/aia", icon: <IconFileText /> },
          { label: "Costs & P&L", href: "/commercial/post-job/costs", icon: <IconTrendingUp /> },
          { label: "Closeout & Warranty", href: "/commercial/post-job/closeout", icon: <IconCheckSquare /> },
        ],
      },
    ],
  },
  {
    // R10: Field Ops - crew scheduling, clock in/out, payroll. Hub pattern
    // (one entry -> card grid). Surfaces build out phase by phase.
    heading: "Field Ops",
    items: [
      { label: "Field Ops", href: "/commercial/field-ops", icon: <IconHardHat />, adminOnly: true },
    ],
  },
  {
    heading: "Reports",
    items: [
      // R4: a Reports framework — one entry, a tab bar inside switches reports
      // (AR Aging · Win/Loss · …). Highlights on every /commercial/reports/* page.
      { label: "Reports", href: "/commercial/reports", icon: <IconChart /> },
    ],
  },
  {
    // RUX-7 (2026-08): collapsed the six flat Settings rows (Operating Company,
    // Setup Health, Competitors, Sales tax, Archived deals, Access) into ONE
    // Settings hub — same pattern as the residential Command Center's
    // /dashboard/settings. The cards live on /commercial/settings.
    heading: "Admin",
    items: [
      { label: "Settings", href: "/commercial/settings", icon: <IconGear /> },
    ],
  },
];

type Props = {
  /** Set when the viewer also has Command Center access — only then is the
   *  switcher block at the bottom-left rendered. */
  showSwitcher: boolean;
  /** Platform admin — gates adminOnly nav items (e.g. Access provisioning). */
  isAdmin?: boolean;
  /** Crew-only login — the allowlist denies every normal nav target, so
   *  rendering them is ~17 links that each bounce back to /commercial/crew. */
  crewOnly?: boolean;
  onNavigate?: () => void;
};

export default function CommercialSidebar({ showSwitcher, isAdmin = false, crewOnly = false, onNavigate }: Props) {
  const pathname = usePathname();
  // Manual expand/collapse overrides for the collapsible groups, keyed by group
  // label. Undefined = follow the auto rule (open when a child is active).
  const [groupOverride, setGroupOverride] = useState<Record<string, boolean>>({});
  // Reset manual overrides on navigation so an explicit nav to a child always
  // wins over a stale collapse — a manual collapse only lasts for the current
  // page (edge-audit MED: a sticky collapse could otherwise hide the active
  // tool after cross-navigation).
  useEffect(() => {
    setGroupOverride((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, [pathname]);

  // Drop admin-only rows (Access) for non-admins so a Commercial tester never
  // sees a link that would just bounce them. The page redirects too (defense).
  // Recurse into collapsible groups so an admin-only leaf inside a group is
  // filtered the same way as a top-level one.
  const sections = crewOnly
    ? // A crew login can reach exactly the crew surfaces. Every other item in
      // navSections — Accounts, Opportunities, Proposals, Invoices, Reports,
      // Costs & P&L, Settings — redirects straight back, so showing them is 17
      // dead links AND it advertises the money surfaces to someone who can't
      // (and shouldn't) open them.
      [
        {
          heading: "My work",
          items: [
            { label: "Home", href: "/commercial/crew", icon: <IconHardHat /> },
            { label: "My schedule", href: "/commercial/crew/schedule", icon: <IconHardHat /> },
            { label: "My jobs", href: "/commercial/crew/jobs", icon: <IconHardHat /> },
            { label: "My hours", href: "/commercial/crew/hours", icon: <IconHardHat /> },
            { label: "Clock in / out", href: "/commercial/field-ops/clock-station", icon: <IconHardHat /> },
          ],
        },
      ]
    : navSections.map((s) => ({
    ...s,
    items: s.items
      .map((entry) =>
        isGroup(entry)
          ? { ...entry, items: entry.items.filter((it) => !it.adminOnly || isAdmin) }
          : entry
      )
      .filter((entry) =>
        isGroup(entry) ? entry.items.length > 0 : !entry.adminOnly || isAdmin
      ),
  }));

  // 2026-07-29: a post-sale tool detail lives UNDER the account
  // (/commercial/accounts/<id>/<tool>/<dealId>) but should light up its OWN
  // sidebar tool tab — same feel as Invoices (?account_id filter) — instead of
  // lighting up "Accounts" (which prefix-matches and made the tool feel like
  // the account page). Map such a path to the owning tool's index href.
  const toolDetailMatch = pathname.match(
    /^\/commercial\/accounts\/[^/]+\/(submittals|change-orders|aia|costs|closeout|work-order)(?:\/|$)/
  );
  // The Work Order account route is `work-order` (singular); its sidebar index
  // is `work-orders` (plural) — map it so the nav still highlights.
  const toolOverride = toolDetailMatch
    ? `/commercial/post-job/${toolDetailMatch[1] === "work-order" ? "work-orders" : toolDetailMatch[1]}`
    : null;

  // A proposal detail/builder lives UNDER the deal
  // (/commercial/accounts/<id>/deals/<dealId>/proposal/...) but is reached from
  // the Proposals index — so it should light up "Proposals", not "Accounts"
  // (which prefix-matches and makes it feel like the account page). Same fix
  // pattern as the tool-detail override above.
  const proposalDetail =
    /^\/commercial\/accounts\/[^/]+\/deals\/[^/]+\/proposal(?:\/|$)/.test(pathname);
  const activeOverride = toolOverride ?? (proposalDetail ? "/commercial/proposals" : null);

  const isActive = (href: string): boolean => {
    if (activeOverride) return href === activeOverride;
    if (href === "/commercial") return pathname === "/commercial";
    return pathname.startsWith(href);
  };

  const renderLeaf = (item: NavItem) => {
    const active = isActive(item.href);
    if (item.disabled) {
      return (
        <li key={item.href}>
          <div className={`${NAV_ROW} text-ppp-charcoal-400 cursor-not-allowed select-none`} title={item.phase ? `Coming in Phase ${item.phase}` : "Coming soon"}>
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
          data-tour={item.href}
          aria-current={active ? "page" : undefined}
          className={[
            NAV_ROW,
            active
              ? "bg-cc-brand-50 text-cc-brand-700"
              : "text-ppp-charcoal hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-50",
          ].join(" ")}
        >
          <span className={active ? "text-cc-brand-700" : "text-ppp-charcoal-500"}>
            {item.icon}
          </span>
          <span className="flex-1">{item.label}</span>
        </Link>
      </li>
    );
  };

  return (
    // Same white/clean shape as the PPP CC sidebar. Red is the ACCENT
    // (active pill background + logo tag), not the whole chrome.
    // Karan 2026-07-01: "do the same format as PPP command center just
    // like different colors, red and blue for the commercial side."
    <aside className="w-64 lg:w-64 h-full bg-surface border-r border-ppp-charcoal-100 flex flex-col shrink-0">
      <div className="px-6 py-3 lg:py-6 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <Link href="/commercial" className="block" onClick={onNavigate}>
          <Image
            src="/brand/logo.svg"
            alt="Precision Painting Plus"
            width={180}
            height={60}
            priority
            className="cc-dark-invert"
          />
          <div className="mt-3 inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cc-brand-600" />
            <span className="font-condensed text-[10px] font-bold tracking-[0.16em] text-ppp-navy-700 uppercase leading-tight">
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

      <nav className="flex-1 px-3 py-3 lg:py-4 overflow-y-auto">
        {sections.map((section, sectionIdx) => (
          <div key={section.heading} className={sectionIdx > 0 ? "mt-4 lg:mt-6" : ""}>
            <div className="font-condensed px-3 mb-1.5 lg:mb-2 text-[10px] font-bold tracking-[0.18em] text-ppp-navy-600 uppercase">
              {section.heading}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((entry) => {
                if (isGroup(entry)) {
                  const childActive = entry.items.some((it) => isActive(it.href));
                  const open = groupOverride[entry.group] ?? childActive;
                  return (
                    <li key={entry.group}>
                      <button
                        type="button"
                        onClick={() =>
                          setGroupOverride((prev) => ({ ...prev, [entry.group]: !open }))
                        }
                        aria-expanded={open}
                        className={[
                          NAV_ROW,
                          "w-full",
                          childActive && !open
                            ? "text-cc-brand-700"
                            : "text-ppp-charcoal hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-50",
                        ].join(" ")}
                      >
                        <span className={childActive && !open ? "text-cc-brand-700" : "text-ppp-charcoal-500"}>
                          {entry.icon}
                        </span>
                        <span className="flex-1 text-left">{entry.group}</span>
                        <span
                          aria-hidden
                          className={`shrink-0 text-ppp-charcoal-400 transition-transform ${open ? "rotate-180" : ""}`}
                        >
                          <IconChevronDown />
                        </span>
                      </button>
                      {open && (
                        <ul className="mt-0.5 ml-3 pl-3 border-l border-ppp-charcoal-100 space-y-0.5">
                          {entry.items.map((it) => renderLeaf(it))}
                        </ul>
                      )}
                    </li>
                  );
                }
                return renderLeaf(entry);
              })}
            </ul>
          </div>
        ))}

        {/* Platform switcher — same shape + position as the Command Center
            sidebar: last item inside the nav block so it scrolls with the
            other items. Visible only to multi-platform users. */}
        {showSwitcher && (
          <div className="mt-6 pt-4 border-t border-ppp-charcoal-100">
            <div className="font-condensed px-3 mb-2 text-[10px] font-semibold tracking-[0.18em] text-ppp-navy-600 uppercase">
              Platforms
            </div>
            <PlatformSwitcher current="new_platform" />
          </div>
        )}
      </nav>

      {/* Footer — hidden on mobile so the drawer's nav fully fits a 568px
         viewport. A calm "live" tag; no stale phase label (RUX-1). */}
      <div className="hidden lg:block px-6 py-4 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ppp-green" aria-hidden />
          <span className="font-condensed font-semibold tracking-[0.14em] uppercase text-ppp-navy-600">
            Commercial Command Center
          </span>
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
function IconBell() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" />
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
function IconRefresh() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5" />
    </svg>
  );
}
function IconFileText() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6" />
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



function IconTools() {
  // Wrench + screwdriver crossed — the "Delivery Tools" group parent. Reads as
  // "a set of tools" distinct from any single tool's icon.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.83 2.83 0 0 1-4-4z" />
      <path d="M14.5 9.5 4 20" />
      <path d="m17 3 4 4-2 2-4-4z" />
    </svg>
  );
}
function IconClipboard() {
  // Clipboard-with-check — the crew Work Order (a checklist handed to the field).
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}
function IconTrendingUp() {
  // Rising line — Costs & P&L (margin/profit trend), distinct from the $ glyph
  // that Invoices already uses.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}
function IconChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
