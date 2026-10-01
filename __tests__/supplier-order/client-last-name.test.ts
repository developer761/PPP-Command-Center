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

describe("a numbered account is not a person (Katie, 2026-10-01)", () => {
  it("puts no name on the PO for 'Testing Paint Hub, 2'", () => {
    // Her report: "Remove Hub from PO + subject line". The comma branch read
    // the name as "Surname, Firstname" and answered with the last word before
    // the comma, so a live purchase order and its email subject both said
    // "00319896 Hub".
    expect(clientLastName("Testing Paint Hub, 2")).toBe("");
    expect(poBaseFor("00319896", "Testing Paint Hub, 2")).toBe("00319896");
  });

  it("holds for any duplicate-account number", () => {
    for (const n of ["Smith Residence, 2", "Acme, 3", "Jones, 10"]) {
      expect(clientLastName(n), n).toBe("");
    }
  });

  it("still reverses a REAL surname-first name", () => {
    // The rule this sits next to, which must not regress — Jason asked for the
    // client's last name on the PO and that is still what a person gets.
    expect(clientLastName("Smith, John")).toBe("Smith");
    expect(clientLastName("O'Brien, Patrick J.")).toBe("O'Brien");
    expect(poBaseFor("00319896", "John Smith")).toBe("00319896 Smith");
  });

  it("still treats a comma before a suffix as punctuation", () => {
    expect(clientLastName("Smith, Jr.")).toBe("Smith");
  });
});
