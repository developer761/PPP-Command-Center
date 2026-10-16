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
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * Past this, the data is old enough that somebody should know.
 *
 * The warm cron runs every 20 minutes and the snapshot TTL is 60, so a
 * healthy platform sits between 0 and ~20 minutes here. Ninety minutes
 * means the cron has missed several runs AND no page load rebuilt the
 * cache — the snapshot can still be served (serve-stale runs to 26h), it
 * just must not be served under the word "Live" with a green pulse.
 */
const STALE_AFTER_MS = 90 * 60 * 1000;

export default function Topbar({
  onOpenMenu,
  user,
  searchIndex = null,
  switcherReps = [],
}: Props) {
  const [now, setNow] = useState<Date | null>(null);
  /**
   * When Salesforce was last pulled — NOT when this component mounted.
   *
   * It used to be `useState(() => new Date())`, i.e. mount time, which made
   * the chip a clock rather than a sync indicator: it read "Live · synced
   * just now" on every fresh load no matter how old the cache row behind
   * the page was, and the serve-stale path lets that row reach 26 hours.
   *
   * Mount time stays as the fallback, because it is the correct answer in
   * the one case the endpoint returns null: the shared cache row has been
   * DELETED by a refresh, so the page we are sitting on was rendered from a
   * live Salesforce pull a moment ago.
   */
  const [syncedAt, setSyncedAt] = useState<Date>(() => new Date());

  // Re-tick once per MINUTE, not per second. The greeting/date only ever
  // change at boundaries (noon, midnight) and the "synced 3m ago" string
  // doesn't need second-level resolution. This stops the whole topbar tree
  // from re-rendering every second — noticeable jank on low-end phones.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  /**
   * Asked ONCE, on mount, and deliberately never polled.
   *
   * The numbers on this page were rendered from whatever snapshot was
   * current when the server rendered it. If the cron rebuilt two minutes
   * later, the data on screen did not get any newer — so a poll would walk
   * the chip BACKWARDS toward "just now" while the page aged, which is the
   * same lie in a new costume. Pinning it near render time and letting it
   * count up is the honest reading. A refresh reloads the page, which
   * remounts this and asks again.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sf-sync-status");
        if (!res.ok) return;
        const json = (await res.json()) as { fetchedAt?: string | null };
        if (cancelled || !json?.fetchedAt) return;
        const at = new Date(json.fetchedAt);
        if (Number.isNaN(at.getTime())) return;
        setSyncedAt(at);
      } catch {
        // Keep the mount-time fallback. A chip that counts from page load is
        // the old behavior, not a regression.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!now)
    return (
      <header
        className="h-[73px] bg-white border-b border-ppp-charcoal-100"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      />
    );

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
  // Before the status fetch resolves, syncedAt is mount time — so this is
  // false, and the alarm can never flash on during a normal page load.
  const isStale = now.getTime() - syncedAt.getTime() > STALE_AFTER_MS;
  // Drop the comma-name when we don't have a real first name (avoids the cold "Good morning, team").
  const greetingLine = user.firstName ? `${greeting}, ${user.firstName}` : greeting;

  return (
    <header
      /* STICKY + a background behind the iOS status bar.
         Kate, 2026-10-07: "The top bar should scroll with me (the time and
         battery have nothing behind them so it's overlapping with the text on
         the screen)". The app sets viewportFit:"cover", so the page extends
         under the clock and battery — and while a dozen places pad for
         safe-area-inset-BOTTOM, nothing had ever padded the top. Page content
         therefore ran underneath the status bar with nothing behind it.
         The padding puts the bar's own white under the clock; sticky keeps it
         there while the page moves. */
      /* `relative` so the search can overlay this whole row on a phone — see
         the open-state classes in global-search.tsx. */
      className="relative sticky top-0 z-30 bg-white border-b border-ppp-charcoal-100 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center gap-3"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
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

        {/* The sync control is an ALARM now, not furniture.
            Karan on a 390px iPhone, 2026-10-16: "the top needs to be cleaner,
            it's all so clustered, do we really need the sync button up there?"
            — six controls were competing for that row and squeezing the search
            box. A permanent green "Live" pill is the least useful of them:
            it reported the same thing on every single load regardless of the
            data behind it, so it carried no information at all. What it should
            have been carrying is the one state worth interrupting someone for
            — the warm cron has stopped and these figures are old — and that
            now has the row to itself on the rare occasion it is true.
            The everyday reading, plus the manual refresh, moved into the user
            menu where they cost no space. */}
        {isStale && (
          <form action="/api/admin/sf-refresh-cache" method="POST">
            <button
              type="submit"
              className="flex items-center gap-1.5 h-11 sm:h-auto px-2.5 sm:px-3 sm:py-1.5 rounded-lg sm:rounded-full bg-ppp-orange-50 border border-ppp-orange-100 hover:bg-ppp-orange-100 active:bg-ppp-orange-100 transition-colors touch-manipulation"
              title={`Salesforce data is ${formatAgo(ago)} — tap to refresh`}
              aria-label={`Salesforce data is ${formatAgo(ago)}. Tap to refresh.`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ppp-orange-600" aria-hidden />
              <span className="text-[11px] font-medium text-ppp-orange-700 whitespace-nowrap">
                <span className="hidden sm:inline">Data {formatAgo(ago)} · refresh</span>
                <span className="sm:hidden">{formatAgo(ago)}</span>
              </span>
            </button>
          </form>
        )}

        <NotificationBell />

        <UserMenu
          name={user.fullName}
          email={user.email}
          initial={user.initial}
          syncedAgo={formatAgo(ago)}
          syncIsStale={isStale}
        />
      </div>
    </header>
  );
}
