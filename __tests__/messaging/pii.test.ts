import { describe, it, expect } from "vitest";
import { scrub, residualPii } from "@/lib/messaging/pii";

describe("scrub — what must never reach a model", () => {
  it("removes emails and phone numbers in every shape they arrive", () => {
    const t = "Call me at 516-344-8418 or (631) 527 6864, email bob@example.com";
    const r = scrub(t);
    expect(r.text).not.toMatch(/516|631|bob@/);
    expect(r.text).toContain("[PHONE]");
    expect(r.text).toContain("[EMAIL]");
  });

  it("removes a street address and zip", () => {
    const r = scrub("118 Bayview Rd, Sayville 11782");
    expect(r.text).toContain("[ADDRESS]");
    expect(r.text).toContain("[ZIP]");
    expect(r.text).not.toMatch(/Bayview|11782/);
  });

  it("scrubs an email before the phone pattern can eat its digits", () => {
    // a1234567890@x.com would otherwise be half-redacted into nonsense.
    const r = scrub("write to a5163448418@example.com");
    expect(r.text).toBe("write to [EMAIL]");
  });

  it("replaces with placeholders, not deletions", () => {
    // "Is [ADDRESS] correct?" still teaches the pattern. "Is  correct?" does not.
    expect(scrub("Is 42 Hillcrest Ave correct?").text).toBe("Is [ADDRESS] correct?");
  });
});

describe("scrub — names, using what the row already tells us", () => {
  it("removes a known name and its parts", () => {
    const r = scrub("Hi Marisol, this is PPP. Thanks Vega!", ["Marisol Vega"]);
    expect(r.text).not.toMatch(/Marisol|Vega/);
    expect(r.text).toContain("[NAME]");
  });

  it("replaces the FULL name as one unit, not leaving a fragment", () => {
    // Replacing "Mary" first would leave "[NAME] Ellen Smith".
    const r = scrub("Speaking with Mary Ellen Smith today", ["Mary Ellen Smith"]);
    expect(r.text).toBe("Speaking with [NAME] today");
  });

  it("is case-insensitive", () => {
    expect(scrub("thanks MARISOL", ["Marisol"]).text).toBe("thanks [NAME]");
  });

  it("does not redact a name fragment shorter than 3 characters", () => {
    // A surname of "Li" would otherwise redact every "li" in the transcript.
    const r = scrub("The lighting in the living room", ["Bo Li"]);
    expect(r.text).toContain("lighting");
    expect(r.text).toContain("living");
  });

  it("only matches whole words", () => {
    // "Rose" as a customer name must not gut "rosemary".
    const r = scrub("we used rosemary green", ["Rose"]);
    expect(r.text).toContain("rosemary");
  });

  it("survives a name containing regex characters", () => {
    // An unescaped "(" would throw and take the whole import down.
    expect(() => scrub("hello", ["A(B) C+D"])).not.toThrow();
  });

  it("does nothing when no names are supplied", () => {
    expect(scrub("Hi Marisol").text).toBe("Hi Marisol");
  });
});

describe("scrub — reporting", () => {
  it("counts what it found, per kind", () => {
    const r = scrub("a@b.com and c@d.com and 516-344-8418");
    expect(r.found).toContainEqual({ kind: "email", count: 2 });
    expect(r.found).toContainEqual({ kind: "phone", count: 1 });
  });

  it("reports nothing for clean text", () => {
    expect(scrub("Just checking in about your project.").found).toEqual([]);
  });
});

describe("residualPii — the check before import", () => {
  it("catches what a scrub missed", () => {
    expect(residualPii("reach me at bob@example.com")).toContain("email");
  });

  it("is clean on scrubbed text", () => {
    expect(residualPii(scrub("bob@example.com 516-344-8418").text)).toEqual([]);
  });

  it("is repeatable — no leftover regex lastIndex between calls", () => {
    // Global regexes keep state. Without a reset the second call silently
    // returns a different answer to the first.
    const t = "bob@example.com";
    expect(residualPii(t)).toEqual(residualPii(t));
  });
});
