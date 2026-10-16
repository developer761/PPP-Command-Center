/**
 * One parser for every recipient list, and a cap that never cuts an address in
 * half.
 *
 * The 2026-10-14 audit found four recipient builders, each missing a different
 * one of split / lowercase / validate / de-dup:
 *
 *   opsAlertRecipients       lower + validate, NO de-dup  → manufactured a duplicate
 *   receivablesRecipients    none of the three            → one typo killed the send
 *   reportRecipients         validate only                → sent the report twice
 *   parseList (proposals)    all four                     → the only correct one
 *
 * Every omission is its own outage, and two of them are the kind nobody
 * notices: Resend rejects the WHOLE send on one bad address, and a repeated
 * address is how a provider decides to deliver two copies.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseRecipients, withoutVisible } from "@/lib/email/recipients";
import { stripComments } from "../helpers/strip-comments";

describe("parseRecipients does all four jobs", () => {
  it("splits on every separator these lists actually arrive with", () => {
    expect(parseRecipients("a@x.com, b@x.com; c@x.com\nd@x.com e@x.com\tf@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
      "f@x.com",
    ]);
  });

  it("de-duplicates ACROSS case — the manufactured duplicate", () => {
    // THE BUG: lowercasing without de-duplicating turns a list with no visible
    // repeat into two identical recipients.
    expect(parseRecipients("Kate@x.com, kate@x.com")).toEqual(["kate@x.com"]);
    expect(parseRecipients("  KIM@X.COM  ;kim@x.com")).toEqual(["kim@x.com"]);
  });

  it("drops anything that is not an address, rather than handing it to Resend", () => {
    // One invalid recipient rejects the entire send, so "alex@x.com, tbd"
    // delivered to nobody.
    expect(parseRecipients("alex@x.com, tbd")).toEqual(["alex@x.com"]);
    expect(parseRecipients("not-an-email")).toEqual([]);
    expect(parseRecipients("a@b")).toEqual([]);
  });

  it("keeps the order somebody wrote, first spelling winning", () => {
    expect(parseRecipients("Zoe@x.com, adam@x.com, ZOE@x.com")).toEqual([
      "zoe@x.com",
      "adam@x.com",
    ]);
  });

  it("treats empty, null and punctuation-only as nobody", () => {
    expect(parseRecipients("")).toEqual([]);
    expect(parseRecipients(null)).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients("  ,  ; ")).toEqual([]);
  });
});

describe("withoutVisible", () => {
  it("drops anyone who can already see the message, case-insensitively", () => {
    expect(
      withoutVisible(["a@x.com", "b@x.com", "c@x.com"], ["A@X.com"], [" c@x.com "]),
    ).toEqual(["b@x.com"]);
  });

  it("returns the list untouched when nobody is visible", () => {
    expect(withoutVisible(["a@x.com"], [], [])).toEqual(["a@x.com"]);
  });
});

/**
 * The crew list on a work order. Capped, because the column is TEXT and a
 * crafted POST should not be able to stuff it — but capped by WHOLE addresses.
 *
 * `uniq.join(", ").slice(0, 500)` validated every address and then cut the
 * string mid-way through the last one, so a crew of ~18 stored a fragment like
 * "forem" and Resend rejected the entire send. Nobody on the crew got the work
 * order, and the person who pressed Send was told nothing.
 */
describe("the work-order crew list is capped by whole addresses", () => {
  /** Mirrors lib/commercial/work-orders/db.ts — see the test below that pins it. */
  function capCrew(valid: string[]): string | null {
    const ADDRESS_LIMIT = 50;
    const JOINED_LIMIT = 2000;
    const kept: string[] = [];
    for (const e of [...new Set(valid)]) {
      if (kept.length >= ADDRESS_LIMIT) break;
      const joined = kept.length === 0 ? e : `${kept.join(", ")}, ${e}`;
      if (joined.length > JOINED_LIMIT) break;
      kept.push(e);
    }
    return kept.length > 0 ? kept.join(", ") : null;
  }

  it("never stores a fragment — every stored address is still valid", () => {
    // 40 crew at ~26 chars each is ~1050 chars: comfortably under the old 500
    // cap's breaking point, and the case that used to truncate.
    const crew = Array.from({ length: 40 }, (_, i) => `crewmember${String(i).padStart(2, "0")}@tomco.com`);
    const stored = capCrew(crew)!;
    const back = stored.split(", ");
    expect(back).toHaveLength(40);
    for (const e of back) expect(e, `"${e}" is a fragment`).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it("the OLD cap corrupted or dropped crew — the regression, stated precisely", () => {
    const crew = Array.from({ length: 40 }, (_, i) => `crewmember${String(i).padStart(2, "0")}@tomco.com`);
    const oldWay = crew.join(", ").slice(0, 500);
    const stored = oldWay.split(", ");

    // Most of the crew is gone outright: 500 characters holds about 20 of 40.
    expect(stored.length).toBeLessThan(crew.length);

    // And the last one survives in CORRUPTED form — "crewmember20@tomco.c".
    // Note it still satisfies the app's own loose address regex, so neither the
    // validator nor a shape check catches it; mail just goes to a domain that
    // does not exist, or Resend rejects the send outright. Either way that crew
    // member never receives the work order and nobody is told.
    const last = stored[stored.length - 1];
    expect(crew).not.toContain(last);
    expect(crew.some((e) => e.startsWith(last))).toBe(true);
  });

  it("still refuses an absurd list, and cuts between addresses when it does", () => {
    const crew = Array.from({ length: 200 }, (_, i) => `person${i}@averyverylongdomainname.example.com`);
    const stored = capCrew(crew)!;
    const back = stored.split(", ");
    expect(back.length).toBeLessThanOrEqual(50);
    for (const e of back) expect(e).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(stored.length).toBeLessThanOrEqual(2000);
  });

  it("one address, and none", () => {
    expect(capCrew(["a@x.com"])).toBe("a@x.com");
    expect(capCrew([])).toBeNull();
  });

  it("the real code caps by whole addresses, not by slicing the joined string", () => {
    // A copy of the logic can drift from the original, so pin the original's
    // SHAPE too: the old `.join(", ").slice(` is what must not come back.
    const src = stripComments(readFileSync("lib/commercial/work-orders/db.ts", "utf8"));
    expect(src).not.toMatch(/crew_email\s*=\s*uniq\.length[\s\S]{0,40}\.join\(", "\)\.slice\(/);
    expect(src).toContain("JOINED_LIMIT");
  });
});
