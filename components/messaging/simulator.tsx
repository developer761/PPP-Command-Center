"use client";

import { useState } from "react";
import { runSimTurn, saveScenario, type SimTurn } from "@/lib/messaging/simulator";

type Graded = SimTurn & {
  verdict?: "good" | "acceptable" | "wrong";
  verdictNote?: string;
  expectedIntent?: string;
};

/**
 * The sandbox.
 *
 * Shows the INTENT alongside the message, which is the whole point. A wrong
 * intent behind a plausible-sounding reply is the failure that matters, and
 * Hatch shows you only the reply — so a bot that says something reasonable
 * while heading down the wrong branch looks fine right up until it books
 * nothing.
 */
export default function Simulator({
  workspaces,
  tags,
  ready,
  notReadyReason,
}: {
  workspaces: { id: string; name: string }[];
  tags: { key: string; label: string; what_to_look_for: string }[];
  ready: boolean;
  notReadyReason?: string;
}) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [brief, setBrief] = useState("");
  const [tagKey, setTagKey] = useState("");
  const [turns, setTurns] = useState<Graded[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const selectedTag = tags.find((t) => t.key === tagKey);

  const send = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const history = turns.flatMap((t) => [
        { role: "customer" as const, text: t.customerText },
        ...(t.message ? [{ role: "assistant" as const, text: t.message }] : []),
      ]);
      // Whether the last thing the bot said asked for something decides
      // whether a reaction counts as an answer.
      const lastAskedForInfo = /^ask_/.test(turns[turns.length - 1]?.intent ?? "");
      const res = await runSimTurn({ workspaceId: workspaceId || undefined, history, customerText: draft.trim(), lastAskedForInfo });
      if (res.ok) { setTurns((t) => [...t, res.turn]); setDraft(""); }
    } finally { setBusy(false); }
  };

  const grade = (i: number, patch: Partial<Graded>) =>
    setTurns((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    const name = `${selectedTag?.label ?? "Scenario"} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const res = await saveScenario({ name, customerBrief: brief, tagKey: tagKey || undefined, workspaceId: workspaceId || undefined, turns });
    setSaved(res.ok ? "Saved. It will replay after a prompt change." : `Could not save: ${res.error}`);
  };

  const allGraded = turns.length > 0 && turns.every((t) => t.verdict);

  if (!ready) {
    return (
      <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-4">
        <p className="font-semibold text-ppp-orange-700">The simulator cannot run yet</p>
        <p className="mt-1.5 text-[13px] text-ppp-orange-700/90 leading-relaxed">{notReadyReason}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">Set the scene</h2>
        <div className="px-4 py-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Answer as</span>
              <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30">
                <option value="">Default settings</option>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Testing which rule</span>
              <select value={tagKey} onChange={(e) => setTagKey(e.target.value)}
                className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30">
                <option value="">Not sure yet</option>
                {tags.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
          </div>
          {selectedTag && (
            <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed bg-ppp-charcoal-50 rounded-lg px-3 py-2">
              {selectedTag.what_to_look_for}
            </p>
          )}
          <label className="block">
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
              Who are you playing? <span className="text-ppp-charcoal-400">(for your notes — the bot never sees this)</span>
            </span>
            <input value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder="Tenant, no access to the property, wants a rough price"
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <h2 className="px-4 py-2.5 border-b border-ppp-charcoal-100 font-semibold text-ppp-charcoal text-[14px]">The conversation</h2>

        {turns.length === 0 && (
          <p className="px-4 py-6 text-center text-[13px] text-ppp-charcoal-500">
            Type what the customer would say first.
          </p>
        )}

        <ol className="divide-y divide-ppp-charcoal-100">
          {turns.map((t, i) => (
            <li key={i} className="px-4 py-3 space-y-2.5">
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ppp-charcoal text-white px-3.5 py-2.5 text-[14px] leading-relaxed">
                  {t.customerText}
                </p>
              </div>

              {t.error ? (
                <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-3.5 py-2.5">
                  <p className="text-[13px] font-medium text-ppp-orange-700">{t.error}</p>
                  {t.rejected && <p className="mt-1 text-[12px] text-ppp-orange-700/90">Blocked before sending: {t.rejected}</p>}
                </div>
              ) : (
                <>
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white border border-ppp-charcoal-100 px-3.5 py-2.5">
                      <p className="text-[14px] leading-relaxed text-ppp-charcoal">{t.message || <span className="italic text-ppp-charcoal-400">no message — action only</span>}</p>
                    </div>
                  </div>
                  {/* The intent, not just the words. A wrong branch behind a
                      reasonable-sounding reply is the failure Hatch hides. */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="rounded-full bg-ppp-charcoal-50 px-2 py-0.5 font-mono text-ppp-charcoal-600">{t.intent}</span>
                    {t.confidence !== null && (
                      <span className="rounded-full bg-ppp-charcoal-50 px-2 py-0.5 tabular-nums text-ppp-charcoal-500">
                        {Math.round(t.confidence * 100)}% sure
                      </span>
                    )}
                    {t.escalate && (
                      <span className="rounded-full bg-ppp-orange-50 px-2 py-0.5 font-medium text-ppp-orange-700">
                        would hand to a person
                      </span>
                    )}
                  </div>
                </>
              )}

              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {(["good", "acceptable", "wrong"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => grade(i, { verdict: v })}
                    className={[
                      "min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium touch-manipulation",
                      t.verdict === v
                        ? v === "wrong" ? "bg-ppp-orange-50 text-ppp-orange-700 ring-1 ring-ppp-orange-500"
                          : "bg-ppp-charcoal text-white"
                        : "border border-ppp-charcoal-200 text-ppp-charcoal-600",
                    ].join(" ")}>
                    {v === "good" ? "Good" : v === "acceptable" ? "Fine" : "Wrong"}
                  </button>
                ))}
              </div>

              {t.verdict === "wrong" && (
                <input
                  value={t.expectedIntent ?? ""}
                  onChange={(e) => grade(i, { expectedIntent: e.target.value })}
                  placeholder="What should it have done instead?"
                  className="w-full rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-3 min-h-[40px] text-base sm:text-[13px] placeholder:text-ppp-orange-700/50 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
                />
              )}
            </li>
          ))}
        </ol>

        <div className="px-4 py-3 border-t border-ppp-charcoal-100 flex gap-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={turns.length ? "Reply as the customer…" : "What does the customer say first?"}
            disabled={busy}
            className="flex-1 min-w-0 rounded-xl border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[14px] placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30 disabled:bg-ppp-charcoal-50" />
          <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()}
            className="shrink-0 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500">
            {busy ? "…" : "Send"}
          </button>
        </div>
      </section>

      {turns.length > 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
          <p className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
            Saving keeps this as a test, not as training data. A made-up customer
            is somebody&apos;s idea of a customer, so it is not something the bot
            should copy — but it is exactly what to replay after changing the
            instructions, to see what broke.
          </p>
          <button type="button" onClick={() => void save()} disabled={!allGraded}
            className="mt-2.5 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500">
            Save as a test
          </button>
          {!allGraded && <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-500">Grade every reply first.</p>}
          {saved && <p className="mt-1.5 text-[12px] text-ppp-charcoal-600">{saved}</p>}
        </section>
      )}
    </div>
  );
}
