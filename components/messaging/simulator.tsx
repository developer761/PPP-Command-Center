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

      {/* A phone, because that is where these land. Not decoration — a
          message that reads fine in a wide column can be four lines on a
          handset, and PPP's opener is 232 characters. */}
      <section className="flex justify-center">
        <div className="w-full max-w-[380px] rounded-[2.25rem] border-[10px] border-ppp-charcoal bg-ppp-charcoal shadow-xl overflow-hidden">
          {/* Status bar */}
          <div className="bg-white px-6 pt-2 pb-1 flex items-center justify-between text-[11px] font-semibold text-ppp-charcoal">
            <span>9:41</span>
            <span className="h-5 w-24 -mt-2 rounded-b-2xl bg-ppp-charcoal" aria-hidden />
            <span className="flex items-center gap-1" aria-hidden>
              <svg width="15" height="11" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2" width="3" height="10" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1" opacity="0.3"/></svg>
              <svg width="18" height="10" viewBox="0 0 24 12" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="1" width="19" height="10" rx="3"/><rect x="3" y="3" width="13" height="6" rx="1.5" fill="currentColor" stroke="none"/><path d="M22 4.5v3" strokeLinecap="round"/></svg>
            </span>
          </div>

          {/* Contact header */}
          <div className="bg-white border-b border-ppp-charcoal-100 px-4 py-2 text-center">
            <p className="text-[13px] font-semibold text-ppp-charcoal">
              {workspaces.find((w) => w.id === workspaceId)?.name ?? "Precision Painting Plus"}
            </p>
            <p className="text-[10.5px] text-ppp-charcoal-400">Text Message</p>
          </div>

          {/* Thread */}
          <div className="bg-white px-3 py-3 min-h-[320px] max-h-[46vh] overflow-y-auto space-y-2.5">
            {turns.length === 0 && (
              <p className="pt-16 text-center text-[12.5px] text-ppp-charcoal-400">
                Type what the customer says first.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className="space-y-1.5">
                {/* Customer — them, on the right, because you are playing them */}
                <div className="flex justify-end">
                  <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-[#0b93f6] text-white px-3 py-2 text-[14px] leading-snug">
                    {t.customerText}
                  </p>
                </div>

                {t.error ? (
                  <div className="rounded-xl bg-ppp-orange-50 px-3 py-2">
                    <p className="text-[12px] font-medium text-ppp-orange-700 leading-snug">{t.error}</p>
                    {t.rejected && <p className="mt-1 text-[11px] text-ppp-orange-700/90 leading-snug">Blocked before sending: {t.rejected}</p>}
                  </div>
                ) : (
                  <>
                    <div className="flex justify-start">
                      <p className="max-w-[80%] rounded-2xl rounded-bl-sm bg-[#e9e9eb] text-ppp-charcoal px-3 py-2 text-[14px] leading-snug">
                        {t.message || <span className="italic text-ppp-charcoal-400">no message — action only</span>}
                      </p>
                    </div>
                    {/* Outside the bubble: what it actually decided. The
                        customer never sees this and Kate always should. */}
                    <div className="flex flex-wrap items-center gap-1 pl-1">
                      <span className="rounded-full bg-ppp-charcoal-50 px-1.5 py-0.5 text-[9.5px] font-mono text-ppp-charcoal-600">{t.intent}</span>
                      {t.confidence !== null && (
                        <span className="rounded-full bg-ppp-charcoal-50 px-1.5 py-0.5 text-[9.5px] tabular-nums text-ppp-charcoal-500">
                          {Math.round(t.confidence * 100)}%
                        </span>
                      )}
                      {t.escalate && (
                        <span className="rounded-full bg-ppp-orange-50 px-1.5 py-0.5 text-[9.5px] font-medium text-ppp-orange-700">
                          hands to a person
                        </span>
                      )}
                    </div>
                  </>
                )}

                <div className="flex flex-wrap gap-1 pl-1 pb-1">
                  {(["good", "acceptable", "wrong"] as const).map((v) => (
                    <button key={v} type="button" onClick={() => grade(i, { verdict: v })}
                      className={[
                        "min-h-[30px] px-2 rounded-md text-[11px] font-medium touch-manipulation",
                        t.verdict === v
                          ? v === "wrong" ? "bg-ppp-orange-50 text-ppp-orange-700 ring-1 ring-ppp-orange-500" : "bg-ppp-charcoal text-white"
                          : "border border-ppp-charcoal-200 text-ppp-charcoal-500",
                      ].join(" ")}>
                      {v === "good" ? "Good" : v === "acceptable" ? "Fine" : "Wrong"}
                    </button>
                  ))}
                </div>

                {t.verdict === "wrong" && (
                  <input value={t.expectedIntent ?? ""} onChange={(e) => grade(i, { expectedIntent: e.target.value })}
                    placeholder="What should it have done?"
                    className="w-full rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-2.5 min-h-[36px] text-base sm:text-[12px] placeholder:text-ppp-orange-700/50 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
                )}
              </div>
            ))}
          </div>

          {/* Composer */}
          <div className="bg-white border-t border-ppp-charcoal-100 px-3 py-2.5 flex gap-2 items-end">
            <input value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={turns.length ? "Reply as the customer…" : "Text the business…"}
              disabled={busy}
              className="flex-1 min-w-0 rounded-full border border-ppp-charcoal-200 px-3.5 min-h-[38px] text-base sm:text-[14px] placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-[#0b93f6]/30 disabled:bg-ppp-charcoal-50" />
            <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()}
              aria-label="Send as the customer"
              className="shrink-0 h-[38px] w-[38px] rounded-full bg-[#0b93f6] text-white flex items-center justify-center touch-manipulation disabled:bg-ppp-charcoal-200">
              {busy ? <span className="text-[11px]">…</span> : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5 M5 12l7-7 7 7" /></svg>
              )}
            </button>
          </div>

          {/* Home indicator */}
          <div className="bg-white pb-2 pt-1 flex justify-center">
            <span className="h-1 w-28 rounded-full bg-ppp-charcoal-300" aria-hidden />
          </div>
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
