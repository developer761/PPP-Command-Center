"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * Mail-history activity stream for a single work order (Kate #2). A
 * Salesforce-style vertical feed of every email SENT (color-form invites +
 * supplier orders) and RECEIVED (customer/supplier replies) for this WO,
 * merged and sorted newest-first. Renders down the right side of the WO page.
 *
 * Data: /api/admin/sent + /api/admin/inbox, both filtered by workOrderId and
 * both scope-gated (Account Managers see all WOs, so they can read it too).
 */

type Item = {
  at: string;
  dir: "out" | "in";
  title: string;
  who: string;
  snippet?: string | null;
  badge?: string | null;
};

export default function WoMailStream({
  workOrderId,
  workOrderNumber,
  refreshKey = 0,
}: {
  workOrderId: string;
  workOrderNumber: string | null;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const q = `workOrderId=${encodeURIComponent(workOrderId)}&kind=all`;
      const [sentRes, inboxRes] = await Promise.all([
        fetch(`/api/admin/sent?${q}`, { cache: "no-store" }),
        fetch(`/api/admin/inbox?${q}`, { cache: "no-store" }),
      ]);
      // If BOTH endpoints failed, surface an error rather than a misleading
      // "No emails" empty state (a 500/401 was silently masked before).
      if (!sentRes.ok && !inboxRes.ok) {
        setState("error");
        return;
      }
      const merged: Item[] = [];

      if (sentRes.ok) {
        const j = await sentRes.json();
        for (const m of (j.messages ?? []) as Array<Record<string, unknown>>) {
          const kind = String(m.kind ?? "");
          const badges: string[] = [];
          if (m.submitted) badges.push("submitted");
          else if (m.opened) badges.push("opened");
          if (m.delivered) badges.push("delivered");
          else if (m.acknowledged) badges.push("acknowledged");
          if (m.deliveryStatus === "bounced" || m.deliveryStatus === "soft_bounce") badges.push("bounced");
          merged.push({
            at: String(m.sentAt ?? ""),
            dir: "out",
            title:
              (m.subject as string) ||
              (kind === "supplier_order" ? "Materials order sent" : "Color form sent"),
            who: `to ${(m.recipientName as string) || (m.recipientEmail as string) || "—"}${
              m.supplierName ? ` · ${m.supplierName}` : ""
            }`,
            badge: badges[0] ?? null,
          });
        }
      }

      if (inboxRes.ok) {
        const j = await inboxRes.json();
        for (const m of (j.messages ?? []) as Array<Record<string, unknown>>) {
          merged.push({
            at: String(m.received_at ?? ""),
            dir: "in",
            title: (m.subject as string) || "(reply)",
            who: `from ${(m.from_name as string) || (m.from_email as string) || "—"}`,
            snippet: (m.body_text as string | null) ?? null,
          });
        }
      }

      merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      setItems(merged);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [workOrderId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500">
          Mail history
        </span>
        <Link
          href={`/dashboard/inbox?wo=${encodeURIComponent(workOrderId)}`}
          className="inline-flex items-center min-h-[44px] text-[11px] font-medium text-ppp-blue-700 hover:text-ppp-blue-800 whitespace-nowrap"
        >
          Open in Mail Hub
        </Link>
      </div>

      {state === "loading" ? (
        <div className="p-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse flex gap-3">
              <div className="h-6 w-6 rounded-full bg-ppp-charcoal-100 shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-2.5 bg-ppp-charcoal-100 rounded w-3/4" />
                <div className="h-2 bg-ppp-charcoal-50 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : state === "error" ? (
        <p className="px-4 py-6 text-center text-xs text-ppp-charcoal-400">
          Couldn&apos;t load mail history.{" "}
          <button type="button" onClick={() => void load()} className="text-ppp-blue-700 underline">
            Retry
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-ppp-charcoal-400">
          No emails sent or received yet for{" "}
          {workOrderNumber ? `WO ${workOrderNumber}` : "this work order"}.
        </p>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-50 max-h-[520px] overflow-y-auto">
          {items.map((m, i) => (
            <li key={`${m.at}-${i}`} className="px-4 py-3 flex gap-3">
              <span
                className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  m.dir === "out"
                    ? "bg-ppp-blue-50 text-ppp-blue-700"
                    : "bg-ppp-green-50 text-ppp-green-700"
                }`}
              >
                <span className="sr-only">{m.dir === "out" ? "Sent:" : "Received:"}</span>
                {m.dir === "out" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13 M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4z M22 6l-10 7L2 6" /></svg>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium text-ppp-charcoal truncate">{m.title}</span>
                  <span className="text-[10px] text-ppp-charcoal-400 whitespace-nowrap">{fmtWhen(m.at)}</span>
                </div>
                <div className="text-[11px] text-ppp-charcoal-400 truncate">{m.who}</div>
                {m.snippet && (
                  <p className="mt-1 text-[11px] text-ppp-charcoal-500 line-clamp-2">{m.snippet}</p>
                )}
                {m.badge && (
                  <span className="mt-1 inline-flex items-center rounded bg-ppp-charcoal-50 px-1.5 py-0.5 text-[10px] font-medium text-ppp-charcoal-500">
                    {m.badge}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
