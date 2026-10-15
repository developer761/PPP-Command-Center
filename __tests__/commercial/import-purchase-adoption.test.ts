/**
 * A cost Mary entered here, and the same cost arriving from Salesforce.
 *
 * Her entries are correct and wanted — the Commercial Command Center is the
 * platform going forward. The duplicate was never her doing: the importer only
 * ever asked "is this Salesforce id mapped?", got no, and inserted a second
 * row. Five pairs were live on 2026-10-14 and the list grew by one while that
 * day's cleanup was running, because nothing stopped it recurring.
 *
 * Deleting one side was the wrong instinct. Both rows are real records of one
 * real purchase. So the importer adopts hers instead — one row, one cost, and
 * the map row that keeps the two systems reconcilable.
 *
 * Every case below is a real pair or a real near-miss from that data.
 */
import { describe, expect, it } from "vitest";
import { matchExistingPurchase, type ExistingPurchase } from "@/lib/commercial/import/mapping";

function row(over: Partial<ExistingPurchase> & { id: string }): ExistingPurchase {
  return { vendor: "Sherwin Williams", amount_cents: 77_974, purchased_at: "2026-09-28T12:00:00Z", mapped: false, ...over };
}

describe("the real pairs are adopted", () => {
  it("Sherwin Williams $779.74, three days apart", () => {
    // Salesforce 09-25 (ticket TN-205834), hers 09-28.
    const hit = matchExistingPurchase([row({ id: "hers" })], {
      vendor: "Sherwin Williams",
      amount_cents: 77_974,
      purchased_at: "2026-09-25T12:00:00Z",
    });
    expect(hit.kind).toBe("adopt");
    if (hit.kind === "adopt") {
      expect(hit.row.id).toBe("hers");
      expect(hit.why).toMatch(/3 days later/);
    }
  });

  it("Peter-Profinish $2,400 — the spelling that hid it through a whole cleanup", () => {
    // Salesforce "Peter-Profinish", hers "Peter - Profinish". A
    // trim-and-lowercase comparison puts those in different buckets.
    const hit = matchExistingPurchase(
      [row({ id: "hers", vendor: "Peter - Profinish", amount_cents: 240_000, purchased_at: "2026-09-30T12:00:00Z" })],
      { vendor: "Peter-Profinish", amount_cents: 240_000, purchased_at: "2026-09-29T12:00:00Z" },
    );
    expect(hit.kind).toBe("adopt");
  });

  it("Sunbelt Rentals $2,593.96, filed under different categories", () => {
    // Salesforce calls it materials, she called it equipment. Category is
    // deliberately NOT part of the match: it is how each system SORTED the
    // money, not what the money is.
    const hit = matchExistingPurchase(
      [row({ id: "hers", vendor: "Sunbelt Rentals", amount_cents: 259_396, purchased_at: "2026-09-22T12:00:00Z" })],
      { vendor: "Sunbelt Rentals", amount_cents: 259_396, purchased_at: "2026-09-21T12:00:00Z" },
    );
    expect(hit.kind).toBe("adopt");
  });

  it("same day reads naturally", () => {
    const hit = matchExistingPurchase([row({ id: "hers", purchased_at: "2026-09-25T12:00:00Z" })], {
      vendor: "Sherwin Williams",
      amount_cents: 77_974,
      purchased_at: "2026-09-25T12:00:00Z",
    });
    if (hit.kind !== "adopt") throw new Error("expected adopt");
    expect(hit.why).toBe("already recorded here on the same day");
  });
});

describe("what must NOT be adopted", () => {
  it("a different amount", () => {
    const hit = matchExistingPurchase([row({ id: "hers", amount_cents: 77_975 })], {
      vendor: "Sherwin Williams",
      amount_cents: 77_974,
      purchased_at: "2026-09-25T12:00:00Z",
    });
    expect(hit.kind).toBe("insert");
  });

  it("a different vendor", () => {
    const hit = matchExistingPurchase([row({ id: "hers", vendor: "Home Depot" })], {
      vendor: "Sherwin Williams",
      amount_cents: 77_974,
      purchased_at: "2026-09-25T12:00:00Z",
    });
    expect(hit.kind).toBe("insert");
  });

  it("outside the window — a monthly bill at the same amount is not the same bill", () => {
    const hit = matchExistingPurchase([row({ id: "hers", purchased_at: "2026-08-25T12:00:00Z" })], {
      vendor: "Sherwin Williams",
      amount_cents: 77_974,
      purchased_at: "2026-09-25T12:00:00Z",
    });
    expect(hit.kind).toBe("insert");
  });

  it("a row the importer already owns", () => {
    // It is another Salesforce transaction's row. Adopting it would steal the
    // link and leave that transaction to insert a duplicate of its own.
    const hit = matchExistingPurchase([row({ id: "theirs", mapped: true })], {
      vendor: "Sherwin Williams",
      amount_cents: 77_974,
      purchased_at: "2026-09-25T12:00:00Z",
    });
    expect(hit.kind).toBe("insert");
  });

  it("a blank vendor is an absence, not a match", () => {
    // Adopting on (amount, date) alone would merge two unrelated receipts for
    // the same money on one job in one week — which happens.
    expect(
      matchExistingPurchase([row({ id: "hers", vendor: null })], {
        vendor: null,
        amount_cents: 77_974,
        purchased_at: "2026-09-25T12:00:00Z",
      }).kind,
    ).toBe("insert");
    expect(
      matchExistingPurchase([row({ id: "hers" })], {
        vendor: "",
        amount_cents: 77_974,
        purchased_at: "2026-09-25T12:00:00Z",
      }).kind,
    ).toBe("insert");
  });

  it("no date to compare", () => {
    expect(
      matchExistingPurchase([row({ id: "hers" })], {
        vendor: "Sherwin Williams",
        amount_cents: 77_974,
        purchased_at: null,
      }).kind,
    ).toBe("insert");
  });
});

describe("two candidates is a question, not a guess", () => {
  it("asks rather than adopting one at random", () => {
    // A crew buying the same thing twice in a week is ordinary. Adopting the
    // first would attach the Salesforce record to whichever sorted first and
    // orphan the other.
    const hit = matchExistingPurchase(
      [row({ id: "a", purchased_at: "2026-09-26T12:00:00Z" }), row({ id: "b", purchased_at: "2026-09-27T12:00:00Z" })],
      { vendor: "Sherwin Williams", amount_cents: 77_974, purchased_at: "2026-09-25T12:00:00Z" },
    );
    expect(hit.kind).toBe("ask");
    if (hit.kind === "ask") {
      expect(hit.row).toBeNull();
      expect(hit.why).toMatch(/2 rows/);
    }
  });

  it("but adopts when only one of the two is still free", () => {
    const hit = matchExistingPurchase(
      [row({ id: "taken", mapped: true }), row({ id: "free" })],
      { vendor: "Sherwin Williams", amount_cents: 77_974, purchased_at: "2026-09-25T12:00:00Z" },
    );
    expect(hit.kind).toBe("adopt");
    if (hit.kind === "adopt") expect(hit.row.id).toBe("free");
  });
});

describe("the importer is wired to it", () => {
  it("stageCosts adopts before inserting, and stamps the adoption stale", async () => {
    // Asserted on the SEAM. The epoch stamp is the load-bearing half: stamping
    // NOW would make her row look untouched since the last sync, and the next
    // run would overwrite the category she chose with Salesforce's.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/import-tomco.mjs", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain("matchExistingPurchase(");
    expect(src).toMatch(/adopt[\s\S]{0,400}remember\(\s*"purchase"/);
    expect(src).toMatch(/remember\(\s*"purchase"[\s\S]{0,200}new Date\(0\)/);
  });
});
