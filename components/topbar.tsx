"use client";

import { useEffect, useState } from "react";
import GlobalSearch from "@/components/global-search";
import NotificationBell from "@/components/notification-bell";
import UserMenu from "@/components/user-menu";
import ViewSwitcher from "@/components/view-switcher";

type SearchableSnapshot = {
  reps?: Array<{ id: string; name: string; email?: string | null; region?: string | null }>;
  accounts?: Array<{ id: string; name: string; type?: string | null; region?: string | null }>;
  workOrders?: Array<{
    id: string;
    workOrderNumber: string | null;
    accountName: string | null;
    status: string | null;
    ownerName: string | null;
    opportunityId: string | null;
  }>;
};

type Props = {
  onOpenMenu?: () => void;
  user: {
    email: string;
    fullName: string | null;
    firstName: string | null;
    initial: string;
  };
  searchIndex?: SearchableSnapshot | null;
  /** Rep options shown in the admin View Switcher dropdown. */
  switcherReps?: Array<{ id: string; name: string }>;
};

function formatAgo(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export default function Topbar({
  onOpenMenu,
  user,
  searchIndex = null,
  switcherReps = [],
}: Props) {
  const [now, setNow] = useState<Date | null>(null);
  const [syncedAt] = useState<Date>(() => new Date());

  // Re-tick once per MINUTE, not per second. The greeting/date only ever
  // change at boundaries (noon, midnight) and the "synced 3m ago" string
  // doesn't need second-level resolution. This stops the whole topbar tree
  // from re-rendering every second — noticeable jank on low-end phones.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <header className="h-[73px] bg-white border-b border-ppp-charcoal-100" />;

  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const dateText = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const dateTextShort = now.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const ago = Math.floor((now.getTime() - syncedAt.getTime()) / 1000);
  // Drop the comma-name when we don't have a real first name (avoids the cold "Good morning, team").
  const greetingLine = user.firstName ? `${greeting}, ${user.firstName}` : greeting;

  return (
    <header className="bg-white border-b border-ppp-charcoal-100 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        {onOpenMenu && (
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Open menu"
            className="lg:hidden flex items-center justify-center h-11 w-11 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-ppp-blue-50 hover:border-ppp-blue-200 active:bg-ppp-blue-100 transition-colors shrink-0 touch-manipulation"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18 M3 12h18 M3 18h18" />
            </svg>
          </button>
        )}
        {/* Greeting block — hidden below sm so the GlobalSearch in the middle
            column has reliable space on phone-sized viewports. At 375px the
            greeting (110px) + hamburger (44px) + right cluster (~180px) +
            padding left a few px for search, causing the search input to
            overlap adjacent elements. Karan 2026-06-08. */}
        <div className="hidden sm:block min-w-0 sm:max-w-none">
          <h2 className="text-sm sm:text-base font-semibold text-ppp-charcoal truncate" title={greetingLine}>
            {greetingLine}
          </h2>
          <p className="text-[10px] sm:text-xs text-ppp-charcoal-500 mt-0.5 truncate">
            <span className="hidden sm:inline">{dateText}</span>
            <span className="sm:hidden">{dateTextShort}</span>
          </p>
        </div>
      </div>

      {/* Global search — always visible (CEO uses dashboard on phone) */}
      <div className="flex flex-1 justify-center min-w-0">
        <GlobalSearch snapshot={searchIndex} />
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
        <ViewSwitcher reps={switcherReps} />

        <form action="/api/admin/sf-refresh-cache" method="POST" className="hidden sm:block">
          <button
            type="submit"
            className="flex items-center gap-2 px-3 py-1.5 bg-ppp-green-50 border border-ppp-green-100 rounded-full hover:bg-ppp-green-100 hover:border-ppp-green-200 transition-colors group"
            title={`Synced ${formatAgo(ago)} · click to refresh from Salesforce`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ppp-green animate-pulse" />
            <span className="text-[11px] font-medium text-ppp-green-700 whitespace-nowrap">
              Live · synced {formatAgo(ago)}
            </span>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-ppp-green-700 opacity-50 group-hover:opacity-100 transition-opacity"
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 4v6h-6" />
            </svg>
          </button>
        </form>

        <form action="/api/admin/sf-refresh-cache" method="POST" className="sm:hidden">
          <button
            type="submit"
            className="flex items-center justify-center gap-1 h-11 min-w-[60px] px-3 rounded-lg bg-ppp-green-50 border border-ppp-green-100 hover:bg-ppp-green-100 active:bg-ppp-green-200 transition-colors touch-manipulation"
            title={`Synced ${formatAgo(ago)} · tap to refresh from Salesforce`}
            aria-label={`Synced ${formatAgo(ago)}. Tap to refresh from Salesforce.`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ppp-green animate-pulse" aria-hidden />
            <span className="text-[11px] font-medium text-ppp-green-700 whitespace-nowrap">Sync</span>
          </button>
        </form>

        <NotificationBell />

        <UserMenu
          name={user.fullName}
          email={user.email}
          initial={user.initial}
        />
      </div>
    </header>
  );
}
