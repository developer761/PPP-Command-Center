"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * In-app notification bell (Katie + Alex 2026-06-12).
 *
 * Behaviour:
 *   - Polls GET /api/notifications every 45s while open + every 90s when
 *     closed. 90s closed is fast enough for "I just got a notification"
 *     awareness without hammering the DB when the user isn't looking.
 *   - Refetches immediately when the tab regains focus so a user who's
 *     been on another tab for 10min sees fresh state on return.
 *   - Click a row → marks it read via PATCH /api/notifications/:id/read,
 *     then follows the row's link in the same tab.
 *   - "Mark all read" wipes unread in one shot.
 *   - 44px tap target on the trigger (iOS HIG); dropdown is mobile-safe
 *     (right-anchored, max-w-[calc(100vw-32px)] so it doesn't clip).
 *
 * Scoping is enforced by the API — this component just renders whatever
 * the server returns for the signed-in user. A worker physically cannot
 * see another rep's rows because they were never inserted as recipient.
 */

type Item = {
  id: string;
  kind: string;
  work_order_id: string | null;
  work_order_number: string | null;
  customer_name: string | null;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

const OPEN_POLL_MS = 45_000;
const IDLE_POLL_MS = 90_000;

function formatAgo(createdAt: string, now: number): string {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount?: number; items?: Item[] };
      setUnread(data.unreadCount ?? 0);
      setItems(data.items ?? []);
    } catch {
      // Silent — bell is non-critical; bad network means stale dropdown,
      // not a broken page.
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + poll loop (cadence depends on open/closed).
  useEffect(() => {
    load();
    const cadence = open ? OPEN_POLL_MS : IDLE_POLL_MS;
    const id = setInterval(load, cadence);
    return () => clearInterval(id);
  }, [load, open]);

  // Refresh on tab focus so a user returning from another tab sees fresh state.
  useEffect(() => {
    const onFocus = () => load();
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // Tick the "5m ago" timestamps once a minute while open. No need when closed.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [open]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markOne = useCallback(
    async (id: string) => {
      // Optimistic: flip locally so the row looks read before the round-trip.
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, read_at: new Date().toISOString() } : it)));
      setUnread((n) => Math.max(0, n - 1));
      try {
        await fetch(`/api/notifications/${id}/read`, { method: "PATCH" });
      } catch {
        // If the PATCH failed the next poll corrects local state.
      }
    },
    []
  );

  const markAll = useCallback(async () => {
    setItems((prev) => prev.map((it) => ({ ...it, read_at: it.read_at ?? new Date().toISOString() })));
    setUnread(0);
    try {
      await fetch("/api/notifications/mark-all-read", { method: "PATCH" });
    } catch {
      // Same — next poll corrects.
    }
  }, []);

  const badgeText = unread > 9 ? "9+" : String(unread);

  // Audit fix: bell used to be hard-coded ppp-blue (residential palette).
  // Now derives from route — commercial surface uses cc-brand (red),
  // everywhere else keeps ppp-blue. Single source of truth for the
  // accent tone across hover/badge/dropdown-row states.
  const pathname = usePathname();
  const isCommercial = (pathname ?? "").startsWith("/commercial");
  const tone = useMemo(() => {
    if (isCommercial) {
      return {
        hoverBg: "hover:bg-cc-brand-50",
        hoverBorder: "hover:border-cc-brand-200",
        activeBg: "active:bg-cc-brand-100",
        badgeBg: "bg-cc-brand-600",
        linkText: "text-cc-brand-700 hover:text-cc-brand-800",
        rowUnreadBg: "bg-cc-brand-50/40",
        rowHoverBg: "hover:bg-cc-brand-50/60",
        dotBg: "bg-cc-brand-600",
      };
    }
    return {
      hoverBg: "hover:bg-ppp-blue-50",
      hoverBorder: "hover:border-ppp-blue-200",
      activeBg: "active:bg-ppp-blue-100",
      badgeBg: "bg-ppp-blue",
      linkText: "text-ppp-blue hover:text-ppp-blue-700",
      rowUnreadBg: "bg-ppp-blue-50/40",
      rowHoverBg: "hover:bg-ppp-blue-50/60",
      dotBg: "bg-ppp-blue",
    };
  }, [isCommercial]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`relative flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal ${tone.hoverBg} ${tone.hoverBorder} ${tone.activeBg} transition-colors touch-manipulation`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <>
            {/* Superhuman-style presence ping — subtle emerald pulse
                overlay that draws the eye without shouting. */}
            <span
              aria-hidden
              className="absolute -top-1 -right-1 h-5 min-w-[20px] rounded-full bg-emerald-500 opacity-40 animate-ping"
            />
            <span
              className={`absolute -top-1 -right-1 h-5 min-w-[20px] px-1 rounded-full ${tone.badgeBg} text-white text-[10px] font-semibold flex items-center justify-center`}
              aria-hidden
            >
              {badgeText}
            </span>
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-96 max-w-[calc(100vw-32px)] bg-white border border-ppp-charcoal-100 rounded-xl shadow-lg overflow-hidden z-50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100">
            <h3 className="text-sm font-semibold text-ppp-charcoal">Notifications</h3>
            {items.some((it) => !it.read_at) && (
              <button
                type="button"
                onClick={markAll}
                className={`text-xs font-medium ${tone.linkText}`}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {loading && items.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ppp-charcoal-500">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-ppp-charcoal-500">
                You&apos;re all caught up.
              </div>
            ) : (
              <ul className="divide-y divide-ppp-charcoal-100">
                {items.map((it) => {
                  const unreadRow = !it.read_at;
                  const body = (
                    <div className={`px-4 py-3 ${unreadRow ? tone.rowUnreadBg : ""} ${tone.rowHoverBg} transition-colors`}>
                      <div className="flex items-start gap-3">
                        {unreadRow && <span className={`mt-1.5 h-2 w-2 rounded-full ${tone.dotBg} shrink-0`} aria-hidden />}
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm ${unreadRow ? "font-semibold text-ppp-charcoal" : "text-ppp-charcoal-700"} leading-snug`}>
                            {it.title}
                          </p>
                          {it.body && (
                            <p className="mt-0.5 text-xs text-ppp-charcoal-500 leading-snug line-clamp-2">{it.body}</p>
                          )}
                          <p className="mt-1 text-[11px] text-ppp-charcoal-400">{formatAgo(it.created_at, now)}</p>
                        </div>
                      </div>
                    </div>
                  );
                  if (it.link) {
                    return (
                      <li key={it.id}>
                        <Link
                          href={it.link}
                          onClick={() => {
                            if (unreadRow) void markOne(it.id);
                            setOpen(false);
                          }}
                          className="block"
                        >
                          {body}
                        </Link>
                      </li>
                    );
                  }
                  return (
                    <li key={it.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (unreadRow) void markOne(it.id);
                        }}
                        className="w-full text-left"
                      >
                        {body}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
