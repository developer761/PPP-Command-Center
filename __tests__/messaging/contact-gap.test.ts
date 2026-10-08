import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";
import { ASK_SUPERSEDED_BY } from "@/lib/messaging/agent-output";
import { readFileSync } from "node:fs";

/**
 * ASKING FOR THE HALF OF THE CONTACT WE ALREADY HOLD. A13.
 *
 * All three ask_contact variants ask for the name AND the email, and
 * ASK_SUPERSEDED_BY refuses the intent only when BOTH are held. So holding one
 * and not the other sent the ask for both — including the one on file, which
 * is the first half of A13: "do not ask the customer to RETYPE data already
 * held."
 *
 * It is the commonest fault in Kate's grading after punctuation. Of the 206
 * A13 breaches she annotated, 165 are an ask for something already on file:
 * 79 the phone, 52 the address, 36 the email, 30 the zip, 6 the name. The
 * address half was narrowed when A11 was built; the contact half never was.
 *
 * The phone is deliberately not narrowed — we always hold it, because they are
 * texting us from it, so the templates read it back instead, which A13 allows.
 */
const ask = (known: Record<string, string>, language = "en") =>
  renderMessage({ intent: "ask_contact", turn: 0, language, known } as never);

describe("ask_contact asks only for the half we are missing", () => {
  it("holds the name, so asks only for the email", () => {
    const out = ask({ name: "Dana Alvarez", address: "44 Elm Ave" });
    expect(out).toMatch(/email/i);
    expect(out, "asked for a name already on file").not.toMatch(/\bname\b/i);
  });

  it("holds the email, so asks only for the name", () => {
    const out = ask({ email: "dana@example.com", address: "44 Elm Ave" });
    expect(out).toMatch(/who|name/i);
    expect(out, "asked for an email already on file").not.toMatch(/email/i);
  });

  it("holds neither, so the ordinary ask stands", () => {
    // Both missing is already the right question; narrowing it would be worse.
    const out = ask({ address: "44 Elm Ave" });
    expect(out).toMatch(/name/i);
    expect(out).toMatch(/email/i);
  });

  /**
   * AND IN SPANISH, IN THE SAME COMMIT. The last time templates were
   * translated and the logic around them was not, every Spanish A7 offer
   * escalated instead of being made and the Spanish availability ask could
   * never fire. A Spanish lead gets the narrowed ask too.
   */
  it("narrows to the email in Spanish", () => {
    const out = ask({ name: "Dana Alvarez", address: "44 Elm" }, "es");
    expect(out).toMatch(/correo/i);
    expect(out, "pidió un nombre que ya tenemos").not.toMatch(/nombre/i);
  });

  it("narrows to the name in Spanish", () => {
    const out = ask({ email: "d@example.com", address: "44 Elm" }, "es");
    expect(out).toMatch(/nombre/i);
    expect(out, "pidió un correo que ya tenemos").not.toMatch(/correo/i);
  });

  /**
   * THE VALIDATOR STILL OWNS THE BOTH-HELD CASE, and this records which layer
   * does what. With name and email both on file the intent is refused before
   * the renderer is reached, so there is deliberately no renderer-side
   * narrowing for it — a second opinion on the validator's decision is how the
   * two drift apart.
   */
  it("leaves the both-held case to ASK_SUPERSEDED_BY", () => {
    expect(ASK_SUPERSEDED_BY.ask_contact).toEqual(["name", "email"]);
  });

  /**
   * The name has to REACH the renderer, which is the part that was missing.
   * knownFields has produced it since it was written and ASK_SUPERSEDED_BY
   * read it, but the renderer's `known` left it out — so this asserts the
   * thread, not just the behaviour.
   */
  it("is handed the name by the agent, not just able to use it", () => {
    const src = readFileSync("lib/messaging/agent-run.ts", "utf8");
    expect(src).toMatch(/name:\s*kf\.name/);
  });
});
