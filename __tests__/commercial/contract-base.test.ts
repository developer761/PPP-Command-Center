import { describe, it, expect } from "vitest";
import {
  pickContractBaseCents,
  contractProposalCents,
  type ContractProposalRow,
} from "@/lib/commercial/aia/constants";

/**
 * F1: an estimator clicks "New revision" on a WON $450k deal and starts typing.
 * The contract value, gross margin, left-to-bill, over-billed flag and the AIA
 * "Original Contract Sum" all silently followed the half-typed draft — replacing
 * the number the customer actually signed.
 *
 * These tests are written as the sequence of events, because the failure is a
 * sequence: it needs a win, then a revision, then typing.
 */

const R = (revision_number: number, status: string, total_cents: number): ContractProposalRow => ({
  revision_number,
  status,
  total_cents,
});

/** The full ladder, as the app runs it for a deal with no AIA app yet. */
const contractFor = (rows: ContractProposalRow[], bidMidCents = 0) => {
  const { acceptedProposalCents, latestProposalCents, pendingProposalCents } =
    contractProposalCents(rows);
  return pickContractBaseCents({
    hasBillingApp: false,
    originalContractCents: 0,
    sovTotalCents: 0,
    acceptedProposalCents,
    latestProposalCents,
    pendingProposalCents,
    bidMidCents,
  });
};

describe("F1 — re-quoting a won deal", () => {
  it("keeps the signed contract while a new revision is being typed", () => {
    // R1 was won at $450k. The estimator opens R2, which supersedes R1 and
    // starts life as a draft with a running total of $1,200 so far.
    const signed = contractFor([R(1, "won", 450_000_00)]);
    expect(signed).toBe(450_000_00);

    const midRevision = contractFor([R(1, "superseded", 450_000_00), R(2, "draft", 1_200_00)]);
    expect(midRevision).toBe(450_000_00);
  });

  it("does not let an empty new revision zero the contract", () => {
    // The first instant after clicking "New revision": R2 exists with no lines.
    expect(contractFor([R(1, "superseded", 450_000_00), R(2, "draft", 0)])).toBe(450_000_00);
  });

  it("keeps the signed contract when the new revision is SENT but not yet won", () => {
    // The half a draft-gate can't reach. Creating R2 supersedes R1, so no
    // proposal reads `won` any more -- the fact that $450k was signed is gone
    // from the proposals table. Send R2 at $500k and the contract silently
    // becomes $500k, on a job the customer signed for $450k.
    //
    // The signed number has to survive on the DEAL, not be re-derived from
    // whatever proposal happens to look newest.
    const rows = [R(1, "superseded", 450_000_00), R(2, "sent", 500_000_00)];
    const { acceptedProposalCents, latestProposalCents } = contractProposalCents(rows);
    expect(acceptedProposalCents).toBe(0); // the win is no longer visible here
    expect(latestProposalCents).toBe(500_000_00);

    // With the snapshot, the signed contract holds until R2 is itself won.
    expect(
      pickContractBaseCents({
        hasBillingApp: false,
        originalContractCents: 0,
        sovTotalCents: 0,
        acceptedProposalCents,
        acceptedSnapshotCents: 450_000_00,
        latestProposalCents,
        bidMidCents: 0,
      })
    ).toBe(450_000_00);
  });

  it("moves to the new number once the new revision is itself won", () => {
    expect(
      pickContractBaseCents({
        hasBillingApp: false,
        originalContractCents: 0,
        sovTotalCents: 0,
        acceptedProposalCents: 500_000_00, // R2 won
        acceptedSnapshotCents: 450_000_00, // stale snapshot from R1
        latestProposalCents: 500_000_00,
        bidMidCents: 0,
      })
    ).toBe(500_000_00);
  });

  it("ranks a draft below every real number, without discarding it", () => {
    // A bid range the office typed beats a draft nobody has sent.
    expect(contractFor([R(1, "draft", 88_000_00)], 12_000_00)).toBe(12_000_00);
    // …but with no bid range — the normal case now that bid low/high were
    // dropped from the create forms — the draft is better than showing the deal
    // no contract at all. Deleting the rung outright reintroduced the "$0
    // contract" symptom it was added to cure.
    expect(contractFor([R(1, "draft", 88_000_00)])).toBe(88_000_00);
  });

  it("keeps a sent proposal ahead of a newer in-progress revision", () => {
    // R2 is being drafted at $9; the GC is holding R1 at $100k. The contract is
    // what the GC is holding.
    expect(contractFor([R(1, "sent", 100_000_00), R(2, "draft", 9_00)])).toBe(100_000_00);
  });

  it("treats internally-approved-but-unsent as pre-send too", () => {
    // Approved means our side signed off, not that the customer has seen it.
    expect(contractFor([R(1, "sent", 100_000_00), R(2, "approved", 500_000_00)])).toBe(100_000_00);
    expect(contractFor([R(1, "sent", 100_000_00), R(2, "pending_approval", 500_000_00)])).toBe(
      100_000_00
    );
  });
});

describe("contractProposalCents", () => {
  it("excludes the pre-send trio from the latest-proposal fallback", () => {
    const { latestProposalCents, pendingProposalCents } = contractProposalCents([
      R(1, "sent", 100_000_00),
      R(2, "draft", 3_00),
    ]);
    expect(latestProposalCents).toBe(100_000_00);
    expect(pendingProposalCents).toBe(3_00);
  });

  it("still tracks the most recent real quote before anything is won", () => {
    // The behaviour this fallback exists for: a deal must not show its oldest
    // quote once a newer one has gone out.
    const { latestProposalCents } = contractProposalCents([
      R(1, "sent", 100_000_00),
      R(2, "sent", 125_000_00),
    ]);
    expect(latestProposalCents).toBe(125_000_00);
  });

  it("counts a superseded proposal, because superseding is how revisions retire", () => {
    // Superseded isn't "withdrawn" — it's the previous revision of a live quote,
    // and its total was really sent to a real GC.
    const { latestProposalCents } = contractProposalCents([R(1, "superseded", 90_000_00)]);
    expect(latestProposalCents).toBe(90_000_00);
  });

  it("prefers a WON proposal over any later revision", () => {
    const { acceptedProposalCents } = contractProposalCents([
      R(1, "won", 450_000_00),
      R(2, "sent", 500_000_00),
    ]);
    expect(acceptedProposalCents).toBe(450_000_00);
    // …and the ladder puts accepted first, so the signed number wins.
    expect(contractFor([R(1, "won", 450_000_00), R(2, "sent", 500_000_00)])).toBe(450_000_00);
  });

  it("keeps the larger of two won proposals rather than whichever sorted last", () => {
    const { acceptedProposalCents } = contractProposalCents([
      R(1, "won", 200_000_00),
      R(2, "won", 450_000_00),
    ]);
    expect(acceptedProposalCents).toBe(450_000_00);
  });

  it("handles totals arriving as strings from the database", () => {
    // bigint columns come back as strings through PostgREST; Number() on a
    // string total silently became NaN in an earlier version of this math.
    const { acceptedProposalCents } = contractProposalCents([
      { revision_number: 1, status: "won", total_cents: "450000000" },
    ]);
    expect(acceptedProposalCents).toBe(450_000_000);
  });

  it("returns zeros for a deal with no proposals at all", () => {
    expect(contractProposalCents([])).toEqual({
      acceptedProposalCents: 0,
      latestProposalCents: 0,
      pendingProposalCents: 0,
    });
  });
});

describe("the rungs below a real quote", () => {
  const ladder = (o: Partial<Parameters<typeof pickContractBaseCents>[0]>) =>
    pickContractBaseCents({
      hasBillingApp: false,
      originalContractCents: 0,
      sovTotalCents: 0,
      bidMidCents: 0,
      ...o,
    });

  it("answers from the AIA document once one exists, even when that answer is zero", () => {
    // The certificate is the system of record from that point on. Falling past
    // it to a bid range or a draft would print a number on a G702 that the G702
    // does not contain.
    expect(
      ladder({ hasBillingApp: true, bidMidCents: 10_000_00, pendingProposalCents: 88_000_00 })
    ).toBe(0);
  });

  it("puts the snapshot above every fallback but below a live won proposal", () => {
    expect(ladder({ acceptedSnapshotCents: 450_000_00, latestProposalCents: 500_000_00 })).toBe(
      450_000_00
    );
    expect(
      ladder({ acceptedProposalCents: 500_000_00, acceptedSnapshotCents: 450_000_00 })
    ).toBe(500_000_00);
  });

  it("orders the last-resort rungs bid-range, then in-progress proposal", () => {
    expect(ladder({ bidMidCents: 12_000_00, pendingProposalCents: 88_000_00 })).toBe(12_000_00);
    expect(ladder({ pendingProposalCents: 88_000_00 })).toBe(88_000_00);
    expect(ladder({})).toBe(0);
  });
});
