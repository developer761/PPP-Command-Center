import { describe, it, expect } from "vitest";
import { leadFromSalesforce, composeAddress, LEAD_FIELDS } from "@/lib/messaging/lead-map";
import { knownFields } from "@/lib/messaging/known-customer";
import { addressGap } from "@/lib/messaging/address";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * THE RULES THAT COULD NOT FIRE.
 *
 * KnownCustomer has carried `address` and `inquiryScope` since it was
 * written, and nothing ever set either one. Traced 2026-09-23:
 *
 *   LEAD_FIELDS did not request Street
 *     -> the parsed lead had no address
 *       -> sms_conversations had no column for one
 *         -> the scheduler passed { name, phone, email }
 *           -> kf.address and kf.inquiryScope were always null
 *
 * So A11's address gap, A6 and A7's job routing, A9's placeholder check and
 * the confirm_address turn were real code that never ran in production. This
 * file holds the chain together at the two ends that are testable without a
 * database: what comes out of Salesforce, and what the rules do once it does.
 */

const lead = (over: Record<string, unknown> = {}) => ({
  Id: "00Q1", Name: "Sam Smith", Phone: "+15165550147", Email: "s@example.com",
  Street: "482 Marchmont Ave", City: "Sayville", State: "NY", PostalCode: "11782",
  ...over,
});

describe("the lead's address survives the trip out of Salesforce", () => {
  it("asks Salesforce for Street at all", () => {
    // The root of it. City, State and PostalCode were requested and Street
    // was not, so an address could never be assembled.
    expect([...LEAD_FIELDS]).toContain("Street");
  });

  it("assembles one line from the parts", () => {
    expect(composeAddress(lead() as never)).toBe("482 Marchmont Ave, Sayville, NY, 11782");
  });

  it("carries it onto the parsed lead", () => {
    const { lead: parsed } = leadFromSalesforce(lead() as never);
    expect(parsed.address).toBe("482 Marchmont Ave, Sayville, NY, 11782");
    expect(parsed.street).toBe("482 Marchmont Ave");
    expect(parsed.postalCode).toBe("11782");
  });

  /**
   * A11 defines a full address as street plus zip. Half of one is not
   * something we can read back for confirmation, so it is not an address.
   */
  it.each([
    ["no street", { Street: null }],
    ["no zip", { PostalCode: null }],
    ["street only", { PostalCode: null, City: null, State: null }],
    ["empty street", { Street: "   " }],
  ])("is null with %s", (_label, over) => {
    expect(composeAddress(lead(over) as never)).toBeNull();
  });

  it("does not need a city or a state to be complete", () => {
    // The zip resolves both, which is the same rule the address gap follows.
    expect(composeAddress(lead({ City: null, State: null }) as never))
      .toBe("482 Marchmont Ave, 11782");
  });
});

/**
 * What the rules do once the value actually arrives. Each of these was
 * unreachable in production, so each is asserted from the shape the
 * scheduler now passes rather than from a hand-built context.
 */
describe("the rules downstream come alive", () => {
  const held = knownFields({
    name: "Sam", phone: "+15165550147", email: "s@example.com",
    address: "482 Marchmont Ave, Sayville, NY, 11782",
    inquiryScope: "two bedrooms and a hallway",
  });

  it("A13: the address ask is now refused, because we hold one", () => {
    const v = validateAction(
      { intent: "ask_address", confidence: 0.9 } as never,
      { knownFields: { address: !!held.address }, stage: 1 } as never
    );
    expect(v.ok).toBe(false);
  });

  it("A11: a partial address narrows the ask instead of repeating it", () => {
    const partial = knownFields({ address: "482 Marchmont Ave" });
    expect(addressGap(partial.address)).toBe("zip");
    const out = renderMessage({
      intent: "ask_address", addressGap: addressGap(partial.address), turn: 0,
      known: { address: partial.address },
    });
    expect(out).toMatch(/zip code/i);
  });

  it("confirm_address can finally render", () => {
    const out = renderMessage({ intent: "confirm_address", turn: 0, known: { address: held.address } });
    expect(out).toContain("482 Marchmont Ave");
  });

  it("A9: a placeholder scope is still treated as no scope", () => {
    const junk = knownFields({ inquiryScope: "painting estimate request" });
    expect(junk.inquiryScope).toBeNull();
  });

  it("A9: a real scope survives", () => {
    expect(held.inquiryScope).toBe("two bedrooms and a hallway");
  });
});

/**
 * PROVE THE OLD BEHAVIOUR WAS THE BUG, so this file is not asserting
 * something that was always true.
 */
describe("what it looked like before", () => {
  it("with no address passed, the ask was allowed and the confirm was empty", () => {
    const none = knownFields({ name: "Sam", phone: "+15165550147", email: "s@example.com" });
    expect(none.address).toBeNull();
    expect(validateAction(
      { intent: "ask_address", confidence: 0.9 } as never,
      { knownFields: { address: !!none.address }, stage: 1 } as never
    ).ok).toBe(true);
    expect(renderMessage({ intent: "confirm_address", turn: 0, known: { address: none.address } })).toBe("");
  });
});
