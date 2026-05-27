"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * Home-dashboard "Recent Activity" card — last-N-hours rollup of every
 * meaningful event across the customer-form / supplier-order / inbox
 * pipelines. Counterpart to the existing Color Forms / Pipeline-at-Risk
 * summary cards but action-level instead of state-level.
 *
 * Polls /api/admin/activity?windowHours=24 every 60s. Scope-aware on the
 * server side — workers see only events on WOs they own.
 *
 * Hidden when zero events to keep the dashboard clean.
 */

type ActivityKind =
  | "form_sent" | "form_opened" | "form_submitted"
  | "order_sent" | "order_acknowledged" | "order_delivered"
  | "reply_received";

type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  at: string;
  label: string;
  detail: string | null;
  workOrderId: string | null;
  workOrderNumber: string | null;
  tone: "positive" | "neutral" | "warning";
};

const KIND_ICON: Record<ActivityKind, string> = {
  form_sent: "📨",
  form_opened: "👁",
  form_submitted: "✓",
  order_sent: "📦",
  order_acknowledged: "🤝",
  order_delivered: "🚚",
  reply_received: "💬",
};

export default function RecentActivityFeed({ windowHours = 24 }: { windowHours?: number }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/activity?windowHours=${windowHours}&limit=20`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      setEvents(data.events ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    void load();
    // Auto-refresh every 60s so the feed stays fresh while admin watches
    const tick = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(tick);
  }, [load]);

  if (loading && events.length === 0) {
    return null; // Don't show a loading placeholder — keep dashboard clean on first paint
  }
  if (error && events.length === 0) {
    // Silent failure on the dashboard — error surfaces in console; card stays hidden
    return null;
  }
  if (events.length === 0) {
    return null; // Hide when nothing recent
  }

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-ppp-blue-50 text-ppp-blue-700 flex items-center justify-center text-xs">
            ⚡
          </div>
          <h3 className="text-sm font-semibold text-ppp-charcoal">Recent Activity</h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500">
          last {windowHours}h · {events.length}
        </span>
      </div>

      <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
        {events.map((e) => {
          const dotTone =
            e.tone === "positive" ? "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100"
            : e.tone === "warning" ? "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100"
            : "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100";
          const href = e.workOrderId
            ? `/dashboard/materials?wo=${encodeURIComponent(e.workOrderId)}`
            : "/dashboard/inbox";
          return (
            <li key={e.id} className="flex items-start gap-2.5 text-xs">
              <span className={`shrink-0 h-5 w-5 rounded border flex items-center justify-center text-[10px] ${dotTone}`}>
                {KIND_ICON[e.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <Link href={href} className="block group">
                  <div className="text-ppp-charcoal font-medium group-hover:text-ppp-blue transition-colors truncate">
                    {e.label}
                  </div>
                  {e.detail && (
                    <div className="text-[11px] text-ppp-charcoal-500 truncate">{e.detail}</div>
                  )}
                </Link>
              </div>
              <span className="shrink-0 text-[10px] text-ppp-charcoal-500 tabular-nums">
                {formatRelative(new Date(e.at))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatRelative(date: Date): string {
  const ms = Date.now() - date.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
