"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveRepair, approveRepair, type RepairCandidate } from "@/lib/messaging/repair-write";
import { linesOf, isRepairable } from "@/lib/messaging/repair";

type Tag = { key: string; label: string };

/**
 * Turning a near-miss into an example of the thing done properly.
 *
 * The conversation is shown whole, with the bot's own lines selectable and
 * everything else inert — rewriting what the CUSTOMER said would be inventing
 * a conversation rather than repairing one.
 *
 * The line is chosen by a PERSON rather than by Kate's turn number. Her
 * numbering counts campaign emails and splits differently from how we store a
 * transcript, so T14 in her sheet lands three turns away in ours. Using it
 * would have edited the wrong line and looked plausible.
 */
export default function RepairConsole({
  candidates, tags,
}: {
  candidates: RepairCandidate[];
  tags: Tag[];
}) {
  const router = useRouter();
  const [i, setI] = useState(0);
  const [findingIdx, setFindingIdx] = useState(0);
  const [lineIndex, setLineIndex] = useState<number | null>(null);
  const [replacement, setReplacement] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; from: string; to: string } | null>(null);

  const c = candidates[i];
  if (!c) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
        <p className="text-[13px] font-semibold text-ppp-charcoal">Nothing left to repair</p>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
          Every conversation with a correction has had one written. Import more
          graded conversations and they will appear here.
        </p>
      </div>
    );
  }

  const finding = c.findings[findingIdx] ?? c.findings[0];
  const lines = linesOf(c.transcript);

  const next = () => {
    setDone(null); setErr(null); setLineIndex(null); setReplacement(""); setPicked([]);
    setFindingIdx(0);
    setI((n) => n + 1);
  };

  const save = async () => {
    if (lineIndex === null) { setErr("Pick the line it got wrong."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await saveRepair({
        exampleId: c.exampleId, findingId: finding.id,
        lineIndex, replacement, tagKeys: picked,
      });
      if (!res.ok) { setErr(res.error); return; }
      setDone({ id: res.id, ...res.changed });
      router.refresh();
    } finally { setBusy(false); }
  };

  const signOff = async () => {
    if (!done) return;
    setBusy(true);
    try {
      const res = await approveRepair({ id: done.id, approve: true });
      if (!res.ok) { setErr(res.error); return; }
      next();
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="space-y-3">
        <section className="rounded-xl border border-ppp-green-100 bg-ppp-green-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-charcoal">Repair written</p>
          <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
            It is saved but the bot cannot copy it yet. Read the whole repaired
            conversation below — if the line reads like something Emily would
            actually send, sign it off.
          </p>
        </section>

        <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <p className="text-[12px] font-medium text-ppp-charcoal-600">What changed</p>
          </div>
          <div className="px-4 py-3 space-y-2">
            <p className="text-[12.5px] text-ppp-charcoal-400 line-through leading-relaxed">{done.from}</p>
            <p className="text-[13px] text-ppp-charcoal leading-relaxed">{done.to}</p>
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void signOff()} disabled={busy}
            className="min-h-[48px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13.5px] font-semibold disabled:opacity-40 touch-manipulation">
            {busy ? "Signing off…" : "Yes, the bot can copy this"}
          </button>
          <button type="button" onClick={next} disabled={busy}
            className="min-h-[48px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
            Leave it unsigned
          </button>
        </div>
        {err && <p className="text-[12.5px] text-ppp-orange-700">{err}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] text-ppp-charcoal-500">
          {c.conduct === "bad" ? "Graded bad" : "Graded mid"}
          {c.repairs.length > 0 && <> · {c.repairs.length} repair{c.repairs.length === 1 ? "" : "s"} already</>}
        </p>
        <span className="shrink-0 text-[12px] text-ppp-charcoal-400 tabular-nums">
          {candidates.length - i} left
        </span>
      </div>

      {/* The correction being applied. */}
      <section className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 overflow-hidden">
        {c.findings.length > 1 && (
          <div className="flex gap-1.5 px-3 pt-2.5 overflow-x-auto">
            {c.findings.map((f, n) => (
              <button key={f.id} type="button" onClick={() => { setFindingIdx(n); setLineIndex(null); }}
                aria-pressed={n === findingIdx}
                className={[
                  "shrink-0 min-h-[32px] px-2 rounded-md text-[11px] font-semibold touch-manipulation",
                  n === findingIdx ? "bg-ppp-charcoal text-white" : "bg-white text-ppp-orange-700",
                ].join(" ")}>
                {f.code ?? `#${n + 1}`}
              </button>
            ))}
          </div>
        )}
        <div className="px-4 py-3">
          <p className="text-[12.5px] text-ppp-orange-700 leading-relaxed">
            <strong>What went wrong:</strong> {finding.what}
          </p>
          {finding.shouldHave && (
            <p className="mt-1.5 text-[13px] text-ppp-charcoal leading-relaxed">
              <strong>Should have</strong> {finding.shouldHave}
            </p>
          )}
          {finding.severity && (
            <p className="mt-1 text-[11px] text-ppp-orange-700/80">
              {finding.severity}{finding.turnOrdinal ? ` · Kate marked this at her turn ${finding.turnOrdinal}` : ""}
            </p>
          )}
        </div>
      </section>

      {/* The conversation. Only the bot's lines can be picked. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <p className="text-[13px] font-semibold text-ppp-charcoal">Which line got it wrong?</p>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            Kate&apos;s turn numbers count differently from ours, so pick it yourself
            rather than trusting the number above.
          </p>
        </div>
        <ul className="max-h-[42vh] overflow-y-auto divide-y divide-ppp-charcoal-100">
          {lines.map((l) => {
            const can = isRepairable(l);
            const on = lineIndex === l.index;
            return (
              <li key={l.index}>
                <button type="button" disabled={!can}
                  onClick={() => { setLineIndex(l.index); setReplacement(l.text); }}
                  className={[
                    "w-full text-left px-4 py-2 min-h-[44px] touch-manipulation",
                    on ? "bg-ppp-charcoal-50 ring-1 ring-inset ring-ppp-charcoal" : "",
                    can ? "" : "opacity-60 cursor-default",
                  ].join(" ")}>
                  <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                    {l.speaker || "…"}
                  </span>
                  <span className="block text-[12.5px] text-ppp-charcoal-600 leading-snug">{l.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {lineIndex !== null && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 space-y-2.5">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ppp-charcoal-600 mb-1">
              What should it have said instead?
            </span>
            <textarea value={replacement} onChange={(e) => setReplacement(e.target.value)} rows={3}
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13.5px] leading-relaxed resize-y" />
            <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400 leading-snug">
              Write the actual message, not a description of it. This is the line
              the bot will copy.
            </span>
          </label>

          <div>
            <span className="block text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
              Which rule does the fixed version show?
            </span>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button key={t.key} type="button"
                  onClick={() => setPicked((p) => p.includes(t.key) ? p.filter((x) => x !== t.key) : [...p, t.key])}
                  aria-pressed={picked.includes(t.key)}
                  className={[
                    "min-h-[36px] px-2.5 rounded-lg text-[12px] font-medium border touch-manipulation",
                    picked.includes(t.key)
                      ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                      : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-600",
                  ].join(" ")}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {err && <p className="text-[12.5px] text-ppp-orange-700 leading-relaxed">{err}</p>}

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void save()} disabled={busy || !replacement.trim()}
              className="min-h-[48px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13.5px] font-semibold disabled:opacity-40 touch-manipulation">
              {busy ? "Saving…" : "Save the repair"}
            </button>
            <button type="button" onClick={next} disabled={busy}
              className="min-h-[48px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
              Skip this one
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
