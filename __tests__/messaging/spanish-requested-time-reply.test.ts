import { describe, it, expect } from "vitest";
import { renderMessage, SILENT_INTENTS } from "@/lib/messaging/render";
import { validateAction, END_INTENTS, CONTINUE_INTENTS, type Intent } from "@/lib/messaging/agent-output";
import { replyToRequestedTime } from "@/lib/messaging/appointment-time";

/**
 * A30 — A SPANISH SPEAKER WHO NAMES A TIME GETS ENGLISH BACK. 2026-10-16.
 *
 * render.ts calls replyToRequestedTime in two places. The calendar line on
 * the collecting turns had a Spanish twin; the availability turn returned the
 * English reply as it was:
 *
 *   "el martes 3pm"         -> "I'll check the calendar for that time."
 *   "el martes a las 7am"   -> "Our earliest visit is usually 10 AM, though…"
 *
 * The language now goes into replyToRequestedTime itself, so neither call
 * site can be the one that forgot it.
 */
const ENGLISH = /\b(?:what|would|your|the|and|please|thanks|project|address|email|check|calendar|earliest|latest|visit|usually|though|works|best|for you)\b/i;

describe("the visit-hours reply in a Spanish conversation", () => {
  it.each([
    ["el martes 3pm", /calendario/],
    ["el martes a las 7am", /primera visita/],
    ["puede venir a las 8pm?", /última visita/],
  ])("answers %j in Spanish on ask_availability", (customerText, want) => {
    // The pair: the validator allows the turn, and what it renders is Spanish.
    const v = validateAction(
      { intent: "ask_availability", confidence: 0.97 },
      { customerText, priorIntents: ["ask_project_details", "ask_address", "ask_contact"],
        knownFields: { inquiryScope: "cocina", address: "12 Oak St", name: "Ana", email: "a@b.com" } } as never,
    );
    expect(v.ok, JSON.stringify(v)).toBe(true);
    const out = renderMessage({ intent: "ask_availability", turn: 0, language: "es", customerText });
    expect(out).toMatch(want);
    expect(out).not.toMatch(ENGLISH);
  });

  it.each(["ask_availability", "checking_availability"] as const)(
    "%s keeps English for an English customer (control)", (intent) => {
      expect(renderMessage({ intent, turn: 0, customerText: "Tuesday at 3pm?" }))
        .toContain("I'll check the calendar for that time.");
      expect(renderMessage({ intent, turn: 0, customerText: "can you come at 7am?" }))
        .toMatch(/earliest visit is usually 10 AM/);
    });

  it("gives the same verdict in both languages and never restates the time", () => {
    for (const t of ["el martes 3pm", "a las 7am", "a las 8pm"]) {
      const en = replyToRequestedTime(t)!;
      const es = replyToRequestedTime(t, "es")!;
      expect(es.verdict).toBe(en.verdict);
      expect(es.reply).not.toMatch(ENGLISH);
      expect(es.reply).not.toMatch(/\b3\b|\b7\b|\b8\b/);
    }
  });
});

/**
 * THE SWEEP. Every intent that speaks, rendered in Spanish against the
 * customer messages that send a reply down its special branches: a named
 * time on each side of the day, a call request, a photo, half an address,
 * half the availability. Not one English sentence may come out.
 */
describe("no English reaches a Spanish conversation from any branch", () => {
  const ALL: Intent[] = [...END_INTENTS, ...CONTINUE_INTENTS];
  const known = { scope: "pintar la cocina", zip: "11530", state: "Florida" };
  const texts = [
    "el martes 3pm", "el martes a las 7am", "a las 8pm", "puede llamarme? a las 11pm",
    "me puede llamar por favor", "hola, necesito pintar la cocina", "tengo una pregunta?",
  ];
  const variants = [
    {}, { photos: 1 }, { photos: 2 }, { addressGap: "zip" as const }, { addressGap: "street" as const },
    { availabilityGap: "window" as const }, { availabilityGap: "day" as const },
    { callback: { unreachableStartHour: null, requestedHour: 23 } },
    { now: new Date("2026-07-15T18:00:00Z"), customerZone: "America/New_York" },
  ];

  it("renders Spanish for every intent, text and branch", () => {
    const leaks: string[] = [];
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const customerText of texts) {
        for (const extra of variants) {
          for (const turn of [0, 1, 2]) {
            const out = renderMessage({
              intent, turn, known, language: "es", customerText,
              offsiteReason: "no puede estar en la propiedad", ...extra,
            } as never);
            if (out && ENGLISH.test(out)) leaks.push(`${intent}/${turn} ${JSON.stringify(extra)} <- ${customerText}: ${out}`);
          }
        }
      }
    }
    expect([...new Set(leaks)].slice(0, 10)).toEqual([]);
  });
});
