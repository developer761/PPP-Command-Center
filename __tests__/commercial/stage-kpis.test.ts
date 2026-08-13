import { describe, it, expect } from "vitest";
import {
  stageKpis,
  phaseFor,
  agoLabel,
  daysBetweenEt,
  type StageKpiInput,
} from "@/lib/commercial/opportunities/stage-kpis";

const TODAY = "2026-08-12";
const base: StageKpiInput = {
  status: "qualifying",
  subStatus: "solicitation",
  todayIso: TODAY,
};
const keys = (i: StageKpiInput) => stageKpis(i).map((k) => k.key);
const tile = (i: StageKpiInput, k: string) => stageKpis(i).find((t) => t.key === k);

describe("elapsed time", () => {
  it("counts whole ET calendar days, not UTC subtraction", () => {
    // Across the DST boundary. Subtracting timestamps gives 0.958 days here and
    // rounds wrong; calendar dates give exactly 1.
    expect(daysBetweenEt("2026-03-07", "2026-03-08")).toBe(1);
    expect(daysBetweenEt("2026-08-03", TODAY)).toBe(9);
  });

  it("never says '0 days ago'", () => {
    expect(agoLabel(TODAY, TODAY)).toBe("today");
    expect(agoLabel("2026-08-11", TODAY)).toBe("yesterday");
    expect(agoLabel("2026-08-03", TODAY)).toBe("9 days ago");
  });
});

describe("stageKpis — only what is live for the stage", () => {
  it("shows a bid its dates, and never shows it money it doesn't have", () => {
    const bid = { ...base, rfpReceivedAt: "2026-08-03", proposalDueAt: "2026-08-20" };
    expect(keys(bid)).toEqual(["rfp", "due"]);
    // No contract, no billing, no margin, no retainage on a job nobody has won.
    for (const k of ["contract", "billed", "margin", "ar"]) {
      expect(keys(bid), k).not.toContain(k);
    }
  });

  it("puts elapsed time on the proposal, from the one the customer is HOLDING", () => {
    // The bug this guards: a drafted revision must not reset "sent 9 days ago"
    // on the proposal they actually have. The caller passes the latest SENT one;
    // this pins that the tile reads from it and says how long ago.
    const out = {
      ...base,
      status: "proposal",
      subStatus: "sent",
      latestSentProposalCents: 45_000_00,
      latestSentProposalAt: "2026-08-03",
    };
    const t = tile(out, "quote")!;
    expect(t.value).toContain("45");
    expect(t.sub).toBe("sent 9 days ago");
  });

  it("flags an overdue date as overdue rather than as a date", () => {
    const late = { ...base, status: "proposal", subStatus: "sent", followUpAt: "2026-08-08" };
    const t = tile(late, "follow_up")!;
    expect(t.value).toBe("4 days overdue");
    expect(t.tone).toBe("bad");
  });

  it("says 'not set' for a won job with no contract — never $0", () => {
    // A zero is a number somebody chose. An unset contract rendered as $0.00
    // reads as real and poisons every total above it.
    const won = { ...base, status: "pre_sale_closed", subStatus: "won", hasContract: false, contractCents: 0 };
    const t = tile(won, "contract")!;
    expect(t.value).toBe("not set");
    expect(t.tone).toBe("warn");
    // …and with a real contract it shows the money, not the warning.
    const real = { ...won, hasContract: true, contractCents: 120_000_00 };
    expect(tile(real, "contract")!.value).not.toBe("not set");
    expect(tile(real, "contract")!.tone).toBe("good");
  });

  it("shows a job on site what's billed and its margin, and drops the bid dates", () => {
    const wip = {
      ...base,
      status: "in_progress",
      subStatus: "wip_on_site",
      hasContract: true,
      contractCents: 100_000_00,
      billedPreTaxCents: 40_000_00,
      grossMarginPct: 22,
      grossMarginCents: 22_000_00,
      // These would be shown on a bid and are meaningless now.
      rfpReceivedAt: "2026-08-03",
      proposalDueAt: "2026-08-20",
    };
    const k = keys(wip);
    expect(k).toContain("billed");
    expect(k).toContain("margin");
    expect(k).not.toContain("rfp");
    expect(k).not.toContain("due");
    expect(tile(wip, "billed")!.value).toBe("40%");
  });

  it("warns on a thin margin and alarms on a negative one", () => {
    const at = (pct: number) =>
      tile({ ...base, status: "in_progress", hasContract: true, contractCents: 100_00, grossMarginPct: pct, grossMarginCents: 1 }, "margin")!;
    expect(at(28).tone).toBe("good");
    expect(at(9).tone).toBe("warn");
    expect(at(-4).tone).toBe("bad");
  });

  it("shows outstanding money while billing, and what was collected once it's clear", () => {
    const owed = { ...base, status: "billing", subStatus: "substantial_completion", openBalanceCents: 12_000_00, oldestUnpaidInvoiceDate: "2026-07-13" };
    expect(tile(owed, "ar")!.sub).toBe("oldest 30 days ago");
    const clear = { ...owed, openBalanceCents: 0, collectedCents: 90_000_00 };
    expect(tile(clear, "ar")!.label).toBe("Collected");
    expect(tile(clear, "ar")!.tone).toBe("good");
  });

  it("shows a lost deal when it was lost, and nothing about delivery", () => {
    const lost = { ...base, status: "pre_sale_closed", subStatus: "lost", decidedAt: "2026-08-03" };
    expect(keys(lost)).toEqual(["lost"]);
  });

  it("renders nothing rather than a row of dashes when there is nothing to say", () => {
    expect(stageKpis(base)).toEqual([]);
  });
});

describe("phaseFor", () => {
  it("separates a won job that hasn't started from one on site", () => {
    expect(phaseFor("pre_sale_closed", "won")).toBe("won_not_started");
    expect(phaseFor("pre_construction", "coordination")).toBe("won_not_started");
    expect(phaseFor("in_progress", "wip_on_site")).toBe("in_progress");
    expect(phaseFor("pre_sale_closed", "lost")).toBe("lost");
    expect(phaseFor("post_sale_closed", "closed")).toBe("closed");
  });
});

/**
 * AUDIT: the strip was fed a CONTRACT-based margin while the Costs tab, the
 * account rollup, the dashboard and every report use the billed-based one —
 * the same job showing two different profit percentages a tab-click apart.
 *
 * Karan settled this in D2 (billed-based is the number). Step 5 rebuilt the
 * strip straight off the raw financials and reintroduced the split.
 */
describe("margin", () => {
  const wip = (over: Partial<StageKpiInput> = {}): StageKpiInput => ({
    ...base,
    status: "in_progress",
    subStatus: "wip_on_site",
    hasContract: true,
    contractCents: 100_000_00,
    billedPreTaxCents: 40_000_00,
    grossMarginPct: 22,
    grossMarginCents: 8_800_00,
    ...over,
  });

  it("says 'Margin so far' while a job is only part-billed", () => {
    // A running figure quoted as final is how somebody promises a number the
    // job cannot finish at.
    expect(tile(wip({ marginProvisional: true }), "margin")!.label).toBe("Margin so far");
  });

  it("says plain 'Margin' once it is the real one", () => {
    expect(tile(wip({ marginProvisional: false }), "margin")!.label).toBe("Margin");
  });
});

/**
 * §7 completeness gaps: the two numbers a delivery job carries that no tile
 * showed. Both answer a question the deal page could not.
 */
describe("retainage held", () => {
  const billing = (over: Partial<StageKpiInput> = {}): StageKpiInput => ({
    ...base,
    status: "billing",
    subStatus: "substantial_completion",
    hasContract: true,
    contractCents: 200_000_00,
    ...over,
  });

  it("shows money the GC is holding even when nothing is outstanding", () => {
    // The gap: retainage is in NEITHER money tile — it isn't overdue, so it's
    // not Outstanding, and it hasn't arrived, so it's not Collected. Without
    // this the page read "Collected" on a job with 5% still out.
    const t = tile(billing({ openBalanceCents: 0, collectedCents: 190_000_00, retainageHeldCents: 10_000_00 }), "retainage")!;
    expect(t.label).toBe("Retainage held");
    expect(t.tone).toBe("warn");
    expect(t.sub).toBe("5% of contract");
  });

  it("survives past closeout, which is exactly when it gets forgotten", () => {
    const closed = { ...billing(), status: "post_sale_closed", subStatus: "closed", retainageHeldCents: 10_000_00 };
    expect(keys(closed)).toContain("retainage");
  });

  it("is omitted when none is held, and never shows on a bid", () => {
    expect(keys(billing({ retainageHeldCents: 0 }))).not.toContain("retainage");
    expect(keys({ ...base, retainageHeldCents: 10_000_00 })).not.toContain("retainage");
  });

  it("drops the percentage rather than dividing by an unset contract", () => {
    const t = tile(billing({ hasContract: false, contractCents: 0, retainageHeldCents: 10_000_00 }), "retainage")!;
    expect(t.sub).toBeNull();
  });
});

describe("warranty expiry", () => {
  const closed = (through: string | null): StageKpiInput => ({
    ...base,
    status: "post_sale_closed",
    subStatus: "closed",
    warrantyThroughAt: through,
  });

  it("counts down in months, and only warns in the last stretch", () => {
    // "in 340 days" is the wrong register for a year-long obligation, and a
    // warning that runs for twelve months is a warning nobody reads.
    expect(tile(closed("2027-08-12"), "warranty")!.value).toBe("12 months left");
    expect(tile(closed("2027-08-12"), "warranty")!.tone).toBe("default");
    const soon = tile(closed("2026-09-15"), "warranty")!;
    expect(soon.value).toBe("34 days left");
    expect(soon.tone).toBe("warn");
  });

  it("says expired plainly — a discharged obligation is not a problem", () => {
    const t = tile(closed("2026-07-01"), "warranty")!;
    expect(t.value).toBe("expired");
    expect(t.tone).toBe("default");
  });

  it("is omitted with no date, and never shows before closeout", () => {
    expect(keys(closed(null))).not.toContain("warranty");
    expect(keys({ ...base, status: "in_progress", warrantyThroughAt: "2027-08-12" })).not.toContain("warranty");
  });
});

/**
 * RE-AUDIT 2026-08-12. Brendan: "Probability? I don't use this." It came out
 * of every form — and `weightedPipelineCents` kept multiplying by the stored
 * column, which is `NOT NULL DEFAULT 10` and no longer editable anywhere.
 *
 * So every deal created after that change was born at 10% and stuck there. A
 * $400k bid at Sent contributed $40k to the weighted pipeline on the dashboard
 * Alex reads every morning, and the gap widened with every new deal.
 */
describe("weighted pipeline reads the stage, not the dead column", () => {
  it("weights by where the deal SITS, ignoring a stale stored probability", async () => {
    const { weightedPipelineCents } = await import("@/lib/commercial/opportunities/db");
    const deal = {
      status: "proposal",
      sub_status: "sent",
      bid_value_low_cents: 400_000_00,
      bid_value_high_cents: 400_000_00,
      probability_pct: 10, // the default nobody could change
    } as never;
    // Sent is a 65% stage. The old code returned 10% of value.
    expect(weightedPipelineCents(deal)).toBe(260_000_00);
  });

  it("a won deal weights at full value and a lost one at nothing", async () => {
    const { weightedPipelineCents } = await import("@/lib/commercial/opportunities/db");
    const at = (sub: string) =>
      weightedPipelineCents({
        status: "pre_sale_closed",
        sub_status: sub,
        bid_value_low_cents: 100_000_00,
        bid_value_high_cents: 100_000_00,
        probability_pct: 10,
      } as never);
    expect(at("won")).toBe(100_000_00);
    expect(at("lost")).toBe(0);
  });

  it("an unrecognised stage behaves exactly as the old default did", async () => {
    const { probabilityFor } = await import("@/lib/commercial/opportunities/constants");
    expect(probabilityFor("something_new", "nonsense")).toBe(10);
  });
});
