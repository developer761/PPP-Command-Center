"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { APP_META } from "@/lib/brand";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  section?: string;
};

const navItems: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: <IconSparkle />, section: "Analytics" },
  { label: "Rep Profiles", href: "/dashboard/rep", icon: <IconUser /> },
  { label: "Leaderboard", href: "/dashboard/leaderboard", icon: <IconTrophy /> },
  { label: "Trends", href: "/dashboard/trends", icon: <IconChart /> },
  { label: "Time Patterns", href: "/dashboard/time-patterns", icon: <IconClock /> },
  { label: "Inconsistencies", href: "/dashboard/inconsistencies", icon: <IconAlert /> },
  { label: "Pipeline Health", href: "/dashboard/pipeline", icon: <IconPipe /> },
  { label: "Lost Reasons", href: "/dashboard/lost-reasons", icon: <IconClose /> },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-white border-r border-ppp-charcoal-100 flex flex-col shrink-0">
      <div className="px-6 py-6 border-b border-ppp-charcoal-100">
        <Link href="/dashboard" className="block">
          <Image
            src="/brand/logo.svg"
            alt="Precision Painting Plus"
            width={180}
            height={60}
            priority
          />
          <div className="mt-3 text-[11px] font-semibold tracking-[0.15em] text-ppp-charcoal-500 uppercase">
            Command Center
          </div>
        </Link>
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        <div className="px-3 mb-2 text-[10px] font-semibold tracking-[0.15em] text-ppp-charcoal-500 uppercase">
          Sales Analytics
        </div>
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={[
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    active
                      ? "bg-ppp-blue/10 text-ppp-blue"
                      : "text-ppp-charcoal hover:bg-ppp-charcoal-50",
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
function IconTrophy() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4h12v4a6 6 0 0 1-12 0V4z M6 4H4v2a2 2 0 0 0 2 2 M18 4h2v2a2 2 0 0 1-2 2 M12 14v3 M8 21h8 M10 17h4" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18 M7 14l4-4 4 4 5-7" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l10 17H2L12 3z M12 10v4 M12 17h.01" />
    </svg>
  );
}
function IconPipe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="6" width="18" height="4" rx="1" />
      <rect x="3" y="14" width="13" height="4" rx="1" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6 M15 9l-6 6" />
    </svg>
  );
}
