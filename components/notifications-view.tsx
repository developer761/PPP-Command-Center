"use client";

import { useState, useRef, useEffect } from "react";
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
  week: number;
  allTime: number;
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
  week,
  allTime,
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
      ? { text: "text-cc-brand-700", activeBg: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200", dot: "bg-cc-brand-600", kpi: "text-cc-brand-700", ring: "focus-visible:ring-cc-brand-600/40" }
      : { text: "text-ppp-blue-700", activeBg: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200", dot: "bg-ppp-blue-500", kpi: "text-ppp-blue-700", ring: "focus-visible:ring-ppp-blue-500/40" };

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

  const activeKindLabel = kind ? kindOptions.find((o) => o.value === kind)?.label ?? "Filtered" : "All types";
  const emptyEver = allTime === 0;

  return (
    <div className="space-y-4">
      {/* KPI strip — at-a-glance summary */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
        <Kpi label="Unread" value={localUnread} accent={localUnread > 0 ? accent.kpi : "text-ppp-charcoal-400"} />
        <Kpi label="This week" value={week} accent="text-ppp-charcoal-800" />
        <Kpi label="All time" value={allTime} accent="text-ppp-charcoal-800" />
      </div>

      {/* Filters: read/unread + kind + mark all */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "unread"] as const).map((f) => {
          const active = filter === f;
          return (
            <Link
              key={f}
              href={buildHref({ filter: f, page: "1" })}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center px-3.5 rounded-full text-[13px] font-semibold border min-h-[44px] transition-colors ${
                active ? accent.activeBg : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
              }`}
            >
              {f === "all" ? "All" : `Unread${localUnread > 0 ? ` · ${localUnread}` : ""}`}
            </Link>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          {kindOptions.length > 0 && (
            <KindMenu
              options={kindOptions}
              value={kind}
              label={activeKindLabel}
              accentRing={accent.ring}
              onPick={(v) => router.push(buildHref({ kind: v, page: "1" }))}
            />
          )}
          {localUnread > 0 && (
            <button
              type="button"
              onClick={markAll}
              disabled={markingAll}
              className={`inline-flex items-center rounded-lg border border-ppp-charcoal-200 bg-surface px-3 min-h-[44px] text-xs font-semibold ${accent.text} hover:bg-ppp-charcoal-50 disabled:opacity-50 touch-manipulation`}
            >
              {markingAll ? "Marking…" : "Mark all read"}
            </button>
          )}
        </div>
      </div>

      {/* List */}
      {localRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ppp-charcoal-200 bg-surface px-4 py-14 text-center">
          <div className={`mx-auto h-12 w-12 rounded-full flex items-center justify-center mb-3 ${emptyEver && filter === "all" && !kind ? "bg-emerald-50 text-emerald-500" : "bg-ppp-charcoal-50 text-ppp-charcoal-400"}`}>
            {emptyEver && filter === "all" && !kind ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
            )}
          </div>
          <p className="text-sm font-semibold text-ppp-charcoal">
            {kind
              ? "Nothing of this type"
              : filter === "unread"
              ? "You're all caught up"
              : "No notifications yet"}
          </p>
          <p className="mt-1 text-xs text-ppp-charcoal-500 max-w-xs mx-auto leading-relaxed">
            {kind
              ? "Try clearing the type filter to see everything."
              : filter === "unread"
              ? "Every notification has been read."
              : platform === "commercial"
              ? "Deal moves, proposals, invoices, and your custom alerts will show up here."
              : "Color-form submissions and team updates will show up here."}
          </p>
          {(kind || filter === "unread") && (
            <Link href={basePath} className={`mt-4 inline-flex items-center min-h-[44px] px-3 text-xs font-semibold ${accent.text} hover:underline`}>
              View all notifications
            </Link>
          )}
        </div>
      ) : (
        <ul className="bg-surface border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
          {localRows.map((n) => {
            const unreadRow = !n.read_at;
            const inner = (
              <div className={`px-4 py-3.5 ${unreadRow ? (platform === "commercial" ? "bg-cc-brand-50/30" : "bg-ppp-blue-50/30") : ""} hover:bg-ppp-charcoal-50/60 transition-colors`}>
                <div className="flex items-start gap-3">
                  {unreadRow ? (
                    <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${accent.dot}`} aria-label="Unread" />
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

function Kpi({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3.5 py-3">
      <div className={`text-2xl font-bold tabular-nums leading-none ${accent}`}>{value.toLocaleString()}</div>
      <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-400">{label}</div>
    </div>
  );
}

/** Styled type filter — replaces the native gray <select>. Button + popover
 *  with type-to-filter for longer option lists. */
function KindMenu({
  options,
  value,
  label,
  accentRing,
  onPick,
}: {
  options: { value: string; label: string }[];
  value: string | null;
  label: string;
  accentRing: string;
  onPick: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  const showSearch = options.length > 8;

  const pick = (v: string | null) => {
    onPick(v);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 min-h-[44px] text-[13px] font-medium touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 ${accentRing} ${
          value ? "border-ppp-charcoal-300 text-ppp-charcoal-800" : "border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6h16M7 12h10M10 18h4" /></svg>
        <span className="max-w-[130px] truncate">{label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-20 mt-1.5 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-ppp-charcoal-200 bg-surface shadow-lg overflow-hidden"
        >
          {showSearch && (
            <div className="p-2 border-b border-ppp-charcoal-100">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search types…"
                className="w-full px-2.5 py-2 text-[13px] rounded-lg border border-ppp-charcoal-200 focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300/40"
              />
            </div>
          )}
          <ul className="max-h-64 overflow-y-auto py-1">
            <li role="option" aria-selected={!value}>
              <button
                type="button"
                onClick={() => pick(null)}
                className={`w-full text-left px-3 py-2.5 text-[13px] min-h-[44px] flex items-center justify-between gap-2 hover:bg-ppp-charcoal-50 ${!value ? "font-semibold text-ppp-charcoal" : "text-ppp-charcoal-700"}`}
              >
                All types
                {!value && <Check />}
              </button>
            </li>
            {filtered.map((o) => (
              <li key={o.value} role="option" aria-selected={value === o.value}>
                <button
                  type="button"
                  onClick={() => pick(o.value)}
                  className={`w-full text-left px-3 py-2.5 text-[13px] min-h-[44px] flex items-center justify-between gap-2 hover:bg-ppp-charcoal-50 ${value === o.value ? "font-semibold text-ppp-charcoal" : "text-ppp-charcoal-700"}`}
                >
                  <span className="truncate">{o.label}</span>
                  {value === o.value && <Check />}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-[12px] text-ppp-charcoal-400 text-center">No matching types</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ppp-charcoal-500"><path d="M20 6 9 17l-5-5" /></svg>
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
