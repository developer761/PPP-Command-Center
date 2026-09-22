"use client";

/**
 * The leads waiting on something, and the button that lets the fresh ones go.
 *
 * Every reason a lead is held resolves through a DELIBERATE act — a region
 * switched on, a number added, a workflow published — and nothing re-drives
 * them afterwards, so they sit. In production on 2026-09-22 that was 432 leads
 * waiting on a workflow nobody had published yet.
 *
 * The screen shows what a release WOULD do before anything moves, because the
 * failure mode here is not subtle: releasing the lot would text four hundred
 * people about an enquiry they made last week.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { releaseHeldLeads } from "@/lib/messaging/lead-redrive-write";
import type { HeldSummary } from "@/lib/messaging/lead-redrive-write";

/** Above this many, a release asks twice. */
const CONFIRM_ABOVE = 25;

const WINDOWS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 72, label: "Last 3 days" },
  { hours: 24 * 7, label: "Last week" },
];

export function HeldLeads({ summary }: { summary: HeldSummary }) {
  const [hours, setHours] = useState(summary.maxAgeHours);
  const [done, setDone] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  if (summary.total === 0) return null;

  // The count shown is for the window the summary was BUILT with. Changing the
  // selector changes what a release would do, and saying "6" next to a
  // different window would be a lie — so it reloads rather than guessing.
  const stale = hours !== summary.maxAgeHours;
  // DERIVED, not set during render. Changing the window invalidates a pending
  // confirmation — the number the person agreed to is not the number they
  // would now get — and calling setState while rendering to express that is a
  // loop waiting to happen.
  const confirming = armed && !stale;

  /**
   * A second press for a big release.
   *
   * Widening the window to a week turns "release 73" into "release 504" — one
   * dropdown and one click away from putting five hundred people into a
   * campaign. The number is shown in the confirm text because "are you sure"
   * without a quantity is a dialog people learn to click through.
   */
  const needsConfirm = !stale && summary.releasable > CONFIRM_ABOVE;

  const release = () => {
    if (needsConfirm && !confirming) { setArmed(true); setProblem(null); setDone(null); return; }
    setArmed(false);
    setProblem(null); setDone(null);
    start(async () => {
      const res = await releaseHeldLeads({ maxAgeHours: hours });
      if (res.ok) {
        setDone(res.released === 0
          ? "Nothing was fresh enough to release."
          : `${res.released} lead${res.released === 1 ? "" : "s"} back in the queue. The next tick picks them up.`);
        router.refresh();
      } else setProblem(res.error);
    });
  };

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">
          {summary.total} lead{summary.total === 1 ? "" : "s"} waiting on something
        </h2>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed">
          These never entered a campaign. Nothing re-runs them on its own, so
          after you switch a region on or publish a workflow, they stay here
          until somebody says otherwise.
        </p>
      </div>

      <ul className="divide-y divide-ppp-charcoal-100">
        {summary.holding.map((h) => (
          <li key={h.why} className="px-4 py-2 flex items-baseline gap-3 text-[12.5px]">
            <span className="font-mono text-ppp-charcoal-400 tabular-nums w-10 shrink-0">{h.count}</span>
            <span className="text-ppp-charcoal-600">{h.why}</span>
          </li>
        ))}
      </ul>

      <div className="px-4 py-3 border-t border-ppp-charcoal-100 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="held-window" className="text-[12.5px] text-ppp-charcoal-600">Release leads from</label>
          <select
            id="held-window"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-ppp-charcoal-200 px-2 text-[16px] text-ppp-charcoal"
          >
            {WINDOWS.map((w) => <option key={w.hours} value={w.hours}>{w.label}</option>)}
          </select>
          <button
            type="button"
            onClick={release}
            disabled={pending || (!stale && summary.releasable === 0)}
            className="min-h-[44px] px-4 rounded-lg bg-ppp-charcoal text-white text-[13px] font-medium disabled:opacity-40 touch-manipulation"
          >
            {pending ? "Releasing…"
              : confirming ? `Yes — release ${summary.releasable}`
              : stale ? "Release"
              : `Release ${summary.releasable}`}
          </button>
        </div>

        <p className="text-[11.5px] text-ppp-charcoal-400 leading-relaxed">
          Only leads newer than the window go back. Anything older stays put —
          somebody who asked last week has already hired a painter or forgotten,
          and a first message arriving now reads badly. Released leads run the
          ordinary intake again, gate included; nothing is sent from here.
        </p>

        {confirming && (
          <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">
            This puts {summary.releasable} leads back into intake. Once a workflow is
            live that means {summary.releasable} first messages. Press again to confirm.
          </p>
        )}
        {done && <p className="text-[12.5px] text-ppp-green-700">{done}</p>}
        {problem && (
          <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">
            {problem}
          </p>
        )}
      </div>
    </section>
  );
}
