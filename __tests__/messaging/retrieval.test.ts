import { describe, it, expect } from "vitest";
import { selectExamples, examplesPrompt, relevantTags, type CorpusExample } from "@/lib/messaging/retrieval";
import { buildSystemPrompt, type AgentConfigForRun } from "@/lib/messaging/agent-run";

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

  it("ignores an example with no bearing on the current turn", () => {
    const sel = selectExamples([ex({ tags: ["handled_language"] })], { stage: 0 });
    expect(sel.good).toHaveLength(0);
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
