import { describe, it, expect } from "vitest";
import { asksOurAvailability, isAvailabilityStandOff } from "@/lib/messaging/availability-ask";
import { returningCustomerDeclining } from "@/lib/messaging/returning-customer";
import { mentionsSecondProperty } from "@/lib/messaging/multi-property";
import { tooManyAsks } from "@/lib/messaging/one-ask";
import { offsiteReasonFor } from "@/lib/messaging/offsite";
import { renderMessage, rapportIsRedundant } from "@/lib/messaging/render";
import { validateAction, BARE_ACKNOWLEDGEMENT } from "@/lib/messaging/agent-output";

/**
 * THE TEMPLATES WERE TRANSLATED. THE MATCHERS THAT GATE THEM WERE NOT.
 *
 * Every Spanish string in render-es.ts was written, reviewed by Mac and
 * Jasmine, and shipped. The regexes that decide WHEN each of them is used
 * stayed English-only, so a rule can hold perfectly in English and be
 * unenforceable in Spanish — and the Spanish half is silent about it, because
 * a matcher that never fires looks exactly like a situation that never arose.
 *
 * Each case below is a thing a Spanish-speaking lead says that the English
 * equivalent of already handles correctly.
 */

describe("the availability stand-off is enforceable in Spanish", () => {
  /**
   * Hatch's rule: "if they insist on knowing OUR availability before giving
   * theirs, End: Schedule Follow Up." Enforced off asksOurAvailability, which
   * could not match a word of Spanish — so a Spanish lead who asked us twice
   * was asked a third and a fourth time for times they had twice requested.
   */
  it("recognises a customer asking for OUR times", () => {
    for (const q of [
      "qué días tienen disponibles?",
      "cuándo pueden venir?",
      "que horarios tienen?",
      "cual es su disponibilidad?",
    ]) {
      expect(asksOurAvailability(q), q).toBe(true);
    }
  });

  it("still knows when they gave their OWN times instead", () => {
    // The stand-off is about them asking US. Somebody answering is not it.
    expect(asksOurAvailability("el martes por la mañana me sirve")).toBe(false);
    expect(isAvailabilityStandOff(["qué días tienen?", "el martes me sirve"])).toBe(false);
  });

  it("fires after they have asked twice", () => {
    expect(isAvailabilityStandOff(["cuándo pueden venir?", "qué horarios tienen?"])).toBe(true);
  });
});

describe("the repeat customer is recognised in Spanish", () => {
  /**
   * returningCustomerReplyEs() exists, is approved, and was unreachable: the
   * matcher that leads to it is English-only, so the one person we should
   * never re-interrogate — somebody we have already painted for — got the
   * plain ask again.
   */
  it("knows they have worked with us before and would rather not repeat it", () => {
    // BOTH halves, as the English rule requires: having used PPP before, and
    // not wanting to type it again. One alone is a returning customer giving
    // us work, or an ordinary customer being terse.
    for (const t of [
      "ustedes ya pintaron mi casa el año pasado, ya tienen mi dirección",
      "ya soy cliente, no quiero repetir todo",
      "la vez pasada ya les di esa información",
    ]) {
      expect(returningCustomerDeclining(t), t).toBe(true);
    }
  });

  it("needs both halves, the same as the English rule", () => {
    // Used us before, but giving us new work: not a refusal.
    expect(returningCustomerDeclining("ustedes pintaron mi cocina el año pasado y ahora quiero el deck")).toBe(false);
    // Terse, but no history with us.
    expect(returningCustomerDeclining("ya les di esa información")).toBe(false);
  });

  it("does not fire on an ordinary new lead", () => {
    expect(returningCustomerDeclining("quiero pintar mi cocina")).toBe(false);
  });
});

describe("a second property is seen in Spanish", () => {
  /**
   * Without this the conversation closes as booked for one house and the
   * second job is lost with nothing looking wrong.
   */
  it("notices two properties in one message", () => {
    for (const t of [
      "tengo dos casas, una en Garden City y otra en Hempstead",
      "son dos propiedades diferentes",
      "también tengo otro departamento",
    ]) {
      expect(mentionsSecondProperty(t), t).toBe(true);
    }
  });

  it("does not fire on one property", () => {
    expect(mentionsSecondProperty("quiero pintar mi casa")).toBe(false);
  });
});

describe("A22 counts asks in Spanish", () => {
  it("catches three fields stacked into one message", () => {
    expect(tooManyAsks("Cuál es su nombre, su correo electrónico y la dirección del proyecto?")).not.toBeNull();
  });

  it("leaves a single ask alone", () => {
    expect(tooManyAsks("Cuál es la dirección del proyecto?")).toBeNull();
  });
});

describe("the trailing availability question is stripped in Spanish too", () => {
  /**
   * defer_to_estimator's Spanish template ends "Mientras tanto, qué días le
   * funcionan mejor?" and the stripper's matcher was English, so a Spanish
   * lead was asked for appointment days at stage 0 — the exact breach the
   * English path documents having fixed.
   */
  it("does not ask for days before the fourth leg", () => {
    const out = renderMessage({
      intent: "defer_to_estimator", language: "es", flowStage: 0, track: "new_lead", turn: 0,
    });
    expect(out).not.toMatch(/qué días|que días|qué horarios|que horarios/i);
    expect(out.trim()).not.toBe("");
  });
});

describe("the acknowledgement rules apply in Spanish", () => {
  /**
   * SAYS[acknowledge] opens "Entendido, gracias." and the model's rapport
   * often opens the same way. rapportIsRedundant drops the duplicate — in
   * English. BARE_ACKNOWLEDGEMENT and OPENS_WITH_ACKNOWLEDGEMENT were both
   * English-only, so the customer got it twice in one message: the "Got it.
   * Got it." bug, untranslated.
   *
   * And the same matcher decides `saysSomething` in validateAction, so a
   * Spanish pleasantry counted as an ANSWER to a direct question, which is
   * precisely what A29 exists to catch.
   */
  /**
   * The outcome test below only fails when BOTH matchers lose their Spanish —
   * the two guards overlap, so either one alone still catches it. Checked:
   * cutting one leaves the message correct, cutting both produces
   * "Entendido, gracias. Entendido, gracias." So each is pinned directly as
   * well, or half this fix could be deleted with every test still green.
   */
  it("BARE_ACKNOWLEDGEMENT reads Spanish", () => {
    for (const t of ["Entendido, gracias.", "Perfecto, gracias.", "Muy bien.", "Claro!"]) {
      expect(BARE_ACKNOWLEDGEMENT.test(t), t).toBe(true);
    }
    // Still not a blanket pass: a sentence that says something is not bare.
    expect(BARE_ACKNOWLEDGEMENT.test("Entendido, la direccion es 12 Hilton Ave.")).toBe(false);
  });

  it("the redundancy rule sees a Spanish opener", () => {
    expect(rapportIsRedundant("Entendido, gracias.", "Entendido, gracias.")).toBe(true);
    expect(rapportIsRedundant("Perfecto.", "Entendido, gracias.")).toBe(true);
    // And leaves substantive rapport alone.
    expect(rapportIsRedundant("El estimador revisa eso con usted.", "Entendido, gracias.")).toBe(false);
  });

  it("does not say the same acknowledgement twice", () => {
    const out = renderMessage({
      intent: "acknowledge", language: "es", freeText: "Entendido, gracias.", turn: 0,
    });
    expect(out.toLowerCase().match(/entendido/g)?.length ?? 0).toBeLessThan(2);
    expect(out.trim()).not.toBe("");
  });

  it("a Spanish pleasantry is not an answer to a question", () => {
    const v = validateAction(
      { intent: "ask_address", freeText: "Perfecto, gracias.", confidence: 0.9 },
      { customerText: "cuánto cuesta pintar una recámara?" }
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("question_left_unanswered");
  });
});

describe("the off-site offer can be made in Spanish", () => {
  /**
   * The reason is a MANDATED slot: without it the A7 template refuses to
   * render, which the renderer calls correct — "A7 without its reason is just
   * A6 said in the wrong situation". The qualifiers were English-only, so for
   * a Spanish lead the reason was always null, the offer always rendered
   * empty, and every Spanish A7 escalated.
   *
   * A7 is the route for precisely the customers who cannot meet — out of
   * state, no access to the property, a price only — so the people it exists
   * for were the ones it never reached.
   */
  it("recognises the qualifiers in Spanish", () => {
    for (const t of [
      "estoy fuera del estado, no puedo estar en la propiedad",
      "solo quiero un precio aproximado",
      "le mandé fotos, puede cotizar con las fotos?",
      "que me llame el estimador mejor",
    ]) {
      expect(offsiteReasonFor(t, "es"), t).not.toBeNull();
    }
  });

  it("says the reason in the language the template is written in", () => {
    const es = offsiteReasonFor("solo quiero un precio aproximado", "es");
    expect(es).toMatch(/precio aproximado/i);
    // Half-English inside a Spanish sentence is worse than the escalation.
    expect(es).not.toMatch(/you/i);
  });

  it("renders the whole offer rather than nothing", () => {
    const out = renderMessage({
      intent: "offer_offsite_quote", language: "es",
      offsiteReason: offsiteReasonFor("solo quiero un precio aproximado", "es"),
      turn: 0,
    });
    expect(out.trim()).not.toBe("");
    expect(out).toMatch(/cotizaci/i);
  });

  it("leaves English alone", () => {
    expect(offsiteReasonFor("I just want a ballpark price")).toMatch(/rough price/i);
  });
});

/**
 * STRIPPING A QUESTION MUST NOT LEAVE AN APOLOGY ON ITS OWN.
 *
 * The Spanish timing matcher arrived with bare `mejor`, `sirve` and
 * `conviene`. None has an English counterpart — the English side matches the
 * phrase "work best", never the bare word "best" — and each carries a
 * commoner meaning that is not about timing. Two real templates paid for it:
 *
 *   acknowledge_negative[0]  "Disculpe. ¿Qué le funcionaría mejor?"  matched
 *                            on `mejor`, and the whole message PPP sent was
 *                            the single word "Disculpe."
 *   offer_estimator_call[0]  "…coordinar los detalles. ¿Le sirve?"   matched
 *                            on `sirve`, turning a consent question into an
 *                            assertion with nothing asked.
 *
 * Both reachable on ANY track, because availabilityStandOff strips regardless
 * of flowStage, and nurture intents never get the backfill ask.
 */
describe("the Spanish timing strip does not eat questions that are not about timing", () => {
  it("never sends a bare apology as the whole message", () => {
    const out = renderMessage({
      intent: "acknowledge_negative", language: "es", turn: 0,
      availabilityStandOff: true,
    });
    expect(out.trim()).not.toBe("Disculpe.");
    expect(BARE_ACKNOWLEDGEMENT.test(out.trim()), `the whole message was a pleasantry: ${out}`).toBe(false);
  });

  it("leaves a consent question asking something", () => {
    const out = renderMessage({
      intent: "offer_estimator_call", language: "es", turn: 0,
      availabilityStandOff: true,
    });
    expect(out, `nothing was asked: ${out}`).toMatch(/\?/);
  });

  /**
   * And the question that started all of this still goes. "¿Qué días le
   * funcionan mejor?" is a timing question because of `días`, which is the
   * word that makes it one — so narrowing `mejor` costs nothing here.
   */
  it("still suppresses a real Spanish availability ask at stage 0", () => {
    const out = renderMessage({
      intent: "defer_to_estimator", language: "es", flowStage: 0, track: "new_lead", turn: 0,
    });
    expect(out).not.toMatch(/qué días|que días|qué horarios|que horarios/i);
    expect(out.trim()).not.toBe("");
  });

  it.each([
    // Timing, and still stripped. `días`, `hora`, `horario` and
    // `disponibilidad` are the words that make these questions about WHEN, and
    // none of them moved.
    ["Qué días le funcionan mejor?", true],
    ["A qué hora le conviene?", true],
    ["Cuál horario le queda mejor?", true],
    ["Tiene disponibilidad esta semana?", true],
    // Not timing, and no longer stripped. Every one of these used to be, each
    // on a single bare word that also means something else.
    ["Le sirve?", false],
    ["Le parece bien el precio?", false],
    ["Le conviene el presupuesto?", false],
    ["Prefiere que pintemos mejor el exterior?", false],
  ])("reads %j as a timing question: %s", (text, isTiming) => {
    /**
     * Driven through the renderer rather than the private matcher, so what is
     * asserted is the behaviour and not an implementation detail.
     *
     * AND THE PREFIX HAS TO SAY SOMETHING. The first version of this used
     * "Claro." — which `acknowledge` drops as redundant rapport, so every case
     * rendered the plain template, the question was never in the output at
     * all, and the four timing rows "passed" without exercising anything. A
     * test whose subject never reaches the code under test agrees with
     * whatever it is told.
     */
    const out = renderMessage({
      intent: "acknowledge", language: "es",
      freeText: `El equipo puede ayudarle con eso. ${text}`, turn: 0,
      availabilityStandOff: true,
    });
    expect(out, "the prefix did not survive, so this case proves nothing")
      .toContain("El equipo puede ayudarle con eso.");
    const survived = out.includes(text);
    expect(survived, `${text} — expected ${isTiming ? "stripped" : "kept"}, got ${JSON.stringify(out)}`)
      .toBe(!isTiming);
  });
});
