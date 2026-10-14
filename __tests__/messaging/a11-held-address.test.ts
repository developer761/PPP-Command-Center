import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A11 — "Ask only for the MISSING part of a partial address."
 *
 * The SECOND LARGEST fault class in Kate's corpus: 289 fell_short findings,
 * behind only A23's punctuation. It was enforced at the INTENT level
 * (partial_address_walked_past) and never on the model's words.
 *
 * Reproduced: customer says "It's 482 Marchmont Ave", addressGap is "zip",
 * and "Can you send me your full address?" goes out ALONE — on `acknowledge`
 * the template is a bare acknowledgement, so it is dropped and the rapport
 * IS the message. The customer retypes the street they sent a moment ago.
 *
 * ── THE STATE GATE IS THE DESIGN, NOT A DETAIL ──────────────────────────
 *
 * The text pattern alone catches 215 of 277 A11 faults and trips on 18
 * messages Kate PRAISED, including "Yes, we can help with wallpaper as well.
 * What's the full address for the project?" — correct, because no address
 * was held then. Asking for the whole address is only wrong when we already
 * hold half, and no reading of the sentence reveals which case it is.
 */
const ctxWith = (addressGap?: "zip" | "street" | "both") => ({
  addressGap,
  knownFields: {},
  templateAsks: () => false,
  customerMessages: [],
}) as never;

const check = (text: string, gap?: "zip" | "street" | "both") =>
  validateAction({ intent: "acknowledge", confidence: 0.97, freeText: text }, ctxWith(gap));

describe("A11 — when we hold half the address", () => {
  it.each([
    "Can you send me your full address?",
    "Could you confirm your full address, including the zip code?",
    "Just resend the whole address including street and zip.",
    "What's the complete address for the project?",
    "Can you give me the address again?",
  ])("refuses %j when the zip is the only gap", (t) => {
    const v = check(t, "zip");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("asked_for_the_held_address");
  });

  /** The remedy A11 asks for, and the shape Kate praises. */
  it.each([
    "What's the zip code there?",
    "For the address, I have zip code 11530. What's the full street address?",
    "Could you share the house number for Marchmont Ave?",
    "What's the house number on Vernon Ave?",
  ])("allows the ask for the missing half: %j", (t) => {
    expect(check(t, "zip").ok).toBe(true);
    expect(check(t, "street").ok).toBe(true);
  });

  /**
   * "full STREET address" must survive. When the street is the missing half,
   * asking for it in full IS the remedy — the negative lookahead is the only
   * thing separating it from "full address", so it gets its own test.
   */
  it("allows 'full street address', which is the missing half in full", () => {
    expect(check("What's the full street address for the project?", "street").ok).toBe(true);
    expect(check("What's the full street address for the project?", "zip").ok).toBe(true);
  });
});

describe("A11 — when we hold none of it, asking for all of it is correct", () => {
  it.each([undefined, "both"] as const)("allows the whole-address ask (gap=%s)", (gap) => {
    expect(check("Can you send me your full address?", gap).ok).toBe(true);
    expect(check("Yes, we can help with wallpaper as well. What's the full address for the project?", gap).ok).toBe(true);
  });

  /**
   * The exact message Kate praised that a text-only guard would have
   * refused. Pinned so nobody "simplifies" the state gate away.
   */
  it("allows the praised message that a text-only guard refuses", () => {
    const praised = "Yes, we can help with wallpaper as well. What's the full address for the project, including the zip code?";
    expect(check(praised, undefined).ok).toBe(true);
    expect(check(praised, "zip").ok).toBe(false);
  });
});
