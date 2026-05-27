"use client";

import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
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
type Mode = "inbox" | "sent";

type SentMessage = {
  id: string;
  kind: "form_invite" | "supplier_order";
  sentAt: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  workOrderId: string | null;
  workOrderNumber: string | null;
  resendMessageId: string | null;
  deliveryStatus: string | null;
  formUrl?: string | null;
  poNumber?: string | null;
  supplierName?: string | null;
  opened?: boolean;
  submitted?: boolean;
  acknowledged?: boolean;
  delivered?: boolean;
};

export default function InboxView() {
  // Per-WO filter — supports deep-linking from the Materials page so admin
  // can click "Mail for this WO" and land in a pre-filtered Mail Hub.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const woFilter = searchParams.get("wo") || null;

  const [mode, setMode] = useState<Mode>("inbox");
  const [tab, setTab] = useState<Tab>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [summary, setSummary] = useState<{ unread: number; returned: number }>({ unread: 0, returned: 0 });
  const [sentMessages, setSentMessages] = useState<SentMessage[]>([]);
  const [sentSummary, setSentSummary] = useState<{ formInvites: number; supplierOrders: number; returned: number }>({ formInvites: 0, supplierOrders: 0, returned: 0 });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const clearWoFilter = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("wo");
    router.replace(`${pathname}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  // Server fetch only depends on the archived flag — kind filtering happens
  // client-side via the tabCounts/visibleMessages memos. Tab switches feel
  // instant instead of triggering a full round-trip. Server fetch returns
  // the full archived/active set (capped at 200) which is fine for typical
  // inbox sizes; if we ever blow past that we'll add server pagination.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === "inbox") {
        const qp = new URLSearchParams({ kind: "all", archived: String(showArchived), limit: "200" });
        if (woFilter) qp.set("workOrderId", woFilter);
        const url = `/api/admin/inbox?${qp.toString()}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data.message ?? data.error ?? `HTTP ${res.status}`);
          return;
        }
        setMessages(data.messages ?? []);
        setSummary(data.summary ?? { unread: 0, returned: 0 });
      } else {
        const qp = new URLSearchParams({ limit: "200" });
        if (woFilter) qp.set("workOrderId", woFilter);
        const res = await fetch(`/api/admin/sent?${qp.toString()}`);
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data.message ?? data.error ?? `HTTP ${res.status}`);
          return;
        }
        setSentMessages(data.messages ?? []);
        setSentSummary(data.summary ?? { formInvites: 0, supplierOrders: 0, returned: 0 });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mode, showArchived, woFilter]);

  useEffect(() => { void load(); }, [load]);

  // Sent-mode client-side kind filter — mirrors the inbox tab pattern so
  // users can flip between "all sent / form invites only / supplier orders
  // only" without a server round-trip. "needs_followup" is a derived filter
  // that surfaces rows admin should chase: supplier orders sent >24h with
  // no ack, form invites sent >3 days with no submission, anything bounced.
  type SentKind = "all" | "form_invite" | "supplier_order" | "needs_followup";
  const [sentKind, setSentKind] = useState<SentKind>("all");
  const [search, setSearch] = useState("");

  const needsFollowupSet = useMemo(() => {
    const now = Date.now();
    const ms24h = 24 * 60 * 60 * 1000;
    const ms3d = 3 * 24 * 60 * 60 * 1000;
    const out = new Set<string>();
    for (const m of sentMessages) {
      const ageMs = now - new Date(m.sentAt).getTime();
      if (m.deliveryStatus === "bounced") {
        out.add(m.id); continue;
      }
      if (m.kind === "supplier_order") {
        // Stale supplier order — sent over 24h ago, not acknowledged, not delivered
        if (ageMs > ms24h && !m.acknowledged && !m.delivered) out.add(m.id);
      } else if (m.kind === "form_invite") {
        // Stale form invite — sent over 3 days ago, not submitted
        if (ageMs > ms3d && !m.submitted) out.add(m.id);
      }
    }
    return out;
  }, [sentMessages]);

  const visibleSent = useMemo(() => {
    let list = sentMessages;
    if (sentKind === "needs_followup") list = list.filter((m) => needsFollowupSet.has(m.id));
    else if (sentKind !== "all") list = list.filter((m) => m.kind === sentKind);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => {
        const hay = [
          m.subject,
          m.recipientEmail,
          m.recipientName ?? "",
          m.workOrderNumber ?? "",
          m.poNumber ?? "",
          m.supplierName ?? "",
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [sentMessages, sentKind, search, needsFollowupSet]);

  // Client-side tab filter for INBOX mode + same search box. Inbox search
  // matches sender + subject + body so admin can scan a long thread list.
  const visibleMessages = useMemo(() => {
    let list = tab === "all" ? messages : messages.filter((m) => m.kind === tab);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => {
        const hay = [
          m.subject ?? "",
          m.from_email,
          m.from_name ?? "",
          m.body_text ?? "",
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [messages, tab, search]);

  // Reset search when switching modes — different surface, different intent
  useEffect(() => { setSearch(""); }, [mode]);

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
      {/* WO-scoped filter banner — when admin deep-links from a WO on the
          materials page, surfaces the active scope + a one-click escape. */}
      {woFilter && (
        <div className="bg-ppp-blue-50/60 border border-ppp-blue-100 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap text-xs">
          <span className="text-ppp-blue-700">
            Showing mail for this work order only · <span className="font-mono">{woFilter.slice(-6)}</span>
          </span>
          <button
            type="button"
            onClick={clearWoFilter}
            className="shrink-0 px-2.5 py-0.5 rounded-lg border border-ppp-blue-100 bg-white text-[11px] font-semibold text-ppp-blue-700 hover:bg-ppp-blue-50 transition-colors"
          >
            Show all mail
          </button>
        </div>
      )}

      {/* Mode toggle — Inbox (replies coming in) vs Sent (every email we've
          sent out). Top-level so the summary strip + tabs below adapt. */}
      <div className="inline-flex bg-ppp-charcoal-50 rounded-lg p-0.5 text-xs font-semibold">
        <button
          type="button"
          onClick={() => setMode("inbox")}
          className={[
            "px-3 py-1.5 rounded-md transition-colors",
            mode === "inbox" ? "bg-white text-ppp-charcoal shadow-sm" : "text-ppp-charcoal-500 hover:text-ppp-charcoal",
          ].join(" ")}
        >
          📥 Inbox
        </button>
        <button
          type="button"
          onClick={() => setMode("sent")}
          className={[
            "px-3 py-1.5 rounded-md transition-colors",
            mode === "sent" ? "bg-white text-ppp-charcoal shadow-sm" : "text-ppp-charcoal-500 hover:text-ppp-charcoal",
          ].join(" ")}
        >
          📤 Sent
        </button>
      </div>

      {mode === "inbox" ? (
        <>
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

          {/* Tabs + search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              <TabButton active={tab === "all"} onClick={() => setTab("all")} label="All" count={tabCounts.all} />
              <TabButton active={tab === "supplier_reply"} onClick={() => setTab("supplier_reply")} label="Suppliers" count={tabCounts.supplier_reply} />
              <TabButton active={tab === "customer_reply"} onClick={() => setTab("customer_reply")} label="Customers" count={tabCounts.customer_reply} />
              <TabButton active={tab === "unmatched"} onClick={() => setTab("unmatched")} label="Unmatched" count={tabCounts.unmatched} tone="orange" />
            </div>
            <SearchBox value={search} onChange={setSearch} placeholder="Search sender / subject / body…" />
          </div>

          {/* List */}
          {loading && (
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
              Loading messages…
            </div>
          )}
          {error && (
            <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-3 text-sm text-ppp-orange-700 flex items-start justify-between gap-3 flex-wrap">
              <span>Couldn&apos;t load inbox: {error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="shrink-0 px-3 py-1 rounded-lg border border-ppp-orange-100 bg-white text-xs font-semibold text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && visibleMessages.length === 0 && (
            <EmptyState archived={showArchived} />
          )}
          {!loading && !error && visibleMessages.length > 0 && (
            <ul className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden divide-y divide-ppp-charcoal-100">
              {visibleMessages.map((m) => (
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
        </>
      ) : (
        <>
          {/* Sent-mode summary strip */}
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-ppp-charcoal-500">
              <strong className="text-ppp-charcoal">{sentSummary.returned}</strong> sent ·{" "}
              <span className="text-ppp-blue-700">{sentSummary.formInvites}</span> color forms ·{" "}
              <span className="text-ppp-charcoal">{sentSummary.supplierOrders}</span> supplier orders
            </div>
            <div className="text-[10px] text-ppp-charcoal-500 uppercase tracking-wider font-semibold">
              Newest first
            </div>
          </div>

          {/* Sent-mode kind tabs + search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              <TabButton active={sentKind === "all"} onClick={() => setSentKind("all")} label="All" count={sentMessages.length} />
              <TabButton active={sentKind === "form_invite"} onClick={() => setSentKind("form_invite")} label="Color Forms" count={sentMessages.filter((m) => m.kind === "form_invite").length} />
              <TabButton active={sentKind === "supplier_order"} onClick={() => setSentKind("supplier_order")} label="Supplier Orders" count={sentMessages.filter((m) => m.kind === "supplier_order").length} />
              <TabButton
                active={sentKind === "needs_followup"}
                onClick={() => setSentKind("needs_followup")}
                label="Needs Follow-up"
                count={needsFollowupSet.size}
                tone={needsFollowupSet.size > 0 ? "orange" : undefined}
              />
            </div>
            <SearchBox value={search} onChange={setSearch} placeholder="Search recipient / PO# / WO#…" />
          </div>

          {/* List */}
          {loading && (
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
              Loading sent mail…
            </div>
          )}
          {error && (
            <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-xl px-4 py-3 text-sm text-ppp-orange-700 flex items-start justify-between gap-3 flex-wrap">
              <span>Couldn&apos;t load sent mail: {error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="shrink-0 px-3 py-1 rounded-lg border border-ppp-orange-100 bg-white text-xs font-semibold text-ppp-orange-700 hover:bg-ppp-orange-50 transition-colors"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && visibleSent.length === 0 && (
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
              <div className="mx-auto h-12 w-12 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-500 flex items-center justify-center text-2xl mb-3">📤</div>
              <h3 className="text-base font-bold text-ppp-charcoal">No sent mail yet.</h3>
              <p className="text-xs text-ppp-charcoal-500 mt-2 max-w-md mx-auto">
                When you send a color form or a supplier order, it'll show up here so you have a complete log of every email the Command Center has produced.
              </p>
            </div>
          )}
          {!loading && !error && visibleSent.length > 0 && (
            <ul className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden divide-y divide-ppp-charcoal-100">
              {visibleSent.map((m) => (
                <SentRow key={m.id} message={m} onResent={load} />
              ))}
            </ul>
          )}
        </>
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
  tone?: "neutral" | "orange" | undefined;
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

/* ─── Sent-mode row ─── */

function SentRow({ message, onResent }: { message: SentMessage; onResent?: () => void }) {
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleResend = async () => {
    if (resending) return;
    setResending(true);
    setResendResult(null);
    try {
      const res = await fetch("/api/admin/sent/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: message.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setResendResult({ ok: false, msg: data.message ?? data.error ?? `HTTP ${res.status}` });
      } else {
        setResendResult({ ok: true, msg: "Re-sent ✓" });
        // Bubble up so the parent reloads the list with fresh delivery status
        setTimeout(() => { onResent?.(); }, 1200);
      }
    } catch (err) {
      setResendResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setResending(false);
    }
  };

  const isForm = message.kind === "form_invite";
  const kindLabel = isForm ? "Color Form" : "Supplier Order";
  const kindTone = isForm ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100"
                          : "bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100";

  // Lifecycle chip — answers "what happened after we sent it?" at a glance.
  let lifecycle: { label: string; tone: string } | null = null;
  if (isForm) {
    if (message.submitted) lifecycle = { label: "✓ Submitted", tone: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100" };
    else if (message.opened) lifecycle = { label: "Opened", tone: "bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100" };
    else lifecycle = { label: "Waiting on customer", tone: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100" };
  } else {
    if (message.delivered) lifecycle = { label: "✓ Delivered", tone: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100" };
    else if (message.acknowledged) lifecycle = { label: "Acknowledged", tone: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100" };
    else lifecycle = { label: "Waiting on supplier", tone: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100" };
  }

  // Deep link: WO# routes admin to the materials page filtered to that WO.
  const woHref = message.workOrderId
    ? `/dashboard/materials?wo=${encodeURIComponent(message.workOrderId)}`
    : null;

  return (
    <li className="px-5 py-3 hover:bg-ppp-charcoal-50/50 transition-colors">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          {/* Top row: kind chip + recipient */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${kindTone}`}>
              {kindLabel}
            </span>
            <span className="font-semibold text-ppp-charcoal truncate">
              {message.recipientName || message.recipientEmail}
            </span>
            {message.recipientName && (
              <span className="text-ppp-charcoal-500 truncate">{message.recipientEmail}</span>
            )}
          </div>

          {/* Subject */}
          <div className="mt-1 text-sm text-ppp-charcoal truncate">{message.subject}</div>

          {/* Bottom row: WO link + relative time + lifecycle chip */}
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-ppp-charcoal-500">
            {woHref && message.workOrderNumber && (
              <a
                href={woHref}
                className="hover:text-ppp-blue hover:underline font-mono"
              >
                WO #{message.workOrderNumber}
              </a>
            )}
            <span>· {formatRelative(new Date(message.sentAt))}</span>
            {lifecycle && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${lifecycle.tone}`}>
                {lifecycle.label}
              </span>
            )}
            {message.deliveryStatus === "bounced" && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-ppp-orange text-white border-ppp-orange">
                ⚠ Bounced
              </span>
            )}
          </div>
        </div>

        {/* Right rail — actions. Resend button when bounced; "Open form ↗"
            for un-bounced form invites; nothing for happy supplier orders. */}
        <div className="shrink-0 self-center flex items-center gap-2">
          {message.deliveryStatus === "bounced" && (
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="px-3 py-1 rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-[11px] font-semibold text-ppp-orange-700 hover:bg-ppp-orange-100 disabled:opacity-60 transition-colors"
            >
              {resending ? "Re-sending…" : resendResult?.ok ? "Re-sent ✓" : "Re-send"}
            </button>
          )}
          {resendResult && !resendResult.ok && (
            <span className="text-[10px] text-ppp-orange-700">{resendResult.msg}</span>
          )}
          {isForm && message.formUrl && message.deliveryStatus !== "bounced" && (
            <a
              href={message.formUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 rounded-lg border border-ppp-charcoal-100 bg-white text-[11px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
            >
              Open form ↗
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

/* ─── Search input ─── */
function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative flex-1 min-w-[200px] max-w-md">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-7 pr-3 py-1.5 text-xs border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
      />
      <svg
        className="absolute left-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-500 pointer-events-none"
        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    </div>
  );
}
