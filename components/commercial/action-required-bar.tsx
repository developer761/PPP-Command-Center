"use client";

/**
 * Sticky "action required" bar.
 *
 * Brendan 2026-08-17: "Maybe for notifications we should have a sticky bar on
 * the top when an action happens — we have to click seen for it to go away?"
 *
 * The bell is passive: a small badge you have to notice, open and read. For the
 * handful of events that BLOCK somebody's work — a proposal waiting on your
 * approval, a decision that just landed back in your court — that isn't enough.
 * This bar sits above the page content, names the thing, links straight to it,
 * and only goes away when the person explicitly acknowledges it.
 *
 * Deliberately narrow: only the kinds in ACTIONABLE_KINDS raise the bar, so it
 * never becomes a second, louder feed of everything. Everything else stays in
 * the bell where it belongs.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Item = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
};

/** Events that put work in YOUR court. Anything else belongs in the bell. */
const ACTIONABLE_KINDS = new Set([
  "commercial_proposal_approval_requested",
  "commercial_proposal_changes_requested",
  "commercial_proposal_approved",
  // Karan 2026-08-22, on the platform being less clicky than Salesforce: the
  // bar answered "what needs me today" for the proposal loop only. These three
  // are addressed to ONE PERSON BY NAME — somebody assigned you a task, your
  // task is now late, someone wrote your name in a note — so they are as much
  // "your court" as an approval request, and they were sitting in the bell.
  //
  // Everything else stays out on purpose, and the line is worth stating: an
  // overdue invoice or an expiring COI is the TEAM's work, not a specific
  // person's, and putting team-wide reminders here would turn a bar that means
  // "you are blocking something" into a second feed people learn to dismiss.
  "commercial_task_assigned",
  "commercial_task_overdue",
  "commercial_note_mention",
]);

/** Per-kind framing so the bar says what to DO, not just what happened. */
function ctaFor(kind: string): string {
  if (kind === "commercial_proposal_approval_requested") return "Review & approve";
  if (kind === "commercial_proposal_changes_requested") return "Make the edits";
  if (kind === "commercial_proposal_approved") return "Send it";
  if (kind === "commercial_task_assigned") return "Open the task";
  if (kind === "commercial_task_overdue") return "It's overdue";
  if (kind === "commercial_note_mention") return "Read it";
  return "Open";
}

export default function ActionRequiredBar() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?platform=commercial", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: Item[] };
      setItems(
        (data.items ?? []).filter((i) => !i.read_at && ACTIONABLE_KINDS.has(i.kind))
      );
    } catch {
      // A failed poll must never break the page it sits on.
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  /** "Seen" = mark read. Optimistic so the bar goes the instant it's clicked. */
  const acknowledge = useCallback(async (id: string) => {
    setBusy(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "PATCH" });
    } catch {
      // Already gone from view; the next poll reconciles if the write failed.
    } finally {
      setBusy(null);
    }
  }, []);

  if (items.length === 0) return null;
  const [top, ...rest] = items;

  return (
    <div className="sticky top-0 z-30 border-b border-amber-300 bg-amber-50">
      <div className="px-4 sm:px-6 py-2.5 flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1.5 shrink-0 text-amber-700">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
          <span className="text-[12px] font-bold uppercase tracking-wide">Action needed</span>
        </span>

        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold text-amber-900 truncate">{top.title}</p>
          {top.body && <p className="text-[12px] text-amber-800 truncate">{top.body}</p>}
        </div>

        {top.link && (
          <Link
            href={top.link}
            onClick={() => void acknowledge(top.id)}
            className="shrink-0 inline-flex items-center px-3 rounded-lg bg-amber-600 text-white text-[12.5px] font-semibold hover:bg-amber-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
          >
            {ctaFor(top.kind)} →
          </Link>
        )}
        <button
          type="button"
          disabled={busy === top.id}
          onClick={() => void acknowledge(top.id)}
          className="shrink-0 inline-flex items-center px-3 rounded-lg border border-amber-300 text-amber-800 text-[12.5px] font-semibold hover:bg-amber-100 min-h-[44px] sm:min-h-[36px] touch-manipulation disabled:opacity-50"
        >
          Seen
        </button>

        {rest.length > 0 && (
          <span className="shrink-0 text-[12px] text-amber-700 font-semibold">
            +{rest.length} more
          </span>
        )}
      </div>
    </div>
  );
}
