"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveAgentConfig, clearAgentConfig, type SaveScope } from "@/lib/messaging/agent-config-write";

type Field = {
  key: string;
  label: string;
  help?: string;
  long?: boolean;
  value: string;
  /** What this level would show if it had no value of its own. */
  inherited?: string | null;
  from?: string;
};

/**
 * Edit the rules for one level.
 *
 * The inherited value is shown under every empty field, because the question
 * being answered here is never "what should this say" in isolation — it is
 * "does this level need to differ from the one above it". A blank box that
 * silently means "Pasadena" is how a Nassau customer gets told the office is
 * in California.
 */
export default function AgentConfigEditor({
  where, track, fields, threshold, maxTurns, canClear, levelName,
}: {
  where: SaveScope;
  track: "new_lead" | "nurture";
  fields: Field[];
  threshold: number;
  maxTurns: number;
  canClear: boolean;
  levelName: string;
}) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.value]))
  );
  const [conf, setConf] = useState(String(threshold));
  const [turns, setTurns] = useState(String(maxTurns));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    fields.some((f) => (vals[f.key] ?? "") !== f.value) ||
    conf !== String(threshold) || turns !== String(maxTurns);

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const res = await saveAgentConfig({
        where, track,
        values: { ...vals, confidence_threshold: Number(conf), max_turns: Number(turns) },
      });
      if (res.ok) { setSaved(true); router.refresh(); }
      else setErr(res.error);
    } catch {
      setErr("Could not save. Nothing was changed.");
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (where.scope === "global") return;
    setBusy(true); setErr(null);
    try {
      const res = await clearAgentConfig({ where, track });
      if (res.ok) router.refresh();
      else setErr(res.error);
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Editing {levelName}</h2>
        <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Saved changes apply to the next message. There is no deploy step.
          Clearing a box means inherit from the level above, not blank.
        </p>
      </div>

      <div className="px-4 py-3 space-y-3">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">{f.label}</span>
            {f.long ? (
              <textarea
                value={vals[f.key] ?? ""} rows={4}
                onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2 text-base sm:text-[13px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30 resize-y"
              />
            ) : (
              <input
                value={vals[f.key] ?? ""}
                onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
              />
            )}
            {!(vals[f.key] ?? "").trim() && f.inherited && (
              <span className="mt-1 block text-[11.5px] text-ppp-charcoal-500 leading-snug">
                Inherits{f.from ? ` from ${f.from}` : ""}: {f.inherited}
              </span>
            )}
            {f.help && <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400 leading-snug">{f.help}</span>}
          </label>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Confidence threshold</span>
            <input value={conf} onChange={(e) => setConf(e.target.value)} inputMode="decimal"
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
            <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400">Below this it hands to a person instead of answering.</span>
          </label>
          <label className="block">
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Max turns</span>
            <input value={turns} onChange={(e) => setTurns(e.target.value)} inputMode="numeric"
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
            <span className="mt-1 block text-[11.5px] text-ppp-charcoal-400">Longer than this hands to a human rather than looping.</span>
          </label>
        </div>

        {err && (
          <p className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 py-2 text-[12.5px] text-ppp-orange-700">{err}</p>
        )}
        {saved && !dirty && (
          <p className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 px-3 py-2 text-[12.5px] text-ppp-charcoal">
            Saved. The next message follows these rules.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void save()} disabled={busy || !dirty}
            className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
            {busy ? "Saving…" : "Save"}
          </button>
          {canClear && (
            <button type="button" onClick={() => void clear()} disabled={busy}
              className="min-h-[44px] px-4 rounded-xl border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal-600 touch-manipulation">
              Remove its own rules
            </button>
          )}
        </div>
        <p className="text-[11.5px] text-ppp-charcoal-400 leading-snug">
          Quiet hours, the opt-out list and the daily cap are not here on
          purpose — they live in the send gate so nothing can configure its way
          past them. Turning a workspace on to send by itself is also not a
          field: that is earned after a clean run.
        </p>
      </div>
    </section>
  );
}
