import { describe, it, expect } from "vitest";
import { classifyInbound, optOutSource } from "@/lib/messaging/compliance";
import { decideInbound } from "@/lib/messaging/inbound";

/**
 * A24 — OPT-OUTS THE AUDIT FOUND GOING TO THE AGENT, 2026-10-16.
 *
 * Replayed against Kate's real corpus, each of these classified as `normal`,
 * so the number stayed textable and the bot answered somebody who had asked
 * it to stop. STOP, "no more texts" and "No me escriba más" were caught; the
 * carrier-standard Spanish keywords and the plainest English ones were not.
 */
describe("opt-outs the corpus audit found unhonoured", () => {
  it.each(["ALTO", "Alto.", "PARAR", "parar", "BAJA", "Baja!", "CANCELAR", "DETENER"])(
    "honours the carrier keyword %j, recorded as a keyword",
    (t) => {
      expect(classifyInbound(t)).toBe("opt_out");
      expect(optOutSource(t)).toBe("inbound_keyword");
    },
  );

  it.each([
    "Ya no quiero recibir mensajes",
    "ya no quiero recibir sus mensajes",
    "No quiero recibir más mensajes, gracias",
    "no deseo recibir mensajes",
    "remove me",
    "Remove me please",
    "remove my number",
    "Please remove my number.",
    "lose my number",
    "please lose my number, not interested",
    // Already caught — pinned so the widening cannot lose them.
    "STOP",
    "no more texts",
    "No me escriba más",
  ])("honours %j", (t) => {
    expect(classifyInbound(t)).toBe("opt_out");
  });

  /**
   * THE COSTLY DIRECTION THE OTHER WAY. An opt-out false positive silences a
   * real lead for good, since suppression is deliberately hard to undo.
   */
  it.each([
    "please don't stop the work halfway",
    "can you remove the old wallpaper",
    "the number on the door is wrong",
    "can you remove the mirror before painting",
    "don't lose my number, I'll call next week",
    "did you lose my number? I never got the estimate",
    "el techo es muy alto",
    "es alto el techo, como 12 pies",
    "la pared baja del jardín también",
    "quiero cancelar mi cita del jueves",
    "no quiero recibir la cotización por correo, mejor por texto",
  ])("leaves %j as a normal message", (t) => {
    expect(classifyInbound(t)).toBe("normal");
  });

  /** The HELP path is untouched by any of this. */
  it("still answers HELP as help", () => {
    expect(classifyInbound("HELP")).toBe("help");
    expect(classifyInbound("info")).toBe("help");
    const d = decideInbound({
      originationNumber: "+15163448418", destinationNumber: "+15167794210",
      messageBody: "ALTO", inboundMessageId: "m1",
    });
    expect(d.kind === "accept" && d.keyword).toBe("opt_out");
  });
});
