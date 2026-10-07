import { describe, it, expect } from "vitest";
import { selectExamples, examplesPrompt, relevantTags, situationFrom, type CorpusExample } from "@/lib/messaging/retrieval";
import { buildSystemPrompt, type AgentConfigForRun } from "@/lib/messaging/agent-run";
import { normalizeInbound } from "@/lib/messaging/inbound-normalize";

const ex = (o: Partial<CorpusExample>): CorpusExample => ({
  id: "1", transcript: "Customer: hi\nEmily: what are you looking to have painted?",
  conduct: "good", approved: true, piiScrubbed: true, note: null, tags: ["flow_details"], ...o,
});

describe("choosing which examples the model sees", () => {
  /** The rule that cannot bend. */
  it("never offers an unscrubbed transcript, however relevant", () => {
    const sel = selectExamples([ex({ piiScrubbed: false })], { stage: 0 });
    expect(sel.good).toHaveLength(0);
    expect(sel.bad).toHaveLength(0);
  });

  it("only imitates examples a person approved", () => {
    const sel = selectExamples([ex({ approved: false })], { stage: 0 });
    expect(sel.good).toHaveLength(0);
  });

  /**
   * Bad examples do NOT need approval. `approved` means "safe to copy" and a
   * bad one is never copied — requiring it would make Kate's four graded
   * conversations, all bad or mixed, unable to teach anything.
   */
  it("still learns from a bad example nobody approved", () => {
    const sel = selectExamples([ex({ conduct: "bad", approved: false })], { stage: 0 });
    expect(sel.bad).toHaveLength(1);
    expect(sel.good).toHaveLength(0);
  });

  it("treats a mixed conversation as something to avoid, not to copy", () => {
    const sel = selectExamples([ex({ conduct: "mixed", approved: true })], { stage: 0 });
    expect(sel.good).toHaveLength(0);
    expect(sel.bad).toHaveLength(1);
  });

  /**
   * This used to assert the opposite — that an example matching nothing was
   * excluded — and that assertion was the bug written down. Excluding them
   * meant thirteen of the twenty-five tags could never reach the model at all.
   * Irrelevant examples are now RANKED LAST, not dropped.
   */
  it("ranks an unrelated example last rather than dropping it", () => {
    const sel = selectExamples([
      ex({ id: "unrelated", tags: ["handled_language"] }),
      ex({ id: "relevant", tags: ["flow_details"] }),
    ], { stage: 0 });
    expect(sel.good.map((e) => e.id)).toEqual(["relevant", "unrelated"]);
  });

  it("picks the rule that is live at this step of the flow", () => {
    expect(relevantTags({ stage: 1 })).toContain("flow_address");
    expect(relevantTags({ stage: 1 })).not.toContain("flow_availability");
    expect(relevantTags({ stage: 3 })).toContain("flow_availability");
  });

  it("always cares about price, scope and one-question-at-a-time", () => {
    for (const t of ["price_refused", "scope_refused", "one_question"]) {
      expect(relevantTags({ stage: 2 })).toContain(t);
    }
  });

  it("asks for photo handling only when a photo arrived", () => {
    expect(relevantTags({ stage: 0 })).not.toContain("handled_photo");
    expect(relevantTags({ stage: 0, mediaCount: 1 })).toContain("handled_photo");
  });

  it("does not ask for collection rules on the nurture track", () => {
    const tags = relevantTags({ stage: 1, track: "nurture" });
    expect(tags).not.toContain("flow_address");
    expect(tags).toContain("price_refused");
  });

  it("prefers the more relevant example", () => {
    const sel = selectExamples([
      ex({ id: "a", tags: ["flow_details"] }),
      ex({ id: "b", tags: ["flow_details", "one_question", "price_refused"] }),
    ], { stage: 0 }, { maxGood: 1 });
    expect(sel.good[0].id).toBe("b");
  });

  it("prefers an example that carries a reason", () => {
    const sel = selectExamples([
      ex({ id: "a", note: null }),
      ex({ id: "b", note: "asked one thing at a time" }),
    ], { stage: 0 }, { maxGood: 1 });
    expect(sel.good[0].id).toBe("b");
  });

  it("obeys the count limits", () => {
    const many = Array.from({ length: 10 }, (_, i) => ex({ id: `g${i}` }));
    const sel = selectExamples(many, { stage: 0 }, { maxGood: 2 });
    expect(sel.good).toHaveLength(2);
  });

  /** A prompt that grows without bound costs latency on every single turn. */
  it("obeys the character budget across good and bad together", () => {
    const big = (id: string, conduct: CorpusExample["conduct"]) =>
      ex({ id, conduct, approved: conduct === "good", transcript: "x".repeat(3000) });
    const sel = selectExamples(
      [big("g1", "good"), big("g2", "good"), big("b1", "bad")],
      { stage: 0 }, { maxChars: 4000 }
    );
    const total = [...sel.good, ...sel.bad].reduce((n, e) => n + e.transcript.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
  });

  it("spends the budget on good examples first", () => {
    const sel = selectExamples([
      ex({ id: "g", transcript: "x".repeat(900) }),
      ex({ id: "b", conduct: "bad", approved: false, transcript: "y".repeat(900) }),
    ], { stage: 0 }, { maxChars: 1000 });
    expect(sel.good).toHaveLength(1);
    expect(sel.bad).toHaveLength(0);
  });
});

describe("what the model is actually told", () => {
  it("labels mistakes as things to avoid, never as examples to follow", () => {
    const p = examplesPrompt({
      good: [],
      bad: [ex({ conduct: "bad", approved: false, note: "quoted a price over text" })],
    });
    expect(p).toMatch(/Do NOT copy/);
    expect(p).toContain("quoted a price over text");
    expect(p).not.toMatch(/Follow the shape/);
  });

  it("keeps good and bad in separate, differently worded sections", () => {
    const p = examplesPrompt({ good: [ex({})], bad: [ex({ id: "2", conduct: "bad", approved: false })] });
    expect(p).toMatch(/Follow the shape of these/);
    expect(p).toMatch(/Do NOT copy/);
    expect(p.indexOf("Follow the shape")).toBeLessThan(p.indexOf("Do NOT copy"));
  });

  /** With an empty corpus the prompt must be what it was before retrieval. */
  it("adds nothing at all when there is nothing to show", () => {
    expect(examplesPrompt({ good: [], bad: [] })).toBe("");
  });

  it("does not leave an empty heading in the system prompt", () => {
    const cfg: AgentConfigForRun = {
      persona_name: "Emily", persona_role: "assistant",
      required_flow: ["project_details"], services_included: null, services_excluded: null,
      offsite_rules: null, tone_rules: null, office_location: null,
      service_area_note: null, confidence_threshold: 0.95,
    };
    const withNone = buildSystemPrompt(cfg, [], "new_lead", {}, { good: [], bad: [] });
    expect(withNone).not.toMatch(/HOW THIS HAS BEEN DONE WELL/);
    expect(withNone).not.toMatch(/MISTAKES THAT HAVE/);
  });

  it("puts the examples into the prompt when there are some", () => {
    const cfg: AgentConfigForRun = {
      persona_name: "Emily", persona_role: "assistant",
      required_flow: ["project_details"], services_included: null, services_excluded: null,
      offsite_rules: null, tone_rules: null, office_location: null,
      service_area_note: null, confidence_threshold: 0.95,
    };
    const p = buildSystemPrompt(cfg, [], "new_lead", {}, { good: [ex({})], bad: [] });
    expect(p).toMatch(/HOW THIS HAS BEEN DONE WELL/);
    expect(p).toContain("what are you looking to have painted?");
  });
});

/**
 * Relevance is scored on tags, so an example whose tags never come up in any
 * detectable situation was invisible for ever: graded, counted as covered on
 * the training page, and never once shown to the model. Thirteen of the
 * twenty-five tags were in that state — including every awkward-situation one,
 * which is exactly the material Kate is being asked to send.
 */
describe("no example is permanently invisible", () => {
  const ex2 = (o: Partial<CorpusExample>): CorpusExample => ({
    id: "x", transcript: "Customer: hi\nEmily: hello",
    conduct: "good", approved: true, piiScrubbed: true, note: null, tags: [], ...o,
  });

  it("shows a good example even when nothing about it matches the situation", () => {
    const sel = selectExamples([ex2({ tags: ["handled_language"] })], { stage: 0 });
    expect(sel.good).toHaveLength(1);
  });

  it("shows a graded mistake that matches nothing either", () => {
    const sel = selectExamples(
      [ex2({ conduct: "bad", approved: false, tags: ["handled_multi_property"] })],
      { stage: 0 }
    );
    expect(sel.bad).toHaveLength(1);
  });

  it("still prefers a relevant example over an irrelevant one", () => {
    const sel = selectExamples([
      ex2({ id: "far", tags: ["handled_language"] }),
      ex2({ id: "near", tags: ["flow_details", "one_question"] }),
    ], { stage: 0 }, { maxGood: 1 });
    expect(sel.good[0].id).toBe("near");
  });

  it("does not let the fallback smuggle in an unapproved good example", () => {
    const sel = selectExamples([ex2({ approved: false, tags: ["handled_language"] })], { stage: 0 });
    expect(sel.good).toHaveLength(0);
  });

  it("does not let the fallback smuggle in an unscrubbed one", () => {
    const sel = selectExamples([ex2({ piiScrubbed: false, tags: ["handled_language"] })], { stage: 0 });
    expect(sel.good).toHaveLength(0);
    expect(sel.bad).toHaveLength(0);
  });

  it("still respects the character budget when topping up", () => {
    const big = Array.from({ length: 5 }, (_, i) =>
      ex2({ id: `b${i}`, tags: ["handled_language"], transcript: "x".repeat(3000) }));
    const sel = selectExamples(big, { stage: 0 }, { maxChars: 4000 });
    const total = sel.good.reduce((n, e) => n + e.transcript.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
  });
});

describe("reading the situation out of the message", () => {
  it("spots someone asking whether they are talking to a machine", () => {
    expect(relevantTags({ stage: 0, ...situationFrom("wait, is this a bot?") })).toContain("handled_bot_q");
  });

  it("spots a request to be phoned", () => {
    expect(relevantTags({ stage: 0, ...situationFrom("can you call me instead") })).toContain("handled_callback");
  });

  it("spots someone asking whether we cover them", () => {
    expect(relevantTags({ stage: 0, ...situationFrom("do you cover Nassau?") })).toContain("area_checked");
  });

  it("spots someone who only wants a number", () => {
    const tags = relevantTags({ stage: 0, ...situationFrom("just after a ballpark price") });
    expect(tags).toContain("offsite_required");
  });

  it("brings up handling a negative reaction when one happens", () => {
    expect(relevantTags({ stage: 0, isNegative: true })).toContain("handled_negative");
  });

  it("does not fire on ordinary messages", () => {
    const tags = relevantTags({ stage: 0, ...situationFrom("I want my kitchen painted") });
    for (const t of ["handled_bot_q", "handled_callback", "area_checked", "handled_negative"]) {
      expect(tags, t).not.toContain(t);
    }
  });

  it("treats tone and endings as relevant on every turn", () => {
    const tags = relevantTags({ stage: 2 });
    for (const t of ["natural_voice", "brief_ack", "no_invented_time", "ended_correctly"]) {
      expect(tags, t).toContain(t);
    }
  });
});

/**
 * An iPhone reaction arrives as `Liked "<our message>"`. Scanning the raw
 * string reads OUR sentence and attributes it to the customer.
 */
describe("situations are read from the customer's words, not ours", () => {
  const scan = (raw: string) => {
    const n = normalizeInbound(raw, 0);
    return situationFrom(n.text ?? (n.kind === "text" ? raw : ""), {});
  };

  it("does not attribute our own words to the customer", () => {
    // We asked "are you a real person" — they only liked it.
    const s = scan('Liked "Are you a real person we should speak to, and how much of the house?"');
    expect(s.asksIfBot).toBe(false);
    expect(s.wantsQuoteOnly).toBe(false);
  });

  it("still hears the customer when they genuinely ask", () => {
    expect(scan("wait, are you a bot?").asksIfBot).toBe(true);
    expect(scan("can you call me back").asksForCall).toBe(true);
    expect(scan("just after a rough price").wantsQuoteOnly).toBe(true);
  });

  it("reads the words when a reaction carries some of their own", () => {
    const s = scan('Liked "the quote" — can you call me about it');
    expect(s.asksForCall).toBe(true);
  });

  it("stays quiet on an ordinary message", () => {
    const s = scan("I want the kitchen and hallway done");
    expect(Object.values(s).every((v) => !v)).toBe(true);
  });
});

/**
 * Migration 195's worry was that training on invented customers teaches the
 * bot to handle an imagination. Exported sandbox runs are allowed — somebody
 * read them and decided — but they sorted identically to real conversations,
 * so a handful of exports could crowd out actual customer ones.
 */
describe("a real conversation outranks a simulated one", () => {
  const e = (o: Partial<CorpusExample>): CorpusExample => ({
    id: "x", transcript: "Customer: hi\nEmily: hello",
    conduct: "good", approved: true, piiScrubbed: true, note: null,
    tags: ["flow_details"], ...o,
  });

  it("puts the real one first at equal relevance", () => {
    const sel = selectExamples([
      e({ id: "sim", source: "simulated" }),
      e({ id: "real", source: "hatch" }),
    ], { stage: 0 }, { maxGood: 2 });
    expect(sel.good.map((x) => x.id)).toEqual(["real", "sim"]);
  });

  it("still uses a simulated one when it is the only thing that fits", () => {
    const sel = selectExamples([e({ id: "sim", source: "simulated" })], { stage: 0 });
    expect(sel.good.map((x) => x.id)).toEqual(["sim"]);
  });

  it("does not let a simulated example win on relevance alone being equal", () => {
    // Relevance still comes first — a far more relevant simulated example
    // beats a barely relevant real one, which is the right order.
    const sel = selectExamples([
      e({ id: "sim", source: "simulated", tags: ["flow_details", "one_question", "price_refused"] }),
      e({ id: "real", source: "hatch", tags: ["flow_details"] }),
    ], { stage: 0 }, { maxGood: 1 });
    expect(sel.good[0].id).toBe("sim");
  });

  it("treats an example with no source recorded as real", () => {
    const sel = selectExamples([
      e({ id: "unknown", source: null }),
      e({ id: "sim", source: "simulated" }),
    ], { stage: 0 }, { maxGood: 2 });
    expect(sel.good[0].id).toBe("unknown");
  });
});

/**
 * A REPAIR'S NOTE IS NOT A REASON IT IS GOOD.
 *
 * Found 2026-10-06 by printing the prompt the live bot actually receives —
 * not by a test, and not by driving the chatbot, which is how it survived
 * three days of scenario testing. It opened:
 *
 *   Good example 1:
 *   Why it is good: T2: Asked for the full address including the zip code
 *   while already holding 07920. It made the customer retype what we had...
 *
 * A defect, under a heading saying it is why the example is good. The data is
 * right — `derived` examples are repairs and repairNote writes "what was wrong
 * … Was: … Now: …" — and the heading was putting the wrong frame on it.
 *
 * Of the twelve approved good examples carrying a note in production, eight
 * are repairs, several of them describing an address asked for twice: A11, the
 * most breached rule in the corpus. The lesson being reinforced under "good"
 * was the commonest mistake in the dataset.
 */
describe("a corrected example is labelled as a correction", () => {
  const repair = (o: Partial<CorpusExample> = {}): CorpusExample => ({
    id: "r1", source: "derived",
    transcript: "Customer: hi\nEmily: what are you looking to have painted?",
    conduct: "good", approved: true, piiScrubbed: true,
    note: 'T2 [A11]: Asked for the full address while already holding the zip. Was: "full address?" Now: "what is the zip there?"',
    tags: ["flow_details"], ...o,
  });

  it("does not call the defect a reason it is good", () => {
    const out = examplesPrompt({ good: [repair()], bad: [] });
    expect(out).not.toMatch(/Why it is good: T2 \[A11\]/);
  });

  it("says plainly that it is a corrected version", () => {
    const out = examplesPrompt({ good: [repair()], bad: [] });
    expect(out).toMatch(/CORRECTED version/);
    // The note itself is unchanged — only the frame around it.
    expect(out).toContain("Asked for the full address while already holding the zip");
  });

  /** An ordinary approved conversation keeps the plain heading. */
  it("leaves a real approved example alone", () => {
    const out = examplesPrompt({
      good: [repair({ id: "h1", source: "hatch", note: "asked one thing at a time" })],
      bad: [],
    });
    expect(out).toMatch(/Why it is good: asked one thing at a time/);
    expect(out).not.toMatch(/CORRECTED/);
  });

  it("still says nothing extra when a repair carries no note", () => {
    const out = examplesPrompt({ good: [repair({ note: null })], bad: [] });
    expect(out).not.toMatch(/CORRECTED/);
    expect(out).not.toMatch(/Why it is good/);
  });
});

/**
 * THE SITUATION REACHED THE SANDBOX AND NOT PRODUCTION.
 *
 * scheduler-db called selectExamples(corpus, { stage }); the simulator also
 * passed the situation — photo, reaction, "are you a bot", callback, service
 * area, price-only. Selection keeps only examples scoring above zero against
 * the context it is handed, so in every REAL conversation those tags matched
 * nothing and the examples Kate graded for them were filtered out before the
 * prompt was built. The model has never seen one.
 *
 * It is the parity bug this codebase keeps having, with the sides swapped: the
 * sandbox was the richer of the two, so grading looked better than production
 * behaved. simulator-parity.test.ts compares the option KEYS at each call site
 * and both said `examples:`, so it stayed green the whole time.
 *
 * Fixed structurally — runAgentTurn reads the situation off the inbound
 * message it has already normalised, and both callers now hand it the corpus —
 * so these assert the behaviour that made it matter.
 */
describe("the situation decides which examples are offered", () => {
  /**
   * A REALISTIC CORPUS, because the top-up is what hides this.
   *
   * With two examples and three slots everything is offered and the test
   * proves nothing. The live corpus is ~1,294 examples for three good slots,
   * so an example that scores zero reaches the model only if the stage-matched
   * ones have not already filled the budget — which they always have. That is
   * the real harm: not filtered out, crowded out, which looks identical from
   * the model's side and is invisible from the training page.
   */
  const photo = ex({ id: "photo", tags: ["handled_photo"] });
  const filler = Array.from({ length: 6 }, (_, i) =>
    ex({ id: `flow${i}`, tags: ["flow_details"] }));
  const corpus = [...filler, photo];

  it("is crowded out when nothing says a photo arrived", () => {
    const sel = selectExamples(corpus, { stage: 0 });
    expect(sel.good.map((e) => e.id)).not.toContain("photo");
  });

  it("is chosen first when the message carries one", () => {
    const sel = selectExamples(corpus, { stage: 0, ...situationFrom("", { mediaCount: 2 }) });
    expect(sel.good[0].id).toBe("photo");
  });

  it("the same holds for asking whether it is a bot", () => {
    const bot = ex({ id: "bot", tags: ["handled_bot_q"] });
    const withBot = [...filler, bot];
    expect(selectExamples(withBot, { stage: 0 }).good.map((e) => e.id)).not.toContain("bot");
    expect(selectExamples(withBot, { stage: 0, ...situationFrom("wait, am I talking to a bot?") }).good[0].id).toBe("bot");
  });
});
