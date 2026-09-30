/**
 * Hatch parity gap 9 — the standing answers a workspace holds.
 *
 * These are BOT-FACING: the whole point is that the bot answers from them.
 * That makes the knowledge base a second place a sentence can reach a
 * customer from, so the content is subject to the same rules as anything else
 * the bot says — and two of them can be broken by the CONTENT rather than by
 * the reply.
 */
import { describe, it, expect } from "vitest";
import { checkFaq, usableFaqs, faqsForPrompt } from "@/lib/messaging/workspace-faq";
import { buildSystemPrompt } from "@/lib/messaging/agent-run";

const ok = (question: string, answer: string) => ({ question, answer });

describe("an answer that is safe to say", () => {
  it("passes a real one from Hatch", () => {
    expect(checkFaq(ok("Are you insured?", "Yes, we are fully licensed and insured."))).toEqual([]);
    expect(checkFaq(ok("Where are you located?", "We serve the majority of the greater Los Angeles and Orange County area."))).toEqual([]);
  });
});

describe("A1 — an answer may never carry a price", () => {
  /**
   * The failure this prevents is subtle: an FAQ with a number in it LAUNDERS
   * a quote. The validator sees a model that answered a question, not one
   * that invented a price, because the price was handed to it.
   */
  for (const a of [
    "It usually runs $2,500 for a room that size.",
    "Most interiors are 800 to 1200 dollars.",
    "We charge per square foot, about $4",
    "Expect around 3000 USD.",
  ]) {
    it(`refuses ${JSON.stringify(a.slice(0, 34))}…`, () => {
      const problems = checkFaq(ok("how much will this cost", a));
      expect(problems.some((p) => p.why.includes("price"))).toBe(true);
    });
  }

  it("allows an answer that declines to give one", () => {
    expect(checkFaq(ok(
      "how much will this cost",
      "Pricing is something our estimator goes over with you directly after seeing the space."
    ))).toEqual([]);
  });

  it("does not trip on an ordinary number", () => {
    // A warranty length and a phone number are not prices.
    expect(checkFaq(ok("Do you warranty the work?", "Yes, we stand behind our work with a 2 year warranty."))).toEqual([]);
    expect(checkFaq(ok("What is your number?", "You can reach us on 877-645-3563."))).toEqual([]);
  });
});

describe("A18 — an answer may never name somebody else", () => {
  for (const a of [
    "We don't do that, but you could try another company.",
    "That isn't us, try calling a different contractor.",
    "We'd recommend another painter for flooring.",
  ]) {
    it(`refuses ${JSON.stringify(a.slice(0, 34))}…`, () => {
      const problems = checkFaq(ok("do you do flooring", a));
      expect(problems.some((p) => p.why.includes("another company"))).toBe(true);
    });
  }

  it("allows saying what we do not cover and stopping there", () => {
    expect(checkFaq(ok("do you do roofing", "That isn't something we take on. We cover interior and exterior painting, cabinets and drywall."))).toEqual([]);
  });
});

describe("an answer is a text message, not a document", () => {
  it("refuses something enormous", () => {
    const problems = checkFaq(ok("tell me everything", "x".repeat(700)));
    expect(problems.some((p) => p.why.includes("text message"))).toBe(true);
  });

  it("refuses a blank one", () => {
    expect(checkFaq(ok("q", "   ")).some((p) => p.field === "answer")).toBe(true);
    expect(checkFaq(ok("  ", "a")).some((p) => p.field === "question")).toBe(true);
  });

  it("reports every problem at once, not just the first", () => {
    const problems = checkFaq(ok("cost", "It's about $3,000, or try another company."));
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a bad row never reaches the prompt", () => {
  it("is dropped, and reported", () => {
    const { usable, rejected } = usableFaqs([
      ok("Are you insured?", "Yes, fully licensed and insured."),
      ok("how much", "About $2,500."),
    ]);
    expect(usable).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].problems[0].why).toMatch(/price/);
  });

  it("and the prompt carries only what survived", () => {
    const out = faqsForPrompt([
      ok("Are you insured?", "Yes, fully licensed and insured."),
      ok("how much", "About $2,500."),
    ]);
    expect(out).toContain("Are you insured?");
    expect(out).not.toContain("$2,500");
  });
});

describe("the prompt section", () => {
  it("is empty when the workspace has none", () => {
    // A workspace with no knowledge base behaves exactly as it does today,
    // rather than getting a heading over nothing.
    expect(faqsForPrompt([])).toBe("");
  });

  /**
   * The framing matters as much as the content. Without this a model treats
   * a knowledge base as a script and starts volunteering answers nobody
   * asked for — a second ask in disguise (A22) that pulls the conversation
   * off the required flow.
   */
  it("says only when asked, and not to volunteer", () => {
    const out = faqsForPrompt([ok("Are you insured?", "Yes.")]);
    expect(out).toMatch(/ONLY WHEN ASKED/);
    expect(out).toMatch(/Do not volunteer/);
    expect(out).toMatch(/second ask in disguise/);
  });

  it("tells it to say it will find out rather than guess", () => {
    expect(faqsForPrompt([ok("q", "a")])).toMatch(/find out rather than guessing/);
  });

  it("renders each pair once, in order", () => {
    const out = faqsForPrompt([ok("First?", "One."), ok("Second?", "Two.")]);
    expect(out.indexOf("First?")).toBeLessThan(out.indexOf("Second?"));
    expect(out.match(/Q: /g)).toHaveLength(2);
  });
});

/**
 * THE INSTRUCTION NOT TO GUESS MUST NOT DEPEND ON THE FAQ TABLE.
 *
 * "If nothing here covers it, say you will find out rather than guessing"
 * lived inside faqsForPrompt, which returns "" when a workspace has no FAQs —
 * which is EVERY workspace today. So the one instruction that stops the model
 * inventing PPP's business shipped only with the feature meant to make it
 * unnecessary.
 *
 * Asked in the simulator, against the empty table:
 *
 *   customer  "before I go further, are you licensed and insured? and do you
 *              have a minimum job size?"
 *   BOT       "Yes, we're fully licensed and insured, and there's no minimum
 *              job size."
 *
 * A business policy, invented. "Do you have a minimum?" is one of the answers
 * Hatch curates precisely because it is real and varies.
 */
describe("the model is told what it does not know, FAQs or not", () => {
  const cfg = {
    persona_name: "Emily", persona_role: "an estimator coordinator",
    required_flow: ["project details", "full address", "contact information", "appointment availability"],
    services_included: "Interior and exterior painting.", services_excluded: "Anything that is not painting.",
    offsite_rules: null, tone_rules: null, office_location: null,
    service_area_note: null, confidence_threshold: 0.95,
  };

  it("says so even when the workspace has no FAQs at all", () => {
    const prompt = buildSystemPrompt(cfg, [], "new_lead");
    expect(prompt).toMatch(/WHAT YOU DO NOT KNOW/);
    expect(prompt).toMatch(/find out rather than answering/i);
  });

  it("names the facts it would otherwise guess", () => {
    const prompt = buildSystemPrompt(cfg, [], "new_lead");
    for (const fact of [/insured/i, /minimum job size/i, /warrant/i, /payment terms/i]) {
      expect(prompt, String(fact)).toMatch(fact);
    }
  });

  it("is there on the nurture track too", () => {
    expect(buildSystemPrompt(cfg, [], "nurture")).toMatch(/WHAT YOU DO NOT KNOW/);
  });

  it("and the FAQ section still adds its own version when there ARE answers", () => {
    expect(faqsForPrompt([{ question: "Are you insured?", answer: "Yes, fully licensed and insured." }]))
      .toMatch(/find out rather than guessing/i);
  });
});

/**
 * ── THE ONE HAZARD THE SHARED TIER OPENS ────────────────────────────────
 *
 * The original migration refused to let anything inherit, in these words:
 * "'Where are you located?' is 'the greater Los Angeles and Orange County
 * area' on CA LA Leads and something else entirely in Nassau... A single list
 * would make the bot confidently wrong about geography."
 *
 * That is still true. The shared tier exists because MOST answers are not
 * like that — insurance, EPA, warranty and payment terms are company policy —
 * and isLocationBound is the line between the two.
 *
 * The check is over-eager on purpose. A question wrongly refused from the
 * shared tier is written per workspace, which is what happens today, so the
 * false positive costs nothing new. A geographic answer wrongly shared is the
 * bot stating the wrong service area as fact in fourteen regions, and nothing
 * downstream can catch it: the validator sees a question answered well.
 */
describe("what may be shared across workspaces", () => {
  const shared = (question: string) =>
    checkFaq({ question, answer: "Sure thing.", shared: true });
  const local = (question: string) =>
    checkFaq({ question, answer: "Sure thing.", shared: false });

  const GEOGRAPHIC = [
    "Where are you located?",
    "Are you local?",
    "What zips do you cover?",
    "What areas do you serve?",
    "Do you serve Nassau County?",
    "Where is your office?",
    "Do you travel to Brooklyn?",
    "How far do you go?",
    "Is there anyone nearby?",
  ];

  it.each(GEOGRAPHIC)("refuses %j from the shared tier", (q) => {
    const problems = shared(q);
    expect(problems.some((p) => p.field === "question"), q).toBe(true);
    expect(problems.map((p) => p.why).join(" ")).toMatch(/depends on where the workspace is/i);
  });

  it.each(GEOGRAPHIC)("still allows %j for a single workspace", (q) => {
    expect(local(q), q).toEqual([]);
  });

  /**
   * The false positives that would actually hurt. These are company policy,
   * identical in every region, and they are the whole reason the tier exists
   * — blocking them would push shared content back into duplication for no
   * safety gain. "serve" and "cover" are deliberately NOT trigger words.
   */
  /**
   * THE QUESTION CHECK IS LOOSER THAN IT WAS, ON PURPOSE.
   *
   * These trip nothing in the question. They are safe to loosen only because
   * the ANSWER is checked too, and a genuinely regional answer to any of them
   * names a place. The two halves compose; neither is sufficient alone.
   */
  it.each([
    ["Do you work in the city?", "Yes, all five boroughs."],
    ["Do you offer office painting?", "Yes, we paint offices in our service area."],
    ["Do you do exterior work?", "Yes - we cover the greater Los Angeles region."],
    ["Do you offer free estimates?", "Yes, anywhere in Nassau County."],
  ])("catches %j through its ANSWER when the question reads as global", (q, a) => {
    const problems = checkFaq({ question: q, answer: a, shared: true });
    expect(problems.some((p) => p.field === "answer"), q).toBe(true);
  });

  it("names the word that flagged it, in the message", () => {
    // Without this a false positive reads as broken software rather than as
    // an over-matched word somebody can see and work around.
    const [problem] = checkFaq({
      question: "Do you use water-based paint?", answer: "Yes, in Nassau County.", shared: true,
    });
    expect(problem.why).toMatch(/"County"/i);
    expect(problem.why).toMatch(/This workspace only/i);
  });

  it.each([
    "Are you insured?",
    "Do you follow EPA lead-safe practices?",
    "What are your payment terms?",
    "What does the warranty cover?",
    "Do you have a minimum job size?",
    "Do you serve commercial properties?",
    "Do you cover wallpaper removal?",
    "Can you provide references?",
    // Every one of these was REFUSED before the pattern was tightened, and
    // every one is a single sentence that reads the same in all 32 regions.
    // The old comment claimed a false positive "costs nothing new"; it costs
    // the whole saving, thirty-two times, which is the entire feature.
    "What is the minimum area you will do?",
    "Do you offer office painting?",
    "Can you paint a whole town house?",
    "How far in advance do I need to book?",
    "How far out are you scheduling?",
    "Do you use water-based or oil-based paint?",
    "Do you count the trim as a separate area?",
    "Do you paint city buildings?",
  ])("allows %j to be shared", (q) => {
    expect(shared(q), q).toEqual([]);
  });

  it("checks the shared rule ON TOP of the rules every answer has", () => {
    // Not instead of. A shared row is still bot-facing.
    const problems = checkFaq({
      question: "Where are you located?", answer: "About $2,500.", shared: true,
    });
    expect(problems.map((p) => p.field).sort()).toEqual(["answer", "question"]);
  });

  it("drops a shared location-bound row at read time too", () => {
    // usableFaqs is what stands between the table and the prompt. SQL is a
    // door the editor does not control.
    const { usable, rejected } = usableFaqs([
      { question: "Where are you located?", answer: "Pasadena.", shared: true },
      { question: "Are you insured?", answer: "Yes, fully licensed and insured.", shared: true },
    ]);
    expect(usable.map((f) => f.question)).toEqual(["Are you insured?"]);
    expect(rejected).toHaveLength(1);
  });

  it("keeps `shared` on a row that survives, so a re-check gets the same answer", () => {
    const { usable } = usableFaqs([
      { question: "Are you insured?", answer: "Yes, fully licensed and insured.", shared: true },
    ]);
    expect(usable[0].shared).toBe(true);
    expect(checkFaq(usable[0])).toEqual([]);
  });
});
