import { describe, it, expect } from "vitest";
import { clientLastName, poBaseFor } from "@/lib/supplier-order/client-last-name";

/**
 * Jason, testing the paint tool with Adler and Ido (2026-09-24): "please add
 * clients last name as part of the po number."
 *
 * The input is a Salesforce ACCOUNT NAME, which is a person on a residential
 * job and a company on a commercial one, entered by hand over several years.
 * Getting the wrong end of it puts a customer's first name — or the word
 * "LLC" — on a purchase order a vendor reads back to PPP.
 */

describe("a person's account name", () => {
  it("is known by the last word", () => {
    expect(clientLastName("John Smith")).toBe("Smith");
    expect(clientLastName("Mary Anne Delgado")).toBe("Delgado");
    expect(clientLastName("  Test   Testing  ")).toBe("Testing");
  });

  it("reversed by a comma, the SURNAME comes first", () => {
    // Both orders exist in PPP's Salesforce. Taking the last word here would
    // put "John" on the purchase order.
    expect(clientLastName("Smith, John")).toBe("Smith");
    expect(clientLastName("O'Brien, Patrick J.")).toBe("O'Brien");
  });

  it("ignores a generational or professional suffix", () => {
    expect(clientLastName("John Smith Jr.")).toBe("Smith");
    expect(clientLastName("Robert Vance III")).toBe("Vance");
    expect(clientLastName("Ana Ruiz MD")).toBe("Ruiz");
    // …but a comma before a suffix is punctuation, not a reversal.
    expect(clientLastName("Smith, Jr.")).toBe("Smith");
  });

  it("keeps the punctuation that is part of a name, and drops the rest", () => {
    expect(clientLastName("Jean-Luc Picard")).toBe("Picard");
    expect(clientLastName("Sean O'Neill")).toBe("O'Neill");
    expect(clientLastName("Maria Lopez-Garcia")).toBe("Lopez-Garcia");
    expect(clientLastName("John Smith (do not mail)")).toBe("Smith");
  });
});

describe("a company's account name", () => {
  it("is known by how it STARTS, not how it ends", () => {
    // "Garden City Realty LLC" → the last word is "LLC", which is on a third
    // of the commercial accounts and identifies none of them.
    expect(clientLastName("Garden City Realty LLC")).toBe("Garden");
    expect(clientLastName("Tomco Painting, Inc.")).toBe("Tomco");
    expect(clientLastName("Bayview Condominium Association")).toBe("Bayview");
    expect(clientLastName("St. Mary's Hospital")).toBe("St");
  });
});

describe("when there is nothing usable", () => {
  it("gives back an empty string rather than a word on a purchase order", () => {
    for (const v of [null, undefined, "", "   ", "!!!", ","]) {
      expect(clientLastName(v), JSON.stringify(v)).toBe("");
    }
  });

  it("and the PO is then simply the work order number", () => {
    expect(poBaseFor("00318847", null)).toBe("00318847");
    expect(poBaseFor("00318847", "   ")).toBe("00318847");
  });
});

describe("the PO number itself", () => {
  it("is the work order number then the client's name", () => {
    expect(poBaseFor("00318847", "John Smith")).toBe("00318847 Smith");
    expect(poBaseFor("00318847", "Garden City Realty LLC")).toBe("00318847 Garden");
  });

  it("never grows without bound from a pasted essay in the name field", () => {
    const silly = `Smith${"x".repeat(200)}`;
    expect(poBaseFor("00318847", `John ${silly}`).length).toBeLessThan(40);
  });
});
