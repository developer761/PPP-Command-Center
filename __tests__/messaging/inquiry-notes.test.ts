import { describe, it, expect } from "vitest";
import {
  customerAsk, stripOperatorNotes, answerFromFormDump, isFormDump, askFromPayload,
} from "@/lib/messaging/inquiry-notes";

/**
 * Every case here is a real shape from PPP's Salesforce, not an invented one.
 * Measured over 921 leads carrying Inquiry Notes across 120 days.
 *
 * The four marked (Kate) are the screenshots she sent on 2026-09-24 naming the
 * field, including the two that show the call centre typing into the same box
 * as the customer.
 */

describe("the customer's own words, out of Inquiry Notes", () => {
  it("passes clean prose straight through (Kate, screenshot 1)", () => {
    const notes =
      "Paint ceiling walls baseboards if 1450 sq ft apartment. Space comprises:" +
      "An open living room kitchen hallway two bedrooms and two bathrooms.";
    expect(customerAsk({ inquiryNotes: notes })).toBe(notes);
  });

  it("drops the call centre's wrapper and keeps the middle (Kate, screenshot 3)", () => {
    const notes = [
      "Phone estimate. Prefers text communications.",
      "",
      "I have a 2bd 2ba 1144sqft. Both rooms and dining area. Give me quote for only walls and also with ceilings and trim. Light color staying light.",
      "",
      "No time frame provided.",
    ].join("\n");
    const out = customerAsk({ inquiryNotes: notes });
    expect(out).toContain("2bd 2ba 1144sqft");
    expect(out).not.toMatch(/phone estimate/i);
    expect(out).not.toMatch(/prefers text/i);
    expect(out).not.toMatch(/no time frame provided/i);
  });

  it("refuses the Angi placeholder (Kate, screenshot 4)", () => {
    expect(customerAsk({
      inquiryNotes: "Customer did not provide additional comments. Please contact the customer to discuss the details of this project.",
    })).toBeNull();
  });

  it("falls back to the payload's Description when notes are empty (Kate, screenshot 2)", () => {
    const payload = JSON.stringify({
      FirstName: "Suzanne", LastName: "Ruffa", PhoneNumber: "9172075477",
      Description: "Paint ceiling walls baseboards if 1450 sq ft apartment.",
      Category: "Interior Painting or Staining: 5 + Rooms",
    });
    expect(customerAsk({ inquiryNotes: null, description: payload }))
      .toBe("Paint ceiling walls baseboards if 1450 sq ft apartment.");
  });

  it("prefers Inquiry Notes over the payload, which is Kate's instruction for live leads", () => {
    const payload = JSON.stringify({ Description: "from the payload" });
    expect(customerAsk({ inquiryNotes: "from the notes", description: payload }))
      .toBe("from the notes");
  });
});

describe("web form dumps — 10% of real leads, none of them caught before", () => {
  it("is recognised", () => {
    expect(isFormDump("when_would_you_like_to_complete_your_painting_project?: as_soon_as_possible")).toBe(true);
    expect(isFormDump("Just want my walls painted one color simple")).toBe(false);
  });

  it("pulls the answer to the project question out", () => {
    const dump = "tell_us_a_little_bit_about_your_painting_project!: Existing cabinets " +
      "how_soon_are_you_looking_to_complete_your_project?: 1_-_2_weeks";
    expect(answerFromFormDump(dump)).toBe("Existing cabinets");
  });

  it("pulls prose out even when it runs long", () => {
    const dump = "tell_us_a_little_bit_about_your_painting_project!: exterior painting 1 and a half story house " +
      "how_soon_are_you_looking_to_complete_your_project?: 1_-_2_weeks";
    expect(answerFromFormDump(dump)).toBe("exterior painting 1 and a half story house");
  });

  /**
   * The whole reason this is not simply "treat a dump as a placeholder": the
   * answer says WHEN, not WHAT. Reading it back would confirm a schedule as
   * though it were the job.
   */
  it("returns nothing when the only answers are canned options", () => {
    const dump = "when_would_you_like_to_complete_your_painting_project?: as_soon_as_possible_(urgent) " +
      "can_you_tell_us_a_little_bit_about_your_project?: not_sure_-_still_planning/budgeting";
    expect(customerAsk({ inquiryNotes: dump })).toBeNull();
  });
});

describe("PP and Cx are not the same marker", () => {
  /**
   * "PP" prefixes Precision Painting's own decisions, so the line is cut
   * there. Treating "Cx" the same way deleted the only description of the job
   * on the record — this exact lead.
   */
  it("keeps what the customer wanted when the note starts Cx", () => {
    const out = customerAsk({
      inquiryNotes: "*Email only* Cx wants to paint wooden cabinets to black. Attached photos and reference photo",
    });
    expect(out).toContain("wooden cabinets");
    expect(out).not.toMatch(/\bCx\b/);
  });

  it("cuts the line at PP, which is internal", () => {
    const out = stripOperatorNotes("Living room and hallway to be painted - Walls and ceilings\nSmall project -PP");
    expect(out).toContain("Living room and hallway");
    expect(out).not.toMatch(/\bPP\b/);
  });

  it("drops a starred aside entirely", () => {
    const out = stripOperatorNotes("**Cx said you may call him from the outside during the appt**\n1 huge wall on exterior");
    expect(out).toContain("1 huge wall on exterior");
    expect(out).not.toMatch(/call him from the outside/);
  });
});

describe("a price must never travel inside scope", () => {
  /**
   * A real lead: "Home is Stucco Cx has the paint PP refused in person
   * Zestimate: $623,300". inquiryScope reaches the prompt as "what they said
   * they need, IN THEIR OWN WORDS", so a figure in it is a price the model is
   * invited to repeat — and it never passes the price rail, because it did
   * not come from the model.
   */
  it("strips the Zestimate and its amount", () => {
    const out = customerAsk({
      inquiryNotes: "Exterior painting: entire home walls, soffits, trim, and doors. Home is Stucco Cx has the paint PP refused in person Zestimate: $623,300",
    });
    expect(out).toContain("soffits");
    expect(out).not.toContain("623,300");
    expect(out).not.toMatch(/\$/);
    expect(out).not.toMatch(/zestimate/i);
  });

  it("strips the bare brand left behind", () => {
    expect(customerAsk({ inquiryNotes: "Interior painting Zestimate®" })).toBeNull();
  });
});

describe("the payload parser", () => {
  it("ignores a Description that is not a payload", () => {
    expect(askFromPayload("just some prose")).toBeNull();
  });

  it("ignores a payload that does not parse", () => {
    expect(askFromPayload('{ "Description": broken')).toBeNull();
  });

  it("ignores a payload with no Description key", () => {
    expect(askFromPayload(JSON.stringify({ FirstName: "A", Category: "Interior" }))).toBeNull();
  });
});
