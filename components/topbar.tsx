"use client";

import { useEffect, useState } from "react";
import UserMenu from "@/components/user-menu";

type Props = {
  onOpenMenu?: () => void;
  user: {
    email: string;
    fullName: string | null;
    firstName: string | null;
    initial: string;
  };
};

function formatAgo(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export default function Topbar({ onOpenMenu, user }: Props) {
  const [now, setNow] = useState<Date | null>(null);
  const [syncedAt] = useState<Date>(() => new Date());
  const [, setTick] = useState(0);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => {
      setNow(new Date());
      setTick((t) => t + 1);
    }, 1000);
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
    <header className="bg-white border-b border-ppp-charcoal-100 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {onOpenMenu && (
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Open menu"
            className="lg:hidden flex items-center justify-center h-9 w-9 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-ppp-blue-50 hover:border-ppp-blue-200 transition-colors shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18 M3 12h18 M3 18h18" />
            </svg>
          </button>
        )}
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-semibold text-ppp-charcoal truncate">
            {greetingLine}
          </h2>
          <p className="text-[10px] sm:text-xs text-ppp-charcoal-500 mt-0.5">
            <span className="hidden sm:inline">{dateText}</span>
            <span className="sm:hidden">{dateTextShort}</span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-ppp-green-50 border border-ppp-green-100 rounded-full">
          <span className="h-1.5 w-1.5 rounded-full bg-ppp-green animate-pulse" />
          <span className="text-[11px] font-medium text-ppp-green-700 whitespace-nowrap">
            Live · synced {formatAgo(ago)}
          </span>
        </div>

        <div
          className="sm:hidden flex items-center justify-center h-9 w-9 rounded-lg bg-ppp-green-50 border border-ppp-green-100"
          title={`Synced ${formatAgo(ago)}`}
        >
          <span className="h-2 w-2 rounded-full bg-ppp-green animate-pulse" />
        </div>

        <UserMenu
          name={user.fullName}
          email={user.email}
          initial={user.initial}
        />
      </div>
    </header>
  );
}
