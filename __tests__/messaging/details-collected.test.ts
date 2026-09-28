import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A3, 105 breaches, critical: "Collect or confirm Project Details, Address
 * and Contact Info."
 *
 * "THE HANDOFF TURN CARRIES THE COLLECTION FAILURE. Where details were never
 * collected or confirmed, the defect sits on the turn where the bot handed
 * off or closed — the sign-off, whichever came last. That is the last moment
 * it could have happened."
 *
 * So it is checked on exactly that turn.
 */

const close = (intent: string, priorIntents: string[]) =>
  validateAction({ intent, confidence: 0.9 } as never, { priorIntents } as never);

const ALL_THREE = ["ask_project_details", "ask_address", "ask_contact"];

describe("closing a conversation that finished the flow", () => {
  it("allows success when all three were asked", () => {
    expect(close("success", ALL_THREE).ok).toBe(true);
  });

  it("allows success when they were confirmed instead of asked", () => {
    // "collect OR confirm". Reading a held value back satisfies the leg.
    expect(close("success", ["confirm_scope", "confirm_address", "confirm_contact"]).ok).toBe(true);
  });

  it("allows a mix of asking and confirming", () => {
    expect(close("success", ["ask_project_details", "confirm_address", "ask_contact"]).ok).toBe(true);
  });
});

describe("closing a conversation that did not", () => {
  it.each([
    [["ask_address", "ask_contact"], "project details"],
    [["ask_project_details", "ask_contact"], "the full address"],
    [["ask_project_details", "ask_address"], "contact details"],
  ])("refuses success when %j leaves out %s", (prior, missing) => {
    const v = close("success", prior as string[]);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("details_never_collected");
      expect(v.detail).toContain(missing);
    }
  });

  it("names every leg that was skipped, not just the first", () => {
    const v = close("success", []);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.detail).toContain("project details");
      expect(v.detail).toContain("the full address");
      expect(v.detail).toContain("contact details");
    }
  });
});

/**
 * "HOLDING IS NOT CONFIRMING. Where the record already holds the address and
 * contact IN FULL, the obligation is NOT satisfied by holding them... The
 * confirmation is an EVENT IN THE CONVERSATION, not a state of the record."
 */
describe("holding is not confirming", () => {
  it("having the details on file does not satisfy it", () => {
    const v = validateAction(
      { intent: "success", confidence: 0.9 } as never,
      {
        priorIntents: ["ask_project_details"],
        knownFields: { address: true, name: true, email: true, phone: true },
      } as never
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("the full address");
  });
});

/**
 * "WHERE THIS DOES NOT FIRE: a customer who DECLINES (A17) or DEFERS (A40)
 * ends the collection obligation at that turn. A bot that stops collecting
 * after 'no thanks', 'I'm not interested', 'I hired someone' or 'I'll reach
 * out later' is CORRECT and carries no A3 defect."
 *
 * Kate measured the cost of missing this clause: 8 of 49 rows are exactly
 * that shape, and the rule would have fired a critical on every one, flipping
 * 6 rows from good to bad. Each of those outcomes has its own intent, so the
 * carve-out is structural rather than something the check has to detect.
 */
describe("a decline or a deferral owes nothing", () => {
  it.each(["bailout", "lost", "discard", "schedule_follow_up"])(
    "%s closes cleanly with nothing collected",
    (intent) => {
      expect(close(intent, []).ok).toBe(true);
    }
  );

  it("and a transfer, because a person finishes the collection", () => {
    expect(close("transferred", []).ok).toBe(true);
  });

  it("but an unserviceable area is not a completed flow either way", () => {
    expect(close("area_not_serviced", []).ok).toBe(true);
  });
});

/**
 * "A Phone Pricing is NOT that: the quote going out by text or phone still
 * requires all three here."
 */
describe("a phone quote still owes all three", () => {
  it("is refused when a leg was skipped", () => {
    const v = close("phone_pricing", ["ask_project_details", "ask_address"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("contact details");
  });

  it("is allowed once they are done", () => {
    expect(close("phone_pricing", ALL_THREE).ok).toBe(true);
  });
});

/**
 * "THE OFF-SITE PATH DOES NOT RELEASE YOU FROM THIS: even when an off-site
 * quote is suggested or required, you must still collect Project Details,
 * Full Address and Contact Information."
 */
describe("the off-site path does not release it", () => {
  it("presenting a quick quote is not a substitute for collecting", () => {
    const v = close("success", ["ask_project_details", "present_offsite_quote"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("the full address");
  });
});

/**
 * PROVE IT CAN FAIL AND PROVE IT CAN BE SWITCHED OFF.
 *
 * The check only runs when the caller supplies priorIntents, which most of
 * the suite does not. Without these the file would pass against code that
 * never executes.
 */
describe("the check is reachable and scoped", () => {
  it("does nothing when the caller tracks no conversation", () => {
    expect(validateAction({ intent: "success", confidence: 0.9 } as never, {}).ok).toBe(true);
  });

  it("the same intent passes or fails purely on what came before", () => {
    expect(close("success", []).ok).toBe(false);
    expect(close("success", ALL_THREE).ok).toBe(true);
  });

  it("counts the closing turn itself", () => {
    // A turn that both asks and closes cannot exist, but the intent under
    // test is included in the set so the logic is stated once.
    expect(close("success", ["ask_project_details", "ask_address", "ask_contact"]).ok).toBe(true);
  });
});

/**
 * ── THE CUSTOMER WHO TELLS YOU EVERYTHING IN MESSAGE ONE ────────────────
 *
 * "Hi, I need the living room, dining room and two bedrooms painted."
 *
 * The project-details leg is satisfied by an intent, and for this customer
 * NEITHER satisfier may legally fire: the prompt forbids asking for what they
 * have already given, and confirm_scope is "read the job back from the RECORD
 * for a yes. Never for something they just typed" — quoting their own sentence
 * at them is the echo Kate bans, not a confirmation.
 *
 * So `success` was refused for the life of every such conversation, and a
 * refusal is terminal: it hands the lead to a person instead of closing. The
 * best lead there is was the one that could not convert. Found in the sandbox
 * on 2026-09-28, present in production on the same path.
 *
 * scope.ts settled the same deadlock one layer earlier, at ask_address: "what
 * they told us IS the scope. AND IT COUNTS AS COLLECTED." That fixed the stage
 * machine and left this check still demanding an intent.
 */
const closeWithScope = (priorIntents: string[], scopeFromCustomer: boolean) =>
  validateAction(
    { intent: "success", confidence: 0.9 } as never,
    { priorIntents, scopeFromCustomer } as never
  );

describe("the customer described the job themselves", () => {
  const NEVER_ASKED_FOR_THE_JOB = ["ask_address", "ask_contact"];

  it("closes, because saying it IS the event A3 asks for", () => {
    expect(closeWithScope(NEVER_ASKED_FOR_THE_JOB, true).ok).toBe(true);
  });

  it("still refuses when the scope only sits on the record", () => {
    // Kate: "HOLDING IS NOT CONFIRMING. Where the record already holds [it]
    // ... confirm them once with the customer before the conversation ends."
    // A lead-form scope nobody has mentioned still owes that confirmation.
    const v = closeWithScope(NEVER_ASKED_FOR_THE_JOB, false);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.detail).toContain("project details");
  });

  it("does not excuse the other two legs", () => {
    // The carve-out is the project leg alone. Having described the job says
    // nothing about the address or how to reach them.
    const v = closeWithScope(["ask_contact"], true);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.detail).toContain("the full address");
  });

  it("does not fire when the caller does not track it", () => {
    // Absent means "unknown", which must behave as it did before.
    expect(close("success", NEVER_ASKED_FOR_THE_JOB).ok).toBe(false);
  });
});
