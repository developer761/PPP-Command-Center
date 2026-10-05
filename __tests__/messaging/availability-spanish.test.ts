import { describe, it, expect } from "vitest";
import { availabilityGap, availabilityGapAcross } from "@/lib/messaging/availability";

/**
 * A4 IN SPANISH.
 *
 * Played live 2026-10-05: a conversation ran entirely in Spanish, the customer
 * answered the availability question with "el miércoles", and the close was
 * refused — "no day and no time of day has been given anywhere in the
 * conversation (A4)". Wednesday HAD been given.
 *
 * Two costs. The obvious one is that a Spanish lead who answered every
 * question still gets handed to a person: the unsatisfiable shape where the
 * best lead is the one that cannot convert. The quieter one is that
 * ASK_AVAILABILITY_GAP_ES — the Spanish "and roughly what time of day?" —
 * could never fire, because the gap only becomes "window" once a DAY has been
 * found. A whole set of translated templates was unreachable, not just unused.
 */
describe("a day named in Spanish is a day", () => {
  it.each([
    "el miércoles",
    "el miercoles",
    "lunes o martes",
    "el jueves me funciona",
    "viernes",
    "el sábado",
    "los domingos",
    "mañana",
    "pasado mañana",
    "hoy",
    "entre semana",
    "el fin de semana",
    "la próxima semana",
  ])("reads %j as a day with no window", (text) => {
    // "window" means the DAY was found and the time of day is what is missing.
    expect(availabilityGap(text)).toBe("window");
  });

  it.each([
    "el miércoles por la mañana",
    "el jueves por la tarde",
    "mañana por la mañana",
    "lunes a las 2",
    "el viernes a las 10:30",
    "el martes temprano",
    "miércoles al mediodía",
  ])("reads %j as complete", (text) => {
    expect(availabilityGap(text)).toBe(null);
  });

  it.each([
    "por la mañana",
    "en la tarde",
    "a las 3",
  ])("reads %j as a time with no day", (text) => {
    expect(availabilityGap(text)).toBe("day");
  });

  it.each([
    "cuando sea",
    "cuando guste",
    "cualquier día",
    "a cualquier hora",
    "soy flexible",
    "lo que le convenga",
  ])("treats %j as nothing left to narrow", (text) => {
    expect(availabilityGap(text)).toBe(null);
  });
});

/**
 * THE FALSE POSITIVES THAT WOULD COST MORE THAN THE BUG.
 *
 * A wrongly-detected day lets a conversation close as BOOKED against nothing,
 * which is the whole thing A4 exists to stop. These are the Spanish sentences
 * a painting customer actually types that contain day- or time-shaped words
 * without naming availability.
 */
describe("does not invent availability out of ordinary Spanish", () => {
  it.each([
    "Hola, necesito pintar el interior de mi casa, tres recámaras y el pasillo",
    "Quiero pintar el exterior de mi vivienda",
    "quería saber sobre un estimado de cuánto me saldría el costo",
    "12 Oak St, Garden City NY 11530",
    "Ana Ruiz, ana@example.com",
    "prefiero no dar mi dirección por mensaje",
    "pintan muebles?",
  ])("finds nothing in %j", (text) => {
    expect(availabilityGap(text)).toBe("both");
  });

  /**
   * "mañana" is TOMORROW on its own and MORNING only with the article and a
   * preposition. Both senses are real and this is the line between them.
   */
  it("tells tomorrow from the morning", () => {
    expect(availabilityGap("mañana")).toBe("window");          // a day, no time
    expect(availabilityGap("por la mañana")).toBe("day");      // a time, no day
    expect(availabilityGap("mañana por la mañana")).toBe(null); // both
  });

  /** "tarde" alone is "late", not an afternoon. */
  it("does not read a bare 'tarde' as an afternoon", () => {
    expect(availabilityGap("llegué tarde")).toBe("both");
    expect(availabilityGap("por la tarde")).toBe("day");
  });
});

/**
 * ACROSS THE THREAD, which is how the validator actually asks. The day and the
 * window arrive in separate messages as often as not.
 */
describe("the two halves can arrive in different Spanish messages", () => {
  it("accumulates a day then a window", () => {
    expect(availabilityGapAcross(["el miércoles"])).toBe("window");
    expect(availabilityGapAcross(["el miércoles", "por la tarde"])).toBe(null);
  });

  it("works in the other order", () => {
    expect(availabilityGapAcross(["por la mañana"])).toBe("day");
    expect(availabilityGapAcross(["por la mañana", "el jueves"])).toBe(null);
  });

  it("still reports both missing when neither was said", () => {
    expect(availabilityGapAcross(["Hola", "necesito pintar mi casa"])).toBe("both");
  });
});
