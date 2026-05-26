"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Inbox list + thread viewer. Filters by kind (All / Customer / Supplier /
 * Unmatched) and toggles archived view. Clicking a message expands the body
 * inline + marks it read.
 *
 * Renders empty-friendly: on a fresh deploy with no Resend inbound config
 * yet, the inbox is empty — UI shows a "How to enable" hint.
 */

type InboxMessage = {
  id: string;
  kind: "customer_reply" | "supplier_reply" | "unmatched";
  linked_token: string | null;
  linked_order_id: string | null;
  linked_work_order_id: string | null;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  read_at: string | null;
  archived_at: string | null;
};

type Tab = "all" | "customer_reply" | "supplier_reply" | "unmatched";

export default function InboxView() {
  const [tab, setTab] = useState<Tab>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [summary, setSummary] = useState<{ unread: number; returned: number }>({ unread: 0, returned: 0 });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/admin/inbox?kind=${tab}&archived=${showArchived}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      setMessages(data.messages ?? []);
      setSummary(data.summary ?? { unread: 0, returned: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tab, showArchived]);

  useEffect(() => { void load(); }, [load]);

  const markRead = async (id: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, read_at: new Date().toISOString() } : m))
    );
    setSummary((prev) => ({ ...prev, unread: Math.max(0, prev.unread - 1) }));
    try {
      await fetch("/api/admin/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: id, action: "mark_read" }),
      });
    } catch {
      // Optimistic update — refresh on error
      void load();
    }
  };

  const archive = async (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    try {
      await fetch("/api/admin/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: id, action: "archive" }),
      });
    } catch {
      void load();
    }
  };

  const expand = (id: string, isUnread: boolean) => {
    setExpandedId((prev) => (prev === id ? null : id));
    if (isUnread) void markRead(id);
  };

  const tabCounts = useMemo(() => {
    const c = { all: 0, customer_reply: 0, supplier_reply: 0, unmatched: 0 };
    for (const m of messages) {
      c.all += 1;
      c[m.kind] += 1;
    }
    return c;
  }, [messages]);

  return (
    <div className="space-y-4">
      {/* Header strip — summary + archive toggle */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-ppp-charcoal-500">
          {summary.unread > 0 ? (
            <>
              <strong className="text-ppp-orange-700">{summary.unread} unread</strong>
              {" · "}
              {summary.returned} in this view
            </>
          ) : (
            <>{summary.returned} messages in this view · all caught up ✓</>
          )}
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-ppp-charcoal-500 cursor-pointer">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        <TabButton active={tab === "all"} onClick={() => setTab("all")} label="All" count={tabCounts.all} />
        <TabButton active={tab === "supplier_reply"} onClick={() => setTab("supplier_reply")} label="Suppliers" count={tabCounts.supplier_reply} />
        <TabButton active={tab === "customer_reply"} onClick={() => setTab("customer_reply")} label="Customers" count={tabCounts.customer_reply} />
        <TabButton active={tab === "unmatched"} onClick={() => setTab("unmatched")} label="Unmatched" count={tabCounts.unmatched} tone="orange" />
      </div>

      {/* List */}
      {loading && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          Loading messages…
        </div>
      )}
      {error && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-3 text-sm text-ppp-orange-700">
          Couldn&apos;t load inbox: {error}
        </div>
      )}
      {!loading && !error && messages.length === 0 && (
        <EmptyState archived={showArchived} />
      )}
      {!loading && !error && messages.length > 0 && (
        <ul className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden divide-y divide-ppp-charcoal-100">
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              expanded={expandedId === m.id}
              onExpand={() => expand(m.id, !m.read_at)}
              onArchive={() => archive(m.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── Components ─── */

function TabButton({
  active,
  onClick,
  label,
  count,
  tone = "neutral",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "neutral" | "orange";
}) {
  const base = "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors";
  const activeCls = active
    ? tone === "orange"
      ? "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100"
      : "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100"
    : "bg-white text-ppp-charcoal-500 border-ppp-charcoal-100 hover:bg-ppp-charcoal-50";
  return (
    <button type="button" onClick={onClick} className={`${base} ${activeCls}`}>
      {label}
      {count > 0 && (
        <span className="ml-1.5 text-[10px] font-normal opacity-75">{count}</span>
      )}
    </button>
  );
}

function MessageRow({
  message,
  expanded,
  onExpand,
  onArchive,
}: {
  message: InboxMessage;
  expanded: boolean;
  onExpand: () => void;
  onArchive: () => void;
}) {
  const isUnread = !message.read_at;
  const kindLabel = message.kind === "customer_reply" ? "Customer" :
                    message.kind === "supplier_reply" ? "Supplier" :
                    "Unmatched";
  const kindCls = message.kind === "customer_reply"
    ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100"
    : message.kind === "supplier_reply"
    ? "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100"
    : "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100";
  const date = new Date(message.received_at);
  const ago = formatRelative(date);

  return (
    <li className={isUnread ? "bg-ppp-blue-50/30" : ""}>
      <button
        type="button"
        onClick={onExpand}
        className="w-full text-left px-4 sm:px-5 py-3 hover:bg-ppp-charcoal-50/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {isUnread && <span className="inline-block h-2 w-2 rounded-full bg-ppp-blue shrink-0" aria-label="Unread" />}
              <span className={`text-[10px] uppercase font-bold tracking-wide px-1.5 py-0.5 rounded border ${kindCls}`}>
                {kindLabel}
              </span>
              <span className={`text-sm truncate ${isUnread ? "font-bold text-ppp-charcoal" : "font-medium text-ppp-charcoal-500"}`}>
                {message.from_name ?? message.from_email}
              </span>
            </div>
            <div className={`text-xs mt-1 truncate ${isUnread ? "text-ppp-charcoal" : "text-ppp-charcoal-500"}`}>
              {message.subject ?? "(no subject)"}
            </div>
          </div>
          <div className="text-[10px] text-ppp-charcoal-500 shrink-0 whitespace-nowrap">
            {ago}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-ppp-charcoal-100 px-4 sm:px-5 py-4 bg-white">
          <div className="text-[11px] text-ppp-charcoal-500 mb-2">
            From <strong className="text-ppp-charcoal">{message.from_email}</strong> · {date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
            {message.linked_work_order_id && (
              <> · linked to WO <span className="font-mono">{message.linked_work_order_id.slice(-8)}</span></>
            )}
          </div>
          {message.body_text ? (
            <pre className="text-xs text-ppp-charcoal whitespace-pre-wrap font-sans leading-relaxed">
              {message.body_text}
            </pre>
          ) : (
            <div className="text-xs text-ppp-charcoal-500 italic">(no plain-text body — HTML only)</div>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onArchive}
              className="px-3 py-1.5 rounded-lg border border-ppp-charcoal-100 text-xs font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
            >
              Archive
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function EmptyState({ archived }: { archived: boolean }) {
  if (archived) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center text-sm text-ppp-charcoal-500">
        Nothing archived yet.
      </div>
    );
  }
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 sm:p-10 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-ppp-blue-50 text-ppp-blue flex items-center justify-center text-2xl mb-3">
        📬
      </div>
      <h3 className="text-base font-bold text-ppp-charcoal">Inbox is empty</h3>
      <p className="text-xs text-ppp-charcoal-500 mt-2 max-w-md mx-auto leading-relaxed">
        Once Resend inbound is configured on{" "}
        <strong className="text-ppp-charcoal font-mono">orders@orders.precisionpaintingplus.net</strong>,
        every supplier reply + customer follow-up will land here.
      </p>
      <div className="mt-4 text-[11px] text-ppp-charcoal-500 max-w-md mx-auto text-left bg-ppp-charcoal-50/40 border border-ppp-charcoal-100 rounded-lg px-4 py-3 leading-relaxed">
        <strong className="text-ppp-charcoal">Setup steps:</strong>
        <ol className="list-decimal list-inside mt-1 space-y-0.5">
          <li>Resend dashboard → Inbound → Add address <code className="font-mono">orders@orders.precisionpaintingplus.net</code></li>
          <li>Webhook URL: <code className="font-mono break-all">https://hub.precisionpaintingplus.net/api/webhooks/resend-inbound</code></li>
          <li>Copy the webhook secret → set Vercel env var <code className="font-mono">RESEND_INBOUND_SECRET</code></li>
        </ol>
      </div>
    </div>
  );
}

function formatRelative(date: Date): string {
  const now = Date.now();
  const ms = now - date.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
