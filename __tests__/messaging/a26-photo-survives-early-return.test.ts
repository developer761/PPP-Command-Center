import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A26 — "Acknowledge that a photo was received", one short line.
 *
 * The photo line is pushed into `parts` near the BOTTOM of renderBody, so
 * every branch that returns before reaching it dropped it silently. On five
 * paths a customer sent a photo and the reply never mentioned it. 9
 * fell_short findings.
 *
 * It now rides on keepingTheAnswer, which already existed for exactly this
 * shape — a thing that must survive an early return — and covers the same
 * eight call sites.
 */
const photoed = (input: Record<string, unknown>) => renderMessage({ photos: 1, ...input } as never);

describe("A26 — the photo is named even when the branch returns early", () => {
  it.each([
    ["ask_availability with a zone", { intent: "ask_availability", turn: 2, now: new Date("2026-10-12T16:00:00Z"), customerZone: "America/New_York" }],
    ["ask_availability with a time", { intent: "ask_availability", turn: 2, customerText: "can you come Tuesday at 2?" }],
    ["checking_availability", { intent: "checking_availability", turn: 2, customerText: "can you come Tuesday at 2?" }],
    ["schedule_follow_up on a callback", { intent: "schedule_follow_up", turn: 2, customerText: "can you give me a call instead?" }],
    ["discard naming what we cover", { intent: "discard", turn: 1, covers: "interior painting and more", customerText: "do you do roofing?" }],
  ])("names the photo on %s", (_label, input) => {
    expect(photoed(input)).toMatch(/thanks for the photo/i);
  });

  it("still names it on the paths that always worked", () => {
    expect(photoed({ intent: "acknowledge", turn: 0 })).toMatch(/thanks for the photo/i);
    expect(photoed({ intent: "ask_project_details", turn: 0 })).toMatch(/thanks for the photo/i);
  });

  /** Spanish takes the same early returns, and carries no inverted mark. */
  it("names it in Spanish, with no inverted punctuation", () => {
    const out = renderMessage({
      intent: "ask_availability", turn: 2, photos: 2, language: "es",
      customerText: "puede venir el martes a las 2?",
    } as never);
    expect(out).toMatch(/gracias por las fotos/i);
    expect(out).not.toMatch(/[¡¿]/);
  });

  /** The photo line leads, as it does on the ordinary path. */
  it("puts the photo first, so an early return reads like the normal one", () => {
    expect(photoed({ intent: "checking_availability", turn: 2, customerText: "can you come Tuesday at 2?" }))
      .toMatch(/^Thanks for the photo!/);
  });

  it("says nothing about photos when none were sent", () => {
    expect(renderMessage({ intent: "ask_project_details", turn: 0 } as never)).not.toMatch(/photo/i);
    expect(renderMessage({ intent: "checking_availability", turn: 2, customerText: "can you come Tuesday at 2?" } as never))
      .not.toMatch(/photo/i);
  });

  /**
   * FOUND LIVE IN CHROME on 2026-10-14, after this fix had shipped:
   *
   *   "I'll check the calendar for that time. Thanks for the photo!
   *    Thanks, got the photo. I can't set times myself, but the office
   *    handles scheduling and will confirm what's open."
   *
   * The whole-message guard drops rapport that is NOTHING but a photo
   * acknowledgement, and the model does not write all-or-nothing — the
   * second sentence says something real, so the first went out too.
   */
  it("drops the model's own photo-thanks SENTENCE and keeps the rest", () => {
    const out = renderMessage({
      intent: "ask_contact", turn: 3, photos: 1,
      customerText: "can you come Tuesday at 2?",
      freeText: "Thanks, got the photo. I can't set times myself, but the office handles scheduling and will confirm what's open.",
    } as never);
    expect((out.match(/\bthanks\b/gi) ?? []).length).toBe(1);
    expect(out).toMatch(/office handles scheduling/);
  });

  /**
   * The most useful sentence the model can write about a photo keeps every
   * word of its content — only the duplicated opener goes.
   */
  it("keeps an observation, losing only its leading thank-you", () => {
    const out = renderMessage({
      intent: "ask_project_details", turn: 0, photos: 1,
      freeText: "Thanks, I can see the water damage along the skirting.",
    } as never);
    expect(out).toMatch(/I can see the water damage along the skirting/);
    expect((out.match(/\bthanks\b/gi) ?? []).length).toBe(1);
  });

  it("never trims a thank-you that is doing real work", () => {
    const out = renderMessage({
      intent: "ask_contact", turn: 3, photos: 1,
      freeText: "Thanks for waiting on the measurements.",
    } as never);
    expect(out).toMatch(/Thanks for waiting on the measurements/);
  });

  /** One source for the line, so the two paths cannot drift apart again. */
  it("uses the same wording on both paths", () => {
    const early = photoed({ intent: "checking_availability", turn: 2, customerText: "can you come Tuesday at 2?" });
    const ordinary = photoed({ intent: "ask_project_details", turn: 0 });
    expect(early.startsWith("Thanks for the photo!")).toBe(true);
    expect(ordinary.startsWith("Thanks for the photo!")).toBe(true);
  });
});
