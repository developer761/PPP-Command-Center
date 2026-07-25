"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  notificationBadgeClasses,
  notificationKindLabel,
} from "@/lib/notifications/labels";

type Row = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

type Props = {
  rows: Row[];
  total: number;
  unread: number;
  page: number;
  totalPages: number;
  filter: "all" | "unread";
  kind: string | null;
  platform: "commercial" | "command_center";
  basePath: string;
  kindOptions: { value: string; label: string }[];
};

export default function NotificationsView({
  rows,
  total,
  unread,
  page,
  totalPages,
  filter,
  kind,
  platform,
  basePath,
  kindOptions,
}: Props) {
  const router = useRouter();
  const [localRows, setLocalRows] = useState<Row[]>(rows);
  const [localUnread, setLocalUnread] = useState(unread);
  const [markingAll, setMarkingAll] = useState(false);

  // Accent tone matches the platform (commercial = cc-brand red, CC = blue).
  const accent =
    platform === "commercial"
      ? { text: "text-cc-brand-700", activeBg: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200", dot: "bg-cc-brand-600" }
      : { text: "text-ppp-blue-700", activeBg: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200", dot: "bg-ppp-blue-500" };

  const buildHref = (patch: Record<string, string | null>): string => {
    const p = new URLSearchParams();
    const f = patch.filter !== undefined ? patch.filter : filter;
    const k = patch.kind !== undefined ? patch.kind : kind;
    const pg = patch.page !== undefined ? patch.page : "1";
    if (f && f !== "all") p.set("filter", f);
    if (k) p.set("kind", k);
    if (pg && pg !== "1") p.set("page", pg);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const markRead = async (id: string) => {
    setLocalRows((prev) => prev.map((r) => (r.id === id ? { ...r, read_at: new Date().toISOString() } : r)));
    setLocalUnread((n) => Math.max(0, n - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "PATCH" });
    } catch {
      /* next load corrects */
    }
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    setLocalRows((prev) => prev.map((r) => ({ ...r, read_at: r.read_at ?? new Date().toISOString() })));
    setLocalUnread(0);
    try {
      await fetch(`/api/notifications/mark-all-read?platform=${platform}`, { method: "PATCH" });
      router.refresh();
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header row: unread + mark all */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-ppp-charcoal-500">
          {localUnread > 0 ? (
            <span>
              <span className="font-semibold text-ppp-charcoal">{localUnread}</span> unread
              <span className="mx-1.5 text-ppp-charcoal-300">·</span>
            </span>
          ) : null}
          {total.toLocaleString()} total
        </div>
        {localUnread > 0 && (
          <button
            type="button"
            onClick={markAll}
            disabled={markingAll}
            className={`text-xs font-semibold ${accent.text} hover:underline min-h-[44px] inline-flex items-center px-1 disabled:opacity-50`}
          >
            {markingAll ? "Marking…" : "Mark all read"}
          </button>
        )}
      </div>

      {/* Filters: read/unread + kind */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "unread"] as const).map((f) => {
          const active = filter === f;
          return (
            <Link
              key={f}
              href={buildHref({ filter: f, page: "1" })}
              className={`inline-flex items-center px-3 py-1.5 rounded-full text-[13px] font-semibold border min-h-[40px] transition-colors ${
                active ? accent.activeBg : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
              }`}
            >
              {f === "all" ? "All" : "Unread"}
            </Link>
          );
        })}
        {kindOptions.length > 0 && (
          <select
            value={kind ?? ""}
            onChange={(e) => router.push(buildHref({ kind: e.target.value || null, page: "1" }))}
            aria-label="Filter by type"
            className="ml-auto rounded-lg border border-ppp-charcoal-200 bg-white px-2.5 py-2 text-[13px] text-ppp-charcoal-700 min-h-[40px]"
          >
            <option value="">All types</option>
            {kindOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* List */}
      {localRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-white px-4 py-16 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 flex items-center justify-center mb-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
          </div>
          <p className="text-sm text-ppp-charcoal-500">
            {filter === "unread" ? "No unread notifications." : "No notifications yet."}
          </p>
        </div>
      ) : (
        <ul className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
          {localRows.map((n) => {
            const unreadRow = !n.read_at;
            const inner = (
              <div className={`px-4 py-3.5 ${unreadRow ? (platform === "commercial" ? "bg-cc-brand-50/30" : "bg-ppp-blue-50/30") : ""} hover:bg-ppp-charcoal-50/60 transition-colors`}>
                <div className="flex items-start gap-3">
                  {unreadRow ? (
                    <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${accent.dot}`} aria-hidden />
                  ) : (
                    <span className="mt-1.5 h-2 w-2 shrink-0" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${notificationBadgeClasses(n.kind)}`}>
                        {notificationKindLabel(n.kind)}
                      </span>
                      <span className="text-[11px] text-ppp-charcoal-400" title={new Date(n.created_at).toLocaleString()}>
                        {formatAgo(n.created_at)}
                      </span>
                    </div>
                    <p className={`mt-1 text-sm ${unreadRow ? "font-semibold text-ppp-charcoal" : "text-ppp-charcoal-700"} leading-snug`}>
                      {n.title}
                    </p>
                    {n.body && (
                      <p className="mt-0.5 text-xs text-ppp-charcoal-500 leading-snug line-clamp-2">{n.body}</p>
                    )}
                  </div>
                </div>
              </div>
            );
            if (n.link) {
              return (
                <li key={n.id}>
                  <Link href={n.link} onClick={() => unreadRow && void markRead(n.id)} className="block">
                    {inner}
                  </Link>
                </li>
              );
            }
            return (
              <li key={n.id}>
                <button type="button" onClick={() => unreadRow && void markRead(n.id)} className="w-full text-left">
                  {inner}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          {page > 1 ? (
            <Link href={buildHref({ page: String(page - 1) })} className="inline-flex items-center gap-1.5 text-sm font-medium text-ppp-charcoal-600 hover:text-ppp-charcoal min-h-[44px] px-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
              Newer
            </Link>
          ) : <span />}
          <span className="text-xs text-ppp-charcoal-400 tabular-nums">Page {page} of {totalPages}</span>
          {page < totalPages ? (
            <Link href={buildHref({ page: String(page + 1) })} className="inline-flex items-center gap-1.5 text-sm font-medium text-ppp-charcoal-600 hover:text-ppp-charcoal min-h-[44px] px-2">
              Older
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
            </Link>
          ) : <span />}
        </div>
      )}
    </div>
  );
}

function formatAgo(createdAt: string): string {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
