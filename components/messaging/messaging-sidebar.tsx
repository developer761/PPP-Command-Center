"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export type SidebarWorkspace = {
  id: string;
  name: string;
  region: string;
  unread: number;
};

const NAV = [
  { href: "/messaging/dashboard", label: "Dashboard", icon: "M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
  { href: "/messaging/reporting", label: "Reports", icon: "M3 3v18h18 M7 15l3-4 3 3 4-6" },
  { href: "/messaging", label: "Conversations", icon: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" },
  { href: "/messaging/automations", label: "Automations", icon: "M6 3v12 M18 9v12 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a9 9 0 0 1 9-9" },
  { href: "/messaging/agent", label: "Chatbot", icon: "M12 8V4H8 M4 8h16v12H4z M2 14h2 M20 14h2 M15 13v2 M9 13v2" },
  { href: "/messaging/training", label: "Training", icon: "M22 10v6M2 10l10-5 10 5-10 5z M6 12v5c3 3 9 3 12 0v-5" },
  { href: "/messaging/settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" },
];

/**
 * The left rail.
 *
 * Follows Hatch's information architecture on purpose — the office already
 * knows where things are, and moving them costs goodwill for no gain. Three
 * nav items, then the workspaces.
 *
 * The one thing changed is the part of Hatch that does not work: it lists all
 * 32 workspaces flat and alphabetical, which puts AM - Dallas TX above every
 * New York inbox and makes "which of my regions has something waiting" a
 * scanning exercise. Here they are grouped by region with the region's unread
 * total on the header, so the answer is available without reading the list.
 *
 * COLLAPSIBLE, since Karan 2026-09-08: "NY should collapse all its workplaces
 * underneath it, same with New Jersey." With 32 workspaces the flat-but-grouped
 * list is still longer than the rail, so the Florida group is off-screen while
 * you are reading New York. Collapsing a region you are not working in is what
 * makes the grouping pay off.
 *
 * Two rules the collapse has to respect:
 *   · the region holding the ACTIVE workspace always opens, so a page load or a
 *     deep link never hides the thing you are looking at inside a closed group;
 *   · a region with unread messages is not collapsed by default — the whole
 *     point of the header count is that unread work is visible without
 *     hunting, and defaulting it shut would undo that.
 *
 * The open/closed set persists in localStorage, because a rail that forgets its
 * shape on every navigation is worse than one that never collapsed.
 */

const COLLAPSE_KEY = "ppp.messaging.collapsedRegions";
export default function MessagingSidebar({
  workspaces,
  onNavigate,
}: {
  workspaces: SidebarWorkspace[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const activeWs = params.get("ws");

  const byRegion = new Map<string, SidebarWorkspace[]>();
  for (const w of workspaces) {
    const list = byRegion.get(w.region) ?? [];
    list.push(w);
    byRegion.set(w.region, list);
  }

  // null until the stored set is read, so the first paint doesn't flash every
  // region open and then snap shut.
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSE_KEY);
      setCollapsed(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setCollapsed(new Set());
    }
  }, []);

  const toggleRegion = (region: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // Private browsing / quota — the rail still works, it just forgets.
      }
      return next;
    });
  };

  /** A region is open unless explicitly collapsed — and never closed when it
   *  holds the active workspace, which would hide the page you are on. */
  const isOpen = (region: string, list: SidebarWorkspace[]) => {
    if (list.some((w) => w.id === activeWs)) return true;
    return !(collapsed?.has(region) ?? false);
  };

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="px-4 h-14 flex items-center gap-2.5 border-b border-ppp-charcoal-100 shrink-0">
        <span className="h-8 w-8 shrink-0 rounded-lg bg-ppp-charcoal text-white flex items-center justify-center font-bold text-[15px]">
          P
        </span>
        <div className="min-w-0">
          <p className="font-bold text-[14px] text-ppp-charcoal leading-tight truncate">
            Precision Painting Plus
          </p>
          <p className="text-[11px] text-ppp-charcoal-400 leading-tight">Messaging</p>
        </div>
      </div>

      <nav className="p-2 border-b border-ppp-charcoal-100">
        {NAV.map((n) => {
          const on = n.href === "/messaging"
            ? pathname === "/messaging" || pathname.startsWith("/messaging/") && !NAV.some((o) => o.href !== "/messaging" && pathname.startsWith(o.href))
            : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              onClick={onNavigate}
              className={[
                "flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] text-[13.5px] font-medium touch-manipulation transition-colors",
                on ? "bg-ppp-orange-50 text-ppp-orange-700" : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50",
              ].join(" ")}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={n.icon} />
              </svg>
              {n.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1 overflow-y-auto p-2">
        <p className="px-2.5 pt-1 pb-2 text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
          Workspaces
        </p>
        <Link
          href="/messaging"
          onClick={onNavigate}
          className={[
            "flex items-center justify-between gap-2 rounded-lg px-2.5 min-h-[40px] text-[13px] touch-manipulation",
            !activeWs ? "bg-ppp-charcoal-50 font-semibold text-ppp-charcoal" : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50",
          ].join(" ")}
        >
          All workspaces
          <span className="text-[11px] font-mono text-ppp-charcoal-400">{workspaces.length}</span>
        </Link>

        {[...byRegion.entries()].map(([region, list]) => {
          const unread = list.reduce((n, w) => n + w.unread, 0);
          const open = isOpen(region, list);
          return (
            <div key={region} className="mt-3">
              {/* The header IS the toggle. A separate chevron would be a 14px
                  target beside a 200px non-target; on a phone the row you can
                  actually hit should be the row that acts. */}
              <button
                type="button"
                onClick={() => toggleRegion(region)}
                aria-expanded={open}
                className="w-full px-2.5 py-1 min-h-[32px] flex items-center justify-between gap-2 rounded-lg hover:bg-ppp-charcoal-50 transition-colors touch-manipulation min-h-[44px] sm:min-h-0"
              >
                <span className="flex items-center gap-1 min-w-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                    className={`shrink-0 text-ppp-charcoal-400 transition-transform ${open ? "" : "-rotate-90"}`}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 truncate">
                    {region}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {/* Collapsed, the count is the only clue how much is hidden. */}
                  {!open && (
                    <span className="text-[10px] font-mono text-ppp-charcoal-300 tabular-nums">{list.length}</span>
                  )}
                  {unread > 0 && (
                    <span className="text-[10px] font-bold text-ppp-orange-700 bg-ppp-orange-50 rounded-full px-1.5 py-0.5 tabular-nums">
                      {unread}
                    </span>
                  )}
                </span>
              </button>
              {open && list.map((w) => {
                const on = activeWs === w.id;
                return (
                  <Link
                    key={w.id}
                    href={`/messaging?ws=${w.id}`}
                    onClick={onNavigate}
                    className={[
                      "group flex items-center gap-2 rounded-lg pl-2 pr-2.5 min-h-[40px] text-[13px] touch-manipulation transition-colors",
                      on ? "bg-ppp-orange-50 text-ppp-orange-700 font-semibold" : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50",
                    ].join(" ")}
                  >
                    {/* The accent bar Hatch uses to separate workspaces at a
                        glance — kept, because it works. */}
                    <span className={`h-4 w-[3px] shrink-0 rounded-full ${on ? "bg-ppp-orange-700" : "bg-ppp-charcoal-200 group-hover:bg-ppp-charcoal-300"}`} />
                    <span className="truncate min-w-0 flex-1">{w.name}</span>
                    {w.unread > 0 && (
                      <span className="shrink-0 text-[10px] font-bold tabular-nums text-ppp-charcoal-500">
                        {w.unread}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
