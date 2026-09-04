import { describe, it, expect } from "vitest";
import {
  billedPct,
  dealStandingLines,
  money,
  type DealStandingInput,
} from "@/lib/commercial/opportunities/deal-standing";

/**
 * Brendan 2026-08-26: "under 'this month' it should say things specific to the
 * deal — this one is billed 5k out of 25k, the work order hasn't been sent."
 *
 * The Activity rail was pure chronology: "Proposal R2 sent · Closed →
 * Pre-Construction · Proposal marked won". True, and it leaves the reader to
 * derive the present state themselves. These are the facts people open a job
 * to check, and none of them were on the page.
 */
function deal(over: Partial<DealStandingInput> = {}): DealStandingInput {
  return {
    billedCents: 5_000_00,
    contractCents: 25_000_00,
    outstandingCents: 0,
    retainageCents: 0,
    workOrderSent: true,
    pendingCoCount: 0,
    isWon: true,
    ...over,
  };
}
const labels = (i: DealStandingInput) => dealStandingLines(i).map((l) => l.label);
const find = (i: DealStandingInput, label: string) =>
  dealStandingLines(i).find((l) => l.label === label);

describe("the billed figure Brendan named", () => {
  it("reads 5k of 25k at 20%", () => {
    const d = deal();
    expect(money(d.billedCents)).toBe("$5k");
    expect(money(d.contractCents)).toBe("$25k");
    expect(billedPct(d)).toBe(20);
  });

  it("does not claim 0% on a job with no contract value yet", () => {
    // "0% billed" against a number that doesn't exist reads as a problem when
    // it is simply a job nobody has priced.
    expect(billedPct(deal({ contractCents: 0 }))).toBeNull();
  });

  it("keeps small numbers legible rather than forcing them into k", () => {
    expect(money(45_00)).toBe("$45");
    expect(money(1_500_00)).toBe("$1.5k");
  });

  it("does not print a decimal on a figure that rounds clean", () => {
    // $5,004 printed "$5.0k" — a trailing .0 claims precision the number does
    // not have, and it was visibly wrong next to "$243" on the same block.
    expect(money(5_004_00)).toBe("$5k");
    expect(money(5_000_00)).toBe("$5k");
    expect(money(4_764_38)).toBe("$4.8k");
    expect(money(29_712_00)).toBe("$29.7k");
    // Not asserting on an exact .x5 tie: 29.65 is stored as 29.6499…, so it
    // rounds down. That is a half-cent of display, not a number anyone acts on.
  });
});

describe("the work order — the fact that blocks people, not money", () => {
  it("says so when none has been written", () => {
    expect(find(deal({ workOrderSent: null }), "Work order")).toMatchObject({
      value: "Not written",
      tone: "warn",
    });
  });

  it("distinguishes written-but-not-sent from never written", () => {
    // The exact case Brendan called out. A sheet that exists but never left the
    // building looks identical to a finished job from every other screen.
    expect(find(deal({ workOrderSent: false }), "Work order")).toMatchObject({
      value: "Written, not sent",
      tone: "warn",
    });
  });

  it("goes quiet once the crew has it", () => {
    expect(find(deal({ workOrderSent: true }), "Work order")).toMatchObject({
      tone: "plain",
    });
  });

  it("is always first — it is the one that stops work today", () => {
    const l = labels(deal({ workOrderSent: null, outstandingCents: 9_000_00, pendingCoCount: 2 }));
    expect(l[0]).toBe("Work order");
  });
});

describe("what else earns a line", () => {
  it("stays silent about money that isn't owed", () => {
    expect(labels(deal())).not.toContain("GC owes");
    expect(labels(deal())).not.toContain("Retainage held");
    expect(labels(deal())).not.toContain("Change orders");
  });

  it("surfaces an outstanding balance", () => {
    expect(find(deal({ outstandingCents: 4_764_38 }), "GC owes")).toMatchObject({
      value: "$4.8k",
      tone: "warn",
    });
  });

  it("shows retainage as held, not as owed", () => {
    // Held by agreement — it is not late, it is just the money that gets
    // forgotten at close-out.
    expect(find(deal({ retainageCents: 242_50 }), "Retainage held")).toMatchObject({
      tone: "plain",
    });
  });

  it("flags over-billing instead of printing a negative left-to-bill", () => {
    const over = deal({ billedCents: 30_000_00 });
    expect(labels(over)).not.toContain("Left to bill");
    expect(find(over, "Billed over contract")).toMatchObject({
      value: "$5k",
      tone: "warn",
    });
  });

  it("a fully billed job with nothing owed says only that the crew has it", () => {
    // The quiet state has to be reachable, or the block is wallpaper.
    expect(labels(deal({ billedCents: 25_000_00 }))).toEqual(["Work order"]);
  });
});

describe("pre-sale bids", () => {
  // This block used to assert pre-sale showed NOTHING. Half of that was right
  // and half was a gap: the delivery lines are genuinely noise on a bid, but
  // returning [] also meant the one fact Brendan named for this stage —
  // "proposal send" — had nowhere to appear for the whole bidding period.
  it("never shows the delivery lines — those are noise on a job nobody has won", () => {
    const labels = dealStandingLines(
      deal({ isWon: false, workOrderSent: null, proposalStatus: "sent" })
    ).map((l) => l.label);
    for (const forbidden of ["Work order", "Retainage held", "Left to bill", "GC owes"]) {
      expect(labels, `a bid must not print "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("says where the proposal has got to instead", () => {
    expect(dealStandingLines(deal({ isWon: false, proposalStatus: "sent" }))).toEqual([
      { label: "Proposal", value: "With the GC", tone: "plain" },
    ]);
  });

  it("does not paint a fresh lead amber for having no proposal yet", () => {
    // Warn means "we are demonstrably the holdup". Without the deal's stage,
    // no-proposal-yet does not qualify.
    const [line] = dealStandingLines(deal({ isWon: false, proposalStatus: null }));
    expect(line.value).toBe("Not started");
    expect(line.tone).toBe("plain");
  });
});
