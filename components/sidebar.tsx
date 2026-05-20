"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { APP_META } from "@/lib/brand";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
};

const navItems: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: <IconSparkle /> },
  { label: "Rep Profiles", href: "/dashboard/rep", icon: <IconUser /> },
];

type SidebarProps = {
  /** Called when any nav link is clicked — used by the mobile drawer to auto-close */
  onNavigate?: () => void;
};

export default function Sidebar({ onNavigate }: SidebarProps = {}) {
  const pathname = usePathname();

  return (
    <aside className="w-64 lg:w-64 h-full bg-white border-r border-ppp-charcoal-100 flex flex-col shrink-0">
      <div className="px-6 py-5 lg:py-6 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <Link href="/dashboard" className="block" onClick={onNavigate}>
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
        <div className="font-condensed px-3 mb-2 text-[10px] font-semibold tracking-[0.18em] text-ppp-charcoal-500 uppercase">
          Sales Analytics
        </div>
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const active =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
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
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="px-6 py-4 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
        <div className="font-semibold text-ppp-charcoal">Version {APP_META.version}</div>
        <div className="mt-0.5">Mock data · not connected to Salesforce</div>
      </div>
    </aside>
  );
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
