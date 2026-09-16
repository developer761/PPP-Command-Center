"use client";

/**
 * The way back out of a report. One link, nothing else.
 *
 * This used to be a bar listing every report the viewer could open, above every
 * report — so opening "Pipeline" put fourteen other report names across the top
 * before you reached the thing you asked for (Karan, 2026-09-16: "when I click
 * into something I don't want this to come up on the top… it should just bring
 * me to that page with a back arrow").
 *
 * It still knows WHERE back is: if you came in from a folder on the Reports
 * index (remembered in a cookie) and this report is in that folder, the link
 * returns you to the folder by name. Opened any other way — a dashboard link, a
 * bookmark — it returns you to Reports.
 *
 * Not shown on the index itself: there the folder rail IS the navigation.
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
  folders,
  initialFolder,
}: {
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

  const home = scoped
    ? { href: `/commercial/reports?folder=${encodeURIComponent(scoped.id)}`, label: scoped.name }
    : { href: "/commercial/reports", label: "Overview" };

  return (
    <nav aria-label="Back to reports" className="-mx-1 px-1">
      <Link
        href={home.href}
        className="inline-flex items-center gap-1.5 py-2 pr-3 text-[13px] font-semibold min-h-[44px] text-ppp-charcoal-500 hover:text-ppp-charcoal touch-manipulation max-w-full"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span className="truncate">{home.label}</span>
      </Link>
    </nav>
  );
}
