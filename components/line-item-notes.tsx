"use client";

import { useState } from "react";

/**
 * The rep's scope notes from the Salesforce quote line (`Description`).
 *
 * Kate, 2026-09-04: "The field team's typical behavior is adding one line item
 * to a Quote, then adding multiple rooms in the line item notes. Without the
 * line item notes, the Account Managers and Customers cannot see which rooms
 * are included."
 *
 * COLLAPSED BY DEFAULT, deliberately. In production 73% of line items carry a
 * Description, the median is ~90 characters but the longest is 3,125, and the
 * content ranges from a real room list to "sdfasdfs". Expanded by default, a
 * long one would push the colour pickers — the thing the customer is here to
 * do — below the fold on a phone. Collapsed, the first line still shows, which
 * is where the rooms almost always are.
 *
 * Renders nothing at all when there are no notes: an empty "Notes" affordance
 * is worse than no affordance, and 27% of line items have none.
 */
export default function LineItemNotes({
  notes,
  /** Slightly quieter presentation for the customer-facing form. */
  tone = "internal",
}: {
  notes: string | null | undefined;
  tone?: "internal" | "customer";
}) {
  const [open, setOpen] = useState(false);

  // Normalise CRLF (Salesforce textareas store \r\n) and drop the lone "-" or
  // "--" separators reps commonly type on the first line, which would otherwise
  // become the entire collapsed preview.
  const cleaned = (notes ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l, i, arr) => !(i === 0 && /^[-–—\s]*$/.test(l) && arr.length > 1))
    .join("\n")
    .trim();

  if (!cleaned) return null;

  const lines = cleaned.split("\n").filter((l) => l.trim());
  const first = lines[0] ?? "";
  const hasMore = lines.length > 1 || first.length > 90;

  const shell =
    tone === "customer"
      ? "bg-ppp-blue-50/40 border-ppp-blue-100"
      : "bg-ppp-charcoal-50/60 border-ppp-charcoal-100";

  return (
    <div className={`mt-2 rounded-lg border ${shell}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-start gap-2 text-left px-3 py-2 min-h-[44px] sm:min-h-0 touch-manipulation"
      >
        <span className="shrink-0 mt-0.5 text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
          Notes
        </span>
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-ppp-charcoal-700">
          {open ? (
            /* whitespace-pre-line so a typed room list keeps its line breaks —
               joining them into a paragraph is what makes a room list unreadable. */
            <span className="whitespace-pre-line">{cleaned}</span>
          ) : (
            <span className="line-clamp-1">{first}</span>
          )}
        </span>
        {hasMore && (
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
            className={`shrink-0 mt-0.5 text-ppp-charcoal-400 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>
    </div>
  );
}
