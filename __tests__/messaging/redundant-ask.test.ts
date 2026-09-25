import { describe, it, expect } from "vitest";
import { addressParts, addressGap, addressIsComplete } from "@/lib/messaging/address";
import { validateAction, ASK_SUPERSEDED_BY } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A11 and A13, the two most broken CRITICAL rules in Kate's grading.
 *
 *   A11  "Ask only for the MISSING part of a partial address."   287 breaches
 *   A13  "Do not ask the customer to RETYPE data already held."  206 breaches
 *
 * Together they are 22% of every defect she marked, and both were the same
 * hole: ASK_SUPERSEDED_BY had no entry for ask_contact at all, and the address
 * check was a boolean, which cannot express "half of one".
 *
 * Street plus zip is complete. Karan, 2026-09-22: "We only need Zip and
 * street. We should be able to fill in the city and state based off the zip."
 */

describe("what counts as a complete address", () => {
  it.each([
    ["482 Marchmont Ave, Sayville NY 11782", "482 Marchmont Ave", "11782"],
    ["11782", null, "11782"],
    ["482 Marchmont Ave", "482 Marchmont Ave", null],
    ["1400 Ocean Parkway Apt 3B, Brooklyn 11230", "1400 Ocean Parkway Apt", "11230"],
    ["", null, null],
  ])("reads %j", (raw, street, zip) => {
    const p = addressParts(raw);
    expect(p.zip).toBe(zip);
    if (street === null) expect(p.street).toBeNull();
    else expect(p.street).toContain(street.split(" ")[0]);
  });

  it("drops the plus-four", () => {
    expect(addressParts("12 Hillcrest Rd 11782-4021").zip).toBe("11782");
  });

  it("does not read a bare zip as a house number", () => {
    // "Sayville 11782" would otherwise parse as street "11782 Sayville".
    expect(addressParts("Sayville 11782").street).toBeNull();
  });

  it("is complete on street plus zip, and not before", () => {
    expect(addressIsComplete("482 Marchmont Ave, 11782")).toBe(true);
    expect(addressIsComplete("482 Marchmont Ave")).toBe(false);
    expect(addressIsComplete("11782")).toBe(false);
    expect(addressIsComplete(null)).toBe(false);
  });

  it("does not need a city or a state", () => {
    // The whole point. A zip resolves both out of PPP's 2,194 curated rows,
    // so asking for them is asking the customer to do our lookup.
    expect(addressIsComplete("12 Hillcrest Rd 11782")).toBe(true);
  });

  it("names the missing half", () => {
    expect(addressGap("482 Marchmont Ave")).toBe("zip");
    expect(addressGap("11782")).toBe("street");
    expect(addressGap("482 Marchmont Ave 11782")).toBeNull();
    expect(addressGap(null)).toBe("both");
  });
});

const ask = (intent: string, ctx: Record<string, unknown>) =>
  validateAction({ intent, confidence: 0.9 } as never, ctx as never);

describe("A13: never ask for what we already hold", () => {
  it("refuses ask_contact when the name and email are on file", () => {
    const v = ask("ask_contact", { knownFields: { name: true, email: true }, stage: 2 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("already on file");
  });

  it("ALLOWS ask_contact when only the name is known", () => {
    // The ask collects two things. Refusing it because we know the name would
    // strand the conversation with no email, which is the opposite failure.
    const v = ask("ask_contact", { knownFields: { name: true, email: false }, stage: 2 });
    expect(v.ok).toBe(true);
  });

  it("refuses ask_project_details when the scope is on file", () => {
    const v = ask("ask_project_details", { knownFields: { inquiryScope: true }, stage: 0 });
    expect(v.ok).toBe(false);
  });

  it("ask_contact is actually in the table", () => {
    // The bug was an absent key, so the regression is an absent key.
    expect(ASK_SUPERSEDED_BY.ask_contact).toEqual(["name", "email"]);
  });
});

describe("A11: a partial address is not an address on file", () => {
  it("refuses ask_address when the address is complete", () => {
    const v = ask("ask_address", {
      knownFields: { address: true }, addressGap: null, stage: 1,
    });
    expect(v.ok).toBe(false);
  });

  it("ALLOWS ask_address when only the zip is missing", () => {
    // Refusing here is how a conversation stalls holding half an address.
    const v = ask("ask_address", {
      knownFields: { address: true }, addressGap: "zip", stage: 1,
    });
    expect(v.ok).toBe(true);
  });

  it("ALLOWS ask_address when only the street is missing", () => {
    const v = ask("ask_address", {
      knownFields: { address: true }, addressGap: "street", stage: 1,
    });
    expect(v.ok).toBe(true);
  });

  it("still refuses when nothing says the address is partial", () => {
    // A caller that does not track addresses in parts gets the old rule,
    // which is the safe direction: no double-asking.
    const v = ask("ask_address", { knownFields: { address: true }, stage: 1 });
    expect(v.ok).toBe(false);
  });
});

describe("A11: the question asks for the missing part only", () => {
  it("asks for the zip, reading the street back", () => {
    const out = renderMessage({
      intent: "ask_address", addressGap: "zip", turn: 0,
      known: { address: "482 Marchmont Ave" },
    });
    expect(out).toContain("zip code");
    expect(out).toContain("482 Marchmont Ave");
    expect(out).not.toMatch(/what.s the address/i);
  });

  it("asks for the street when that is what is missing", () => {
    const out = renderMessage({ intent: "ask_address", addressGap: "street", turn: 0 });
    expect(out).toMatch(/street address/i);
    expect(out).not.toContain("zip");
  });

  it("never asks for a city or a state", () => {
    for (const gap of ["zip", "street"] as const) {
      for (let turn = 0; turn < 4; turn++) {
        const out = renderMessage({
          intent: "ask_address", addressGap: gap, turn, known: { address: "12 Hillcrest Rd" },
        });
        expect(out).not.toMatch(/\bcity\b|\bstate\b/i);
      }
    }
  });

  it("falls back to the ordinary ask when we hold nothing", () => {
    const out = renderMessage({ intent: "ask_address", addressGap: "both", turn: 0 });
    expect(out).toBe("What's the address for the project?");
  });

  it("is unchanged for every other intent", () => {
    const out = renderMessage({ intent: "ask_contact", addressGap: "zip", turn: 0 });
    expect(out).toContain("name and email");
  });
});

/**
 * PROVE THE CHECKS CAN FAIL.
 *
 * These are the exact shapes that were live before this change. If a later
 * edit reverts the behaviour, these go red rather than the suite staying green
 * because an assertion quietly stopped applying.
 */
describe("the old behaviour is genuinely gone", () => {
  it("the pre-fix code would have allowed this ask_contact", () => {
    const v = ask("ask_contact", { knownFields: { name: true, email: true, phone: true }, stage: 2 });
    expect(v.ok).toBe(false);
  });

  it("the pre-fix renderer would have asked for the whole address", () => {
    const out = renderMessage({
      intent: "ask_address", addressGap: "zip", turn: 1, known: { address: "482 Marchmont Ave" },
    });
    expect(["What's the address for the project?", "Where's the property located?"]).not.toContain(out);
  });
});
