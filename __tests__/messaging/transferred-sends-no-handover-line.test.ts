import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderMessage, isSilent } from "@/lib/messaging/render";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * THE HANDOVER LINE THE SPEC REMOVED, STILL SENT BY THE TWIN. 2026-10-16.
 *
 * Iteration 1 spec, Human takeover: "The bot sends nothing on the way out —
 * no sign-off, no handover line. No visible seam." escalate was made silent
 * for it on 2026-09-26. transferred, the same hand-off by another name, kept
 * sending "I'm passing you over to our office now. They'll take it from
 * here." — including to an email_only customer, by text, which is the one
 * channel they asked us not to use.
 */
describe("transferred says nothing on the way out", () => {
  it("the spec says what it says", () => {
    const spec = readFileSync("docs/ITERATION_1_BUILD_SPEC_2026_09_25.md", "utf8");
    expect(spec).toMatch(/sends\s+nothing on the way out\*\*\s+—\s+no sign-off, no handover line/);
  });

  it.each([
    ["an email-only customer", "please just email me, I don't text"],
    ["a request to meet at the office", "can I just come by your office instead?"],
    ["no words at all", ""],
  ])("is silent for %s, in both languages", (_who, customerText) => {
    const v = validateAction({ intent: "transferred", confidence: 0.97 }, { customerText } as never);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    for (const language of ["en", "es"] as const) {
      expect(renderMessage({ intent: "transferred", turn: 0, customerText, language, freeText: "Thanks!" })).toBe("");
    }
    // Silent BY DESIGN, so agent-run does not read the empty render as a
    // dropped turn; scheduler-db's empty-reply branch hands it to a person.
    expect(isSilent({ intent: "transferred" })).toBe(true);
  });

  /** CONTROL: the sibling that still speaks, and the one already silent. */
  it("leaves the endings that do speak alone", () => {
    expect(renderMessage({ intent: "bailout", turn: 0 })).not.toBe("");
    expect(renderMessage({ intent: "escalate", turn: 0 })).toBe("");
  });

  it("still refuses transferred for a text-only customer (A25)", () => {
    const v = validateAction({ intent: "transferred", confidence: 0.97 }, { customerText: "text only please, don't call" } as never);
    expect(v.ok === false && v.reason).toBe("transferred_a_text_only_customer");
  });
});
