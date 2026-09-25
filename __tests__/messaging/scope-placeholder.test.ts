import { describe, it, expect } from "vitest";
import { isPlaceholderScope, usableScope, scopeFromCustomer, resolveScope, scopeAndStage } from "@/lib/messaging/scope";
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

/**
 * SCOPE THE CUSTOMER GAVE US IN THE CONVERSATION.
 *
 * inquiry_scope was written once at enrolment and never again, so a lead who
 * opened by describing the job left the record empty and the flow stuck:
 * ask_project_details was the only legal move and the model would not take it,
 * having been told never to ask for what they have already given. Reproduced
 * five times out of five in the simulator.
 */
describe("scope the customer supplies in the conversation", () => {
  it("captures a job description", () => {
    for (const t of [
      "Hi, I need the interior of my house painted, about 4 rooms",
      "hi i need my living room painted",
      "Looking to repaint kitchen cabinets!",
      "I have a 10x10 bedroom that I need painted on August 1st.",
      "I need my 2 car garage trim repaired and painted",
      "Whole house needs painting. Pretty much every room.",
    ]) {
      expect(scopeFromCustomer(t), t).toBeTruthy();
    }
  });

  /**
   * The dangerous direction. Captured scope is treated as collected, so a
   * question captured here would tick the project-details step off on the
   * strength of the customer ASKING something.
   *
   * "do" was briefly a work word, which made every one of these scope.
   */
  it("never captures a question as the job", () => {
    for (const t of [
      "Do you do kitchen cabinets?",
      "do you do exterior houses",
      "What do you charge for a room",
      "Do you guys do condos",
      "How much for a room?",
      "Can I get a quote?",
      "Hello can i send pictures here ?",
      "Hello Are you able to complete a virtual estimate?",
    ]) {
      expect(scopeFromCustomer(t), t).toBeNull();
    }
  });

  it("never captures scheduling, contact details or acknowledgements", () => {
    for (const t of [
      "Ok", "Now", "ok not ready now", "Sábado 9:30 am",
      "You can reach me by email at tom@example.com.",
      "Yes still interested but no power at the house. Will contact you later.",
      "Weekday mornings are best",
    ]) {
      expect(scopeFromCustomer(t), t).toBeNull();
    }
  });

  it("refuses a placeholder even when the customer types it", () => {
    expect(scopeFromCustomer("Customer did not provide additional comments. Please contact the customer to discuss the details of this project.")).toBeNull();
  });

  describe("resolveScope", () => {
    it("prefers what PPP already had on the lead", () => {
      const r = resolveScope({ onFile: "Kitchen cabinets, 20 doors", customerText: "actually I need my living room painted" });
      expect(r).toEqual({ scope: "Kitchen cabinets, 20 doors", from: "record" });
    });

    it("falls back to what they said when the record holds nothing", () => {
      const r = resolveScope({ onFile: null, customerText: "hi i need my living room painted" });
      expect(r.from).toBe("customer");
      expect(r.scope).toBe("hi i need my living room painted");
    });

    it("falls back when the record holds a placeholder rather than scope", () => {
      const r = resolveScope({
        onFile: "Customer did not provide additional comments. Please contact the customer to discuss the details of this project.",
        customerText: "I need the interior of my house painted, about 4 rooms",
      });
      expect(r.from).toBe("customer");
    });

    it("reports nothing when neither side has any", () => {
      expect(resolveScope({ onFile: null, customerText: "hi" })).toEqual({ scope: null, from: null });
    });
  });
});

describe("scopeAndStage — the rule the scheduler and the simulator share", () => {
  /**
   * The simulator only ever knew the stage from the BOT's past intents, so on
   * turn one it was 0 no matter what the customer said. Playing a homeowner
   * who opens with the whole job, the next step came back refused —
   * "ask_address belongs to step 2 but only 0 of the required information has
   * been collected" — while production would have answered it. A sandbox that
   * disagrees with production is a bot nobody has tested.
   */
  it("counts a job the customer described as step one already done", () => {
    const r = scopeAndStage({
      stage: 0, onFile: null,
      rawInbound: "Hi I need my living room and hallway painted, about 600 sq ft, walls and ceilings",
    });
    expect(r.from).toBe("customer");
    expect(r.stage).toBe(1);
  });

  /**
   * AND IT MUST BE THEIR WORDS, NOT OURS READ BACK.
   *
   * An iPhone reaction arrives as `Liked "<our message>"`. Resolving scope
   * from the raw body recorded our own confirmation sentence as the project,
   * persisted it to inquiry_scope, and showed it in the thread and the
   * reporting — because somebody tapped Like.
   */
  it("takes no scope from a reaction, which is our own sentence quoted back", () => {
    const r = scopeAndStage({
      stage: 0, onFile: null,
      rawInbound: 'Liked "Just to confirm, you are looking for: paint the kitchen cabinets. Is that right?"',
    });
    expect(r.scope).toBeNull();
    expect(r.from).toBeNull();
    expect(r.stage).toBe(0);
  });

  it("takes no scope from a bare emoji either", () => {
    expect(scopeAndStage({ stage: 0, onFile: null, rawInbound: "👍" }).scope).toBeNull();
  });

  /**
   * THE MORE SPECIFIC MESSAGE WAS THE ONE THAT FAILED.
   *
   * Playing somebody who wants a number: "just give me a ballpark, how much
   * for a 12x14 bedroom? I don't want an appointment". The bot answered
   * "What are you looking to have painted?" — asking for the one thing they
   * had just told it. "how much to paint a bedroom" worked, because it
   * happens to contain a verb; naming the room AND its size did not.
   */
  it("counts a room given with its measurements as the job described", () => {
    for (const t of [
      "just give me a ballpark, how much for a 12x14 bedroom? I don't want an appointment",
      "how much for a 12 x 14 bedroom",
      "10x12 deck, whats the cost",
    ]) {
      expect(scopeAndStage({ stage: 0, onFile: null, rawInbound: t }).stage, t).toBe(1);
    }
  });

  /**
   * And the guard that keeps it narrow. A subject on its own says nothing
   * about the work — a house is named in half the messages a painter gets —
   * so the measurements are what carry it.
   */
  it("does not treat merely naming a room as describing the job", () => {
    for (const t of [
      "Can you come to my house on Tuesday?",
      "whats your price",
      "what is your address",
      "I am at 12 Oak St apartment 3",
      "Do you service my area",
    ]) {
      expect(scopeAndStage({ stage: 0, onFile: null, rawInbound: t }).stage, t).toBe(0);
    }
  });

  /**
   * A30 MEANS SCOPE CAPTURE HAS TO READ SPANISH TOO.
   *
   * The templates were translated and the detection worked, and this was
   * still entirely English — so "necesito pintar mi casa por dentro"
   * resolved to no project at all, and the bot would have replied "¿Qué le
   * gustaría pintar?" to somebody who had just told it. Fluent, polite, and
   * the exact A3 breach the English fix was for.
   */
  it("counts a job described in Spanish as step one already done", () => {
    for (const t of [
      "Hola, necesito pintar mi casa por dentro",
      "quiero pintar dos habitaciones",
      "necesito pintar la cocina y el bano",
      "pintar los gabinetes de la cocina",
      "Quisiera un presupuesto para pintar el exterior de mi casa",
    ]) {
      expect(scopeAndStage({ stage: 0, onFile: null, rawInbound: t }).stage, t).toBe(1);
    }
  });

  it("does not treat a Spanish greeting or question as a described job", () => {
    for (const t of ["Hola", "¿Cuánto cuesta?", "gracias", "buenos dias", "Mi direccion es 12 Oak St"]) {
      expect(scopeAndStage({ stage: 0, onFile: null, rawInbound: t }).stage, t).toBe(0);
    }
  });

  it("never lowers a stage the flow has already reached", () => {
    expect(scopeAndStage({ stage: 3, onFile: null, rawInbound: "paint my kitchen cabinets" }).stage).toBe(3);
  });

  it("leaves what the office recorded alone — that version wins", () => {
    const r = scopeAndStage({
      stage: 0, onFile: "Interior repaint, 3 bedrooms",
      rawInbound: "actually I also want the trim done",
    });
    expect(r.from).toBe("record");
    expect(r.scope).toBe("Interior repaint, 3 bedrooms");
  });
});
