"use client";

import { useState } from "react";
import { saveGrade, nextToGrade, type GradeQueueItem } from "@/lib/messaging/grading";

type Tag = { key: string; section: string; label: string; what_to_look_for: string };

const SECTION_LABEL: Record<string, string> = {
  flow: "The required flow", quote_type: "Quote type",
  qualification: "Qualifying the job", tone: "Tone",
  handling: "Awkward situations", ending: "Ending",
};

/**
 * Grade one conversation at a time.
 *
 * One at a time rather than a table, because grading is a reading task and a
 * table invites skimming. The rules are grouped the way Emily's instructions
 * are written, each with what to look for, so a tag never has to be guessed at.
 *
 * The save button stays disabled until at least one rule is ticked. That is
 * the whole point of the screen: "good" on its own tells retrieval it was good
 * at something, which is not a signal it can use.
 */
export default function Grader({
  first,
  remaining: initialRemaining,
  tags,
}: {
  first: GradeQueueItem | null;
  remaining: number;
  tags: Tag[];
}) {
  const [item, setItem] = useState(first);
  const [remaining, setRemaining] = useState(initialRemaining);
  const [conduct, setConduct] = useState<"good" | "mixed" | "bad" | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const bySection = new Map<string, Tag[]>();
  for (const t of tags) {
    const list = bySection.get(t.section) ?? [];
    list.push(t);
    bySection.set(t.section, list);
  }

  const advance = async (skip: string[]) => {
    const next = await nextToGrade(skip);
    setItem(next.item);
    setRemaining(next.remaining);
    setConduct(null); setPicked([]); setNote(""); setError(null);
  };

  const save = async () => {
    if (!item || !conduct || picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await saveGrade({
        exampleId: item.id, conduct, tagKeys: picked, note: note || undefined,
        // Only a good example is offered as something to copy. A bad one is
        // kept — it is how the coverage report knows a rule has been broken —
        // but it is never retrieved as a model reply.
        approve: conduct === "good",
      });
      if (!res.ok) { setError(res.error); return; }
      await advance(skipped);
    } finally { setBusy(false); }
  };

  if (!item) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-10 text-center">
        <p className="font-semibold text-ppp-charcoal">Nothing left to grade</p>
        <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
          Import conversations from Hatch and they will queue up here.
        </p>
      </div>
    );
  }

  const text = typeof item.transcript === "string"
    ? item.transcript
    : JSON.stringify(item.transcript, null, 2);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-ppp-charcoal-500">{remaining} left</span>
        <button type="button" onClick={() => void advance([...skipped, item.id])}
          className="min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation">
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
        <pre className="px-4 py-3 text-[13px] leading-relaxed text-ppp-charcoal whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto font-sans">
          {text}
        </pre>
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
              <button key={v} type="button" onClick={() => setConduct(v)}
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
            At least one. Without this the grade teaches nothing.
          </p>
        </div>
        <div className="divide-y divide-ppp-charcoal-50">
          {[...bySection.entries()].map(([section, items]) => (
            <div key={section} className="px-4 py-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1.5">
                {SECTION_LABEL[section] ?? section}
              </p>
              <div className="space-y-1">
                {items.map((t) => {
                  const on = picked.includes(t.key);
                  return (
                    <button key={t.key} type="button"
                      onClick={() => setPicked((p) => on ? p.filter((k) => k !== t.key) : [...p, t.key])}
                      className={[
                        "w-full text-left rounded-lg px-2.5 py-2 min-h-[44px] touch-manipulation transition-colors",
                        on ? "bg-ppp-charcoal-50 ring-1 ring-ppp-charcoal-300" : "hover:bg-ppp-charcoal-50",
                      ].join(" ")}>
                      <span className="flex items-start gap-2">
                        <span aria-hidden className={[
                          "mt-0.5 shrink-0 h-4 w-4 rounded border-2 flex items-center justify-center",
                          on ? "border-ppp-charcoal bg-ppp-charcoal" : "border-ppp-charcoal-300",
                        ].join(" ")}>
                          {on && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ppp-charcoal">{t.label}</span>
                          <span className="block mt-0.5 text-[11.5px] text-ppp-charcoal-500 leading-snug">{t.what_to_look_for}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <label className="block">
          <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
            Anything worth saying in words <span className="text-ppp-charcoal-400">(optional)</span>
          </span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
        </label>
        {error && <p className="mt-2 text-[12.5px] text-ppp-orange-700">{error}</p>}
        <button type="button" onClick={() => void save()} disabled={!conduct || picked.length === 0 || busy}
          className="mt-2.5 w-full sm:w-auto min-h-[44px] px-5 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500">
          {busy ? "Saving…" : "Save and next"}
        </button>
        {picked.length === 0 && conduct && (
          <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-500">Tick at least one rule first.</p>
        )}
      </section>
    </div>
  );
}
