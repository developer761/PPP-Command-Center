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
  /** Only render for platform admins (e.g. Access — user provisioning). */
  adminOnly?: boolean;
  /** Admin OR account manager — the money surfaces (margin, cost, AR).
   *  Separate from adminOnly because Mary keeps the receivables book and is
   *  not a platform admin; gating Accounting to adminOnly would lock out the
   *  one person who uses it most. */
  financeOnly?: boolean;
  icon: React.ReactNode;
};

/** Every section carries a heading. An unlabelled one inherits the label above
 *  it — see the Company section below, which shipped without one and came out
 *  reading as part of Libraries. */
type NavSection = { heading: string; items: NavItem[] };

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
  // ── Restructure step 8 (Karan 2026-08-12) ────────────────────────────────
  //
  // Was: Pre-Contract (5 rows) + Post-Contract (Projects, Invoices, and a
  // Delivery Tools group of six). Eleven destinations, nine of which listed the
  // same jobs through a different lens.
  //
  // The job is the thing now, and every one of those lenses is a saved view on
  // the Opportunities list — Proposals out, Active projects, Billing — or a tab
  // on the job itself. A separate page per tool made the platform feel like six
  // apps that happened to share a database.
  //
  // The retired routes still resolve, so bookmarks, bell links and anything
  // already emailed keep working. They are unlinked, not deleted.
  //
  // AR aging lives under Reports: "who owes us across every job" is a genuinely
  // cross-job question that a per-job page structurally cannot answer, which is
  // exactly why it is a report rather than a tool.
  {
    heading: "Work",
    items: [
      { label: "Accounts", href: "/commercial/accounts", icon: <IconBuilding /> },
      { label: "Opportunities", href: "/commercial/opportunities", icon: <IconTarget /> },
    ],
  },
  {
    heading: "Libraries",
    items: [
      { label: "Products", href: "/commercial/pre-job/products", icon: <IconDollar /> },
      { label: "Exclusions", href: "/commercial/pre-job/exclusions", icon: <IconCheckSquare /> },
    ],
  },
  {
    // ── Company ─────────────────────────────────────────────────────────────
    //
    // These were four separate sections — "Field Ops" containing Field Ops,
    // "Accounting" containing Accounting, "Reports" containing Reports, "Admin"
    // containing Settings. Four headings that named their only child, which
    // made a ten-item sidebar read as seven sections and gave the eye four
    // dividers with nothing on either side of them. Merging them into one
    // group was right; shipping that group with NO heading was not.
    //
    // Karan, 2026-08-20: read the sidebar back and these four came out under
    // LIBRARIES. The gap above them is `mt-4`, the same gap every section
    // gets — but every other gap is followed by a label, so a gap WITHOUT one
    // reads as "keep reading", not as "new group". A lone unlabelled tail can
    // only inherit the heading above it.
    //
    // "Company" and not "Operations": the first child is Field Ops, and a
    // heading that repeats its own child's name is noise.
    //
    // What they share is scope — these are the whole-company surfaces, where
    // Work is the per-job ones and Libraries is the reference data behind both.
    //
    // R10 Field Ops: crew scheduling, clock in/out, payroll — a hub, one entry
    // to a card grid.
    //
    // Accounting (Karan, 2026-08-19): "maybe have a separate Accounting Page
    // with this plus other important things that Alex would need to see."
    // Deliberately NOT another Reports tab — Reports is per-topic analysis you
    // open with a question already in mind; Accounting is the money desk that
    // answers "where do we stand" without picking a report first.
    //
    // Settings (RUX-7): one hub, not six flat rows.
    heading: "Company",
    items: [
      { label: "Field Ops", href: "/commercial/field-ops", icon: <IconHardHat />, adminOnly: true },
      { label: "Accounting", href: "/commercial/accounting", icon: <IconLedger />, financeOnly: true },
      { label: "Reports", href: "/commercial/reports", icon: <IconChart /> },
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
  /** Admin or account manager — gates financeOnly nav items (Accounting). Same
   *  predicate the page itself enforces, so a rep never sees a link that
   *  bounces them (the D12 rule). */
  canSeeFinance?: boolean;
  /** Crew-only login — the allowlist denies every normal nav target, so
   *  rendering them is ~17 links that each bounce back to /commercial/crew. */
  crewOnly?: boolean;
  onNavigate?: () => void;
};

export default function CommercialSidebar({ showSwitcher, isAdmin = false, canSeeFinance = false, crewOnly = false, onNavigate }: Props) {
  const pathname = usePathname();
  // Drop admin-only rows (Access) for non-admins so a Commercial tester never
  // sees a link that would just bounce them. The page redirects too (defense).
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
            { label: "Today's hours", href: "/commercial/crew/log", icon: <IconHardHat /> },
            { label: "My hours", href: "/commercial/crew/hours", icon: <IconHardHat /> },
            { label: "Clock in / out", href: "/commercial/field-ops/clock-station", icon: <IconHardHat /> },
          ],
        },
      ]
    : navSections.map((s) => ({
    ...s,
    items: s.items.filter(
      (entry) => (!entry.adminOnly || isAdmin) && (!entry.financeOnly || canSeeFinance)
    ),
  }))
    // Every section carries a heading now, so a section that role-gating has
    // emptied would render a label with nothing under it — the mirror of the
    // bug above (a row with no label). Neither can happen.
    .filter((s) => s.items.length > 0);

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
  // The six delivery tools have the same shape as the proposal above: they live
  // under /commercial/accounts/<id>/<tool>/<dealId>, and the Post-Job rows this
  // pointed at were retired in the restructure — so they fell through to the
  // account prefix and lit ACCOUNTS as well. They are all views of a JOB.
  const toolOverride = toolDetailMatch ? "/commercial/opportunities" : null;

  // A proposal detail/builder lives UNDER the deal
  // (/commercial/accounts/<id>/deals/<dealId>/proposal/...) but is reached from
  // the Proposals index — so it should light up "Proposals", not "Accounts"
  // (which prefix-matches and makes it feel like the account page). Same fix
  // pattern as the tool-detail override above.
  const proposalDetail =
    /^\/commercial\/accounts\/[^/]+\/deals\/[^/]+\/proposal(?:\/|$)/.test(pathname);
  // Brendan 2026-08-26: "when I click on a proposal it brings me to the account
  // tab… it should keep me on the opp page."
  //
  // It does keep him — the page and the back link are both the deal. What moved
  // was the SIDEBAR: a proposal lives at /commercial/accounts/<id>/deals/<id>/
  // proposal/<id>, so ordinary prefix matching lights ACCOUNTS, and the whole
  // left rail says you have left the pipeline. The Proposals row this used to
  // point at was removed in the restructure, so the override silently fell
  // through to that prefix match.
  //
  // A proposal reached from a deal belongs to OPPORTUNITIES — that is where the
  // deal lives and where the back link returns. Same for the delivery tools
  // below, which sit under the same account-shaped path.
  const wantedOverride =
    toolOverride ?? (proposalDetail ? "/commercial/opportunities" : null);

  // Only honour an override that points at a row the sidebar actually RENDERS.
  //
  // Both override targets — /commercial/proposals and the six
  // /commercial/post-job/* indexes — were removed from navSections in the
  // restructure. `isActive` short-circuits to `href === activeOverride`, so
  // once the target stopped existing the comparison failed for every row and
  // NOTHING highlighted: open any proposal editor or post-sale tool and the
  // whole sidebar went dark, with no indication of where you were. An override
  // aimed at a row that isn't there should fall back to ordinary prefix
  // matching (lighting "Accounts", which is at least true) rather than
  // silently disabling highlighting altogether. Self-healing too: if Proposals
  // returns to the nav, the override starts working again on its own.
  const renderedHrefs = new Set<string>();
  for (const s of sections) {
    for (const entry of s.items) renderedHrefs.add(entry.href);
  }
  const activeOverride =
    wantedOverride && renderedHrefs.has(wantedOverride) ? wantedOverride : null;

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
          <div
            key={section.heading}
            className={sectionIdx > 0 ? "mt-4 lg:mt-6" : ""}
          >
            {/* Every section is labelled, and the type enforces it. The gap
                alone cannot carry the grouping: it is the same `mt-4` between
                every pair of sections, so an unlabelled one reads as a
                continuation of the section above rather than a new one — which
                is exactly how Field Ops / Accounting / Reports / Settings ended
                up appearing to sit under LIBRARIES. */}
            <div className="font-condensed px-3 mb-1.5 lg:mb-2 text-[10px] font-bold tracking-[0.18em] text-ppp-navy-600 uppercase">
              {section.heading}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((entry) => renderLeaf(entry))}
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
/** A ledger — ruled book with a column line. The money desk, not another chart. */
function IconLedger() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M8 3v17" />
      <path d="M11.5 8h5 M11.5 12h5 M11.5 16h3" />
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



function IconGear() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
