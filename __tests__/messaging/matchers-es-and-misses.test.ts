/**
 * FIVE MATCHERS THAT MISSED KATE'S OWN WORDS, MOSTLY IN SPANISH. 2026-10-16.
 *
 * Every input below is either a phrasing Kate wrote in the rule card itself
 * (2026-09-28 RULES sheet) or its plain Spanish twin. Each block carries a
 * CONTROL — a phrasing that already worked, or one that must keep NOT
 * matching — because a widened pattern that also catches the wrong thing is
 * the commoner failure here than a narrow one.
 *
 *   A6  jobRoute: Spanish rooms and doors routed nowhere
 *   A7  offsiteReasonFor: "today/tomorrow" and "call me about the estimate
 *       instead of coming out" had no qualifier, so offer_offsite_quote
 *       rendered "" and escalated
 *   A17 declinesTheWork: three of Kate's three examples, and all Spanish
 *   A40 parkKind / asksNotToBeChased: two of Kate's bare deferrals, and the
 *       Spanish no-chase
 *   A25 statedChannelPreference / ASKED_FOR_A_CALL: Spanish, and "give me a
 *       call tomorrow at 3"
 */
import { describe, it, expect } from "vitest";
import { jobRoute, roomCount, offsiteReasonFor } from "@/lib/messaging/offsite";
import { declinesTheWork, parkKind, asksNotToBeChased } from "@/lib/messaging/parking";
import { statedChannelPreference } from "@/lib/messaging/channel-preference";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";
import { requestedTime } from "@/lib/messaging/appointment-time";

const act = (intent: string) => ({ intent, confidence: 0.95, freeText: "" });

describe("A6 — Spanish job vocabulary routes", () => {
  it.each([
    ["una recamara", "offsite"],
    ["una recámara", "offsite"],
    ["pintar un cuarto", "offsite"],
    ["la habitación de mi hija", "offsite"],
    ["la sala y el comedor", "onsite"],
    ["tres recámaras", "onsite"],
    ["la cocina y dos baños", "onsite"],
    ["pintar la puerta principal", "offsite"],
    ["la cerca del patio", "offsite"],
    ["los gabinetes de la cocina", "onsite"],
    ["el exterior de la casa", "onsite"],
    ["el interior de la casa", "onsite"],
  ])("%j routes %s", (scope, route) => {
    expect(jobRoute(scope)?.route ?? null).toBe(route);
  });

  it("counts Spanish rooms", () => {
    expect(roomCount("una recamara")).toBe(1);
    expect(roomCount("dos cuartos")).toBe(2);
    expect(roomCount("la habitación y las habitaciones")).toBe(1);
  });

  it("routes a named exterior item with no verb, in English too", () => {
    expect(jobRoute("the front door")?.route).toBe("offsite");
    expect(jobRoute("our garage door")?.route).toBe("offsite");
  });

  it("CONTROL: the English twin still routes, and scheduling still does not", () => {
    expect(jobRoute("one bedroom")?.route).toBe("offsite");
    expect(jobRoute("Sure, I'm home all day, please let me know before coming")).toBeNull();
    expect(jobRoute("I'll leave the door open for you")).toBeNull();
    expect(jobRoute("estoy en casa todo el día")).toBeNull();
  });

  it("the commercial gate speaks Spanish too, so the new room words cannot route a business off-site", () => {
    expect(jobRoute("la sala de espera del consultorio")?.route).toBe("onsite");
    expect(jobRoute("pintar una oficina en el local comercial")?.route).toBe("onsite");
    // CONTROL: where somebody lives is never commercial (A6 [6]).
    expect(jobRoute("una recámara en mi departamento")?.route).toBe("offsite");
  });
});

describe("A7 — urgency and a call about the estimate qualify", () => {
  const offer = (said: string, language: "en" | "es" = "en") =>
    renderMessage({ intent: "offer_offsite_quote", turn: 0, language, offsiteReason: offsiteReasonFor(said, language) ?? undefined });

  it.each([
    "I need the quote today",
    "can I get the estimate by tomorrow?",
    "I need a price ASAP",
    "can the estimator just call me about the estimate instead of coming out",
    "could someone call me about the quote instead of a visit",
  ])("%j renders an offer, not an empty escalation", (said) => {
    expect(offsiteReasonFor(said, "en")).not.toBeNull();
    expect(offer(said)).not.toBe("");
  });

  it.each([
    "necesito la cotización hoy",
    "me puede dar el presupuesto mañana?",
    "que el estimador me llame en vez de venir",
    "mejor llámenme sobre el presupuesto en lugar de la visita",
  ])("Spanish %j qualifies", (said) => {
    expect(offsiteReasonFor(said, "es")).not.toBeNull();
    expect(offer(said, "es")).not.toBe("");
  });

  it("CONTROL: a visit tomorrow, or a call about this thread, is not a remote-quote reason", () => {
    expect(offsiteReasonFor("can you come out tomorrow for an estimate?", "en")).toBeNull();
    expect(offsiteReasonFor("could I get an estimate appointment tomorrow", "en")).toBeNull();
    expect(offsiteReasonFor("please call me instead of texting", "en")).toBeNull();
    expect(offsiteReasonFor("I'm out of state", "en")).toBe("you're not able to be at the property");
  });
});

describe("A17 — Kate's three declines, and Spanish", () => {
  const ctx = (customerText: string, over: Record<string, unknown> = {}) => ({
    customerText,
    knownFields: { address: true, inquiryScope: true },
    addressGap: null,
    templateAsks: () => false,
    customerMessages: [],
    flowStage: 3,
    ...over,
  }) as never;

  it.each([
    "no, I'll do the project myself",
    "I'm all set, thank you",
    "probably not",
    "no gracias",
    "ya no, gracias",
    "lo voy a hacer yo mismo",
    "ya lo resolví",
    "no me interesa",
  ])("%j is a decline and refuses the next ask", (said) => {
    expect(declinesTheWork(said)).toBe(true);
    const v = validateAction(act("ask_contact"), ctx(said));
    expect(v.ok === false && v.reason).toBe("pursued_after_a_decline");
  });

  it("CONTROL: the decline that already worked still does", () => {
    expect(validateAction(act("ask_contact"), ctx("not interested, no thanks")).ok).toBe(false);
  });

  it("CONTROL: not a decline", () => {
    for (const t of [
      "probably not until March",
      "probably not the ceilings, just the walls",
      "no gracias a los gabinetes, solo los cuartos",
      "I'll paint the trim myself, you do the walls",
    ]) expect(declinesTheWork(t), t).toBe(false);
  });

  it("'I'm all set' right after a booking confirmation is thanks, not a decline", () => {
    for (const lastIntent of ["success", "accepted"]) {
      const v = validateAction(
        act("accepted"),
        ctx("I'm all set, thank you", { lastIntent, priorIntents: [lastIntent] }),
      );
      expect(v.ok === false && v.reason, lastIntent).not.toBe("recorded_a_decline_as_acceptance");
    }
    expect(declinesTheWork("I'm all set, thank you", { afterBookingConfirmed: true })).toBe(false);
    // A real decline is still one after a booking.
    expect(declinesTheWork("not interested anymore", { afterBookingConfirmed: true })).toBe(true);
  });
});

describe("A40 — Kate's bare deferrals park the conversation", () => {
  const deferredBy = (said: string) => ({ customerMessages: [said], customerText: "ok" });

  it.each([
    "let me get back once I've spoken to my wife",
    "not ready yet",
    "we're not ready to book yet",
    "yo le aviso despues, tengo que hablar con mi esposa",
    "todavía no estoy lista, luego les escribo",
  ])("%j stops collection", (said) => {
    expect(parkKind(said)).toBe("conversation");
    const v = validateAction(act("ask_contact"), deferredBy(said));
    expect(v.ok === false && v.reason).toBe("pressed_after_deferral");
  });

  it("Spanish field parks read as a field", () => {
    expect(parkKind("estoy disponible en marzo pero tengo que hablar con mi esposo")).toBe("field");
    expect(parkKind("no estoy segura de las fechas")).toBe("field");
  });

  it("CONTROL: the deferral that already worked, and things that are not parks", () => {
    expect(parkKind("I'll get back to you")).toBe("conversation");
    expect(parkKind("the room is not ready yet for paint, it needs drying")).not.toBe("conversation");
    expect(parkKind("4821 Oak Lane")).toBeNull();
    // Present-tense Spanish that OPENS a conversation is not a deferral.
    expect(parkKind("le escribo para pedir una cotización")).toBeNull();
    expect(parkKind("me comunico para una cotización de pintura")).toBeNull();
    expect(parkKind("le aviso que mañana no estoy en casa")).toBeNull();
    expect(parkKind("no se puede pintar la cocina?")).toBeNull();
  });

  it("asks not to be chased, in Spanish", () => {
    expect(asksNotToBeChased("por favor no me den seguimiento")).toBe(true);
    expect(asksNotToBeChased("no hace falta que me den seguimiento, yo les escribo")).toBe(true);
    // CONTROLS
    expect(asksNotToBeChased("don't chase me, I'll reach out")).toBe(true);
    expect(asksNotToBeChased("yo le aviso despues")).toBe(false);
    expect(asksNotToBeChased("I'll get back to you")).toBe(false);
  });
});

describe("A25 — Spanish, and a call with a time in it", () => {
  it("reads a Spanish text-only preference", () => {
    expect(statedChannelPreference("solo mensajes por favor, no me llamen")).toBe("text_only");
    expect(statedChannelPreference("prefiero por correo, no me manden mensajes")).toBe("email_only");
  });

  it("refuses the handoff for a Spanish text-only customer, as for the English one", () => {
    const v = validateAction(act("transferred"), { customerText: "solo mensajes por favor, no me llamen" });
    expect(v.ok === false && v.reason).toBe("transferred_a_text_only_customer");
    // CONTROL: the English twin already refused.
    const en = validateAction(act("transferred"), { customerText: "text only please, don't call" });
    expect(en.ok === false && en.reason).toBe("transferred_a_text_only_customer");
  });

  it("reads a Spanish call request and asks when to call", () => {
    expect(statedChannelPreference("mejor llámenme")).toBe("phone");
    const out = renderMessage({ intent: "schedule_follow_up", turn: 0, language: "es", customerText: "mejor llámenme", callback: {} });
    expect(out).toMatch(/hora|momento/i);
  });

  it("reads 'give me a call tomorrow at 3' as a call request", () => {
    const said = "give me a call tomorrow at 3";
    expect(statedChannelPreference(said)).toBe("phone");
    // Through the renderer the way agent-run feeds it: the time is held, and
    // 3 is an afternoon hour inside the window, so it neither re-asks nor
    // corrects them with the office hours.
    const out = renderMessage({
      intent: "schedule_follow_up", turn: 0, customerText: said,
      callback: { requestedHour: requestedTime(said)?.hour ?? null },
    });
    expect(out).not.toBe("");
    expect(out).not.toMatch(/good time to reach you|best time to give you a call/i);
    expect(out).not.toMatch(/between/i);
  });

  it("CONTROLS", () => {
    expect(statedChannelPreference("please call me instead of texting")).toBe("phone");
    expect(statedChannelPreference("mándenme la cotización por correo")).toBeNull();
    expect(statedChannelPreference("le mando las fotos por mensaje")).toBeNull();
    expect(statedChannelPreference("give us a call")).toBeNull();
    // "solo" qualifying the wanting, not the channel.
    expect(statedChannelPreference("solo quería mandar un mensaje para preguntar algo")).toBeNull();
    expect(statedChannelPreference("I just wanted to text to ask a question")).toBeNull();
    expect(statedChannelPreference("mensajes nada más")).toBe("text_only");
  });
});
