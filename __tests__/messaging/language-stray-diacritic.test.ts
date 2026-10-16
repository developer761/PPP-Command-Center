import { describe, it, expect } from "vitest";
import { languageOf, conversationLanguage } from "@/lib/messaging/language";
import { normalizeInbound } from "@/lib/messaging/inbound-normalize";

/**
 * ENGLISH CUSTOMERS ANSWERED IN SPANISH FOR THE REST OF THE THREAD.
 *
 * Corpus audit, 2026-10-16. One accented letter decided the language before
 * anything checked for English around it, and the verdict latched for good.
 * Every one of these is a real English customer from Kate's corpus.
 */
describe("a stray diacritic does not make a message Spanish", () => {
  it.each([
    "fiancé",
    "My fiancé and I want the living room done",
    "ü600",
    "ü1800sf",
    "Can you give me an estímate?",
    "My name is Ana Muñoz",
    // The iOS reaction text from a phone set to Spanish. A tapback, not words.
    "Le gustó “What days work best for you this week?”",
    "Le gustó \"Is 12 Oak St the correct address?\"",
  ])("does not read %j as Spanish", (t) => {
    expect(languageOf(t)).not.toBe("es");
  });

  it.each([
    "Quiero pintar mi casa",
    "Quiero pintar…",
    "Hola, quiero un presupuesto",
    "Sábado 9:30 am",
    "¿Cuánto cuesta?",
    "Sí",
    "No, gracias, está bien",
    "Mañana",
  ])("still reads %j as Spanish", (t) => {
    expect(languageOf(t)).toBe("es");
  });

  it("does not keep an English customer in Spanish after one stray accent", () => {
    expect(conversationLanguage(["Can you give me an estímate?", "ok"])).toBe("en");
    expect(conversationLanguage(["ü1800sf", "yes"])).toBe("en");
    expect(conversationLanguage(["Le gustó “What days work best for you?”"])).toBe("en");
  });

  /**
   * ONE WEAK SIGNAL IS NOT A PERMANENT SWITCH. A lone "Hola" followed by a
   * full English sentence is the "hola is all the Spanish I know" customer.
   * A decisive Spanish message still latches, per A30.
   */
  it("lets clear English undo a tentative Spanish read, never a decisive one", () => {
    expect(conversationLanguage(["Hola", "I need my kitchen painted, can you come Tuesday?"])).toBe("en");
    expect(conversationLanguage(["Sábado 9:30 am", "ok", "sure"])).toBe("es");
    expect(conversationLanguage(["Hola, necesito pintar mi casa", "Thanks, the kitchen and the hall"])).toBe("es");
  });
});

describe("Spanish iOS reactions are reactions", () => {
  it.each([
    "Le gustó “What days work best for you?”",
    "Le encantó “Thanks!”",
    "No le gustó “What's the address?”",
  ])("normalises %j as a reaction", (t) => {
    const n = normalizeInbound(t);
    expect(n.kind).toBe("reaction");
    expect(n.text).toBeNull();
  });

  it("still treats an unquoted sentence as text", () => {
    expect(normalizeInbound("Le gustó la cocina a mi esposa").kind).toBe("text");
  });
});
