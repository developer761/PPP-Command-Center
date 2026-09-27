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
  addressesCollected, secondPropertyOutstanding, addressesInThread,
  askSecondPropertyAddress,
  CONTACT_IS_SHARED_ACROSS_PROPERTIES,
} from "@/lib/messaging/multi-property";
import { renderMessage } from "@/lib/messaging/render";
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

/**
 * THE DEFECT ALL OF THE ABOVE MISSED, FOUND IN THE PERSONA HUNT.
 *
 * Every test in this file passed `addressesHeld` by hand, so every one of them
 * could reach two. The REAL caller built that list from the conversation's
 * single address column — `kf.address ? [kf.address] : []` — which can never
 * hold more than one. So `addressesCollected(...) < 2` was permanently true
 * from the moment somebody said "two rentals", and `success` was refused for
 * the entire life of the conversation, no matter how many addresses they typed.
 *
 * Nothing looked broken. Twenty other intents stayed available, so the bot kept
 * talking and the lead ended as a follow-up instead of a booked estimate: a
 * class of lead that could not convert, with no error anywhere. 5,522 tests
 * were green over it.
 *
 * These tests work from the THREAD, the way the caller now does, because that
 * is the only shape in which the bug is visible.
 */
describe("every address the thread holds, not the one column", () => {
  const thread = [
    "I have two rental properties I need quoted, one in Garden City and one in Hempstead",
    "both need the interiors done, 3 bedrooms each",
    "first one is 12 Oak St, Garden City NY 11530",
    "the other is 44 Elm Ave, Hempstead NY 11550",
    "tom@example.com",
  ];

  it("finds both addresses the customer typed", () => {
    expect(addressesInThread({ customerMessages: thread })).toHaveLength(2);
  });

  it("so the conversation can finally close", () => {
    const addressesHeld = addressesInThread({ customerMessages: thread, onFile: "12 Oak St, 11530" });
    expect(secondPropertyOutstanding({ customerMessages: thread, addressesHeld })).toBe(false);
  });

  it("AND THE OLD SHAPE COULD NOT — one column can never reach two", () => {
    // The regression, stated as the thing that used to happen. This is what
    // every turn of every two-property conversation looked like.
    const onlyTheColumn = ["12 Oak St, 11530"];
    expect(secondPropertyOutstanding({ customerMessages: thread, addressesHeld: onlyTheColumn })).toBe(true);
  });

  it("still refuses to close when a second address genuinely never arrived", () => {
    const short = thread.filter((m) => !m.includes("44 Elm"));
    const addressesHeld = addressesInThread({ customerMessages: short, onFile: "12 Oak St, 11530" });
    expect(addressesHeld).toHaveLength(1);
    expect(secondPropertyOutstanding({ customerMessages: short, addressesHeld })).toBe(true);
  });

  it("keeps the record's address first — it is the office's version", () => {
    const out = addressesInThread({ customerMessages: thread, onFile: "99 Office Rd, 11530" });
    expect(out[0]).toBe("99 Office Rd, 11530");
  });

  /**
   * The near-duplicate, which fails the OTHER way: counting one property twice
   * would satisfy the check with one address collected and close over the very
   * job this exists to protect.
   */
  it("does not count one property twice because they reworded it", () => {
    const reworded = [...thread.filter((m) => !m.includes("44 Elm")), "sorry, 12 Oak Street, Garden City NY 11530"];
    expect(addressesInThread({ customerMessages: reworded })).toHaveLength(1);
  });

  it("counts two different houses at the same number as two", () => {
    expect(addressesCollected(["12 Oak St, 11530", "12 Elm Ave, 11550"])).toBe(2);
  });
});

/**
 * AND SOMETHING HAS TO ASK THE QUESTION.
 *
 * askSecondPropertyAddress() had NO CALLER anywhere in lib or app. The
 * validator refused the close and nothing ever asked for the thing that would
 * unblock it, so the bot repeated "What's the address for the project?" to
 * somebody who had already given one.
 */
describe("the ask names which property", () => {
  const ask = (extra = {}) => renderMessage({
    intent: "ask_address", turn: 3, known: { address: "12 Oak St, 11530" },
    secondProperty: true, ...extra,
  });

  it("asks for the SECOND one, not for 'the project'", () => {
    expect(ask()).toBe(askSecondPropertyAddress());
    expect(ask()).toMatch(/second property/i);
  });

  it("in Spanish too", () => {
    expect(ask({ language: "es" })).toMatch(/segunda propiedad/i);
  });

  it("is the ordinary ask when there is no second property", () => {
    expect(renderMessage({ intent: "ask_address", turn: 3 })).not.toMatch(/second property/i);
  });

  /**
   * A11 STILL WINS. Somebody who gave "44 Elm Ave" with no zip is asked for
   * the zip — asking "what's the address for the second property?" when we
   * already hold half of it is the exact breach gap-narrowing exists to stop,
   * and it was Kate's most-broken rule at 287 breaches.
   */
  it("never overrides the A11 gap ask", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 3, addressGap: "zip",
      known: { address: "44 Elm Ave" }, secondProperty: true,
    });
    expect(out).toMatch(/zip/i);
    expect(out).not.toMatch(/second property/i);
  });
});
