"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { WoProgress } from "@/lib/wo-progress/types";

/**
 * Activity History for a single work order (Kate round-2 #05). A Salesforce-
 * style vertical feed that merges every email SENT (color-form invites +
 * supplier orders) and RECEIVED (replies) with the WO's lifecycle EVENTS (form
 * opened, colors submitted, order drafted), sorted newest-first. Renders down
 * the right side of the WO page.
 *
 * Data: /api/admin/sent + /api/admin/inbox (both filtered by workOrderId, both
 * scope-gated) + the server-derived `progress` timeline for the lifecycle events.
 */

type Item = {
  at: string;
  dir: "out" | "in" | "event";
  title: string;
  who: string;
  snippet?: string | null;
  badge?: string | null;
};

export default function WoMailStream({
  workOrderId,
  workOrderNumber,
  refreshKey = 0,
  progress = null,
}: {
  workOrderId: string;
  workOrderNumber: string | null;
  refreshKey?: number;
  progress?: WoProgress | null;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  // Kate round-2 #05 / round-3 #03: granular lifecycle events merged into the
  // email feed, with EVERY action attributed to a customer or a named account
  // manager. Kate's words: "The whole point is removing ambiguity about who did
  // what." Previously an open showed with no actor at all, and the attribution
  // was derived from submittedByName — so a form an AM had opened but not yet
  // submitted was reported as the customer opening it.
  const events = useMemo<Item[]>(() => {
    if (!progress) return [];
    const internal = progress.entryMode === "internal";
    const sentBy = progress.sentByName?.trim() || null;
    const openedBy = progress.openedByName?.trim() || null;
    const submittedBy = progress.submittedByName?.trim() || null;
    // An internal entry is staff acting for the customer; a normal token's
    // opens and submits are the customer's, whoever sent the link.
    const actor = (name: string | null) =>
      name ? `by ${name} (account manager)` : internal ? "by an account manager" : "by the customer";

    const out: Item[] = [];
    // Only for an INTERNAL entry: no email is sent, so nothing in the mail feed
    // marks the start. A real send already appears below as an outbound row —
    // adding it here too would list it twice.
    if (progress.formSentAt && internal)
      out.push({
        at: progress.formSentAt,
        dir: "event",
        title: "Internal entry started",
        who: sentBy ? `by ${sentBy} (account manager)` : "by an account manager",
      });
    if (progress.formOpenedAt)
      out.push({
        at: progress.formOpenedAt,
        dir: "event",
        title: "Color form opened",
        who: actor(openedBy),
      });
    if (progress.formSubmittedAt)
      out.push({
        at: progress.formSubmittedAt,
        dir: "event",
        title: "Colors submitted",
        who: actor(submittedBy),
      });
    // Drafted has no email behind it, so it needs its own row. Sent /
    // acknowledged / delivered all surface on the supplier-order email row
    // below (as its badge) — repeating them here would double the history.
    if (progress.supplierDraftedAt)
      out.push({ at: progress.supplierDraftedAt, dir: "event", title: "Materials order drafted", who: "in the Command Center" });
    return out;
  }, [progress]);

  const allItems = useMemo(() => {
    return [...items, ...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [items, events]);

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
            // Kate round-3 #03: say who sent it, not just who it went to.
            who: `${(m.senderName as string) ? `sent by ${m.senderName} · ` : ""}to ${
              (m.recipientName as string) || (m.recipientEmail as string) || "—"
            }${m.supplierName ? ` · ${m.supplierName}` : ""}`,
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
          Activity History
        </span>
        <Link
          href={`/dashboard/inbox`}
          className="inline-flex items-center min-h-[44px] text-[11px] font-medium text-ppp-blue-700 hover:text-ppp-blue-800 whitespace-nowrap"
        >
          Open Mail Hub
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
      ) : allItems.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-ppp-charcoal-400">
          No activity yet for{" "}
          {workOrderNumber ? `WO ${workOrderNumber}` : "this work order"}.
        </p>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-50 max-h-[520px] overflow-y-auto">
          {allItems.map((m, i) => (
            <li key={`${m.at}-${i}`} className="px-4 py-3 flex gap-3">
              <span
                className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  m.dir === "out"
                    ? "bg-ppp-blue-50 text-ppp-blue-700"
                    : m.dir === "in"
                    ? "bg-ppp-green-50 text-ppp-green-700"
                    : "bg-ppp-charcoal-50 text-ppp-charcoal-500"
                }`}
              >
                <span className="sr-only">{m.dir === "out" ? "Sent:" : m.dir === "in" ? "Received:" : "Event:"}</span>
                {m.dir === "out" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13 M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                ) : m.dir === "in" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16H4z M22 6l-10 7L2 6" /></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4l2.5 2.5" /></svg>
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
