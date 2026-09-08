"use client";

import { useState } from "react";
import Link from "next/link";
import { saveAuthoredExample, type AuthoredTurn } from "@/lib/messaging/authoring";

type Tag = { key: string; section: string; label: string; what_to_look_for: string };

/**
 * Write the example you wish the corpus had.
 *
 * The form opens with the rule already chosen and stated, because it is
 * reached from a named gap — arriving at a blank page and being asked "which
 * of twenty-five rules is this?" is how the coverage page failed in the first
 * place.
 */
export default function ExampleWriter({ tags, initialTagKey }: { tags: Tag[]; initialTagKey?: string }) {
  const [picked, setPicked] = useState<string[]>(
    initialTagKey && tags.some((t) => t.key === initialTagKey) ? [initialTagKey] : []
  );
  const [conduct, setConduct] = useState<"good" | "bad">("good");
  const [turns, setTurns] = useState<AuthoredTurn[]>([
    { who: "customer", text: "" },
    { who: "agent", text: "" },
  ]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ scrubbed: string[] } | null>(null);

  const toggle = (k: string) =>
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const setText = (i: number, text: string) =>
    setTurns((t) => t.map((x, n) => (n === i ? { ...x, text } : x)));

  const addTurn = () =>
    setTurns((t) => [...t, { who: t[t.length - 1]?.who === "customer" ? "agent" : "customer", text: "" }]);

  const removeTurn = (i: number) => setTurns((t) => (t.length <= 2 ? t : t.filter((_, n) => n !== i)));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await saveAuthoredExample({ turns, conduct, tagKeys: picked, note });
      if (res.ok) setDone({ scrubbed: res.scrubbed });
      else setErr(res.error);
    } catch {
      setErr("Could not save. Nothing was written.");
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="rounded-xl border border-ppp-green-100 bg-ppp-green-50 p-4">
        <p className="text-[14px] font-semibold text-ppp-charcoal">Saved.</p>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
          {conduct === "good"
            ? "It is approved, so the bot can draw on it straight away."
            : "Kept as an example of what not to do — it is never offered as something to copy."}
        </p>
        {done.scrubbed.length > 0 && (
          <p className="mt-1.5 text-[12px] text-ppp-orange-700">
            Redacted before saving: {done.scrubbed.join(", ")}.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button"
            onClick={() => { setDone(null); setTurns([{ who: "customer", text: "" }, { who: "agent", text: "" }]); setNote(""); }}
            className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation">
            Write another
          </button>
          <Link href="/messaging/training/coverage"
            className="inline-flex items-center min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal touch-manipulation">
            Back to what is missing
          </Link>
        </div>
      </div>
    );
  }

  const bySection = tags.reduce<Record<string, Tag[]>>((acc, t) => {
    (acc[t.section] ??= []).push(t); return acc;
  }, {});

  return (
    <div className="space-y-4">
      {/* The rule first — it is why this page was opened. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">What does this show?</h2>
        </div>
        <div className="px-4 py-3 space-y-3">
          {picked.length > 0 && (
            <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
              {tags.find((t) => t.key === picked[0])?.what_to_look_for}
            </p>
          )}
          {Object.entries(bySection).map(([section, list]) => (
            <div key={section}>
              <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">{section.replace(/_/g, " ")}</p>
              <div className="flex flex-wrap gap-1.5">
                {list.map((t) => (
                  <button key={t.key} type="button" onClick={() => toggle(t.key)}
                    aria-pressed={picked.includes(t.key)}
                    className={[
                      "min-h-[36px] px-2.5 rounded-lg text-[12px] font-medium border touch-manipulation text-left",
                      picked.includes(t.key)
                        ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                        : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
                    ].join(" ")}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Right way or wrong way — both are worth writing. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Is this how it should go, or how it should not?</h2>
        </div>
        <div className="px-4 py-3 flex gap-2">
          {([["good", "How it should go"], ["bad", "What we never say"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setConduct(v)}
              aria-pressed={conduct === v}
              className={[
                "flex-1 min-h-[44px] px-3 rounded-xl text-[13px] font-semibold border touch-manipulation",
                conduct === v
                  ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                  : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
              ].join(" ")}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* The conversation itself. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">The conversation</h2>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">Use a made-up name and number.</p>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {turns.map((t, i) => (
            <li key={i} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex gap-1">
                  {(["customer", "agent"] as const).map((w) => (
                    <button key={w} type="button"
                      onClick={() => setTurns((ts) => ts.map((x, n) => (n === i ? { ...x, who: w } : x)))}
                      aria-pressed={t.who === w}
                      className={[
                        "min-h-[32px] px-2.5 rounded-lg text-[11.5px] font-semibold touch-manipulation",
                        t.who === w ? "bg-ppp-charcoal text-white" : "bg-ppp-charcoal-50 text-ppp-charcoal-500",
                      ].join(" ")}>
                      {w === "customer" ? "Customer" : "Emily"}
                    </button>
                  ))}
                </div>
                {turns.length > 2 && (
                  <button type="button" onClick={() => removeTurn(i)}
                    aria-label={`Remove message ${i + 1}`}
                    className="min-h-[32px] px-2 text-[12px] font-medium text-ppp-charcoal-400 hover:text-ppp-charcoal touch-manipulation">
                    Remove
                  </button>
                )}
              </div>
              <textarea
                value={t.text}
                onChange={(e) => setText(i, e.target.value)}
                rows={2}
                aria-label={`${t.who === "customer" ? "Customer" : "Emily"} message ${i + 1}`}
                placeholder={t.who === "customer" ? "Hi, looking for a quote on my kitchen" : "What Emily should say back"}
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[16px] leading-snug text-ppp-charcoal placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300 resize-y"
              />
            </li>
          ))}
        </ul>
        <button type="button" onClick={addTurn}
          className="w-full min-h-[44px] text-[13px] font-medium text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 border-t border-ppp-charcoal-100 touch-manipulation">
          + Add a message
        </button>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Why, in your words</h2>
        </div>
        <div className="px-4 py-3">
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            aria-label="Why this is the right or wrong way"
            placeholder={conduct === "good" ? "She asked one thing at a time and never named a price…" : "She quoted over text, which we never do…"}
            className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-[16px] leading-snug text-ppp-charcoal placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300 resize-y"
          />
        </div>
      </section>

      {err && (
        <p className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2.5 text-[12.5px] text-ppp-orange-700">{err}</p>
      )}

      <button type="button" onClick={() => void save()} disabled={busy}
        className="w-full min-h-[48px] rounded-xl bg-ppp-charcoal text-white text-[14px] font-semibold disabled:opacity-50 touch-manipulation">
        {busy ? "Saving…" : "Save this example"}
      </button>
    </div>
  );
}
