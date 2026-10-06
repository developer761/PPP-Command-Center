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
import { releaseHeldLeads, heldLeads } from "@/lib/messaging/lead-redrive-write";
import type { HeldSummary } from "@/lib/messaging/lead-redrive-write";

/** Above this many, a release asks twice. */
const CONFIRM_ABOVE = 25;

const WINDOWS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 72, label: "Last 3 days" },
  { hours: 24 * 7, label: "Last week" },
];

export function HeldLeads({ summary: initial }: { summary: HeldSummary }) {
  /**
   * THE COUNT FOLLOWS THE WINDOW, which is what makes the confirmation real.
   *
   * It used to be a fixed prop. The page calls heldLeads() with no argument,
   * so the summary was always the 24-hour one and nothing re-read it. Picking
   * a wider window therefore made `stale` true for ever, and `needsConfirm`
   * is `!stale && ...` — so the second press was required for the SMALL
   * default and skipped for the big ones. The button lost its number too and
   * read a bare "Release".
   *
   * The file's own comment describes the hazard it then had: "Widening the
   * window to a week turns 'release 73' into 'release 504' — one dropdown and
   * one click away from putting five hundred people into a campaign." That was
   * exactly the path with no confirmation on it.
   *
   * heldLeads already takes the window, so the honest fix is to ask it rather
   * than to guess or to disable the rail.
   */
  const [summary, setSummary] = useState(initial);
  const [hours, setHours] = useState(initial.maxAgeHours);
  const [counting, setCounting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  if (summary.total === 0) return null;

  /**
   * The summary now always belongs to the chosen window — chooseWindow
   * re-counts and disarms — so there is no longer a "stale" state to reason
   * about. That flag is gone deliberately rather than left at false: it was
   * the mechanism of the bug, and `!stale` in the two lines below is what
   * switched the confirmation off exactly when the number was largest.
   */
  const confirming = armed;

  /**
   * A second press for a big release.
   *
   * Widening the window to a week turns "release 73" into "release 504" — one
   * dropdown and one click away from putting five hundred people into a
   * campaign. The number is shown in the confirm text because "are you sure"
   * without a quantity is a dialog people learn to click through.
   */
  const needsConfirm = summary.releasable > CONFIRM_ABOVE;

  /** Re-count for a newly chosen window, and disarm: the number somebody
   *  agreed to is not the number they would now get. */
  const chooseWindow = (next: number) => {
    setHours(next);
    setArmed(false);
    setDone(null);
    setProblem(null);
    setCounting(true);
    void heldLeads(next)
      .then(setSummary)
      .catch(() => setProblem("Could not count the leads for that window."))
      .finally(() => setCounting(false));
  };

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
            <span className="text-ppp-charcoal-600">
              {h.why}
              {h.oldestDays !== undefined && (
                <span className="text-ppp-charcoal-400">
                  {" "}· oldest {h.oldestDays} day{h.oldestDays === 1 ? "" : "s"}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="px-4 py-3 border-t border-ppp-charcoal-100 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="held-window" className="text-[12.5px] text-ppp-charcoal-600">Release leads from</label>
          <select
            id="held-window"
            value={hours}
            onChange={(e) => chooseWindow(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-ppp-charcoal-200 px-2 text-[16px] text-ppp-charcoal"
          >
            {WINDOWS.map((w) => <option key={w.hours} value={w.hours}>{w.label}</option>)}
          </select>
          <button
            type="button"
            onClick={release}
            disabled={pending || counting || summary.releasable === 0}
            className="min-h-[44px] px-4 rounded-lg bg-ppp-charcoal text-white text-[13px] font-medium disabled:opacity-40 touch-manipulation"
          >
            {pending ? "Releasing…"
              : counting ? "Counting…"
              : confirming ? `Yes — release ${summary.releasable}`
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
