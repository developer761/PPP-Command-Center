import { describe, it, expect } from "vitest";
import { renderMessage, SILENT_INTENTS } from "@/lib/messaging/render";
import { END_INTENTS, CONTINUE_INTENTS, type Intent } from "@/lib/messaging/agent-output";

const ALL: Intent[] = [...END_INTENTS, ...CONTINUE_INTENTS];

describe("rendering an intent into words", () => {
  /**
   * The regression this file exists for. A correctly chosen intent used to go
   * out as the model's rapport — "Hi there!" — because agent-run returned
   * freeText instead of a rendered message.
   */
  it("asks the actual question, not just the rapport", () => {
    const out = renderMessage({ intent: "ask_project_details", freeText: "Hi there!" });
    expect(out).toMatch(/painted|project/i);
    expect(out).not.toBe("Hi there!");
  });

  it("does not stack the model's greeting on top of the template's", () => {
    const out = renderMessage({ intent: "ask_project_details", freeText: "Hi there!", turn: 1 });
    expect(out.toLowerCase().startsWith("hi there")).toBe(false);
  });

  it("keeps rapport that actually says something", () => {
    const out = renderMessage({ intent: "ask_address", freeText: "Kitchen cabinets, got it." });
    expect(out).toContain("Kitchen cabinets");
    expect(out).toMatch(/address|located/i);
  });

  it("acknowledges a photo, which is the thing Hatch cannot do at all", () => {
    const out = renderMessage({ intent: "ask_project_details", photos: 1 });
    expect(out).toMatch(/thanks for the photo/i);
    expect(renderMessage({ intent: "ask_project_details", photos: 3 })).toMatch(/photos/i);
  });

  it("says nothing at all for intents that end the conversation quietly", () => {
    for (const i of SILENT_INTENTS) {
      expect(renderMessage({ intent: i, freeText: "Thanks so much!" })).toBe("");
    }
  });

  it("varies the opener across turns rather than repeating one sentence", () => {
    const seen = new Set(
      [0, 1, 2].map((turn) => renderMessage({ intent: "ask_project_details", turn }))
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is deterministic for the same turn, so a test can assert output", () => {
    const a = renderMessage({ intent: "ask_address", turn: 4 });
    const b = renderMessage({ intent: "ask_address", turn: 4 });
    expect(a).toBe(b);
  });

  /**
   * The safety property. The model cannot put a price or a time into an
   * outgoing message because it does not write outgoing messages — so the only
   * way one could appear is if somebody typed it into a template here.
   */
  it("has no template that quotes a price or offers a specific time", () => {
    for (const intent of ALL) {
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({ intent, turn });
        expect(out, `${intent}/${turn}`).not.toMatch(/\$|\b\d+\s*(?:dollars|usd)\b/i);
        expect(out, `${intent}/${turn}`).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
        expect(out, `${intent}/${turn}`).not.toMatch(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      }
    }
  });

  /** A new intent with no words is an empty text message to a customer. */
  it("has words for every non-silent intent", () => {
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      if (intent === "answer_question") continue; // the rapport IS the answer
      expect(renderMessage({ intent }).length, intent).toBeGreaterThan(0);
    }
  });

  it("still produces the answer when answer_question carries it in rapport", () => {
    const out = renderMessage({ intent: "answer_question", freeText: "Yes, we do cabinet refinishing." });
    expect(out).toContain("cabinet refinishing");
  });
});
