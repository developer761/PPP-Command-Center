"use client";

/**
 * Reports tab bar — one row across the top of every report so each reads as a
 * tab of one Reports area.
 *
 * The tab list is no longer hand-kept here: the layout passes the reports this
 * viewer may open, straight from lib/commercial/reports/registry.ts and the
 * folder access rule. A tab for a report you can't open would bounce you.
 *
 * Scoped to your folder: if you came in from a folder on the Reports index
 * (remembered in a cookie) and the report you're on is in it, the bar shows
 * that folder's reports, with the folder's name as the way back. Opened any
 * other way — a dashboard link, a bookmark — it shows every report you can see.
 *
 * Not shown on the index itself: there the folder rail / chips ARE the
 * navigation, and two sideways-scrolling rows stacked on a phone is clutter.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { FOLDER_COOKIE } from "@/lib/commercial/reports/access-rule";
import { reportKeyFromPath } from "@/lib/commercial/reports/registry";

export type TabReport = { key: string; href: string; label: string };
export type TabFolder = { id: string; name: string; keys: string[] };

function readCookie(): string | null {
  try {
    const hit = document.cookie.split("; ").find((c) => c.startsWith(`${FOLDER_COOKIE}=`));
    return hit ? decodeURIComponent(hit.slice(FOLDER_COOKIE.length + 1)) : null;
  } catch {
    return null;
  }
}
const noopSubscribe = () => () => {};

export function ReportTabs({
  reports,
  folders,
  initialFolder,
}: {
  reports: TabReport[];
  folders: TabFolder[];
  initialFolder: string | null;
}) {
  const pathname = usePathname() ?? "";
  // Re-read on every render (a pathname change re-renders), server value on
  // hydration so the markup matches.
  const remembered = useSyncExternalStore(noopSubscribe, readCookie, () => initialFolder);

  if (pathname === "/commercial/reports") return null;

  const currentKey = reportKeyFromPath(pathname);
  const folder = folders.find((f) => f.id === remembered) ?? null;
  const scoped = folder && currentKey && folder.keys.includes(currentKey) ? folder : null;

  const byKey = new Map(reports.map((r) => [r.key, r]));
  const tabs: TabReport[] = scoped
    ? scoped.keys.map((k) => byKey.get(k)).filter((r): r is TabReport => !!r)
    : reports;
  const home = scoped
    ? { href: `/commercial/reports?folder=${encodeURIComponent(scoped.id)}`, label: scoped.name }
    : { href: "/commercial/reports", label: "Overview" };

  return (
    <nav aria-label="Reports" className="flex gap-1 overflow-x-auto border-b border-ppp-charcoal-100 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Link
        href={home.href}
        className="shrink-0 pl-2 pr-3 py-2 text-[13px] font-semibold border-b-2 border-transparent min-h-[44px] inline-flex items-center gap-1 touch-manipulation text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-200 max-w-[12rem]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span className="truncate">{home.label}</span>
      </Link>
      <span aria-hidden className="shrink-0 w-px my-2.5 bg-ppp-charcoal-100" />
      {tabs.map((r) => {
        const active = pathname === r.href || pathname.startsWith(`${r.href}/`);
        return (
          <Link
            key={r.href}
            href={r.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 px-3 py-2 text-[13px] font-semibold border-b-2 min-h-[44px] inline-flex items-center touch-manipulation transition-colors ${
              active
                ? "border-cc-brand-600 text-ppp-charcoal"
                : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-200"
            }`}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
