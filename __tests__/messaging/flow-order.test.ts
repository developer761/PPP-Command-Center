import { describe, it, expect } from "vitest";
import { validateAction, stageFromIntents, stageOfIntent, FLOW_ORDER } from "@/lib/messaging/agent-output";

const act = (intent: string) => ({ intent, freeText: "", confidence: 0.99, reasoning: "" });

/**
 * "The order is the rule." It was previously only in the prompt, and Kate's
 * graded conversations show the model skipping and reordering — which is what
 * an instruction gets you when nothing checks it.
 */
describe("the required order is enforced, not requested", () => {
  it("refuses availability before an address has been collected", () => {
    const res = validateAction(act("ask_availability"), { stage: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_order");
  });

  it("allows the next step in the sequence", () => {
    expect(validateAction(act("ask_address"), { stage: 1 }).ok).toBe(true);
  });

  it("allows going back over a step already covered", () => {
    // Re-asking is a different failure from skipping, and sometimes correct —
    // the customer gave a half address and it needs the zip.
    expect(validateAction(act("ask_project_details"), { stage: 3 }).ok).toBe(true);
  });

  it("refuses skipping straight to the end from nothing", () => {
    for (const intent of ["ask_address", "ask_contact", "ask_availability"]) {
      expect(validateAction(act(intent), { stage: 0 }).ok, intent).toBe(false);
    }
  });

  it("orders the confirm variants the same way as the asks they replace", () => {
    expect(stageOfIntent("confirm_address")).toBe(stageOfIntent("ask_address"));
    expect(stageOfIntent("confirm_scope")).toBe(stageOfIntent("ask_project_details"));
    expect(validateAction(act("confirm_contact"), { stage: 1 }).ok).toBe(false);
  });

  it("never blocks the intents that are not part of the flow", () => {
    for (const intent of ["acknowledge", "answer_question", "escalate", "offer_offsite_quote", "bailout"]) {
      expect(validateAction(act(intent), { stage: 0 }).ok, intent).toBe(true);
    }
  });

  it("does not check order at all when no stage is given", () => {
    expect(validateAction(act("ask_availability"), {}).ok).toBe(true);
  });

  it("advances one step per flow intent used", () => {
    expect(stageFromIntents([])).toBe(0);
    expect(stageFromIntents(["ask_project_details"])).toBe(1);
    expect(stageFromIntents(["ask_project_details", "acknowledge", "ask_address"])).toBe(2);
    expect(stageFromIntents(["confirm_scope", "confirm_address", "confirm_contact"])).toBe(3);
  });

  it("never reports a stage past the end of the flow", () => {
    const all = FLOW_ORDER.flatMap((g) => [...g]);
    expect(stageFromIntents([...all, ...all])).toBe(FLOW_ORDER.length);
  });

  it("ignores nulls, which is what an errored turn leaves behind", () => {
    expect(stageFromIntents([null, "ask_project_details", undefined])).toBe(1);
  });

  /** The off-site rule: a phone quote replaces the appointment, never the
   *  three things collected before it. */
  it("still requires the first three steps when an off-site quote is offered", () => {
    expect(validateAction(act("offer_offsite_quote"), { stage: 0 }).ok).toBe(true);
    expect(validateAction(act("ask_contact"), { stage: 1 }).ok).toBe(false);
  });
});
