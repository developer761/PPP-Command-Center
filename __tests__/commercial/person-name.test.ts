import { describe, it, expect } from "vitest";
import { personName, nameFromEmail } from "@/lib/commercial/person-name";

/**
 * Guards the fix for the approval bell that read
 * "stephanie@tomcopainting.com approved R1 · …" — a raw address dropped into
 * the middle of an English sentence.
 */
describe("nameFromEmail", () => {
  it("takes the local part and capitalises it", () => {
    expect(nameFromEmail("stephanie@tomcopainting.com")).toBe("Stephanie");
    expect(nameFromEmail("brendan@tomcopainting.com")).toBe("Brendan");
  });

  it("splits dotted, underscored and hyphenated locals into words", () => {
    expect(nameFromEmail("karan.malhotra@x.com")).toBe("Karan Malhotra");
    expect(nameFromEmail("mary_smith@x.com")).toBe("Mary Smith");
    expect(nameFromEmail("jo-anne@x.com")).toBe("Jo Anne");
  });

  it("drops a plus-tag and a trailing disambiguator", () => {
    expect(nameFromEmail("karan+test@x.com")).toBe("Karan Test");
    expect(nameFromEmail("jsmith2@x.com")).toBe("Jsmith");
  });

  it("leaves an already-capitalised token alone rather than mangling it", () => {
    // "Mccarthy" produced by us is worse than "McCarthy" typed by a person.
    expect(nameFromEmail("McCarthy@x.com")).toBe("McCarthy");
  });

  it("returns null when there is nothing to work with", () => {
    expect(nameFromEmail(null)).toBeNull();
    expect(nameFromEmail("")).toBeNull();
    expect(nameFromEmail("   ")).toBeNull();
    expect(nameFromEmail("@x.com")).toBeNull();
  });

  it("never returns an empty string for an all-digit local", () => {
    // stripTrailingDigits would empty it; the guard keeps the original.
    expect(nameFromEmail("12345@x.com")).toBe("12345");
  });
});

describe("personName", () => {
  it("prefers the real name", () => {
    expect(personName("Stephanie Ruiz", "stephanie@tomcopainting.com")).toBe("Stephanie Ruiz");
  });

  it("ignores a whitespace-only name", () => {
    expect(personName("   ", "stephanie@tomcopainting.com")).toBe("Stephanie");
  });

  it("falls back to the caller's default when there is no name and no email", () => {
    expect(personName(null, null)).toBe("A teammate");
    expect(personName(null, null, "PPP admin")).toBe("PPP admin");
  });

  it("never leaks a raw address into prose", () => {
    const out = personName(null, "accounts.payable@bigbuilder.com");
    expect(out).not.toContain("@");
    expect(out).toBe("Accounts Payable");
  });
});
