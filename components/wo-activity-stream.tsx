"use client";

import type { WoProgress } from "@/lib/wo-progress/types";

/**
 * Activity stream for a single work order (Kate #2). A chronological timeline
 * of what's happened on this WO — color form sent/opened/submitted, materials
 * drafted/ordered/acknowledged/delivered, job completed — built entirely from
 * the WoProgress the page already loaded (no extra fetch). Renders on the WO
 * detail page's "Activity" tab.
 */

type Event = {
  at: string;
  title: string;
  detail?: string;
  tone: "blue" | "green" | "charcoal" | "navy";
};

function pushEvent(list: Event[], at: string | null, ev: Omit<Event, "at">) {
  if (!at) return;
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return;
  list.push({ at, ...ev });
}

export default function WoActivityStream({
  progress,
  workOrderNumber,
}: {
  progress: WoProgress | undefined;
  workOrderNumber: string | null;
}) {
  const events: Event[] = [];

  if (progress) {
    pushEvent(events, progress.formSentAt, {
      title: "Color form sent to customer",
      tone: "blue",
    });
    pushEvent(events, progress.formOpenedAt, {
      title: "Customer opened the color form",
      tone: "blue",
    });
    pushEvent(events, progress.formSubmittedAt, {
      title: "Customer submitted their colors",
      tone: "green",
    });

    // Per-supplier order events when the WO has multiple suppliers; otherwise
    // the roll-up timestamps.
    const perSupplier = progress.perSupplier ?? [];
    if (perSupplier.length > 0) {
      for (const s of perSupplier) {
        pushEvent(events, s.draftedAt, {
          title: "Materials order drafted",
          detail: s.supplierName,
          tone: "charcoal",
        });
        pushEvent(events, s.sentAt, {
          title: "Order sent to supplier",
          detail: s.supplierName,
          tone: "green",
        });
        pushEvent(events, s.acknowledgedAt, {
          title: "Supplier acknowledged the order",
          detail: s.supplierName,
          tone: "charcoal",
        });
        pushEvent(events, s.deliveredAt, {
          title: "Materials delivered",
          detail: s.supplierName,
          tone: "green",
        });
      }
    } else {
      pushEvent(events, progress.supplierDraftedAt, {
        title: "Materials order drafted",
        tone: "charcoal",
      });
      pushEvent(events, progress.supplierSentAt, {
        title: "Order sent to supplier",
        tone: "green",
      });
      pushEvent(events, progress.supplierAcknowledgedAt, {
        title: "Supplier acknowledged the order",
        tone: "charcoal",
      });
      pushEvent(events, progress.materialsDeliveredAt, {
        title: "Materials delivered",
        tone: "green",
      });
    }

    pushEvent(events, progress.jobCompletedAt, {
      title: "Job marked complete",
      tone: "navy",
    });
  }

  // Newest first — the most recent thing that happened reads at the top.
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (events.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
        <div className="mx-auto h-11 w-11 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 flex items-center justify-center mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 8v4l3 3 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
          </svg>
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          No activity yet on {workOrderNumber ? `WO ${workOrderNumber}` : "this work order"}.
        </p>
        <p className="text-xs text-ppp-charcoal-400 mt-1">
          Sending the color form or ordering materials will start the timeline.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500 mb-4">
        Activity
      </h3>
      <ol className="relative border-l border-ppp-charcoal-100 ml-1.5 space-y-5">
        {events.map((e, i) => (
          <li key={`${e.at}-${i}`} className="ml-4">
            <span
              className={`absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${dotClass(e.tone)}`}
              aria-hidden
            />
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5">
              <span className="text-sm font-medium text-ppp-charcoal">
                {e.title}
                {e.detail && (
                  <span className="ml-1.5 text-xs font-normal text-ppp-charcoal-400">· {e.detail}</span>
                )}
              </span>
              <span className="text-[11px] text-ppp-charcoal-400 whitespace-nowrap">
                {fmtWhen(e.at)}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function dotClass(tone: Event["tone"]): string {
  switch (tone) {
    case "green":
      return "bg-ppp-green-500";
    case "blue":
      return "bg-ppp-blue-500";
    case "navy":
      return "bg-ppp-navy-500";
    default:
      return "bg-ppp-charcoal-300";
  }
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
