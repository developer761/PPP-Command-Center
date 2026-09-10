"use client";

import { useState } from "react";
import { replayScenario, type ScenarioSummary } from "@/lib/messaging/replay-run";
import type { ReplaySummary } from "@/lib/messaging/replay";

const STATUS_WORD: Record<string, string> = {
  fixed: "Fixed",
  broken: "Broke",
  still_wrong: "Still wrong",
  unchanged: "Same",
  reworded: "Reworded",
  changed_intent: "Changed",
};

/**
 * What a prompt change did to the conversations somebody already judged.
 *
 * Grading in the sandbox went nowhere until this existed. The result leads
 * with the only two things worth acting on — something that used to be right
 * is not, or something known to be wrong still is — and everything else is
 * available but not shouted about, because a run that lights up every line
 * teaches people to stop reading it.
 */
export default function ScenarioReplay({ scenarios }: { scenarios: ScenarioSummary[] }) {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { line: string; summary: ReplaySummary } | { error: string }>>({});
  const [open, setOpen] = useState<string | null>(null);

  const run = async (id: string) => {
    setRunning(id);
    try {
      const res = await replayScenario({ scenarioId: id });
      setResults((p) => ({ ...p, [id]: res.ok ? { line: res.line, summary: res.summary } : { error: res.error } }));
      setOpen(id);
    } catch {
      setResults((p) => ({ ...p, [id]: { error: "The replay could not be run." } }));
    } finally { setRunning(null); }
  };

  const runAll = async () => {
    for (const s of scenarios) await run(s.id);
  };

  if (scenarios.length === 0) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
        <p className="text-[13px] font-semibold text-ppp-charcoal">Nothing saved yet</p>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
          Play a conversation in the simulator, grade each reply, and save it as
          a test. Then changing Emily&apos;s rules tells you what broke instead of
          you finding out from a customer.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button type="button" onClick={() => void runAll()} disabled={running !== null}
        className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
        {running ? "Replaying…" : `Replay all ${scenarios.length}`}
      </button>

      <ul className="space-y-2">
        {scenarios.map((s) => {
          const r = results[s.id];
          const failed = r && "error" in r;
          const summary = r && "summary" in r ? r.summary : null;
          const bad = summary && !summary.clean;

          return (
            <li key={s.id} className={[
              "rounded-xl border overflow-hidden",
              failed || bad ? "border-ppp-orange-100" : "border-ppp-charcoal-100",
            ].join(" ")}>
              <div className="px-4 py-3 bg-white">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ppp-charcoal truncate">{s.name}</p>
                    <p className="mt-0.5 text-[11.5px] text-ppp-charcoal-400">
                      {s.turns} turn{s.turns === 1 ? "" : "s"}
                      {s.lastRunAt && !r && (
                        <> · last run {s.lastRunPassed ? "was clean" : "found something"}</>
                      )}
                    </p>
                  </div>
                  <button type="button" onClick={() => void run(s.id)} disabled={running !== null}
                    className="shrink-0 min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12.5px] font-semibold text-ppp-charcoal disabled:opacity-40 touch-manipulation">
                    {running === s.id ? "Running…" : "Replay"}
                  </button>
                </div>

                {r && (
                  <p className={[
                    "mt-2 text-[12.5px] leading-relaxed",
                    failed || bad ? "text-ppp-orange-700" : "text-ppp-charcoal-600",
                  ].join(" ")}>
                    {failed ? r.error : r.line}
                  </p>
                )}

                {summary && (
                  <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)}
                    className="mt-1 min-h-[44px] text-[12px] font-medium text-ppp-charcoal-500 underline touch-manipulation">
                    {open === s.id ? "Hide the turns" : "Show every turn"}
                  </button>
                )}
              </div>

              {summary && open === s.id && (
                <ul className="divide-y divide-ppp-charcoal-100 border-t border-ppp-charcoal-100">
                  {summary.turns.map((t) => (
                    <li key={t.ordinal} className="px-4 py-2.5 bg-white">
                      <div className="flex items-baseline gap-2">
                        <span className={[
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                          t.status === "broken" || t.status === "still_wrong"
                            ? "bg-ppp-orange-50 text-ppp-orange-700"
                            : t.status === "fixed"
                              ? "bg-ppp-green-50 text-ppp-green-700"
                              : "bg-ppp-charcoal-100 text-ppp-charcoal-500",
                        ].join(" ")}>
                          {STATUS_WORD[t.status]}
                        </span>
                        <span className="text-[12px] text-ppp-charcoal-500 truncate">
                          They said: {t.customerText}
                        </span>
                      </div>

                      {t.note && (
                        <p className="mt-1 text-[11.5px] text-ppp-charcoal-500 leading-snug">
                          Graded: {t.note}
                        </p>
                      )}

                      {t.status !== "unchanged" && (
                        <div className="mt-1.5 space-y-1">
                          <p className="text-[12px] text-ppp-charcoal-400 leading-snug">
                            <span className="font-medium">Was:</span> {t.before.message || "(nothing)"}
                          </p>
                          <p className="text-[12px] text-ppp-charcoal leading-snug">
                            <span className="font-medium">Now:</span> {t.after.message || "(nothing)"}
                          </p>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
