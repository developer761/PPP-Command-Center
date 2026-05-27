"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_META } from "@/lib/brand";
import { useViewer } from "@/lib/auth/viewer-context";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  /** When set, the item is only visible to admins. */
  adminOnly?: boolean;
};

type NavSection = {
  heading: string;
  items: NavItem[];
  adminOnly?: boolean;
};

const navSections: NavSection[] = [
  {
    heading: "Sales Analytics",
    items: [
      { label: "Overview", href: "/dashboard", icon: <IconSparkle /> },
      { label: "Rep Profiles", href: "/dashboard/rep", icon: <IconUser /> },
      { label: "Map", href: "/dashboard/map", icon: <IconMap /> },
    ],
  },
  {
    heading: "Finance & Ops",
    items: [
      { label: "Financials", href: "/dashboard/financials", icon: <IconDollar /> },
      { label: "Operations", href: "/dashboard/operations", icon: <IconGears /> },
    ],
  },
  {
    heading: "Operations Tools",
    items: [
      { label: "Materials Ordering", href: "/dashboard/materials", icon: <IconPaint /> },
      { label: "Inbox", href: "/dashboard/inbox", icon: <IconInbox />, adminOnly: true },
    ],
  },
  {
    heading: "Admin",
    adminOnly: true,
    items: [
      { label: "Integrations", href: "/dashboard/integrations", icon: <IconPlug />, adminOnly: true },
      { label: "Customer Copy", href: "/dashboard/settings/templates", icon: <IconPencil />, adminOnly: true },
      { label: "Suppliers", href: "/dashboard/settings/suppliers", icon: <IconTruck />, adminOnly: true },
      { label: "Supplier Email Copy", href: "/dashboard/settings/supplier-templates", icon: <IconMail />, adminOnly: true },
    ],
  },
];

type SidebarProps = {
  /** Called when any nav link is clicked — used by the mobile drawer to auto-close */
  onNavigate?: () => void;
};

export default function Sidebar({ onNavigate }: SidebarProps = {}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const viewer = useViewer();
  const isAdmin = viewer?.isAdmin ?? false;

  // Inbox unread badge — refreshes every 60s while sidebar is mounted, plus
  // immediately on first paint. Admin-only (worker doesn't see the Inbox
  // entry, so no need to fetch). Failures fall through silently — badge
  // just stays at its last value (or 0 on first paint).
  const [unreadInbox, setUnreadInbox] = useState(0);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await fetch("/api/admin/inbox?kind=all&limit=1");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && typeof data?.summary?.unread === "number") {
          setUnreadInbox(data.summary.unread);
        }
      } catch {
        // Silent — keep last-known count
      }
    };
    void fetchCount();
    const id = setInterval(fetchCount, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAdmin]);
  // Preserve admin view state (?view_as= / ?scope=) across sidebar navigation.
  // Without this, clicking any nav link would drop the impersonation/scope.
  const viewQs = buildViewQs(params);
  const withView = (href: string) => (viewQs ? `${href}?${viewQs}` : href);

  // Hide admin-only sections / items from reps. Server-side route guards still
  // enforce access, but stripping the link removes the confusing 404 path.
  const visibleSections = navSections
    .filter((s) => !s.adminOnly || isAdmin)
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.adminOnly || isAdmin) }))
    .filter((s) => s.items.length > 0);

  return (
    <aside className="w-64 lg:w-64 h-full bg-white border-r border-ppp-charcoal-100 flex flex-col shrink-0">
      <div className="px-6 py-5 lg:py-6 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <Link href={withView("/dashboard")} className="block" onClick={onNavigate}>
          <Image
            src="/brand/logo.svg"
            alt="Precision Painting Plus"
            width={180}
            height={60}
            priority
          />
          <div className="font-condensed mt-3 text-[11px] font-bold tracking-[0.18em] text-ppp-navy uppercase">
            Command Center
          </div>
        </Link>
        {onNavigate && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Close menu"
            className="lg:hidden flex items-center justify-center h-8 w-8 rounded-lg text-ppp-charcoal-500 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {visibleSections.map((section, sectionIdx) => (
          <div key={section.heading} className={sectionIdx > 0 ? "mt-6" : ""}>
            <div className="font-condensed px-3 mb-2 text-[10px] font-semibold tracking-[0.18em] text-ppp-charcoal-500 uppercase">
              {section.heading}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname.startsWith(item.href);
                // Per-item badge — only the Inbox entry has a live count
                // today, but the pattern is extensible (add more keys as
                // future surfaces want unread/alert counts).
                const badgeCount = item.href === "/dashboard/inbox" ? unreadInbox : 0;
                return (
                  <li key={item.href}>
                    <Link
                      href={withView(item.href)}
                      onClick={onNavigate}
                      className={[
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                        active
                          ? "bg-ppp-blue/10 text-ppp-blue"
                          : "text-ppp-charcoal hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-50",
                      ].join(" ")}
                    >
                      <span className={active ? "text-ppp-blue" : "text-ppp-charcoal-500"}>
                        {item.icon}
                      </span>
                      <span className="flex-1">{item.label}</span>
                      {badgeCount > 0 && (
                        <span
                          className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold bg-ppp-orange text-white"
                          aria-label={`${badgeCount} unread`}
                        >
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="px-6 py-4 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
        <div className="font-semibold text-ppp-charcoal">Version {APP_META.version}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ppp-green animate-pulse" aria-hidden />
          Live · Salesforce
        </div>
      </div>
    </aside>
  );
}

/**
 * Whitelist the only params worth preserving across nav: view_as + scope.
 * Other params (period, region, etc.) are page-local and should reset.
 * `view_as` is validated against the SF User Id shape so a rep manually
 * typing junk into the URL doesn't end up writing garbage rows into the
 * view_as_audit table on every nav.
 */
const SF_USER_ID_RE = /^005[A-Za-z0-9]{12,15}$/;

function buildViewQs(params: URLSearchParams | null): string {
  if (!params) return "";
  const out = new URLSearchParams();
  const viewAs = params.get("view_as");
  const scope = params.get("scope");
  if (viewAs && SF_USER_ID_RE.test(viewAs)) out.set("view_as", viewAs);
  if (scope === "my") out.set("scope", "my");
  return out.toString();
}

/* Icons — clean stroke style, 18×18 */
function IconSparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}
function IconUser() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
}
function IconPlug() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 2v6 M15 2v6 M5 8h14v3a7 7 0 0 1-14 0V8z M12 18v4" />
    </svg>
  );
}
function IconPencil() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
function IconTruck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 3h15v13H1z M16 8h4l3 3v5h-7V8z M5.5 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M20.5 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function IconMail() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 5L2 7" />
    </svg>
  );
}
function IconMap() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z M9 3v15 M15 6v15" />
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
function IconGears() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconPaint() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="8" rx="1" />
      <path d="M4 6h16 M12 10v4 M9 14h6v8H9z" />
    </svg>
  );
}
