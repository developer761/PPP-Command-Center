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
