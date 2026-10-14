/**
 * The pairing ranker, tested on the two real pairs it exists for.
 *
 * Measured in production 2026-10-14: of the four sold Command Center deals with
 * no Salesforce link, two already had a twin over there. Those two are the cases
 * every naive matcher gets wrong, so they are the cases here:
 *
 *   Cummins          ours $5,150.00  ↔  SF "Cummins -Interior" $5,150   same cent
 *   PCCI Eastport    ours $8,900.00  ↔  SF "Facade Renovation-Eastport" $9,350
 *                                       same job, price renegotiated down
 *
 * Exact name match misses both. Substring misses PCCI. Amount catches Cummins
 * and misses PCCI. Nothing here auto-pairs — the ranker only has to put the
 * right record on top of the list a person reads.
 */
import { describe, expect, it } from "vitest";
import { rankCandidates, type SfCandidate, type SoldDeal } from "@/lib/salesforce/tomco-pairing";

function cand(over: Partial<SfCandidate> & { sfId: string; name: string }): SfCandidate {
  return {
    accountName: null,
    stageName: "Estimate Sent",
    closeDate: null,
    subtotalCents: null,
    alreadyPaired: false,
    ...over,
  };
}

/** The 43 open Tomco estimates, as a handful of the real ones. */
const OPEN: SfCandidate[] = [
  cand({ sfId: "006cummins", name: "Cummins -Interior", accountName: "Cummins sales and Service", subtotalCents: 515_000, closeDate: "2026-10-10" }),
  cand({ sfId: "006pcci", name: "Facade Renovation-Eastport", accountName: "PCCI Builders Corp.", subtotalCents: 935_000, closeDate: "2026-09-23" }),
  cand({ sfId: "006tesla1", name: "Tesla-Islip", accountName: "Spano Industries", subtotalCents: 3_803_020, closeDate: "2026-10-14" }),
  cand({ sfId: "006tesla2", name: "Tesla-Islip", accountName: "Vision General Contractors", subtotalCents: 3_803_020, closeDate: "2026-10-14" }),
  cand({ sfId: "006glaz", name: "Southern Glazers- HR Dept.", accountName: "TLA Contracting Inc.", subtotalCents: 450_000, closeDate: "2026-10-08" }),
  cand({ sfId: "006avr", name: "AVR-Lot C", accountName: "LMJ Management & Construction", subtotalCents: 38_588_222, closeDate: "2026-09-09" }),
];

describe("the two real twins come out on top", () => {
  it("puts Cummins -Interior first for the Cummins deal", () => {
    const deal: SoldDeal = {
      id: "deal-cummins",
      title: "Cummins",
      accountName: "Cummins Sales and Service",
      contractCents: 515_000,
      decidedAt: "2026-10-13",
    };
    const ranked = rankCandidates(deal, OPEN);
    expect(ranked[0].sfId).toBe("006cummins");
    expect(ranked[0].reasons).toContain("same account");
    expect(ranked[0].reasons).toContain("amount matches to the cent");
    // And the right answer must be clearly ahead, not a coin toss.
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score + 20);
  });

  it("puts Facade Renovation-Eastport first for PCCI, despite the price moving", () => {
    // THE CASE AMOUNT MATCHING CANNOT SOLVE: $8,900 sold against a $9,350
    // estimate. The account and the shared words have to carry it.
    const deal: SoldDeal = {
      id: "deal-pcci",
      title: "PCCI Builders Corp. Eastport Facade Renovation",
      accountName: "PCCI Builders Corp.",
      contractCents: 890_000,
      decidedAt: "2026-10-13",
    };
    const ranked = rankCandidates(deal, OPEN);
    expect(ranked[0].sfId).toBe("006pcci");
    expect(ranked[0].reasons).toContain("same account");
    expect(ranked[0].reasons.join(" ")).toMatch(/words in common/);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score + 20);
  });

  it("matches the account across a letter-case difference", () => {
    // Ours says "Cummins Sales and Service", Salesforce says "Cummins sales and
    // Service". SOQL's `=` ignores that too — and so must this.
    const ranked = rankCandidates(
      { id: "d", title: "Cummins", accountName: "Cummins Sales and Service", contractCents: null, decidedAt: null },
      OPEN,
    );
    expect(ranked[0].sfId).toBe("006cummins");
  });
});

describe("the genuinely new deals do not get a confident wrong answer", () => {
  it("scores everything low for Flagstar, which has no twin", () => {
    const deal: SoldDeal = {
      id: "deal-flagstar",
      title: "Flagstar Bank Trash Enclosures",
      accountName: "PCCI Builders Corp.",
      contractCents: 240_000,
      decidedAt: "2026-10-07",
    };
    const ranked = rankCandidates(deal, OPEN);
    // PCCI's other job will top the list on account alone — that is correct and
    // useful. What matters is that it does NOT look like a match: no amount
    // agreement and no shared words beyond the company.
    expect(ranked[0].reasons).not.toContain("amount matches to the cent");
    expect(ranked[0].score).toBeLessThan(80);
  });

  it("scores everything low for Thermo Fisher, whose account isn't even open", () => {
    const ranked = rankCandidates(
      { id: "d", title: "Thermo Fisher Inspection Room & Exterior Door Painting P.O. 718210", accountName: "Thermo Fisher", contractCents: 537_500, decidedAt: "2026-10-07" },
      OPEN,
    );
    expect(ranked[0].score).toBeLessThan(40);
  });
});

describe("the two identical Tesla-Islip records", () => {
  it("ranks both, and does not pretend one is the answer", () => {
    // Mary created these the same day, same amount, different accounts. A
    // person has to choose; the ranker must not hide one or separate them.
    const ranked = rankCandidates(
      { id: "d", title: "Tesla Islip", accountName: "Spano Industries", contractCents: 3_803_020, decidedAt: "2026-10-14" },
      OPEN,
    );
    const teslas = ranked.filter((c) => c.name === "Tesla-Islip");
    expect(teslas).toHaveLength(2);
    // The account breaks the tie — which is the only honest signal available.
    expect(ranked[0].sfId).toBe("006tesla1");
    expect(teslas[1].score).toBeGreaterThan(0);
  });
});

describe("a record already linked to another deal", () => {
  it("is sorted last and says so, rather than being hidden", () => {
    const taken = OPEN.map((c) => (c.sfId === "006cummins" ? { ...c, alreadyPaired: true } : c));
    const ranked = rankCandidates(
      { id: "deal-cummins", title: "Cummins", accountName: "Cummins Sales and Service", contractCents: 515_000, decidedAt: "2026-10-13" },
      taken,
    );
    // Still present — hiding it would leave a reader wondering where the obvious
    // match went — but last, and labelled.
    expect(ranked.at(-1)!.sfId).toBe("006cummins");
    expect(ranked.at(-1)!.reasons.join(" ")).toMatch(/already linked/);
    expect(ranked.at(-1)!.score).toBe(0);
  });
});

describe("it degrades rather than throws", () => {
  it("handles a deal with no account, amount or date", () => {
    const ranked = rankCandidates(
      { id: "d", title: "Untitled", accountName: null, contractCents: null, decidedAt: null },
      OPEN,
    );
    expect(ranked).toHaveLength(OPEN.length);
    expect(ranked.every((c) => c.score >= 0 && c.score <= 100)).toBe(true);
  });

  it("handles an empty candidate list", () => {
    expect(rankCandidates({ id: "d", title: "x", accountName: null, contractCents: null, decidedAt: null }, [])).toEqual([]);
  });

  it("ignores a zero-value Salesforce subtotal rather than calling it a match", () => {
    // Two open Tomco opps sit in the "CA, FL" pricebook where the Other entry
    // is $0, so a $0 subtotal means "no price", not "free".
    const ranked = rankCandidates(
      { id: "d", title: "Whatever", accountName: null, contractCents: 0, decidedAt: null },
      [cand({ sfId: "006zero", name: "Zero priced", subtotalCents: 0 })],
    );
    expect(ranked[0].reasons).not.toContain("amount matches to the cent");
  });
});

/**
 * Each signal, isolated.
 *
 * The cases above all passed with the account weight set to zero, and again
 * with the word-overlap weight set to zero — because on the real pairs the
 * other signals carry the result on their own. That is good robustness and bad
 * testing: it meant two thirds of the ranker could be deleted silently. These
 * construct the case where ONE signal is the only thing separating two
 * candidates, so removing it flips the answer.
 */
describe("every signal is load-bearing on its own", () => {
  const twins = (over: Partial<SfCandidate>[]) =>
    over.map((o, i) => cand({ sfId: `c${i}`, name: `Candidate ${i}`, ...o }));

  it("the ACCOUNT alone decides when nothing else differs", () => {
    const ranked = rankCandidates(
      { id: "d", title: "Nothing In Common Here", accountName: "Spano Industries", contractCents: null, decidedAt: null },
      twins([{ accountName: "Unrelated Holdings" }, { accountName: "Spano Industries" }]),
    );
    expect(ranked[0].sfId).toBe("c1");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("the AMOUNT alone decides when nothing else differs", () => {
    const ranked = rankCandidates(
      { id: "d", title: "Nothing In Common Here", accountName: null, contractCents: 515_000, decidedAt: null },
      twins([{ subtotalCents: 999_999 }, { subtotalCents: 515_000 }]),
    );
    expect(ranked[0].sfId).toBe("c1");
    expect(ranked[0].reasons).toContain("amount matches to the cent");
  });

  it("the SHARED WORDS alone decide when nothing else differs", () => {
    /*
     * The PCCI shape with every other signal removed: no accounts, no prices,
     * no dates. Only the job name connects them.
     *
     * The matching name is deliberately LATE in the alphabet. The first version
     * of this test used "Facade Renovation-Eastport" against "Something
     * Unrelated", and passed with the word weight set to zero — because on a
     * score tie the sort falls back to localeCompare and "Facade" sorts first
     * anyway. It was testing the tiebreaker, not the signal.
     */
    const ranked = rankCandidates(
      { id: "d", title: "Eastport Facade Renovation", accountName: null, contractCents: null, decidedAt: null },
      twins([
        { name: "Aardvark Unrelated Job" },
        { name: "Zzz Facade Renovation-Eastport" },
      ]),
    );
    expect(ranked[0].sfId).toBe("c1");
    expect(ranked[0].reasons.join(" ")).toMatch(/words in common/);
    // And on SCORE, not merely on order — `reasons` is pushed regardless of the
    // weight, so asserting the wording alone would pass with it zeroed too.
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("the CLOSE DATE alone breaks a tie when nothing else differs", () => {
    const ranked = rankCandidates(
      { id: "d", title: "Nothing In Common Here", accountName: null, contractCents: null, decidedAt: "2026-10-13" },
      twins([{ closeDate: "2024-01-01" }, { closeDate: "2026-10-10" }]),
    );
    expect(ranked[0].sfId).toBe("c1");
    expect(ranked[0].reasons.join(" ")).toMatch(/closed within/);
  });
});
