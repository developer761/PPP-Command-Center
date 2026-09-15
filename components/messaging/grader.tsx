"use client";

import { useState } from "react";
import { saveGrade, nextToGrade, type GradeQueueItem } from "@/lib/messaging/grading";
import type { RuleOption } from "@/lib/messaging/repair-write";
import { turnsOf } from "@/lib/messaging/repair";
import RulePicker from "./rule-picker";

/**
 * Grade one conversation at a time.
 *
 * One at a time rather than a table, because grading is a reading task and a
 * table invites skimming. Turns carry Kate's T-numbers, and rules are found by
 * searching her codes or Emily's rule names rather than scanning a wall.
 *
 * The save button stays disabled until at least one rule that feeds the bot
 * is picked. "Good" on its own tells retrieval it was good at something, which
 * is not a signal it can use.
 */
export default function Grader({
  first,
  remaining: initialRemaining,
  options,
}: {
  first: GradeQueueItem | null;
  remaining: number;
  options: RuleOption[];
}) {
  const [item, setItem] = useState(first);
  const [remaining, setRemaining] = useState(initialRemaining);
  // Start from what is already stored, so re-grading shows the current answer
  // rather than a blank form that would wipe it on save.
  const [conduct, setConduct] = useState<"good" | "mixed" | "bad" | null>(first?.conduct ?? null);
  const [picked, setPicked] = useState<string[]>((first?.tags ?? []).map((k) => `tag:${k}`));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(options.map((o) => [o.id, o]));
  const tagKeys = [...new Set(picked.map((id) => byId.get(id)?.tagKey).filter((k): k is string => !!k))];

  const advance = async (skip: string[]) => {
    const next = await nextToGrade(skip);
    setItem(next.item);
    setRemaining(next.remaining);
    setConduct(next.item?.conduct ?? null);
    setPicked((next.item?.tags ?? []).map((k) => `tag:${k}`));
    setNote(""); setError(null);
  };

  const save = async () => {
    if (!item || !conduct || tagKeys.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await saveGrade({
        exampleId: item.id, conduct, tagKeys, note: note || undefined,
        // Only a good example is offered as something to copy. A bad one is
        // kept, because it is how the coverage report knows a rule has been
        // broken, but it is never retrieved as a model reply.
        approve: conduct === "good",
      });
      if (!res.ok) { setError(res.error); return; }
      const nextSkip = [...skipped, item.id];
      setSkipped(nextSkip);
      await advance(nextSkip);
    } finally { setBusy(false); }
  };

  if (!item) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-10 text-center">
        <p className="font-semibold text-ppp-charcoal">Nothing left to grade</p>
        <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
          Everything has a grade and at least one rule. Rated conversations has
          them all if you want to change one.
        </p>
      </div>
    );
  }

  const text = typeof item.transcript === "string" ? item.transcript : JSON.stringify(item.transcript, null, 2);
  const turns = turnsOf(text);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-ppp-charcoal-500">{remaining} still need a grade or a rule</span>
        <button type="button" onClick={() => { const s = [...skipped, item.id]; setSkipped(s); void advance(s); }}
          className="min-h-[44px] px-3 rounded-lg text-[12.5px] font-medium text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation">
          Skip this one
        </button>
      </div>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">The conversation</h2>
          {item.outcome && (
            <span className="shrink-0 rounded-full bg-ppp-charcoal-50 px-2.5 py-0.5 text-[11px] font-medium text-ppp-charcoal-600 capitalize">
              ended: {item.outcome.replace(/_/g, " ")}
            </span>
          )}
        </div>
        {turns.length > 0 ? (
          <ul className="max-h-[50vh] overflow-y-auto divide-y divide-ppp-charcoal-100">
            {turns.map((t) => (
              <li key={t.turn} className="px-4 py-2">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 w-8 text-[11px] font-bold text-ppp-charcoal-400 tabular-nums">T{t.turn}</span>
                  <span className="min-w-0">
                    <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{t.speaker}</span>
                    <span className="block text-[13px] text-ppp-charcoal leading-relaxed whitespace-pre-wrap break-words">{t.text}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <pre className="px-4 py-3 text-[13px] leading-relaxed text-ppp-charcoal whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto font-sans">
            {text}
          </pre>
        )}
        {!item.piiScrubbed && (
          <p className="px-4 py-2 border-t border-ppp-orange-100 bg-ppp-orange-50 text-[12px] text-ppp-orange-700">
            Personal details have not been removed from this one yet.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">
          How was it handled?
        </h2>
        <div className="px-4 py-3">
          <div className="grid grid-cols-3 gap-2">
            {([
              ["good", "Well", "Worth copying"],
              ["mixed", "Mixed", "Kept for context"],
              ["bad", "Badly", "An example of what not to do"],
            ] as const).map(([v, label, hint]) => (
              <button key={v} type="button" onClick={() => setConduct(v)} aria-pressed={conduct === v}
                className={[
                  "rounded-xl border-2 px-3 py-2.5 text-left min-h-[44px] touch-manipulation transition-colors",
                  conduct === v ? "border-ppp-charcoal bg-ppp-charcoal-50" : "border-ppp-charcoal-100",
                ].join(" ")}>
                <span className="block text-[13px] font-semibold text-ppp-charcoal">{label}</span>
                <span className="block mt-0.5 text-[11px] text-ppp-charcoal-500 leading-tight">{hint}</span>
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            This is about how it was HANDLED, not whether it booked. A good
            conversation can lose an unqualified lead.
          </p>
        </div>
      </section>

      <section className="rounded-xl border-2 border-ppp-charcoal-200 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">
            {conduct === "bad" ? "Which rules did it break?" : "Which rules does it show?"}
          </h2>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
            Search by your code or by what the rule is about. At least one.
          </p>
        </div>
        <div className="px-4 py-3">
          <RulePicker options={options} selected={picked} onChange={setPicked}
            unlinkedNote="Not linked to one of Emily's rules yet, so it does not count for grading on its own. Pick the closest rule as well." />
        </div>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
            Anything worth saying in words <span className="text-ppp-charcoal-400">(optional)</span>
          </span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder="T5 asked for the street address it should have asked for at T3"
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
        </label>
        {error && <p className="mt-2 text-[12.5px] text-ppp-orange-700">{error}</p>}
        <button type="button" onClick={() => void save()} disabled={!conduct || tagKeys.length === 0 || busy}
          className="mt-2.5 w-full sm:w-auto min-h-[44px] px-5 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500">
          {busy ? "Saving…" : "Save and next"}
        </button>
        {conduct && tagKeys.length === 0 && (
          <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-500">
            {picked.length ? "The codes picked are not linked to a rule yet. Add the closest rule too." : "Pick at least one rule first."}
          </p>
        )}
      </section>
    </div>
  );
}
