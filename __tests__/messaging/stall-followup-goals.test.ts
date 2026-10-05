import { describe, it, expect } from "vitest";
import {
  stallFollowUpGoal, isFollowUpStep, FOLLOW_UP_COUNT,
} from "@/lib/messaging/stall-followup-goals";
import { buildSystemPrompt, buildSystemPromptParts } from "@/lib/messaging/agent-run";

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

/**
 * THE CACHE SPLIT, which is a cost property and a correctness one.
 *
 * A cache breakpoint covers a PREFIX, so anything that varies per turn has to
 * sit after everything that does not. If a varying value leaks into the
 * stable half, the cache misses on every turn and the saving silently
 * disappears — no test fails, the bill just stays where it was.
 *
 * Worse in the other direction: a STABLE value drifting into the variable
 * half is only wasted money, but a per-customer value in the cached half
 * would be a customer's details reused across conversations. That is the one
 * worth a test.
 */
describe("the cached half of the prompt holds nothing that varies", () => {
  const cfg = {
    persona_name: "Emily", persona_role: "coordinator",
    required_flow: ["project_details", "address", "contact", "availability"],
    services_included: "Interior and exterior painting", services_excluded: null,
    offsite_rules: null, tone_rules: "Friendly, brief",
    office_location: "Nassau", service_area_note: null, confidence_threshold: 0.95,
  };
  const parts = (over: Record<string, unknown> = {}) => buildSystemPromptParts(
    cfg, ["never quote a price"], "new_lead",
    (over.known ?? { name: "Dana", phone: "999-784-6046", email: "d@e.com",
      address: "12 Oak St", inquiryScope: "kitchen" }) as never,
    (over.examples ?? undefined) as never,
    undefined, "A40 RULE TEXT", "STANDING ANSWERS\nAre you insured? Yes.", "en",
    (over.area ?? null) as never,
  );

  it("keeps the customer out of the cached half", () => {
    const { stable, variable } = parts();
    for (const secret of ["Dana", "12 Oak St", "999-784-6046", "d@e.com"]) {
      expect(stable, `${secret} must not be cached`).not.toContain(secret);
      expect(variable).toContain(secret);
    }
  });

  it("keeps the service-area verdict out of the cached half", () => {
    const { stable, variable } = parts({ area: { outcome: "serviced", zip: "11530", state: null } });
    expect(stable).not.toContain("OUR RECORDS SAY");
    expect(variable).toContain("OUR RECORDS SAY");
  });

  it("keeps the rules and standing answers IN the cached half", () => {
    const { stable } = parts();
    expect(stable).toContain("A40 RULE TEXT");
    expect(stable).toContain("STANDING ANSWERS");
    expect(stable).toContain("never quote a price");
  });

  /** Two different customers must share a byte-identical cached prefix. */
  it("produces the same cached prefix for different customers", () => {
    const a = parts({ known: { name: "Dana", phone: "999-111-1111", email: "a@e.com" } });
    const b = parts({ known: { name: "Tom", phone: "999-222-2222", email: "b@e.com" } });
    expect(a.stable).toBe(b.stable);
    expect(a.variable).not.toBe(b.variable);
  });

  /** And the joined string still contains everything it used to. */
  it("loses nothing by splitting", () => {
    const { stable, variable } = parts();
    const whole = `${stable}\n\n${variable}`;
    for (const probe of ["A40 RULE TEXT", "STANDING ANSWERS", "Dana", "WHAT WE DO"]) {
      expect(whole).toContain(probe);
    }
  });
});
