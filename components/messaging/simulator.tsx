"use client";

import { useState } from "react";
import { stageFromIntents } from "@/lib/messaging/agent-output";
import { runSimTurn, saveScenario, type SimTurn } from "@/lib/messaging/simulator";

type Graded = SimTurn & {
  verdict?: "good" | "acceptable" | "wrong";
  verdictNote?: string;
  expectedIntent?: string;
  showNote?: boolean;
};

/**
 * Feedback belongs to ONE reply.
 *
 * Karan: "responses 1-4 are good but response 5 is bad — we don't want to say
 * this is bad and have it think the whole interaction is bad." So every reply
 * carries its own verdict and its own note, and a note is available on a GOOD
 * reply too: "fine, but word it like…" is the most useful feedback there is
 * and the first version had nowhere to put it.
 */

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
  initialTagKey = "",
}: {
  workspaces: { id: string; name: string }[];
  tags: { key: string; label: string; what_to_look_for: string }[];
  ready: boolean;
  notReadyReason?: string;
  /** Arrives from the coverage page, so a gap opens the sandbox already
   *  pointed at the rule it is missing. */
  initialTagKey?: string;
}) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [brief, setBrief] = useState("");
  const [tagKey, setTagKey] = useState(initialTagKey);
  const [turns, setTurns] = useState<Graded[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [photos, setPhotos] = useState(0);
  const [track, setTrack] = useState<"new_lead" | "nurture">("new_lead");
  const [known, setKnown] = useState({ name: "", phone: "", email: "", address: "", inquiryScope: "" });
  const [showKnown, setShowKnown] = useState(false);

  const filledKnown = Object.values(known).filter((v) => v.trim()).length;
  const flowStage = stageFromIntents(turns.map((t) => t.intent));
  const selectedTag = tags.find((t) => t.key === tagKey);

  /**
   * React to the bot's last message, in the format a phone actually sends.
   *
   * iPhone sends `Liked "<the message>"` as ordinary SMS text — that string IS
   * the reaction, and parsing it is what Hatch cannot do. Generating the real
   * format here means the simulator exercises the real parser rather than a
   * tidied-up version of it.
   */
  const react = (verb: string) => {
    const last = [...turns].reverse().find((t) => t.message)?.message;
    if (!last || busy) return;
    void send(`${verb} "${last}"`);
  };

  const send = async (override?: string, media = 0) => {
    const text = override ?? draft.trim();
    if ((!text && media === 0) || busy) return;
    setBusy(true);
    try {
      const history = turns.flatMap((t) => [
        { role: "customer" as const, text: t.customerText },
        ...(t.message ? [{ role: "assistant" as const, text: t.message }] : []),
      ]);
      // Whether the last thing the bot said asked for something decides
      // whether a reaction counts as an answer.
      const lastAskedForInfo = /^ask_/.test(turns[turns.length - 1]?.intent ?? "");
      const res = await runSimTurn({
        workspaceId: workspaceId || undefined,
        history, customerText: text, lastAskedForInfo,
        mediaCount: media || photos,
        track,
        known,
        // The order is a rule, so the sandbox has to enforce it too — a
        // simulator that lets the bot skip a step is testing a bot we will
        // never run.
        stage: stageFromIntents(turns.map((t) => t.intent)),
        lastIntent: [...turns].reverse().find((t) => t.intent)?.intent ?? undefined,
      });
      if (res.ok) { setTurns((t) => [...t, res.turn]); setDraft(""); setPhotos(0); }
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
          {/* Which conversation. Testing a quote follow-up against the
              new-lead rules is how you get a bot asking a customer who has
              already had an estimator in their house for their address. */}
          <div>
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Which conversation</span>
            <div className="flex gap-2">
              {([["new_lead", "New lead"], ["nurture", "Quote already sent"]] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setTrack(v)}
                  aria-pressed={track === v}
                  className={[
                    "flex-1 min-h-[44px] px-3 rounded-xl text-[13px] font-semibold border touch-manipulation",
                    track === v
                      ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                      : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
                  ].join(" ")}>
                  {label}
                </button>
              ))}
            </div>
          </div>
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
          {/* Kate: "In Hatch we had the ability to add inquiry details, customer
              contact information, etc. to the Customer Data section when
              sandbox testing." Without it the sandbox cannot reproduce the bug
              she graded four conversations down for. */}
          <div className="rounded-lg border border-ppp-charcoal-100">
            <button type="button" onClick={() => setShowKnown((v) => !v)}
              aria-expanded={showKnown}
              className="w-full min-h-[44px] px-3 flex items-center justify-between text-left touch-manipulation">
              <span className="text-[12px] font-medium text-ppp-charcoal-600">
                What we already know about them
                {filledKnown > 0 && (
                  <span className="ml-1.5 text-[11px] text-ppp-charcoal-400">{filledKnown} on file</span>
                )}
              </span>
              <span className="text-[12px] text-ppp-charcoal-400">{showKnown ? "Hide" : "Add"}</span>
            </button>
            {showKnown && (
              <div className="px-3 pb-3 space-y-2">
                <p className="text-[12px] text-ppp-charcoal-500 leading-relaxed">
                  Anything filled in here, the bot is forbidden to ask for — it
                  can only read it back. Leave a field blank to test what happens
                  when we genuinely do not have it.
                </p>
                {([
                  ["name", "Name", "Jeremy Saxe"],
                  ["phone", "Texting them on", "516-784-6046"],
                  ["email", "Email", "tom@example.com"],
                  ["address", "Address", "166 S Park Ave, Rockville Centre, NY 11570"],
                  ["inquiryScope", "What the enquiry said", "1500sqft Cape Cod, cedar shake cleaned and scraped, 2 coats exterior"],
                ] as const).map(([k, label, placeholder]) => (
                  <label key={k} className="block">
                    <span className="block text-[11px] font-medium text-ppp-charcoal-500 mb-0.5">{label}</span>
                    <input
                      value={known[k]}
                      onChange={(e) => setKnown((p) => ({ ...p, [k]: e.target.value }))}
                      placeholder={placeholder}
                      className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[40px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* THE ORDER, VISIBLE.
              Karan: "it's not even doing this... how do I trust it." The rule
              IS enforced — an out-of-order intent is refused before it can be
              sent — but nothing on screen showed it happening, so there was no
              way to believe it from the outside. Watching it fill in one step
              at a time is the difference between a claim and evidence. */}
          {track === "new_lead" && (
            <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50 px-3 py-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                What it has to collect, in order
              </p>
              <ol className="mt-1.5 space-y-1">
                {["Project details", "Full address", "Contact information", "Appointment availability"].map((label, n) => {
                  const done = flowStage > n;
                  const current = flowStage === n;
                  return (
                    <li key={label} className="flex items-center gap-2">
                      <span aria-hidden className={[
                        "shrink-0 h-4 w-4 rounded-full border-2 flex items-center justify-center text-[9px] font-bold",
                        done ? "border-ppp-green-700 bg-ppp-green-50 text-ppp-green-700"
                             : current ? "border-ppp-charcoal bg-ppp-charcoal text-white"
                             : "border-ppp-charcoal-200 text-ppp-charcoal-400",
                      ].join(" ")}>
                        {done ? "✓" : n + 1}
                      </span>
                      <span className={[
                        "text-[12.5px]",
                        done ? "text-ppp-charcoal-500 line-through" : current ? "text-ppp-charcoal font-medium" : "text-ppp-charcoal-400",
                      ].join(" ")}>
                        {label}
                      </span>
                      {current && (
                        <span className="text-[11px] text-ppp-charcoal-400">← asking for this next</span>
                      )}
                    </li>
                  );
                })}
              </ol>
              <p className="mt-1.5 text-[11px] text-ppp-charcoal-400 leading-snug">
                It cannot skip ahead. Asking for an address before it has the
                project details is refused before it can be sent, so if you see
                these tick off in order that is the rule working, not luck.
              </p>
            </div>
          )}

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
                    {t.saysNothing && (
                      <p className="mt-1 text-[11px] text-ppp-orange-700/90 leading-snug">
                        It had nothing to say, so it handed to a person.
                      </p>
                    )}
                    {t.droppedRapport && (
                      <p className="mt-1 text-[11px] text-ppp-charcoal-500 leading-snug">
                        A sentence was removed before sending: {t.droppedRapport}.
                      </p>
                    )}
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

                <div className="flex flex-wrap gap-1 pl-1">
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
                  {/* NOT gated behind picking a verdict.
                      Karan: "there's no way for me to input the feedback here."
                      It only appeared once Good/Fine/Wrong had been chosen, so
                      the most common thing somebody wants to write — "this is
                      nearly right, say it like this" — needed a grade first and
                      looked impossible until you had guessed that. */}
                  {!t.showNote && t.verdictNote === undefined && (
                    <button type="button" onClick={() => grade(i, { showNote: true })}
                      className="min-h-[30px] px-2 rounded-md text-[11px] font-medium text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation min-h-[44px] sm:min-h-0">
                      {t.verdict ? "+ say why" : "+ add a note"}
                    </button>
                  )}
                </div>

                {(t.showNote || t.verdictNote !== undefined) && (
                  <textarea
                    value={t.verdictNote ?? ""}
                    onChange={(e) => grade(i, { verdictNote: e.target.value })}
                    rows={2}
                    placeholder={
                      t.verdict === "wrong"
                        ? "We don't say this… / it should have asked for…"
                        : "Fine, but word it like…"
                    }
                    className="w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-base sm:text-[12px] placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
                  />
                )}

                {t.verdict === "wrong" && (
                  <input value={t.expectedIntent ?? ""} onChange={(e) => grade(i, { expectedIntent: e.target.value })}
                    placeholder="What should it have done instead?"
                    className="w-full rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 px-2.5 min-h-[36px] text-base sm:text-[12px] placeholder:text-ppp-orange-700/50 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30" />
                )}
              </div>
            ))}
          </div>

          {/* What a real customer can send, and Hatch cannot read. */}
          <div className="bg-white border-t border-ppp-charcoal-100 px-3 pt-2 pb-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-0.5">Send</span>
              {["👍", "❤️", "😂", "👎", "❓"].map((e) => (
                <button key={e} type="button" onClick={() => void send(e)} disabled={busy}
                  aria-label={`Send ${e} on its own`}
                  className="h-11 w-11 sm:h-8 sm:w-8 rounded-lg text-[15px] hover:bg-ppp-charcoal-50 touch-manipulation disabled:opacity-40">
                  {e}
                </button>
              ))}
              <button type="button" onClick={() => setPhotos((n) => (n >= 3 ? 0 : n + 1))} disabled={busy}
                className={[
                  "h-8 px-2 rounded-lg text-[11px] font-medium touch-manipulation disabled:opacity-40",
                  photos > 0 ? "bg-ppp-charcoal text-white" : "text-ppp-charcoal-500 hover:bg-ppp-charcoal-50",
                ].join(" ")}>
                {photos > 0 ? `${photos} photo${photos === 1 ? "" : "s"}` : "📷 photo"}
              </button>
            </div>
            {turns.some((t) => t.message) && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-0.5">React</span>
                {["Liked", "Loved", "Questioned", "Disliked"].map((v) => (
                  <button key={v} type="button" onClick={() => react(v)} disabled={busy}
                    className="h-8 px-2 rounded-lg text-[11px] font-medium text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 touch-manipulation disabled:opacity-40 min-h-[44px] sm:min-h-0">
                    {v}
                  </button>
                ))}
                <span className="text-[10px] text-ppp-charcoal-400 ml-0.5">its last message</span>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="bg-white px-3 pb-2.5 pt-1 flex gap-2 items-end">
            <input value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={turns.length ? "Reply as the customer…" : "Text the business…"}
              disabled={busy}
              className="flex-1 min-w-0 rounded-full border border-ppp-charcoal-200 px-3.5 min-h-[38px] text-base sm:text-[14px] placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-[#0b93f6]/30 disabled:bg-ppp-charcoal-50" />
            <button type="button" onClick={() => void send()} disabled={busy || (!draft.trim() && photos === 0)}
              aria-label="Send as the customer"
              className="shrink-0 h-[38px] w-[38px] rounded-full bg-[#0b93f6] text-white flex items-center justify-center touch-manipulation disabled:bg-ppp-charcoal-200 min-h-[44px] sm:min-h-0">
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
