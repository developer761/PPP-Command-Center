"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export type SidebarWorkspace = {
  id: string;
  name: string;
  region: string;
  unread: number;
};

const NAV = [
  { href: "/messaging/dashboard", label: "Dashboard", icon: "M3 3v18h18 M7 15l3-4 3 3 4-6" },
  { href: "/messaging", label: "Conversations", icon: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" },
  { href: "/messaging/automations", label: "Automations", icon: "M6 3v12 M18 9v12 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a9 9 0 0 1 9-9" },
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
 */
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
          return (
            <div key={region} className="mt-3">
              <div className="px-2.5 pb-1 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                  {region}
                </span>
                {unread > 0 && (
                  <span className="text-[10px] font-bold text-ppp-orange-700 bg-ppp-orange-50 rounded-full px-1.5 py-0.5 tabular-nums">
                    {unread}
                  </span>
                )}
              </div>
              {list.map((w) => {
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
