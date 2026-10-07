"use client";

import { useState } from "react";
import { stageFromIntents } from "@/lib/messaging/agent-output";
import { runSimTurn, saveScenario, type SimTurn } from "@/lib/messaging/simulator";
import { exportScenarioToTraining, scenarioAsSheet } from "@/lib/messaging/scenario-export";
import type { AuditSheet } from "@/lib/messaging/audit-sheet";
import { scopeAndStage } from "@/lib/messaging/scope";
import { addressFromCustomer, addressIsComplete } from "@/lib/messaging/address";
import { availabilityIsBookable } from "@/lib/messaging/availability";

type Graded = SimTurn & {
  verdict?: "good" | "acceptable" | "wrong";
  verdictNote?: string;
  expectedIntent?: string;
  showNote?: boolean;
  /**
   * Kate's two axes, kept independent.
   *
   * Her audit sheet lists the SAME turn under "Where it fell short" and "Good
   * Turns" — T3 fired the off-site quote immediately, which is right, and said
   * it clumsily. A single verdict cannot express that, so a turn carries both.
   */
  didWell?: string;
  shortfall?: string;
  shouldHave?: string;
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
  /**
   * EVERY RULE THE RUN SHOWS, not one of them.
   *
   * This was a single <select>, and Kate asked the question that exposes it:
   * "if there are multiple missteps (a9, a23, a15) corrected in the convo,
   * would i tag the main one (a9)? will that leave the others untagged?" It
   * would have. She would have corrected three rules, got credit for one, and
   * the other two would have read as untested on the coverage page for ever —
   * so she would have gone back and re-run conversations she had already run.
   *
   * Nothing below the control needed changing: exportScenarioToTraining has
   * always taken `tagKeys: string[]` and writes one sms_training_example_tags
   * row per key, and that join table is what loadTrainingCoverage counts. The
   * storage and the server action were already many-to-many; the picker was
   * the only thing that was not.
   *
   * sms_scenarios.tag_key (migration 195) is still a single column, so the
   * saved REPLAY test files under the first one picked. That is a different
   * artefact from a training example and one tag is the right shape for it:
   * a test is "re-run this and check the rule it was aimed at".
   */
  /**
   * Checked against the real tag list, the way example-writer already does it.
   * `?tag=` comes off a URL, and a <select> ignored a value with no matching
   * option — chips do not. An unknown key would sit in this array invisibly,
   * enable "Send to training", and fail on the foreign key at the insert.
   */
  const [tagKeys, setTagKeys] = useState<string[]>(
    initialTagKey && tags.some((t) => t.key === initialTagKey) ? [initialTagKey] : []
  );
  const [turns, setTurns] = useState<Graded[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** The run already written, so a second save edits it instead of colliding. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const [photos, setPhotos] = useState(0);
  const [track, setTrack] = useState<"new_lead" | "nurture">("new_lead");
  const [overall, setOverall] = useState<"good" | "mid" | "bad" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [known, setKnown] = useState({ name: "", phone: "", email: "", address: "", inquiryScope: "" });
  const [showKnown, setShowKnown] = useState(false);

  const filledKnown = Object.values(known).filter((v) => v.trim()).length;
  const flowStage = stageFromIntents(turns.map((t) => t.intent));

  /**
   * WHAT IS ACTUALLY HELD, WHICH IS NOT WHAT WAS ASKED FOR.
   *
   * This list ticked off from stageFromIntents, which counts the bot's own
   * past INTENTS — so asking a question ticked the box whether or not anybody
   * answered. Sending a photo, a thumbs up and a Like, saying nothing at all,
   * showed "✓ Project details".
   *
   * That matters more here than anywhere: this panel is the evidence Kate
   * reads to decide whether the flow works, and it was telling her a step was
   * done when the record was empty.
   *
   * The ORDER gate still runs on intents — that is production behaviour and
   * is what refuses an address ask before project details. This is the other
   * question: do we HOLD it.
   */
  const customerSaid = turns.map((t) => t.customerText);
  const heldScope = !!known.inquiryScope.trim()
    || customerSaid.some((t) => scopeAndStage({ stage: 0, onFile: null, rawInbound: t }).from === "customer");
  /**
   * COMPLETE, not merely present — the tick says "we actually hold it".
   *
   * This asked whether an address could be FOUND, and addressFromCustomer
   * returns partials on purpose, because A11 needs the half it has. So "zip is
   * 11530" ticked "Full address" while the bot was asking "And what's the
   * street address?" in the same view — the panel contradicting the
   * conversation two inches below it.
   *
   * A3 is explicit: "FULL ADDRESS MEANS street number + street name + zip."
   * The other three legs already test completeness rather than presence —
   * availability uses availabilityIsBookable — and this was the one that did
   * not. It matters because this panel exists to be EVIDENCE: Karan asked for
   * it after "it's not even doing this... how do I trust it", and a tick that
   * is not true is worse than no tick.
   */
  const heldAddress = addressIsComplete(known.address)
    || customerSaid.some((t) => addressIsComplete(addressFromCustomer(t)));
  const heldContact = !!known.email.trim() || !!known.phone.trim()
    || customerSaid.some((t) => /[\w.+-]+@[\w-]+\.[\w.]+/.test(t));
  const heldAvailability = customerSaid.some((t) => availabilityIsBookable(t));
  const held = [heldScope, heldAddress, heldContact, heldAvailability];
  /** The first thing still missing, which is what it should be working on. */
  const working = held.findIndex((h) => !h);
  /** In the order the rules are listed, not the order she happened to tap. */
  const pickedTags = tags.filter((t) => tagKeys.includes(t.key));
  /** The one the run is NAMED for, and the one the replay test files under. */
  const selectedTag = pickedTags[0];
  const toggleTag = (key: string) =>
    setTagKeys((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

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
    // THE GUARD HAS TO AGREE WITH THE BUTTON'S OWN disabled CHECK.
    //
    // The send button is enabled when there is a draft OR an attached photo
    // (`!draft.trim() && photos === 0`), but this read only `media`, the
    // PARAMETER, which is 0 for a plain send. So a photo with no caption gave
    // an enabled blue button that did nothing at all when clicked: no turn,
    // no error, nothing. The photos STATE is not read until further down.
    //
    // A photo with no message is not an edge case — it is how a customer asks
    // for a quote on a wall they are looking at. And this screen is the one
    // place a photo can be tested at all.
    if ((!text && media === 0 && photos === 0) || busy) return;
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
        // And the intents THEMSELVES, not only the stage they collapse to.
        // A3 is satisfied by events — what was actually asked and confirmed —
        // so the four guards that refuse a close read this list, not the
        // number. Without it the sandbox closed a conversation as booked on
        // "Weekdays are better", which production refuses: a day is not a
        // window (A4), and the estimator cannot be booked against it.
        priorIntents: turns.map((t) => t.intent).filter((i): i is string => !!i),
        lastIntent: [...turns].reverse().find((t) => t.intent)?.intent ?? undefined,
      });
      if (res.ok) { setTurns((t) => [...t, res.turn]); setDraft(""); setPhotos(0); }
    } finally { setBusy(false); }
  };

  const grade = (i: number, patch: Partial<Graded>) =>
    setTurns((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  /**
   * SAVING TWICE IS THE NORMAL THING TO DO, and it used to fail.
   *
   * Kate, first session 2026-10-06: saved, read the run back, added more to
   * "where it fell short", saved again, and got "duplicate key value violates
   * unique constraint sms_scenarios_name_key". The name was stamped to the
   * minute, so a second save inside the same minute collided — and a save a
   * minute later was worse, because it wrote a SECOND scenario and left the
   * first one on file without the feedback she had just typed.
   *
   * So the id of the saved run is held here and passed back: pressing save
   * again updates the run she is looking at. Seconds in the name as well, so
   * two DIFFERENT runs in one minute cannot collide either.
   */
  const save = async () => {
    setSaved("Saving…");
    const name = `${selectedTag?.label ?? "Scenario"} — ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
    const res = await saveScenario({
      id: savedId ?? undefined,
      // One tag, deliberately: see tagKeys above. The replay test is aimed at
      // a rule; the training example shows all of them.
      name, customerBrief: brief, tagKey: tagKeys[0] || undefined,
      workspaceId: workspaceId || undefined,
      // The three boxes explicitly, because they were silently dropped: the
      // save wrote the verdict and none of the words. "Send to training"
      // already used them, which is what made the gap invisible.
      turns: turns.map((t) => ({
        ...t,
        didWell: t.didWell,
        shortfall: t.shortfall,
        shouldHave: t.shouldHave,
      })),
    });
    if (res.ok) {
      setSavedId(res.id);
      setSaved(savedId
        ? "Updated. Your latest notes are the ones saved."
        : "Saved. It will replay after a prompt change, and you can keep editing and save again.");
    } else {
      setSaved(`Could not save: ${res.error}`);
    }
  };

  const allGraded = turns.length > 0 && turns.every((t) => t.verdict);

  /** This run in Kate's sheet shape, so both directions use one format. */
  const asSheet = (): AuditSheet => ({
    title: selectedTag ? `${selectedTag.label} — sandbox run` : "Sandbox run",
    overall,
    turns: turns.flatMap((t, i) => [
      { ordinal: i * 2 + 1, speaker: "CUSTOMER", channel: "SMS" as const, text: t.customerText },
      {
        ordinal: i * 2 + 2, speaker: "AI (Emily)", channel: "SMS" as const, text: t.message,
        didWell: t.didWell?.trim() ? { code: null, why: t.didWell.trim() } : null,
        shortfall: t.shortfall?.trim()
          ? { code: null, what: t.shortfall.trim(), shouldHave: t.shouldHave?.trim() || null }
          : null,
      },
    ]),
  });

  const sendToTraining = async () => {
    setExporting(true); setExportNote(null);
    try {
      const res = await exportScenarioToTraining({ sheet: asSheet(), tagKeys });
      setExportNote(res.ok
        // Names the rules it counted towards, because that is the question
        // somebody has after pressing it: did this teach the three things I
        // corrected, or one of them?
        ? `Sent to training as an example of ${pickedTags.map((t) => t.label).join(", ")}${res.redacted.length ? ` (redacted ${res.redacted.join(", ")})` : ""}. It is marked as a sandbox run for ever, so it can never be mistaken for a real conversation.`
        : res.error);
    } finally { setExporting(false); }
  };

  const download = async (as: "sheet" | "csv") => {
    setExporting(true); setExportNote(null);
    try {
      const res = await scenarioAsSheet({ sheet: asSheet(), as });
      if (!res.ok) { setExportNote(res.error); return; }
      const url = URL.createObjectURL(new Blob([res.body], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      setExportNote(`Downloaded ${res.filename}.`);
    } finally { setExporting(false); }
  };

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
          <label className="block">
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">Answer as</span>
            <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}
              className="w-full rounded-lg border border-ppp-charcoal-200 px-3 min-h-[44px] text-base sm:text-[13px] focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30">
              <option value="">Default settings</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <div>
            <span className="block text-[12px] font-medium text-ppp-charcoal-600 mb-1">
              Testing which rules{" "}
              <span className="font-normal text-ppp-charcoal-400">
                {tagKeys.length > 0
                  ? `(${tagKeys.length} picked — tick every one the run shows)`
                  : "(tick every one you want this run to count towards)"}
              </span>
            </span>
            {/* NO INNER SCROLL. thread-teach caps its list because it sits in a
                modal over a conversation; this one is the screen's own control,
                and a capped box turns the page scroll into a scroll TRAP — the
                wheel moves the rule list instead of the page whenever the
                pointer is over it, which is most of the panel. Worse, it takes
                the ticks you have already made out of sight. All of the rules
                fit in about five rows. */}
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const on = tagKeys.includes(t.key);
                return (
                  <button key={t.key} type="button" onClick={() => toggleTag(t.key)}
                    aria-pressed={on}
                    className={[
                      "min-h-[36px] px-2.5 rounded-lg text-[12px] font-medium border touch-manipulation",
                      on
                        ? "bg-ppp-charcoal text-white border-ppp-charcoal"
                        : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200",
                    ].join(" ")}>
                    {t.label}
                  </button>
                );
              })}
            </div>
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
                  ["phone", "Texting them on", "999-784-6046"],
                  ["email", "Email", "tom@example.com"],
                  ["address", "Address", "12 Oak St, Rockville Centre, NY 11570"],
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
              {/* Says what a tick MEANS, because it used to mean "was asked
                  for" while reading as "we have it". */}
              <p className="mt-0.5 text-[11px] text-ppp-charcoal-400">
                A tick means we actually hold it, not that it was asked for.
              </p>
              <ol className="mt-1.5 space-y-1">
                {["Project details", "Full address", "Contact information", "Appointment availability"].map((label, n) => {
                  const done = held[n];
                  const current = working === n;
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

          {/* One line per rule picked, labelled once there is more than one —
              otherwise three pieces of guidance run together into a paragraph
              nobody can tell apart. */}
          {pickedTags.length > 0 && (
            <div className="text-[12.5px] text-ppp-charcoal-600 leading-relaxed bg-ppp-charcoal-50 rounded-lg px-3 py-2 space-y-1">
              {pickedTags.map((t) => (
                <p key={t.key}>
                  {pickedTags.length > 1 && (
                    <span className="font-semibold text-ppp-charcoal">{t.label}: </span>
                  )}
                  {t.what_to_look_for}
                </p>
              ))}
            </div>
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
                  <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-[#0b76ce] text-white px-3 py-2 text-[14px] leading-snug">
                    {t.customerText}
                  </p>
                </div>

                {t.error ? (
                  <div className="rounded-xl bg-ppp-orange-50 px-3 py-2">
                    <p className="text-[12px] font-medium text-ppp-orange-700 leading-snug">{t.error}</p>
                    {t.rejected && (
                      <>
                        <p className="mt-1 text-[11px] text-ppp-orange-700/90 leading-snug">Blocked before sending: {t.rejected}</p>
                        {/*
                          BOTH REFUSALS, BECAUSE THEY MEAN DIFFERENT THINGS.
                          The turn gets one retry with the refusal fed back, so
                          a second DIFFERENT reason means the model moved and
                          still missed — the rule is probably unsatisfiable —
                          while the same reason twice means it declined the
                          instruction outright. Guessing between those is what
                          made the first draft of the dodge fix a prompt line
                          that did nothing.
                        */}
                        {t.retriedAfter && (
                          <p className="mt-1 text-[11px] text-ppp-orange-700/90 leading-snug">
                            It had already been refused once, for: {t.retriedAfter}
                          </p>
                        )}
                        {/*
                          WITHOUT THIS LINE THE SANDBOX LIES ABOUT PRODUCTION.
                          A refusal reads as the customer getting silence, and
                          it is not: scheduler-db calls handToAPerson on a
                          rejection, so the conversation lands in "Needs a
                          person" and somebody reads the thread. The
                          saysNothing case next door already said so; this one
                          did not, and it is the commoner of the two.
                        */}
                        <p className="mt-1 text-[11px] text-ppp-orange-700/90 leading-snug">
                          Live, this hands the conversation to a person rather than replying. It is not silence.
                        </p>
                        {/*
                          WHAT IT TRIED, because the reason on its own is not
                          enough to act on. "question_left_unanswered" is true
                          both when the model wrote no answer and when it wrote
                          one that a style filter deleted, and those need
                          opposite fixes — two changes were shipped guessing
                          between them before this line existed. A grader needs
                          it for the same reason: you cannot say what the bot
                          should have said instead without seeing what it said.
                        */}
                        {t.attempted && (
                          <p className="mt-1 text-[11px] text-ppp-orange-700/90 leading-snug">
                            It chose <span className="font-mono">{t.attempted.intent}</span>
                            {t.attempted.freeText
                              ? <> and wrote: “{t.attempted.freeText}”</>
                              : <> and wrote nothing alongside it.</>}
                          </p>
                        )}
                      </>
                    )}
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
                      {/*
                        A TURN THE RETRY RESCUED. Without it this reply would
                        not exist and the conversation would have gone to a
                        person here, so it is worth seeing while grading: a
                        reply that needed two goes is a rule the model keeps
                        getting wrong, even though the customer saw something
                        correct.
                      */}
                      {t.retriedAfter && (
                        <span
                          title={t.retriedAfter}
                          className="rounded-full bg-ppp-charcoal-50 px-1.5 py-0.5 text-[9.5px] font-medium text-ppp-charcoal-500">
                          took two tries
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

                {(t.showNote || t.verdictNote !== undefined || t.didWell || t.shortfall) && (
                  <div className="space-y-1.5">
                    <label className="block">
                      <span className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                        What it got right
                      </span>
                      <textarea
                        value={t.didWell ?? ""}
                        onChange={(e) => grade(i, { didWell: e.target.value })}
                        rows={2}
                        placeholder="Offsite fired straight away when they asked the price"
                        className="mt-0.5 w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-base sm:text-[12px] placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
                      />
                    </label>
                    <label className="block">
                      <span className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                        Where it fell short
                      </span>
                      <textarea
                        value={t.shortfall ?? ""}
                        onChange={(e) => grade(i, { shortfall: e.target.value })}
                        rows={2}
                        placeholder="Said the same thing twice in one sentence"
                        className="mt-0.5 w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-base sm:text-[12px] placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
                      />
                    </label>
                    {(t.shortfall ?? "").trim() && (
                      <label className="block">
                        <span className="block text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                          Should have
                        </span>
                        <textarea
                          value={t.shouldHave ?? ""}
                          onChange={(e) => grade(i, { shouldHave: e.target.value })}
                          rows={2}
                          placeholder="kept it short and natural"
                          className="mt-0.5 w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-base sm:text-[12px] placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-orange-500/30"
                        />
                        <span className="mt-0.5 block text-[10.5px] text-ppp-charcoal-400 leading-snug">
                          The most useful thing on the sheet. A correction teaches;
                          a complaint only marks something as bad.
                        </span>
                      </label>
                    )}
                  </div>
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
                  "h-11 sm:h-8 px-2.5 rounded-lg text-[11px] font-medium touch-manipulation disabled:opacity-40",
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
              className="flex-1 min-w-0 rounded-full border border-ppp-charcoal-200 px-3.5 min-h-[38px] text-base sm:text-[14px] placeholder:text-ppp-charcoal-400 focus:outline-none focus:ring-2 focus:ring-[#0b76ce]/30 disabled:bg-ppp-charcoal-50" />
            <button type="button" onClick={() => void send()} disabled={busy || (!draft.trim() && photos === 0)}
              aria-label="Send as the customer"
              className="shrink-0 h-[38px] w-[38px] rounded-full bg-[#0b76ce] text-white flex items-center justify-center touch-manipulation disabled:bg-ppp-charcoal-200 min-h-[44px] sm:min-h-0">
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
          {/* The label says which of the two things pressing it does, because
              the first time Kate pressed it she could not tell whether it had
              worked — the panel stays open by design so she can keep editing,
              and nothing on screen said so. */}
          <button type="button" onClick={() => void save()} disabled={!allGraded}
            className="mt-2.5 min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold touch-manipulation disabled:bg-ppp-charcoal-200 disabled:text-ppp-charcoal-500">
            {savedId ? "Save changes" : "Save as a test"}
          </button>
          {!allGraded && <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-500">Grade every reply first.</p>}
          {saved && (
            <p className={`mt-1.5 text-[12px] ${
              saved.startsWith("Could not save")
                ? "text-ppp-orange-700 font-medium"
                : "text-ppp-charcoal-600"
            }`}>
              {saved}
            </p>
          )}
          {/* THE PANEL STAYING OPEN IS DELIBERATE, so say so once it has been
              saved rather than leaving somebody wondering whether to press it
              again. Her words: "I clicked save as a test, but this feedback
              window is still open." */}
          {savedId && (
            <p className="mt-1 text-[11.5px] text-ppp-charcoal-500">
              This stays open on purpose — keep adding notes and press Save changes
              again, as often as you like. Nothing is sent to the customer from
              this screen.
            </p>
          )}

          {/* Karan's idea, and it resolves the tension rather than ignoring it.
              Migration 195 forbids a sandbox run SILENTLY becoming training
              data. An explicit export is a different act: a person read it and
              decided. Marked as simulated for ever either way. */}
          <div className="mt-4 pt-3 border-t border-ppp-charcoal-100">
            <p className="text-[12px] font-medium text-ppp-charcoal-600">How did the whole thing go?</p>
            <div className="mt-1.5 flex gap-1.5">
              {([["good", "Good"], ["mid", "Mid"], ["bad", "Bad"]] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setOverall(v)} aria-pressed={overall === v}
                  className={[
                    "min-h-[40px] px-3 rounded-lg text-[12.5px] font-medium border touch-manipulation",
                    overall === v ? "bg-ppp-charcoal text-white border-ppp-charcoal" : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-600",
                  ].join(" ")}>
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" onClick={() => void sendToTraining()} disabled={exporting || !overall || tagKeys.length === 0}
                className="min-h-[44px] px-4 rounded-xl bg-ppp-charcoal text-white text-[13px] font-semibold disabled:opacity-40 touch-manipulation">
                {exporting ? "Working…" : "Send to training"}
              </button>
              <button type="button" onClick={() => void download("sheet")} disabled={exporting}
                className="min-h-[44px] px-3 rounded-xl border border-ppp-charcoal-200 bg-white text-[12.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
                Download as a sheet
              </button>
              <button type="button" onClick={() => void download("csv")} disabled={exporting}
                className="min-h-[44px] px-3 rounded-xl border border-ppp-charcoal-200 bg-white text-[12.5px] font-semibold text-ppp-charcoal-600 touch-manipulation">
                CSV
              </button>
            </div>
            {(!overall || tagKeys.length === 0) && (
              <p className="mt-1.5 text-[11.5px] text-ppp-charcoal-500 leading-snug">
                {!overall && "Say how it went"}{!overall && tagKeys.length === 0 && ", and "}
                {tagKeys.length === 0 && "tick every rule it shows at the top"}{" "}
                before sending it to training — an untagged example counts
                towards the total and teaches none of Emily&apos;s rules, and a
                rule you corrected but did not tick stays on the list of
                untested ones.
              </p>
            )}
            {exportNote && <p className="mt-1.5 text-[12px] text-ppp-charcoal-600 leading-relaxed">{exportNote}</p>}
            <p className="mt-2 text-[11px] text-ppp-charcoal-400 leading-snug">
              Downloads use Kate&apos;s audit sheet layout, so a run from here and
              a conversation she audited are the same shape.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
