import { describe, it, expect } from "vitest";
import { renderMessage, SILENT_INTENTS } from "@/lib/messaging/render";
import { tooManyAsks } from "@/lib/messaging/one-ask";
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
    // confirm_* read a value back, so they are given one. Without it they
    // correctly render nothing rather than a message containing "{address}".
    const known = {
      address: "1 Test St, Garden City, NY 11530",
      phone: "(516) 555-0100", email: "test@example.com", scope: "interior painting",
      // A2 names the zip we hold and the state it resolves to. Without them
      // the message correctly renders nothing, because naming the wrong state
      // is worse than the blanket sentence it replaced.
      zip: "11530", state: "New York",
    };
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      if (intent === "answer_question") continue; // the rapport IS the answer
      // A7 reads its reason back the way confirm_* reads an address, and for
      // the same reason: the rule MANDATES the justification, so a render
      // without one is deliberately empty rather than a sentence with the
      // explanation missing.
      const offsiteReason = "you're not able to be at the property";
      expect(renderMessage({ intent, known, offsiteReason }).length, intent).toBeGreaterThan(0);
    }
  });

  it("renders nothing for a confirm_* intent with no value to confirm", () => {
    for (const intent of ["confirm_address", "confirm_contact", "confirm_scope"] as const) {
      expect(renderMessage({ intent }), intent).toBe("");
    }
  });

  it("still produces the answer when answer_question carries it in rapport", () => {
    const out = renderMessage({ intent: "answer_question", freeText: "Yes, we do cabinet refinishing." });
    expect(out).toContain("cabinet refinishing");
  });

  /**
   * THE TEMPLATE'S PUNCTUATION WINS AT A SLOT SEAM.
   *
   * Seen in the simulator against a real lead: Inquiry Notes ended in a full
   * stop, the template adds its own, and the customer was sent
   * "...two bathrooms.. Is that right?".
   *
   * Scope is somebody's typing — it comes from Salesforce Inquiry Notes now —
   * so it ends however they left it, and every slot with punctuation behind it
   * has the same seam.
   */
  it("does not double the punctuation when a slot value ends with it", () => {
    for (const scope of [
      "Paint ceiling walls baseboards 1450 sq ft apartment. Open living room and two bathrooms.",
      "walls and ceilings, trim,",
      "interior painting...",
      "the hallway;",
    ]) {
      const out = renderMessage({ intent: "confirm_scope", turn: 0, known: { scope } });
      expect(out, scope).not.toMatch(/[.,;:]{2}/);
      expect(out, scope).toContain("Is that right?");
    }
  });

  it("leaves a value alone when the template has no punctuation behind the slot", () => {
    const out = renderMessage({ intent: "confirm_scope", turn: 0, known: { scope: "Kitchen cabinets, maybe 20 doors" } });
    expect(out).toContain("Kitchen cabinets, maybe 20 doors");
  });

  /**
   * "ARE YOU A BOT" IS NOT A REASON TO GO QUIET.
   *
   * bot_suspected sat in SILENT_INTENTS beside discard and lost, whose comment
   * explains itself: "sending a cheerful sign-off to somebody who asked to be
   * left alone is how a complaint starts". That is the opposite situation.
   * Somebody typing "is this a real person or a bot" is the most engaged a
   * customer gets, and silence is the single worst answer available — it reads
   * exactly like a bot that has been caught.
   *
   * Kate's tag handled_bot_q: "Answered as Emily and ended as Bot Suspected."
   * Both halves. It was doing the second one only.
   */
  it("answers when asked whether it is a bot", () => {
    for (const turn of [0, 1, 2, 3]) {
      const out = renderMessage({ intent: "bot_suspected", turn });
      expect(out.length, `turn ${turn}`).toBeGreaterThan(0);
      // It must not claim to be a person, and must not deny anything either.
      expect(out).not.toMatch(/\b(?:real person|i am human|not a bot|a human)\b/i);
    }
  });

  it("still says nothing to somebody who has disengaged", () => {
    for (const intent of ["discard", "lost", "msg_liked_loved"] as const) {
      expect(renderMessage({ intent }), intent).toBe("");
    }
  });

  /**
   * DISCARD WAS SILENT FOR BOTH OF THE THINGS IT MEANS.
   *
   * Kate's outcome definition is "Not an estimate request, OR work we do not
   * cover", and the configuration spells out what to do about the second:
   * "say we cannot help with this project but will circle back if that is
   * wrong". It said nothing. Found in the simulator — a homeowner asking
   * "do you guys paint furniture?" got back "no message, action only", and
   * only a 94% confidence sent it to a person at all. At 95% nobody sees it
   * and nobody answers.
   *
   * A project on file is what tells the two apart: if an estimate was
   * requested, the discard cannot be the "not an estimate request" branch.
   */
  it("answers a real customer whose project is work PPP does not cover", () => {
    const known = { scope: "paint a standalone bookcase and a dresser black" };
    for (const turn of [0, 1, 2, 3]) {
      const out = renderMessage({ intent: "discard", turn, known });
      expect(out.length, `turn ${turn}`).toBeGreaterThan(0);
      // A9 — never restate the scope the customer just typed.
      expect(out).not.toMatch(/bookcase|dresser/i);
      // Kate: "Never suggest another company."
      expect(out).not.toMatch(/another (?:company|contractor)|someone else|refer you/i);
      // It has to leave a door open, because the bot may simply be wrong.
      expect(out).toMatch(/let me know|tell me|misread|got that wrong/i);
    }
  });

  it("stays silent on a discard with no project behind it, which is the spam case", () => {
    // The other half of the same rule. Answering a wrong number or a
    // solicitor is how a complaint starts, and agent-run escalates anything
    // that renders nothing unintentionally — so getting this wrong would put
    // every junk text on somebody's desk.
    expect(renderMessage({ intent: "discard", turn: 0 })).toBe("");
    expect(renderMessage({ intent: "discard", turn: 0, known: { scope: "" } })).toBe("");
  });

  /**
   * A22, WHICH WAS NOT ENFORCED ANYWHERE.
   *
   * one-ask.ts was written with ten tests of its own and never imported by a
   * single production file, so the rule it implements was never applied to an
   * outgoing message. Found by sweeping lib/messaging for exported functions
   * with no callers — the same sweep that found loadInbox and bucketCounts.
   *
   * The count only means anything on the WHOLE message. The template asks for
   * one thing, the model's rapport can quietly ask for two more, and neither
   * half is over the line alone.
   */
  it("drops rapport that pushes the message over the ask limit", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 0,
      freeText: "Also, what is your first and last name and the best email to reach you?",
    });
    expect(tooManyAsks(out)).toBeNull();
    expect(out).not.toMatch(/last name/i);
    // The template still carries the turn.
    expect(out).toMatch(/address/i);
  });

  it("leaves rapport alone when the message is within the limit", () => {
    const out = renderMessage({ intent: "ask_address", turn: 0, freeText: "Kitchen cabinets, got it." });
    expect(out).toContain("Kitchen cabinets");
  });

  /** The first version dropped the photo acknowledgement instead, because it
   *  assumed rapport was always the part before the template. */
  it("keeps the photo acknowledgement when it is the rapport that goes", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 0, photos: 2,
      freeText: "Also, what is your first and last name and the best email to reach you?",
    });
    expect(out).toMatch(/thanks for the photos/i);
    expect(out).not.toMatch(/last name/i);
  });

  /** Every template, on its own, must already satisfy the rule. */
  it("has no template that asks for too much by itself", () => {
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({ intent, turn, known: {
          address: "12 Oak St, Garden City, NY 11530", phone: "999-784-6046",
          email: "tom@example.com", scope: "interior painting", zip: "11530", state: "New York",
        }, offsiteReason: "you're not able to be at the property" });
        if (!out) continue;
        expect(tooManyAsks(out), `${intent}/${turn}: ${out}`).toBeNull();
      }
    }
  });
});
