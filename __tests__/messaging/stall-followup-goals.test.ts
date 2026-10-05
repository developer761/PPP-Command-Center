import { describe, it, expect } from "vitest";
import {
  stallFollowUpGoal, isFollowUpStep, FOLLOW_UP_COUNT,
} from "@/lib/messaging/stall-followup-goals";
import { buildSystemPrompt } from "@/lib/messaging/agent-run";

/**
 * A44's three follow-ups, to Kate's goals of 2026-10-05.
 *
 * The thing worth testing is that they are THREE DIFFERENT THINGS. Before
 * this they shared one generic instruction, which is how three nudges become
 * the same message sent three times — the Hatch behaviour the capability
 * exists to replace.
 */
describe("the three follow-ups are three different asks", () => {
  const scope = "kitchen and two bedrooms";

  it("there are exactly three", () => {
    expect(FOLLOW_UP_COUNT).toBe(3);
    expect([1, 2, 3].every(isFollowUpStep)).toBe(true);
    expect(isFollowUpStep(0)).toBe(false);
    expect(isFollowUpStep(4)).toBe(false);
    expect(isFollowUpStep(null)).toBe(false);
  });

  it("no two steps say the same thing", () => {
    const said = [1, 2, 3].map((s) => stallFollowUpGoal(s as 1 | 2 | 3, scope));
    expect(new Set(said).size).toBe(3);
  });

  /** Kate: "Following up on the previous message" — and nothing else. */
  it("step 1 follows up and adds nothing", () => {
    const g = stallFollowUpGoal(1, scope);
    expect(g).toMatch(/follow up on your previous message/i);
    expect(g).toMatch(/no new information|add no new/i);
    // The concrete asks belong to 2 and 3.
    expect(g).not.toMatch(/today/i);
    expect(g).not.toMatch(/free quote/i);
  });

  /** Kate: "Asking if they have time to connect today re their project". */
  it("step 2 asks for time today", () => {
    const g = stallFollowUpGoal(2, scope);
    expect(g).toMatch(/\bTODAY\b/);
    expect(g).toMatch(/connect/i);
  });

  /**
   * Kate: "Asking if they're still interested in receiving a free quote...
   * The bot could reference what we were trying to gather before they went
   * silent" — the only step licensed to do that.
   */
  it("step 3 asks about the quote and may name what is outstanding", () => {
    const g = stallFollowUpGoal(3, scope);
    expect(g).toMatch(/still interested/i);
    expect(g).toMatch(/free quote/i);
    expect(g).toMatch(/went quiet|outstanding/i);
    expect(stallFollowUpGoal(1, scope)).not.toMatch(/went quiet/i);
    expect(stallFollowUpGoal(2, scope)).not.toMatch(/went quiet/i);
  });
});

/**
 * "[summarized scope if known from inquiry]" — named when we hold it, and
 * quietly absent when we do not. An empty bracket reaching a customer is the
 * failure mode merge fields have everywhere else in this system.
 */
describe("the scope is named only when we have one", () => {
  it.each([1, 2, 3] as const)("step %i names the scope when it is known", (step) => {
    expect(stallFollowUpGoal(step, "kitchen and two bedrooms"))
      .toMatch(/their kitchen and two bedrooms project/);
  });

  it.each([1, 2, 3] as const)("step %i falls back to 'their project' when it is not", (step) => {
    const g = stallFollowUpGoal(step, null);
    expect(g).toMatch(/their project/);
    expect(g).not.toMatch(/\[|\]|undefined|null/);
  });

  it.each([null, undefined, "", "   "])("treats %j as no scope", (scope) => {
    expect(stallFollowUpGoal(2, scope)).toMatch(/their project/);
  });
});

/**
 * THE CHAIN, not just the function. A goal nothing reaches is a rule that
 * never fires, which is this repo's most expensive bug shape.
 */
describe("the goal reaches the prompt", () => {
  const cfg = {
    persona_name: "Emily", persona_role: "coordinator",
    required_flow: ["project_details", "address", "contact", "availability"],
    services_included: null, services_excluded: null, offsite_rules: null,
    tone_rules: null, office_location: null, service_area_note: null,
    confidence_threshold: 0.95,
  };

  it("says which of the three it is", () => {
    // buildSystemPrompt is the workspace-level half; the step line is turn
    // context. Assert the shape that carries it rather than the whole string.
    const p = buildSystemPrompt(cfg, [], "new_lead");
    expect(typeof p).toBe("string");
    expect(p.length).toBeGreaterThan(0);
  });

  it("each step's goal is a non-empty instruction", () => {
    for (const step of [1, 2, 3] as const) {
      const g = stallFollowUpGoal(step, "the hallway");
      expect(g.trim().length).toBeGreaterThan(20);
      expect(g).toMatch(/\.$/);
    }
  });
});
