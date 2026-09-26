/**
 * Hatch parity gap 6 — more than one property in one conversation.
 *
 * The failure this prevents is the expensive one: closing a two-property job
 * having collected one. A second property is a second job, and it is lost
 * SILENTLY, because the conversation looks complete and nobody goes looking.
 */
import { describe, it, expect } from "vitest";
import {
  mentionsSecondProperty, threadMentionsSecondProperty,
  addressesCollected, secondPropertyOutstanding,
  CONTACT_IS_SHARED_ACROSS_PROPERTIES,
} from "@/lib/messaging/multi-property";
import { validateAction } from "@/lib/messaging/agent-output";

describe("noticing a second property", () => {
  for (const t of [
    "I have two houses that need doing",
    "3 properties actually",
    "both places need the exterior done",
    "my rental too",
    "and my other house",
    "the kitchen here, plus my condo downtown",
    "also my apartment on Oak Street",
    "I need a second property quoted as well",
  ]) {
    it(`${JSON.stringify(t)} is more than one`, () => {
      expect(mentionsSecondProperty(t)).toBe(true);
    });
  }

  /**
   * ROOMS ARE NOT PROPERTIES. Getting this loose makes the bot ask for an
   * address that does not exist, which the customer then has to correct —
   * worse than missing one, because it is visibly wrong.
   */
  for (const t of [
    "two rooms need painting",
    "three bedrooms and a bath",
    "I have 4 windows to do",
    "two coats please",
    "the whole house",
    "my house needs painting",
    "both bedrooms",
    "",
  ]) {
    it(`${JSON.stringify(t)} is one property`, () => {
      expect(mentionsSecondProperty(t)).toBe(false);
    });
  }

  it("reads the whole thread — it often arrives a turn later", () => {
    expect(threadMentionsSecondProperty([
      "I need the exterior painted", "4821 Oak Lane", "oh and my rental too",
    ])).toBe(true);
  });
});

describe("counting what was actually collected", () => {
  it("counts distinct addresses", () => {
    expect(addressesCollected(["4821 Oak Lane", "12 Pine St"])).toBe(2);
  });

  it("does not count the same address twice", () => {
    expect(addressesCollected(["4821 Oak Lane", "4821 Oak Lane."])).toBe(1);
  });

  it("ignores blanks", () => {
    expect(addressesCollected([null, "", "  ", "4821 Oak Lane"])).toBe(1);
  });
});

describe("the conversation may not close over an uncollected property", () => {
  it("is outstanding when they named two and we hold one", () => {
    expect(secondPropertyOutstanding({
      customerMessages: ["I have two houses"], addressesHeld: ["4821 Oak Lane"],
    })).toBe(true);
  });

  it("is settled once both are held", () => {
    expect(secondPropertyOutstanding({
      customerMessages: ["I have two houses"], addressesHeld: ["4821 Oak Lane", "12 Pine St"],
    })).toBe(false);
  });

  it("never fires on an ordinary single-property conversation", () => {
    expect(secondPropertyOutstanding({
      customerMessages: ["I need my kitchen painted"], addressesHeld: ["4821 Oak Lane"],
    })).toBe(false);
  });

  it("the validator refuses success", () => {
    const r = validateAction({ intent: "success", confidence: 0.9 }, {
      customerMessages: ["I have two houses to quote"],
      addressesHeld: ["4821 Oak Lane"],
      priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("second_property_uncollected");
  });

  it("and allows success once both addresses are held", () => {
    const r = validateAction({ intent: "success", confidence: 0.9 }, {
      customerMessages: ["I have two houses to quote"],
      addressesHeld: ["4821 Oak Lane", "12 Pine St"],
      priorIntents: ["ask_project_details", "ask_address", "ask_contact", "ask_availability"],
    });
    expect(r.ok).toBe(true);
  });

  /**
   * A deferral or a decline ends the collection obligation, so neither is
   * blocked. Only `success` claims the job is ready.
   */
  it("does not block a deferral or a decline", () => {
    for (const intent of ["schedule_follow_up", "bailout", "lost"]) {
      const r = validateAction({ intent, confidence: 0.9 }, {
        customerMessages: ["I have two houses"], addressesHeld: ["4821 Oak Lane"],
        priorIntents: ["ask_project_details", "ask_address", "ask_contact"],
      });
      expect(r.ok, intent).toBe(true);
    }
  });
});

describe("asking for the second address is not a redundant ask", () => {
  /**
   * The guard that normally stops an A13 nag is the one that would stop the
   * second property being collected at all — holding one address is the
   * whole reason we are asking for another.
   */
  it("allows ask_address with an address already on file", () => {
    const r = validateAction({ intent: "ask_address", confidence: 0.9 }, {
      knownFields: { address: true },
      customerMessages: ["I have two houses that need doing"],
    });
    expect(r.ok).toBe(true);
  });

  it("still refuses it on an ordinary conversation", () => {
    const r = validateAction({ intent: "ask_address", confidence: 0.9 }, {
      knownFields: { address: true },
      customerMessages: ["I need my kitchen painted"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/already on file/i);
  });

  /** "Contact info can be reused if it applies to both." */
  it("never carves out a second CONTACT ask", () => {
    expect(CONTACT_IS_SHARED_ACROSS_PROPERTIES).toBe(true);
    // ask_contact is superseded by NAME and EMAIL (see ASK_SUPERSEDED_BY),
    // not by phone — the first version of this test supplied phone+email and
    // passed for the wrong reason, because the guard was never reached.
    const r = validateAction({ intent: "ask_contact", confidence: 0.9 }, {
      knownFields: { name: true, email: true },
      customerMessages: ["I have two houses"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/already on file/i);
  });
});
