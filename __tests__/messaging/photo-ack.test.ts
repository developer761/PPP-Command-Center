import { describe, it, expect } from "vitest";
import { onlyAcknowledgesThePhoto } from "@/lib/messaging/agent-output";

describe("rapport that only says the photo arrived", () => {
  /** The exact string seen live on 2026-10-11. */
  it("drops the one that shipped", () => {
    expect(onlyAcknowledgesThePhoto("Thanks, got the photo!")).toBe(true);
  });

  it.each([
    "Got the photo, thanks",
    "Got them both, thank you",
    "Thanks for sending that over",
    "Perfect, got the pictures",
    "I have received the images",
    "Thanks, I can see them",
    "Gracias, recibí la foto",
    "Perfecto, gracias por las fotos",
  ])("drops %j", (s) => expect(onlyAcknowledgesThePhoto(s)).toBe(true));

  /**
   * The line this must not cross. Each of these mentions a photo or thanks
   * AND says something a customer would want kept.
   */
  it.each([
    "Thanks, I can see the water damage along the skirting",
    "I can see from the photo that the ceiling is water damaged",
    "Got it — looks like about 200 square feet",
    "Thanks, the cabinets look like oak",
    "Perfect, that helps. The trim looks rotted",
    "Gracias, se ve daño de agua en el techo",
  ])("keeps %j", (s) => expect(onlyAcknowledgesThePhoto(s)).toBe(false));

  it("is false for empty, so it never drops something that was not there", () => {
    expect(onlyAcknowledgesThePhoto("")).toBe(false);
    expect(onlyAcknowledgesThePhoto(null)).toBe(false);
    expect(onlyAcknowledgesThePhoto(undefined)).toBe(false);
  });
});
