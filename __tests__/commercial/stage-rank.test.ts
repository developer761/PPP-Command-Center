import { describe, it, expect } from "vitest";
import {
  stageRank,
  isTerminalOffRamp,
  dealPhase,
  SUB_STATUSES_BY_STATUS,
} from "@/lib/commercial/opportunities/constants";

/**
 * stageRank is the ONE ordinal behind "forward-only". Before it existed the
 * concept was undefined — ALLOWED_TRANSITIONS is flat — and the two status
 * guards each carried their own idea of forward. These tests pin the ladder so
 * a third can't quietly disagree.
 */
describe("stageRank", () => {
  it("climbs monotonically through the real delivery ladder", () => {
    const ladder: [string, string | null][] = [
      ["qualifying", "solicitation"],
      ["estimating", "estimating"],
      ["proposal", "sent"],
      ["pre_sale_closed", "won"],
      ["pre_construction", "coordination"],
      ["in_progress", "wip_on_site"],
      ["billing", "substantial_completion"],
      ["post_sale_closed", "closeout"],
    ];
    const ranks = ladder.map(([s, sub]) => stageRank(s, sub));
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]! > ranks[i - 1]!, `${ladder[i][0]} must outrank ${ladder[i - 1][0]}`).toBe(true);
    }
  });

  it("ranks every sub-status of qualifying the same", () => {
    // RFP is a display stage, not extra delivery progress — otherwise moving
    // Solicitation → RFP would count as an auto-advance.
    for (const sub of SUB_STATUSES_BY_STATUS.qualifying) {
      expect(stageRank("qualifying", sub), sub).toBe(0);
    }
  });

  it("treats a LOST bid as terminal, never as behind", () => {
    expect(stageRank("pre_sale_closed", "lost")).toBeNull();
    expect(isTerminalOffRamp({ status: "pre_sale_closed", sub_status: "lost" })).toBe(true);
    // The point is the ADVANCE RULE: "move to T only if stageRank(current) is
    // non-null and < stageRank(T)". A null current can never satisfy it, so
    // editing an old proposal on a lost deal can't resurrect it.
    const canAdvance = (from: [string, string | null], to: [string, string | null]) => {
      const a = stageRank(from[0], from[1]);
      const b = stageRank(to[0], to[1]);
      return a !== null && b !== null && a < b;
    };
    expect(canAdvance(["pre_sale_closed", "lost"], ["in_progress", "wip_on_site"])).toBe(false);
    expect(canAdvance(["pre_sale_closed", "lost"], ["proposal", "sent"])).toBe(false);
    // …while a live deal still advances normally.
    expect(canAdvance(["estimating", "estimating"], ["proposal", "sent"])).toBe(true);
    // …and never backwards.
    expect(canAdvance(["proposal", "sent"], ["estimating", "estimating"])).toBe(false);
  });

  it("distinguishes closeout (still progress) from closed (finished)", () => {
    expect(stageRank("post_sale_closed", "closeout")).toBe(7);
    expect(stageRank("post_sale_closed", "closed")).toBeNull();
    expect(isTerminalOffRamp({ status: "post_sale_closed", sub_status: "closeout" })).toBe(false);
    expect(isTerminalOffRamp({ status: "post_sale_closed", sub_status: "closed" })).toBe(true);
  });

  it("fails CLOSED on an unknown or legacy status", () => {
    // A v1 row that escaped migration 052 must not be auto-moved by an engine
    // that doesn't understand it.
    for (const s of ["rfp", "follow_up", "won", "lost", "", "nonsense"]) {
      expect(stageRank(s, null), s).toBeNull();
    }
  });

  it("gives every whitelisted tuple a defined answer", () => {
    for (const [status, subs] of Object.entries(SUB_STATUSES_BY_STATUS)) {
      for (const sub of subs as readonly string[]) {
        const r = stageRank(status, sub);
        expect(r === null || (Number.isInteger(r) && r >= 0), `${status}/${sub}`).toBe(true);
      }
    }
  });
});

describe("dealPhase", () => {
  it("puts a freshly-won deal in its own phase, not in delivery", () => {
    // isPostSaleProject returns TRUE here, which is exactly why it can't be the
    // switch: a just-won job has no invoices and no costs, so the delivery
    // money block would render as a wall of $0.
    expect(dealPhase({ status: "pre_sale_closed", sub_status: "won" })).toBe("won_not_started");
  });

  it("puts a lost bid in its own phase, not in pre-sale", () => {
    // isPostSaleProject returns FALSE here, which would have shown a dead bid
    // live pipeline tiles — weighted value, win probability, a decision
    // countdown — on a deal that's over.
    expect(dealPhase({ status: "pre_sale_closed", sub_status: "lost" })).toBe("lost");
  });

  it("treats every post-sale status as in-delivery", () => {
    for (const s of ["pre_construction", "in_progress", "billing", "post_sale_closed"]) {
      expect(dealPhase({ status: s, sub_status: null }), s).toBe("in_delivery");
    }
  });

  it("treats the open pre-contract stages as pre-sale", () => {
    for (const s of ["qualifying", "estimating", "proposal"]) {
      expect(dealPhase({ status: s, sub_status: null }), s).toBe("pre_sale");
    }
  });

  it("never leaves a whitelisted tuple unclassified", () => {
    for (const [status, subs] of Object.entries(SUB_STATUSES_BY_STATUS)) {
      for (const sub of subs as readonly string[]) {
        expect(["lost", "won_not_started", "in_delivery", "pre_sale"]).toContain(
          dealPhase({ status, sub_status: sub })
        );
      }
    }
  });
});
