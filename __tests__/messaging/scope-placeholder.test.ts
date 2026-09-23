import { describe, it, expect } from "vitest";
import { isPlaceholderScope, usableScope } from "@/lib/messaging/scope";
import { knownFields, knownCustomerPrompt } from "@/lib/messaging/known-customer";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A9: "Paraphrasing the record does not include paraphrasing a placeholder.
 * 'Customer did not provide additional comments. Please contact the customer
 * to discuss the details of this project.' is not scope — it is the absence
 * of scope sitting in a scope field. Treat it as no scope held: ask for it,
 * never summarise it back. A PLACEHOLDER IS ANY NON-SCOPE VALUE SITTING IN
 * THE SCOPE FIELD... quoting it back as the project summary lets the customer
 * RUBBER-STAMP AN EMPTY RECORD."
 */

const PLACEHOLDER =
  "Customer did not provide additional comments. Please contact the customer to discuss the details of this project.";

describe("what is not a description of work", () => {
  it.each([
    PLACEHOLDER,
    "painting estimate request",
    "Estimate Request",
    "free estimate request",
    "Painting",
    "paint",
    "Painting - Interior",
    "Estimate Request / Web Lead",
    "Web Lead",
    "contact form",
    "quote",
    "N/A", "none", "TBD", "see notes", "-", "", "   ",
  ])("treats %j as no scope at all", (v) => {
    expect(isPlaceholderScope(v)).toBe(true);
    expect(usableScope(v)).toBeNull();
  });

  it("treats null and undefined the same way", () => {
    expect(isPlaceholderScope(null)).toBe(true);
    expect(isPlaceholderScope(undefined)).toBe(true);
  });
});

describe("what IS a description of work", () => {
  it.each([
    "2 bedrooms and a hallway",
    "exterior of my house",
    "kitchen cabinets refinished",
    "paint the living room ceiling",
    "470 sq ft basement",
    "touch ups and a drywall patch on a door",
    "Interior painting of 3 rooms plus trim",
    "we want the shutters and front door done",
    "Painting the whole exterior including siding",
  ])("keeps %j", (v) => {
    expect(isPlaceholderScope(v)).toBe(false);
    expect(usableScope(v)).toBe(v);
  });
});

/**
 * THE FOUR PLACES IT REACHED.
 *
 * inquiryScope feeds four consumers and a placeholder corrupted every one.
 * They all read knownFields, so nulling it there fixes all four at once —
 * these assert that it actually did.
 */
describe("a placeholder stops behaving like scope everywhere", () => {
  const withPlaceholder = { inquiryScope: PLACEHOLDER, name: "Sam", phone: "+19995550101" };
  const withScope = { inquiryScope: "2 bedrooms and a hallway", name: "Sam", phone: "+19995550101" };

  it("1. we no longer claim to hold scope", () => {
    expect(knownFields(withPlaceholder).inquiryScope).toBeNull();
    expect(knownFields(withScope).inquiryScope).toBe("2 bedrooms and a hallway");
  });

  it("2. so the bot is ALLOWED to ask what the job is", () => {
    // The worst of the four and the least visible: a truthy scope made
    // ask_project_details a redundant ask under A13, so the bot never asked
    // and nothing anywhere said why.
    const known = knownFields(withPlaceholder);
    const v = validateAction(
      { intent: "ask_project_details", confidence: 0.9 } as never,
      { knownFields: { inquiryScope: !!known.inquiryScope }, stage: 0 } as never
    );
    expect(v.ok).toBe(true);
  });

  it("…and is still refused when real scope is on file", () => {
    const known = knownFields(withScope);
    const v = validateAction(
      { intent: "ask_project_details", confidence: 0.9 } as never,
      { knownFields: { inquiryScope: !!known.inquiryScope }, stage: 0 } as never
    );
    expect(v.ok).toBe(false);
  });

  it("3. the prompt never calls a form label their own words", () => {
    const p = knownCustomerPrompt(withPlaceholder);
    expect(p).not.toContain("did not provide additional comments");
    expect(p).not.toContain("in their own words");
    // Real scope still gets quoted, which is the point of the line.
    expect(knownCustomerPrompt(withScope)).toContain("in their own words");
  });

  it("4. confirm_scope cannot read a placeholder back to the customer", () => {
    // "Just to confirm, you're looking for: Customer did not provide
    // additional comments." is the rubber-stamp Kate describes.
    const out = renderMessage({
      intent: "confirm_scope", turn: 0,
      known: { scope: knownFields(withPlaceholder).inquiryScope },
    });
    expect(out).toBe("");
    expect(renderMessage({ intent: "confirm_scope", turn: 0, known: { scope: knownFields(withScope).inquiryScope } }))
      .toContain("2 bedrooms and a hallway");
  });
});

/**
 * PROVE IT CAN FAIL. Feeding the placeholder through unfiltered must produce
 * the old behaviour, or these tests are asserting nothing.
 */
describe("the old behaviour is what was actually wrong", () => {
  it("unfiltered, the placeholder would have been read back verbatim", () => {
    const out = renderMessage({ intent: "confirm_scope", turn: 0, known: { scope: PLACEHOLDER } });
    expect(out).toContain("Customer did not provide");
  });

  it("unfiltered, it would have blocked the ask", () => {
    const v = validateAction(
      { intent: "ask_project_details", confidence: 0.9 } as never,
      { knownFields: { inquiryScope: true }, stage: 0 } as never
    );
    expect(v.ok).toBe(false);
  });
});
