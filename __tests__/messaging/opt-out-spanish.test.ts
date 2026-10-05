import { describe, it, expect } from "vitest";
import { classifyInbound, isPlainLanguageOptOut, optOutSource } from "@/lib/messaging/compliance";

/**
 * A24 IN SPANISH.
 *
 * "Any clear 'STOP', 'stop', or PLAIN-LANGUAGE REQUEST to end or halt
 * communication STOPS all further text outreach immediately."
 *
 * The carrier keywords are language-neutral — a Spanish speaker texting STOP
 * was always honoured. The plain-language half was English-only, so
 * "no me manden más mensajes" came back `normal` and the bot carried on
 * texting somebody who had asked it to stop. The file prices that at
 * $500-$1500 per message, and it is the same bill in either language.
 */
describe("a Spanish speaker can opt out in words", () => {
  it.each([
    "dejen de mandarme mensajes",
    "deje de escribirme por favor",
    "paren de llamarme",
    "no me manden mas mensajes",
    "no me manden más mensajes",
    "no me escriban mas",
    "no me vuelvan a contactar",
    "no quiero más mensajes",
    "quítenme de la lista",
    "quitenme de su lista",
    "sáquenme de la lista por favor",
    "borren mi número",
    "déjenme en paz",
    "dejenme tranquilo",
    "no me molesten",
    "quiero darme de baja",
  ])("treats %j as an opt-out", (text) => {
    expect(isPlainLanguageOptOut(text)).toBe(true);
    expect(classifyInbound(text)).toBe("opt_out");
  });

  it("records it as a phrase, not a carrier keyword", () => {
    expect(optOutSource("dejen de mandarme mensajes")).toBe("inbound_phrase");
  });
});

/**
 * AN OPT-OUT IS NOT A DECLINE, and this is the half that would cost more than
 * the bug. "No thanks" declines the SERVICE — A17, close warmly. Reading a
 * Spanish decline as an opt-out suppresses the number permanently and a live
 * lead is lost with no way to recover it, since suppression is deliberately
 * hard to undo.
 */
describe("declining the work in Spanish is not an opt-out", () => {
  it.each([
    "No gracias, ya contratamos a alguien más",
    "ya no me interesa",
    "no por ahora, gracias",
    "ya conseguimos a otra persona",
    "creo que no, gracias",
    "no estoy seguro todavía",
    "no tengo el presupuesto ahora",
  ])("leaves %j as a normal message", (text) => {
    expect(isPlainLanguageOptOut(text)).toBe(false);
    expect(classifyInbound(text)).toBe("normal");
  });

  /**
   * The Spanish mirror of "stop by tomorrow" and "please don't cancel my
   * appointment": ordinary sentences that contain a stop word or the word
   * "lista" without asking us to stop texting.
   */
  it.each([
    "pueden parar en la casa primero?",
    "quiero cancelar mi cita del jueves",
    "está lista la cotización?",
    "ya estoy listo para empezar",
    "me manda el presupuesto por favor",
    "déjenme ver con mi esposa y les aviso",
  ])("does not read %j as an opt-out", (text) => {
    expect(isPlainLanguageOptOut(text)).toBe(false);
  });
});

/** English is untouched. */
describe("the English patterns still work", () => {
  it.each(["stop texting me", "take me off your list", "leave me alone", "unsubscribe"])(
    "%j is still an opt-out", (text) => {
      expect(classifyInbound(text)).toBe("opt_out");
    }
  );

  it.each(["stop by tomorrow", "can you stop at the house first", "no thanks we hired someone"])(
    "%j is still normal", (text) => {
      expect(classifyInbound(text)).toBe("normal");
    }
  );
});
