import { describe, it, expect } from "vitest";
import { toE164 } from "@/lib/messaging/phone";

/**
 * A "+" in front of a ten-digit US number is a typo, not a country code.
 *
 * Found by listing every non-US number in the real lead data: eight of
 * 2,042, and six of those eight are plainly local — four Nassau (516), one
 * Manhattan (646), one New Jersey (609). All six arrived from Meta, where
 * somebody typed a "+" before a ten-digit number.
 *
 * Read as international, +5165286105 is +51 65286105: Peru, and not a valid
 * Peruvian number either. The message fails silently and a real Nassau lead
 * is never contacted — the worse failure, and the harder one to notice.
 */
describe("a stray + before a ten-digit number", () => {
  it.each([
    ["+5165286105", "+15165286105"],
    ["+5163611799", "+15163611799"],
    ["+5164769219", "+15164769219"],
    ["+5164455205", "+15164455205"],
    ["+6465650369", "+16465650369"],
    ["+6099531140", "+16099531140"],
  ])("reads %s as the US number it is", (raw, want) => {
    expect(toE164(raw)).toBe(want);
  });

  /**
   * THE DISCRIMINATOR IS LENGTH. The two genuine international numbers in
   * the same data are twelve digits. A real international number must never
   * be mangled into a US one — that would text a stranger.
   */
  it.each([
    "+905544202801",
    "+233244707688",
    "+447911123456",
    "+34612345678",
  ])("leaves the genuine international number %s alone", (raw) => {
    expect(toE164(raw)).toBe(raw);
  });

  it.each([
    ["(516) 555-1234", "+15165551234"],
    ["+15165551234", "+15165551234"],
    ["15165551234", "+15165551234"],
    ["5165551234", "+15165551234"],
  ])("leaves ordinary US input %s unchanged", (raw, want) => {
    expect(toE164(raw)).toBe(want);
  });

  it.each(["null", "abc", "5551234", ""])("still rejects %j", (raw) => {
    expect(toE164(raw)).toBeNull();
  });

  /**
   * The NANP rule the rest of the function already applies: area code and
   * exchange both start 2-9. A ten-digit number failing that is not treated
   * as US, so it stays international.
   */
  it("does not claim a ten-digit number that breaks the NANP rule", () => {
    expect(toE164("+1165286105")).not.toBe("+11165286105");
    expect(toE164("+5160286105")).toBe("+5160286105");
  });
});
