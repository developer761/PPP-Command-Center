import { describe, it, expect } from "vitest";
import { validateAction, asksToRetype } from "@/lib/messaging/agent-output";

/**
 * A13 — "Do not ask the customer to RETYPE data already held. CONFIRMING
 * held data once is CORRECT."
 *
 * 207 fell_short findings, the third largest class in Kate's corpus. Like
 * A11 it was enforced on the INTENT (ASK_SUPERSEDED_BY refuses ask_address /
 * ask_contact when the field is on file) and never on the model's words.
 * With the address held, "Can you retype your address for me?" was allowed
 * and on `acknowledge` went out as the entire message.
 *
 * Scored over the corpus: 177 of 192 faults caught, 0 false positives on the
 * 77 A13-praised messages.
 */
const ALL = { name: true, phone: true, email: true, address: true, inquiryScope: true };
const ctx = (held = ALL, addressGap: string | null = null) => ({
  knownFields: held, addressGap, templateAsks: () => false, customerMessages: [],
}) as never;

const check = (t: string, held = ALL, gap: string | null = null) =>
  validateAction({ intent: "acknowledge", confidence: 0.97, freeText: t }, ctx(held, gap));

describe("A13 — asking for a field we already hold", () => {
  it.each([
    "Can you retype your address for me?",
    "What's the best phone number to reach you at?",
    "Can you confirm your email address again for me?",
    "Remind me of your name?",
    "Send over your email and phone number when you get a chance.",
  ])("refuses %j", (t) => {
    const v = check(t);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("asked_to_retype_held_data");
  });

  /**
   * The corpus writes "What's" with U+2019. Matching only the ASCII quote
   * missed 87 of 177 catchable faults — pinned so the normalisation is not
   * quietly dropped.
   */
  it("catches a curly apostrophe, which a straight-quote pattern misses", () => {
    expect(check("What’s the best email address for your quote details?").ok).toBe(false);
  });

  /** A13 says confirming held data once is CORRECT. A read-back shows the value. */
  it.each([
    "Is 123 Main St the right address?",
    "Is john@example.com still the best email?",
    "Is (516) 555-1234 and john@example.com the best contact?",
    "The estimator will confirm that with you directly.",
    "Sounds good.",
  ])("allows the read-back %j", (t) => {
    expect(check(t).ok).toBe(true);
  });

  it("asks for a field we do NOT hold, which is the whole flow", () => {
    expect(check("What's the best phone number to reach you at?", { address: true } as never).ok).toBe(true);
    expect(check("Can you share your email?", { address: true } as never).ok).toBe(true);
  });

  /**
   * A PARTIAL address belongs to A11. Catching it here would leave no legal
   * way to ask for the missing zip at all — the "two correct rules with no
   * move between them" failure this codebase keeps producing.
   */
  it("leaves a partial address to A11", () => {
    expect(check("What's the zip code there?", ALL, "zip").ok).toBe(true);
    expect(check("Could you share the house number for Marchmont Ave?", ALL, "zip").ok).toBe(true);
  });

  /** One message can legitimately read one field back and ask for another. */
  it("judges sentence by sentence", () => {
    expect(asksToRetype("Is john@example.com still best? And what's your name?", ALL)).toEqual(["name"]);
    expect(asksToRetype("Is john@example.com still the best email?", ALL)).toEqual([]);
  });

  /** availability is not a knownField and must never be caught here. */
  it("never catches an availability ask", () => {
    expect(asksToRetype("What days work best for you this week?", ALL)).toEqual([]);
    expect(asksToRetype("What time window works on Friday?", ALL)).toEqual([]);
  });
});
