import { describe, it, expect } from "vitest";
import { languageOf, conversationLanguage } from "@/lib/messaging/language";
import { renderMessage, SILENT_INTENTS } from "@/lib/messaging/render";
import { SAYS_ES } from "@/lib/messaging/render-es";
import { tooManyAsks } from "@/lib/messaging/one-ask";
import { END_INTENTS, CONTINUE_INTENTS, type Intent } from "@/lib/messaging/agent-output";

const ALL: Intent[] = [...END_INTENTS, ...CONTINUE_INTENTS];

/**
 * A30 — "Reply in the customer's language." Live and critical, and the rule
 * card calls the old behaviour what it was: "Guard B12 (other languages ->
 * End: Transferred) is the splint over it."
 *
 * The bug that started this, seen in the simulator: a customer wrote "Hola,
 * necesito pintar mi casa por dentro. No hablo ingles" and got back "Hola!
 * Con gusto le ayudo. What are you looking to have painted?" — the greeting
 * in one language and the question in the other.
 */
describe("A30 — detecting the customer's language", () => {
  it("reads Spanish, including from two words", () => {
    for (const t of [
      "Hola, necesito pintar mi casa por dentro",
      // The corpus trigger named in the rule card.
      "Sábado 9:30 am",
      "Hola",
      "¿Cuánto cuesta?",
      "Buenos dias, quiero un presupuesto",
      "No hablo ingles",
      "Mi direccion es 12 Oak St",
    ]) {
      expect(languageOf(t), t).toBe("es");
    }
  });

  /**
   * THE EXPENSIVE DIRECTION. Answering a fluent English speaker in Spanish is
   * worse than the handover this replaces, so a Spanish word inside an
   * English sentence must not decide it.
   *
   * "exterior and interior painting please" was read as Spanish, because both
   * words are spelled the same in both languages and the first version
   * counted them.
   */
  it("does not turn an English message Spanish on one word", () => {
    for (const t of [
      "Hi, looking for a quote on my kitchen",
      "ok", "yes that works", "11530",
      "I need my living room and hallway painted, about 600 sq ft",
      "exterior and interior painting please",
      "my name is Jose Rodriguez",
      "La Casa Blanca restaurant on Main St",
      "Hi there, hola is all the Spanish I know but I need an estimate for my house",
    ]) {
      expect(languageOf(t), t).toBe(null);
    }
  });

  /** "Do not switch back to English on the next turn." */
  it("keeps the language once the customer has set it", () => {
    expect(conversationLanguage(["Hola, necesito pintar mi casa", "ok"])).toBe("es");
    expect(conversationLanguage(["Hi", "necesito pintar la cocina"])).toBe("es");
    expect(conversationLanguage(["Hi", "yes", "ok"])).toBe("en");
  });
});

describe("A30 — the Spanish templates", () => {
  const known = {
    address: "12 Oak St, Garden City, NY 11530", phone: "999-784-6046",
    email: "tom@example.com", scope: "pintar la cocina", zip: "11530", state: "Florida",
  };

  /** A new intent with no Spanish words is an empty text to a customer. */
  it("has words for every intent that speaks", () => {
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      if (intent === "answer_question") continue; // the rapport IS the answer
      if (intent === "discard") continue; // covered in render.test.ts, needs a scope
      const out = renderMessage({
        intent, known, language: "es",
        offsiteReason: "no puede estar en la propiedad",
      });
      expect(out.length, intent).toBeGreaterThan(0);
    }
  });

  /**
   * The same safety property as the English table. The model cannot put a
   * price or a time into an outgoing message because it does not write them —
   * so the only way one appears is if somebody typed it here.
   */
  it("quotes no price and offers no specific time", () => {
    for (const intent of ALL) {
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({ intent, turn, known, language: "es" });
        expect(out, `${intent}/${turn}`).not.toMatch(/\$|\b\d+\s*(?:dolares|usd)\b/i);
        expect(out, `${intent}/${turn}`).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
        expect(out, `${intent}/${turn}`).not.toMatch(/\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i);
      }
    }
  });

  /** A22 binds in Spanish too. */
  it("asks for one thing at a time", () => {
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({
          intent, turn, known, language: "es",
          offsiteReason: "no puede estar en la propiedad",
        });
        if (!out) continue;
        expect(tooManyAsks(out), `${intent}/${turn}: ${out}`).toBeNull();
      }
    }
  });

  /** A23 binds in Spanish too: no em dash, no ellipsis. */
  it("sounds like the house", () => {
    for (const list of Object.values(SAYS_ES)) {
      for (const t of list) {
        expect(t, t).not.toMatch(/[—–]/);
        expect(t, t).not.toMatch(/\.\.\.|…/);
      }
    }
  });

  /** Every slot the English table fills, spelled the same way. */
  it("uses the same slot names, so the same filler works", () => {
    const slots = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
    for (const intent of ["confirm_address", "confirm_contact", "confirm_scope", "area_not_serviced", "offer_offsite_quote"] as const) {
      const en = renderMessage({ intent, turn: 0, known, offsiteReason: "x" });
      const es = renderMessage({ intent, turn: 0, known, offsiteReason: "x", language: "es" });
      // Both rendered something, and neither left a slot unfilled.
      expect(en.length, intent).toBeGreaterThan(0);
      expect(es.length, intent).toBeGreaterThan(0);
      expect(slots(es), intent).toBe("");
      expect(slots(en), intent).toBe("");
    }
  });

  /** And the whole point: one language per message, never half of each. */
  it("does not mix English into a Spanish message", () => {
    const englishGiveaways = /\b(?:what|would|your|the|and|please|thanks|project|address|email)\b/i;
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({
          intent, turn, known, language: "es",
          offsiteReason: "no puede estar en la propiedad",
        });
        if (!out) continue;
        // The address slot carries a real US address, so strip the filled
        // values before reading the sentence around them.
        const sentence = out.replace(known.address, "").replace(known.email, "");
        expect(sentence, `${intent}/${turn}: ${out}`).not.toMatch(englishGiveaways);
      }
    }
  });
});
