"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  saveRepair, approveRepair,
  type RepairCandidate, type RuleOption, type RepairRecord,
} from "@/lib/messaging/repair-write";
import { turnsOf, isRepairable, type Turn } from "@/lib/messaging/repair";
import RulePicker from "./rule-picker";

type Fix = { replacement: string; reason: string; ruleIds: string[] };

/**
 * Turning a near-miss into an example of the thing done properly.
 *
 * Kate, 2026-09-15, three things fixed here:
 *  - Every message carries her T-number, counted the way her sheet counts, so
 *    "came back at T5" in a reason means the same line to everybody.
 *  - A repair takes as many of Emily's lines as were wrong. One at a time made
 *    a "good" example that still held the other wrong line.
 *  - Saving stays on the conversation. The queue used to be walked by list
 *    position, and a refresh after saving reordered the list underneath it.
 *    It is walked by conversation id now.
 */
export default function RepairConsole({
  candidates, options,
}: {
  candidates: RepairCandidate[];
  options: RuleOption[];
}) {
  // The order is fixed for the visit. Refreshed data is looked up by id.
  const [order] = useState(() => candidates.map((c) => c.exampleId));
  const [pos, setPos] = useState(0);

  const byId = new Map(candidates.map((c) => [c.exampleId, c]));
  const c = order[pos] ? byId.get(order[pos]) : undefined;

  if (!c) {
    return (
      <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
        <p className="text-[13px] font-semibold text-ppp-charcoal">Nothing left to repair</p>
        <p className="mt-1 text-[12.5px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
          Every conversation graded mixed or bad has been through here. Open one
          from Rated conversations to change a repair.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setPos((p) => Math.max(0, p - 1))} disabled={pos === 0}
          className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12.5px] font-medium text-ppp-charcoal-600 disabled:opacity-40 touch-manipulation">
          Previous
        </button>
        <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">{pos + 1} of {order.length}</span>
        <button type="button" onClick={() => setPos((p) => p + 1)}
          className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12.5px] font-medium text-ppp-charcoal-600 touch-manipulation">
          {pos + 1 < order.length ? "Next" : "Finish"}
        </button>
      </div>
      <RepairOne key={c.exampleId} c={c} options={options} onNext={() => setPos((p) => p + 1)} />
    </div>
  );
}

function fixesFrom(r: RepairRecord | undefined): Record<number, Fix> {
  const out: Record<number, Fix> = {};
  for (const f of r?.fixes ?? []) out[f.turn] = { replacement: f.replacement, reason: f.reason, ruleIds: f.ruleIds };
  return out;
}

function RepairOne({ c, options, onNext }: { c: RepairCandidate; options: RuleOption[]; onNext: () => void }) {
  const router = useRouter();
  // Reopen the latest repair rather than starting a second one beside it.
  const latest = c.repairs[c.repairs.length - 1];
  const [repairId, setRepairId] = useState<string | null>(latest?.id ?? null);
  const [fixes, setFixes] = useState<Record<number, Fix>>(() => fixesFrom(latest));
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ transcript: string; turns: number[]; signed: boolean } | null>(null);

  const turns = turnsOf(c.transcript);
  const fixedTurns = Object.keys(fixes).map(Number).sort((a, b) => a - b);

  const setFix = (turn: number, patch: Partial<Fix>) =>
    setFixes((f) => ({ ...f, [turn]: { ...f[turn], ...patch } }));

  const startFix = (turn: number, text: string) => {
    if (!fixes[turn]) setFixes((f) => ({ ...f, [turn]: { replacement: text, reason: "", ruleIds: [] } }));
    setOpen(turn);
  };

  const removeFix = (turn: number) => {
    setFixes((f) => { const n = { ...f }; delete n[turn]; return n; });
    setOpen(null);
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await saveRepair({
        exampleId: c.exampleId, repairId,
        fixes: fixedTurns.map((turn) => ({ turn, ...fixes[turn] })),
      });
      if (!res.ok) { setErr(res.error); return; }
      setRepairId(res.id);
      setSaved({ transcript: res.transcript, turns: res.changed.map((x) => x.turn), signed: false });
      setOpen(null);
      router.refresh();
    } finally { setBusy(false); }
  };

  const signOff = async () => {
    if (!repairId) return;
    setBusy(true); setErr(null);
    try {
      const res = await approveRepair({ id: repairId, approve: true });
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
      onNext();
    } finally { setBusy(false); }
  };

  if (saved) {
    const repaired = turnsOf(saved.transcript);
    return (
      <div className="space-y-3">
        <section className="rounded-xl border border-ppp-green-100 bg-ppp-green-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-charcoal">
            Repair saved · {saved.turns.map((t) => `T${t}`).join(", ")}
          </p>
          <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
            The bot cannot copy it until it is signed off. Read the whole
            conversation below. If every line reads like something Emily would
            actually send, sign it off.
          </p>
        </section>

        <TurnList turns={repaired} highlight={saved.turns} />

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void signOff()} disabled={busy}
            className="min-h-[48px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13.5px] font-semibold disabled:opacity-40 touch-manipulation">
            {busy ? "Signing off…" : "Yes, the bot can copy this"}
          </button>
          <button type="button" onClick={() => setSaved(null)} disabled={busy}
            className="min-h-[48px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
            Fix another line
          </button>
          <button type="button" onClick={onNext} disabled={busy}
            className="min-h-[48px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
            Leave unsigned, next conversation
          </button>
        </div>
        {err && <p className="text-[12.5px] text-ppp-orange-700">{err}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ppp-charcoal-500">
        {c.conduct === "mixed" ? "Nearly right" : c.conduct === "bad" ? "Went wrong" : "Graded good"}
        {latest && (
          <> · the saved repair is open{latest.approved ? ". It is signed off, and changing it unsigns it" : ""}</>
        )}
      </p>

      {c.findings.length > 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50 px-4 py-3 space-y-2">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Kate&apos;s notes</p>
          {c.findings.map((f) => (
            <div key={f.id} className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
              {f.turnOrdinal != null && <strong className="mr-1">T{f.turnOrdinal}</strong>}
              {f.code && <strong className="mr-1">{f.code}</strong>}
              {f.what}
              {f.shouldHave && <span className="block text-ppp-charcoal"><strong>Should have</strong> {f.shouldHave}</span>}
            </div>
          ))}
        </section>
      )}

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <p className="text-[13px] font-semibold text-ppp-charcoal">Which of Emily&apos;s lines were wrong?</p>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            Tap every line that needs fixing. Turn numbers match your sheet.
          </p>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {turns.map((t) => {
            if (t.turn === null) return <ContextRow key={`m${t.position}`} t={t} />;
            const turn = t.turn;
            const can = isRepairable(t);
            const fix = fixes[turn];
            const isOpen = open === turn;
            return (
              <li key={`m${t.position}`} className={fix ? "bg-ppp-charcoal-50/60" : ""}>
                <button type="button" disabled={!can}
                  onClick={() => (isOpen ? setOpen(null) : startFix(turn, t.text))}
                  aria-expanded={can ? isOpen : undefined}
                  className={[
                    "w-full text-left px-4 py-2 min-h-[44px] touch-manipulation",
                    can ? "hover:bg-ppp-charcoal-50" : "cursor-default",
                  ].join(" ")}>
                  <span className="flex items-baseline gap-2">
                    <span className="shrink-0 w-8 text-[11px] font-bold text-ppp-charcoal-400 tabular-nums">T{turn}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                        {t.label}
                        {fix && <span className="ml-1.5 normal-case tracking-normal text-ppp-orange-700">being fixed</span>}
                      </span>
                      <span className={[
                        "block text-[12.5px] leading-snug whitespace-pre-wrap break-words",
                        fix ? "text-ppp-charcoal-400 line-through" : can ? "text-ppp-charcoal" : "text-ppp-charcoal-500",
                      ].join(" ")}>{t.text}</span>
                      {fix && !isOpen && (
                        <span className="block mt-1 text-[12.5px] text-ppp-charcoal leading-snug whitespace-pre-wrap">{fix.replacement}</span>
                      )}
                    </span>
                  </span>
                </button>

                {isOpen && fix && (
                  <div className="px-4 pb-3 pt-1 space-y-2.5">
                    <label className="block">
                      <span className="block text-[12.5px] font-medium text-ppp-charcoal-600 mb-1">
                        What should T{turn} have said?
                      </span>
                      <textarea value={fix.replacement} onChange={(e) => setFix(turn, { replacement: e.target.value })} rows={3}
                        className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13.5px] leading-relaxed resize-y bg-white" />
                      <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400 leading-snug">
                        The actual message, not a description of it. This is what the bot copies.
                      </span>
                    </label>

                    <label className="block">
                      <span className="block text-[12.5px] font-medium text-ppp-charcoal-600 mb-1">
                        What was wrong with it?
                      </span>
                      <textarea value={fix.reason} onChange={(e) => setFix(turn, { reason: e.target.value })} rows={2}
                        placeholder="Asked for the full address while we already had the zip"
                        className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] leading-relaxed resize-y bg-white" />
                    </label>

                    <div>
                      <span className="block text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
                        Which rule does the fixed line show?
                      </span>
                      <RulePicker options={options} selected={fix.ruleIds}
                        onChange={(ids) => setFix(turn, { ruleIds: ids })} />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setOpen(null)}
                        className="min-h-[44px] px-3 rounded-lg bg-ppp-charcoal text-white text-[12.5px] font-semibold touch-manipulation">
                        Done with T{turn}
                      </button>
                      <button type="button" onClick={() => removeFix(turn)}
                        className="min-h-[44px] px-3 rounded-lg border border-ppp-charcoal-200 bg-white text-[12.5px] font-medium text-ppp-charcoal-600 touch-manipulation">
                        Don&apos;t fix this line
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Sticky, so saving never needs a scroll back down a long thread. */}
      <div className="sticky bottom-0 -mx-4 px-4 py-2.5 bg-white/95 backdrop-blur border-t border-ppp-charcoal-100 space-y-1.5">
        {err && <p className="text-[12.5px] text-ppp-orange-700 leading-relaxed">{err}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void save()}
            disabled={busy || fixedTurns.length === 0}
            className="min-h-[48px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13.5px] font-semibold disabled:opacity-40 touch-manipulation">
            {busy ? "Saving…" : fixedTurns.length
              ? `Save repair · ${fixedTurns.map((t) => `T${t}`).join(", ")}`
              : "Tap a line to fix it"}
          </button>
          {fixedTurns.some((t) => !fixes[t].reason.trim()) && (
            <span className="text-[11.5px] text-ppp-charcoal-500">Each fixed line needs what was wrong with it.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A campaign message or auto-reply: shown so the customer's reply has its
 * context, not numbered and not selectable. Kate, 2026-09-15.
 */
export function ContextRow({ t }: { t: Turn }) {
  return (
    <li className="px-4 py-2 bg-ppp-charcoal-50/70">
      <span className="flex items-baseline gap-2">
        <span className="shrink-0 w-8" aria-hidden />
        <span className="min-w-0">
          <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{t.label}</span>
          <span className="block text-[12px] text-ppp-charcoal-500 leading-snug whitespace-pre-wrap break-words">{t.text}</span>
        </span>
      </span>
    </li>
  );
}

function TurnList({ turns, highlight }: { turns: Turn[]; highlight: number[] }) {
  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
      <ul className="divide-y divide-ppp-charcoal-100">
        {turns.map((t) => t.turn === null ? <ContextRow key={`m${t.position}`} t={t} /> : (
          <li key={`m${t.position}`} className={["px-4 py-2", highlight.includes(t.turn) ? "bg-ppp-green-50" : ""].join(" ")}>
            <span className="flex items-baseline gap-2">
              <span className="shrink-0 w-8 text-[11px] font-bold text-ppp-charcoal-400 tabular-nums">T{t.turn}</span>
              <span className="min-w-0">
                <span className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{t.label}</span>
                <span className="block text-[12.5px] text-ppp-charcoal leading-snug whitespace-pre-wrap break-words">{t.text}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
