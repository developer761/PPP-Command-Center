import { describe, it, expect } from "vitest";
import {
  intentsForTrack, validateAction, NURTURE_CONTINUE_INTENTS, CONTINUE_INTENTS,
} from "@/lib/messaging/agent-output";
import { buildSystemPrompt, type AgentConfigForRun } from "@/lib/messaging/agent-run";
import { renderMessage } from "@/lib/messaging/render";

const CFG: AgentConfigForRun = {
  persona_name: "Emily",
  persona_role: "following up on quotes already sent",
  required_flow: ["confirm_quote_received", "ask_for_a_decision"],
  services_included: "Interior and exterior painting.",
  services_excluded: "Roofing.",
  offsite_rules: null,
  tone_rules: "Warm and unhurried.",
  office_location: "Garden City",
  service_area_note: null,
  confidence_threshold: 0.95,
};

describe("nurture is a different conversation, not a different tone", () => {
  /**
   * The failure this track exists to prevent. Jeremy has had an estimator at
   * the property and a written quote; asking him for his address is the
   * clearest possible proof that nobody is reading.
   */
  it("cannot choose any of the collection intents", () => {
    const nurture = intentsForTrack("nurture");
    for (const collecting of ["ask_project_details", "ask_address", "ask_contact", "ask_availability"]) {
      expect(nurture, collecting).not.toContain(collecting);
    }
  });

  it("rejects a collection intent outright, not just discourages it", () => {
    const res = validateAction(
      { intent: "ask_address", freeText: "", confidence: 0.99, reasoning: "need it" },
      { track: "nurture" }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown_intent");
  });

  it("still allows it on the new-lead track — proving the check is about track, not the intent", () => {
    const res = validateAction(
      { intent: "ask_address", freeText: "", confidence: 0.99, reasoning: "need it" },
      { track: "new_lead" }
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a nurture intent on the new-lead track, in the other direction", () => {
    const res = validateAction(
      { intent: "ask_check_back", freeText: "", confidence: 0.99, reasoning: "" },
      { track: "new_lead" }
    );
    expect(res.ok).toBe(false);
  });

  it("tells the model the customer already has a quote", () => {
    const p = buildSystemPrompt(CFG, [], "nurture");
    expect(p).toMatch(/already received a written quote/i);
    expect(p).toMatch(/never ask for anything they have already given/i);
    expect(p).not.toMatch(/COLLECT IN THIS ORDER/);
  });

  it("keeps the new-lead prompt unchanged when no track is given", () => {
    expect(buildSystemPrompt(CFG, [])).toMatch(/COLLECT IN THIS ORDER/);
  });

  it("never re-quotes or discounts in any nurture template", () => {
    for (const intent of NURTURE_CONTINUE_INTENTS) {
      for (const turn of [0, 1]) {
        const out = renderMessage({ intent, turn });
        expect(out, intent).not.toMatch(/\$|discount|off the price|re-?quote/i);
      }
    }
  });

  it("has words for every nurture intent it can choose", () => {
    for (const intent of NURTURE_CONTINUE_INTENTS) {
      if (intent === "answer_question") continue; // the rapport IS the answer
      expect(renderMessage({ intent }).length, intent).toBeGreaterThan(0);
    }
  });

  it("shares the intents that mean the same thing in both tracks", () => {
    for (const shared of ["acknowledge", "answer_question", "escalate"]) {
      expect(CONTINUE_INTENTS).toContain(shared);
      expect(NURTURE_CONTINUE_INTENTS).toContain(shared);
    }
  });
});
