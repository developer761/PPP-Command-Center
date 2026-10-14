/**
 * The duplicate detector, and the false positive that makes it necessary.
 *
 * Every case here is taken from the real 2026-10-14 data, because the detector
 * that preceded it was written from reasoning and reported $83,531.51 against a
 * true figure of $21,494.99.
 */
import { describe, expect, it } from "vitest";
import {
  findNearMissDuplicates,
  rowToRemove,
  type NearMissRow,
} from "@/lib/commercial/import/near-miss";

const AIREF = "deal-airef-2";

function row(over: Partial<NearMissRow> & { id: string }): NearMissRow {
  return {
    groupKey: AIREF,
    payee: "Tomco Labor - Greg",
    amountCents: 198_722,
    occurredAt: "2026-10-06",
    imported: true,
    ...over,
  };
}

describe("a recurring wage is not a duplicate", () => {
  it("does NOT flag the same weekly amount on four different weeks", () => {
    // Greg, $1,987.22, four weeks, all four imported from Salesforce. This is
    // the shape that produced 107 false pairs when the key ignored the date.
    const r = findNearMissDuplicates([
      row({ id: "w1", occurredAt: "2026-06-10" }),
      row({ id: "w2", occurredAt: "2026-07-07" }),
      row({ id: "w3", occurredAt: "2026-08-12" }),
      row({ id: "w4", occurredAt: "2026-08-18" }),
    ]);
    expect(r.cross).toHaveLength(0);
    expect(r.same).toHaveLength(0);
    expect(r.crossCents).toBe(0);
    expect(r.scanned).toBe(4);
  });

  it("DOES flag two consecutive weeks if they fall inside the window", () => {
    // 08-12 and 08-18 are 6 days apart — outside. 08-12 and 08-14 are not.
    // Stated so the window's edge is a decision on the record, not an accident.
    const r = findNearMissDuplicates([
      row({ id: "a", occurredAt: "2026-08-12", imported: true }),
      row({ id: "b", occurredAt: "2026-08-14", imported: false }),
    ]);
    expect(r.cross).toHaveLength(1);
    expect(r.cross[0].daysApart).toBe(2);
  });
});

describe("the dual-run collision", () => {
  it("flags one day apart, one side imported — the real 35-pair shape", () => {
    const r = findNearMissDuplicates([
      row({ id: "sf", occurredAt: "2026-10-06", imported: true }),
      row({ id: "cc", occurredAt: "2026-10-07", imported: false }),
    ]);
    expect(r.cross).toHaveLength(1);
    expect(r.cross[0].daysApart).toBe(1);
    expect(r.cross[0].crossProvenance).toBe(true);
    expect(r.crossCents).toBe(198_722);
  });

  it("would have been MISSED by an exact-day match", () => {
    // The guarantee that the earlier scripts' key cannot find these.
    const rows = [
      row({ id: "sf", occurredAt: "2026-10-06", imported: true }),
      row({ id: "cc", occurredAt: "2026-10-07", imported: false }),
    ];
    expect(findNearMissDuplicates(rows, { windowDays: 0 }).cross).toHaveLength(0);
    expect(findNearMissDuplicates(rows).cross).toHaveLength(1);
  });

  it("separates same-provenance pairs out as questions, not findings", () => {
    // AIREF #3, "Tomco Labor", $400.00, two rows, both from Salesforce, same
    // day. Could be one payout entered twice over there, or two real ones.
    const r = findNearMissDuplicates([
      row({ id: "x", payee: "Tomco Labor", amountCents: 40_000, occurredAt: "2026-07-29" }),
      row({ id: "y", payee: "Tomco Labor", amountCents: 40_000, occurredAt: "2026-07-29" }),
    ]);
    expect(r.cross).toHaveLength(0);
    expect(r.same).toHaveLength(1);
    expect(r.crossCents).toBe(0);
  });

  it("keeps jobs and payees apart", () => {
    // Joe earned $258.36 on four different jobs in the same week. Four real
    // payouts; the job is part of the identity.
    const r = findNearMissDuplicates([
      row({ id: "j1", groupKey: "mcdonalds", payee: "Joe", amountCents: 25_836, occurredAt: "2026-09-24", imported: false }),
      row({ id: "j2", groupKey: "panera", payee: "Joe", amountCents: 25_836, occurredAt: "2026-09-24", imported: false }),
      row({ id: "j3", groupKey: "cipla", payee: "Joe", amountCents: 25_836, occurredAt: "2026-09-24", imported: false }),
      row({ id: "j4", groupKey: "galil", payee: "Joe", amountCents: 25_836, occurredAt: "2026-09-24", imported: false }),
    ]);
    expect(r.cross).toHaveLength(0);
    expect(r.same).toHaveLength(0);
  });

  it("matches payees case- and whitespace-insensitively", () => {
    // "Cummins Sales and Service" vs "Cummins sales and Service" is a real
    // difference in this data, and SOQL's `=` on Name ignores it too.
    const r = findNearMissDuplicates([
      row({ id: "a", payee: "Sherwin Williams", occurredAt: "2026-09-14", imported: false }),
      row({ id: "b", payee: " sherwin williams ", occurredAt: "2026-09-15", imported: true }),
    ]);
    expect(r.cross).toHaveLength(1);
  });
});

describe("pairing is greedy, so a triple is one pair and a leftover", () => {
  it("reports one pair from three rows at the same amount in the window", () => {
    const r = findNearMissDuplicates([
      row({ id: "a", occurredAt: "2026-10-06", imported: true }),
      row({ id: "b", occurredAt: "2026-10-07", imported: false }),
      row({ id: "c", occurredAt: "2026-10-07", imported: false }),
    ]);
    expect(r.cross.length + r.same.length).toBe(1);
    expect(r.crossCents).toBe(198_722);
  });
});

describe("rowToRemove keeps the side that ties to Salesforce", () => {
  it("returns the UNMAPPED row, whichever order the pair came in", () => {
    const sf = row({ id: "sf", occurredAt: "2026-10-06", imported: true });
    const cc = row({ id: "cc", occurredAt: "2026-10-07", imported: false });
    expect(rowToRemove(findNearMissDuplicates([sf, cc]).cross[0])?.id).toBe("cc");
    expect(rowToRemove(findNearMissDuplicates([cc, sf]).cross[0])?.id).toBe("cc");
  });

  it("refuses to choose on a same-provenance pair", () => {
    const r = findNearMissDuplicates([
      row({ id: "x", amountCents: 40_000, occurredAt: "2026-07-29" }),
      row({ id: "y", amountCents: 40_000, occurredAt: "2026-07-29" }),
    ]);
    expect(rowToRemove(r.same[0])).toBeNull();
  });
});

describe("missing dates cannot create a pair", () => {
  it("skips rows with no date rather than treating null as a match", () => {
    const r = findNearMissDuplicates([
      row({ id: "a", occurredAt: null, imported: true }),
      row({ id: "b", occurredAt: null, imported: false }),
    ]);
    expect(r.cross).toHaveLength(0);
  });

  it("skips an unparseable date", () => {
    const r = findNearMissDuplicates([
      row({ id: "a", occurredAt: "not a date", imported: true }),
      row({ id: "b", occurredAt: "2026-10-07", imported: false }),
    ]);
    expect(r.cross).toHaveLength(0);
  });
});

describe("it proves it measured", () => {
  it("reports scanned: 0 on an empty book rather than a silent pass", () => {
    const r = findNearMissDuplicates([]);
    expect(r.scanned).toBe(0);
    expect(r.cross).toHaveLength(0);
  });
});

describe("one payee spelled two ways is still one payee", () => {
  it("matches across punctuation — the $2,400 pair that survived the cleanup", () => {
    // Salesforce holds the sub as "Peter-Profinish", the app as
    // "Peter - Profinish". Lower-case-and-trim left them in different buckets,
    // so this duplicate was invisible to the sweep that removed 35 others.
    const r = findNearMissDuplicates([
      row({ id: "sf", payee: "Peter-Profinish", amountCents: 240_000, occurredAt: "2026-09-23", imported: true }),
      row({ id: "cc", payee: "Peter - Profinish", amountCents: 240_000, occurredAt: "2026-09-24", imported: false }),
    ]);
    expect(r.cross).toHaveLength(1);
    expect(r.crossCents).toBe(240_000);
  });

  it("matches across case, punctuation and inner spacing together", () => {
    const r = findNearMissDuplicates([
      row({ id: "a", payee: "Sherwin-Williams Co.", occurredAt: "2026-09-23", imported: true }),
      row({ id: "b", payee: "sherwin williams co", occurredAt: "2026-09-24", imported: false }),
    ]);
    expect(r.cross).toHaveLength(1);
  });

  it("does NOT merge genuinely different payees", () => {
    // The guard on the normalisation: stripping punctuation must not turn two
    // suppliers into one.
    const r = findNearMissDuplicates([
      row({ id: "a", payee: "Home Depot", occurredAt: "2026-09-23", imported: true }),
      row({ id: "b", payee: "Home Depot 2", occurredAt: "2026-09-24", imported: false }),
    ]);
    expect(r.cross).toHaveLength(0);
  });

  it("a null payee does not collide with an empty-string payee's real twin", () => {
    // Both normalise to "" — so they CAN pair, and that is correct: the job,
    // amount and date window still have to agree. Stated so the behaviour is a
    // decision rather than a surprise.
    const r = findNearMissDuplicates([
      row({ id: "a", payee: null, occurredAt: "2026-09-23", imported: true }),
      row({ id: "b", payee: "", occurredAt: "2026-09-24", imported: false }),
    ]);
    expect(r.cross).toHaveLength(1);
  });
});
