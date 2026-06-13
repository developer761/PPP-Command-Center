"use client";

import NotificationBell from "@/components/notification-bell";
import UserMenu from "@/components/user-menu";

/**
 * Minimal topbar for `/commercial/*`.
 *
 * Phase 0 ships with just brand + greeting + bell + user. Search + view-as
 * are intentionally NOT here — they're SF-snapshot-dependent surfaces from
 * Command Center. The commercial platform will get its own search index
 * (over commercial_* tables) in Phase 2 when there's something to search.
 */
export default function CommercialTopbar({
  user,
  onOpenMenu,
}: {
  user: {
    email: string;
    fullName: string | null;
    firstName: string | null;
    initial: string;
  };
  onOpenMenu?: () => void;
}) {
  return (
    <header className="bg-white border-b border-ppp-charcoal-100 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        {onOpenMenu && (
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Open menu"
            className="lg:hidden flex items-center justify-center h-11 w-11 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-emerald-50 hover:border-emerald-200 active:bg-emerald-100 transition-colors shrink-0 touch-manipulation"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18 M3 12h18 M3 18h18" />
            </svg>
          </button>
        )}
        <div className="hidden sm:block min-w-0">
          <h2 className="text-sm sm:text-base font-semibold text-ppp-charcoal truncate">
            {user.firstName ? `Hi, ${user.firstName}` : "Hi"}
          </h2>
          <p className="text-[10px] sm:text-xs text-ppp-charcoal-500 mt-0.5 truncate">
            New Platform · Commercial OS
          </p>
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
        <NotificationBell />
        <UserMenu name={user.fullName} email={user.email} initial={user.initial} />
      </div>
    </header>
  );
}
