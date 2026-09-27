import { describe, it, expect } from "vitest";
import { knownFromThread } from "@/lib/messaging/known-from-thread";

/**
 * THE DERIVATION THE SCHEDULER AND THE SIMULATOR NOW SHARE.
 *
 * They answered "what do we hold" separately and drifted apart four times in
 * one day, every time with the sandbox knowing less than production and
 * refusing turns production answers: the stage, the scope, the address, and
 * each fix needing to be made twice.
 */
describe("knownFromThread", () => {
  const msg = (body: string, mediaCount = 0) => ({ body, mediaCount });

  it("takes the job from what the customer said, and raises the stage", () => {
    const k = knownFromThread({
      onFile: {},
      messages: [msg("Hi I need my living room and hallway painted, about 600 sq ft")],
      stage: 0,
    });
    expect(k.scopeFrom).toBe("customer");
    expect(k.stage).toBe(1);
  });

  it("finds an address given on an EARLIER turn, which is what the row remembers", () => {
    const k = knownFromThread({
      onFile: {},
      messages: [msg("paint my kitchen cabinets"), msg("12 Oak St, Garden City NY 11530"), msg("ok")],
      stage: 1,
    });
    expect(k.address).toBe("12 Oak St, 11530");
    expect(k.addressFromChat).toBe(true);
  });

  /** The office's version is never overwritten by something read out of chat. */
  it("prefers what is already on file", () => {
    const k = knownFromThread({
      onFile: { inquiryScope: "Interior repaint, 3 bedrooms", address: "1 Record Way, 11530" },
      messages: [msg("actually paint the deck at 99 Other Street 11111")],
      stage: 0,
    });
    expect(k.scopeFrom).toBe("record");
    expect(k.inquiryScope).toBe("Interior repaint, 3 bedrooms");
    expect(k.address).toBe("1 Record Way, 11530");
    expect(k.addressFromChat).toBe(false);
  });

  /** A reaction quotes OUR sentence back, so nothing in it is theirs. */
  it("takes nothing from a reaction", () => {
    const k = knownFromThread({
      onFile: {},
      messages: [msg('Liked "Is 12 Oak St, Garden City NY 11530 the correct address?"')],
      stage: 0,
    });
    expect(k.address).toBeNull();
    expect(k.scopeFrom).toBeNull();
    expect(k.stage).toBe(0);
  });

  it("holds nothing when the customer has sent no words at all", () => {
    const k = knownFromThread({ onFile: {}, messages: [msg("", 1), msg("👍")], stage: 0 });
    expect(k.inquiryScope).toBeNull();
    expect(k.address).toBeNull();
    expect(k.stage).toBe(0);
  });
});

/**
 * THE PROJECT DOES NOT STOP BEING TRUE BECAUSE THE NEXT MESSAGE WAS "OK".
 *
 * Found in the simulator on 2026-09-27, playing a customer who wanted a price:
 *
 *   customer  "just give me a ballpark, how much for a 12x14 bedroom?
 *              I don't want an appointment"
 *   BOT       "Happy to skip the appointment. We can provide a quick quote for
 *              this project. Do you prefer text or email?"     ← it KNEW
 *   customer  "text is fine"
 *   BOT       "Text works. Sure thing. What are you hoping to have painted?"
 *
 * It asked about the bedroom it had just quoted. Scope was read from the
 * NEWEST message only, so any reply without a project in it — "ok", "yes
 * please", "text is fine", which is most second messages — wiped it, dropped
 * the stage back to 0, and left A13's held-field guard with nothing to guard.
 *
 * The address was already scanned across the whole thread, one line below, for
 * exactly this reason. Production was shielded by accident because it persists
 * inquiry_scope to the conversation row; the simulator has no row, so the two
 * diverged — which is the failure this module was created to stop.
 */
describe("a scope stated earlier in the thread is still held", () => {
  const ballpark = "just give me a ballpark, how much for a 12x14 bedroom? I don't want an appointment";
  const derive = (bodies: string[]) =>
    knownFromThread({ onFile: {}, messages: bodies.map((body) => ({ body })), stage: 0 });

  it("survives a reply that carries no project", () => {
    for (const second of ["ok", "yes please", "text is fine", "sounds good"]) {
      const k = derive([ballpark, second]);
      expect(k.inquiryScope, `wiped by ${JSON.stringify(second)}`).toBeTruthy();
      expect(k.stage, `stage fell back after ${JSON.stringify(second)}`).toBeGreaterThan(0);
    }
  });

  it("still reads it from the newest message when that is where it is", () => {
    const k = derive(["hi", "paint my bedroom"]);
    expect(k.inquiryScope).toBe("paint my bedroom");
  });

  /**
   * OLDEST WINS, matching how production stores it: the row is written once
   * with `.is("inquiry_scope", null)` and never overwritten. A sandbox that
   * preferred the newest would disagree with the row whenever a customer
   * described the job twice.
   */
  it("keeps the FIRST description, as the record does", () => {
    const k = derive(["paint my bedroom", "ok", "and the hallway too"]);
    expect(k.inquiryScope).toBe("paint my bedroom");
  });

  it("the record still outranks anything in the chat", () => {
    const k = knownFromThread({
      onFile: { inquiryScope: "interior, 3 bedrooms" },
      messages: [{ body: "paint my bedroom" }, { body: "ok" }],
      stage: 0,
    });
    expect(k.inquiryScope).toBe("interior, 3 bedrooms");
    expect(k.scopeFrom).toBe("record");
  });

  it("finds nothing when nobody described a project", () => {
    const k = derive(["hi", "ok", "sure"]);
    expect(k.inquiryScope).toBeNull();
  });

  it("never walks the stage backwards", () => {
    // A scope recovered from an earlier message must not undo progress the
    // bot's own intents already made.
    const k = knownFromThread({
      onFile: {}, messages: [{ body: "paint my bedroom" }, { body: "ok" }], stage: 3,
    });
    expect(k.stage).toBeGreaterThanOrEqual(3);
  });
});
