import { describe, it, expect } from "vitest";
import { isSilent, renderMessage } from "@/lib/messaging/render";
import { mentionsWorkWeDoNotDo, promisesOutOfScopeWork } from "@/lib/messaging/agent-output";

/**
 * A SPANISH SPEAKER ASKING ABOUT WORK WE DO NOT COVER GOT SILENCE.
 *
 * Found 2026-10-05 by adding Spanish scenarios to the harness. isSilent()
 * splits Kate's two discards — "not an estimate request" (a wrong number,
 * where silence is right) from "work we do not cover" (a real customer owed an
 * answer) — by asking whether the customer NAMED the work. Every word in that
 * test was English, so "Hola, pintan muebles?" fell into the silent branch.
 *
 * The cost is the one isSilent's own comment describes: "A homeowner asking
 * 'do you paint furniture?' got nothing back, ever, and above the escalation
 * threshold no person saw it either." Discard is an ending, so nobody is
 * waiting on it. That fix landed on the English half only.
 */
describe("work we do not cover, named in Spanish", () => {
  const asks = [
    "Hola, pintan muebles? Tengo un librero grande y una cómoda",
    "necesito que pinten mi bañera",
    "hacen plomería?",
    "ustedes hacen jardinería tambien?",
    "pueden pintar un mural en la pared",
    "buscan a alguien para tapicería",
  ];

  it.each(asks)("recognises %j", (text) => {
    expect(mentionsWorkWeDoNotDo(text)).toBe(true);
  });

  it.each(asks)("so the discard is NOT silent: %j", (text) => {
    expect(isSilent({ intent: "discard", known: { scope: null }, customerText: text })).toBe(false);
  });

  it.each(asks)("and it actually says something, in Spanish: %j", (text) => {
    const out = renderMessage({
      intent: "discard", turn: 0, language: "es", known: {}, customerText: text,
    } as never);
    expect(out.length).toBeGreaterThan(20);
    expect(out).toMatch(/[áéíóúñ¿]|Creo|proyecto/);
  });

  /**
   * THE WORDS DELIBERATELY LEFT OUT, which matter more than the ones in.
   * `techo` is the ordinary word for a CEILING and PPP paints ceilings on
   * nearly every interior job — matching it would discard a live lead.
   */
  it.each([
    "quiero pintar el techo de la sala",
    "necesito pintar las ventanas y el marco",
    "pintar el piso de concreto del garaje",
    "Quiero pintar el exterior de mi vivienda",
  ])("does not read ordinary painting work as out of scope: %j", (text) => {
    expect(mentionsWorkWeDoNotDo(text)).toBe(false);
  });

  /** English is untouched. */
  it("still recognises the English list", () => {
    expect(mentionsWorkWeDoNotDo("do you guys paint furniture?")).toBe(true);
    expect(mentionsWorkWeDoNotDo("I need the living room painted")).toBe(false);
  });
});

/**
 * AND THE PROMISE TEST IS UNCHANGED, which is the reason these are two lists.
 *
 * outOfScopePromise runs over OUR text and clears a match only when the clause
 * reads as a refusal — in English. Had the Spanish nouns gone into that regex,
 * "No pintamos muebles" would look like a promise to paint furniture and the
 * one sentence the configuration tells the bot to say would be refused.
 */
describe("declining the work in Spanish is not a promise to do it", () => {
  it.each([
    "No pintamos muebles, pero podemos ayudarle con el interior.",
    "Creo que no podemos ayudar con este proyecto. Sí cubrimos pintura interior y exterior.",
  ])("does not refuse %j", (text) => {
    expect(promisesOutOfScopeWork(text)).toBe(false);
  });
});
