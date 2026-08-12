import { describe, it, expect } from "vitest";
import {
  AUTO_ADVANCE_TARGETS,
  targetForProposalStatus,
  foldAutoAdvanceTargets,
  canAutoAdvance,
  type AutoAdvanceTargetKey,
} from "@/lib/commercial/opportunities/auto-advance-targets";
import { advanceFromFilter } from "@/lib/commercial/opportunities/constants";

/**
 * The scenarios this engine exists to fix, written as the sequence of events a
 * person would actually perform. These are the regressions named in the build
 * spec — they describe behaviour, so they keep meaning even if the internals
 * are rewritten.
 */

/** A deal, moved only through the rules the engine enforces. */
function deal(status: string, sub: string | null) {
  let state = { status, sub_status: sub };
  return {
    get at() {
      return `${state.status}·${state.sub_status}`;
    },
    /** Attempt an automatic move; returns whether it happened. */
    auto(key: AutoAdvanceTargetKey) {
      if (!canAutoAdvance(state, key)) return false;
      const t = AUTO_ADVANCE_TARGETS[key];
      state = { status: t.status, sub_status: t.sub_status };
      return true;
    },
    /** A person dragging the card — no rules, they can do what they like. */
    human(status: string, sub: string | null) {
      state = { status, sub_status: sub };
    },
  };
}

describe("the ping-pong", () => {
  it("leaves a deal at Proposal when a new R2 draft is opened", () => {
    // The exact regression: send R1 (deal → Proposal), then open an R2 draft.
    // createProposal used to yank the deal to Estimating on the spot, and the
    // reconciler then fought over it on every page load — each swing emailing
    // the whole team.
    const d = deal("estimating", "estimating");
    expect(d.auto(targetForProposalStatus("sent")!)).toBe(true);
    expect(d.at).toBe("proposal·sent");

    // R2 opens as a draft. A reconcile pass reads the highest revision — the
    // draft — and must leave the deal alone.
    expect(d.auto(targetForProposalStatus("draft")!)).toBe(false);
    expect(d.at).toBe("proposal·sent");

    // …and it stays put no matter how many times the page is loaded.
    for (let i = 0; i < 25; i++) d.auto(targetForProposalStatus("draft")!);
    expect(d.at).toBe("proposal·sent");
  });

  it("still promotes a deal that is genuinely behind", () => {
    // Forward-only must not mean "never moves" — the R2 draft eventually gets
    // priced, approved and sent, and the deal follows each time.
    const d = deal("qualifying", "solicitation");
    expect(d.auto(targetForProposalStatus("draft")!)).toBe(true);
    expect(d.at).toBe("estimating·estimating");
    expect(d.auto(targetForProposalStatus("pending_approval")!)).toBe(true);
    expect(d.at).toBe("estimating·proposal_pending_approval");
    expect(d.auto(targetForProposalStatus("sent")!)).toBe(true);
    expect(d.at).toBe("proposal·sent");
    expect(d.auto(targetForProposalStatus("won")!)).toBe(true);
    expect(d.at).toBe("pre_sale_closed·won");
  });

  it("does not freeze a deal at plain Estimating", () => {
    // Both estimating sub-statuses are rank 1. A pure rank compare would refuse
    // this promotion, and forward-only means nothing would ever correct it.
    const d = deal("estimating", "estimating");
    expect(d.auto(targetForProposalStatus("pending_approval")!)).toBe(true);
    expect(d.at).toBe("estimating·proposal_pending_approval");
  });
});

describe("a person's decision wins", () => {
  it("does not walk a deal back into delivery-side stages", () => {
    // Crews are on site. Editing an old proposal must not rewind the job.
    const d = deal("in_progress", "wip_on_site");
    for (const s of ["draft", "pending_approval", "sent", "won"]) {
      expect(d.auto(targetForProposalStatus(s)!), s).toBe(false);
    }
    expect(d.at).toBe("in_progress·wip_on_site");
  });

  it("never resurrects a lost bid", () => {
    const d = deal("pre_sale_closed", "lost");
    for (const s of ["draft", "pending_approval", "sent", "won"]) {
      expect(d.auto(targetForProposalStatus(s)!), s).toBe(false);
    }
    expect(d.at).toBe("pre_sale_closed·lost");
  });

  it("does not re-close a job someone reopened", () => {
    const d = deal("post_sale_closed", "closed");
    d.human("in_progress", "wip_on_site"); // an explicit human reopen
    // The closeout package is still complete, but the deal is live again and
    // only a person may close it.
    expect(d.auto("closed")).toBe(false);
    expect(d.at).toBe("in_progress·wip_on_site");
  });
});

describe("closeout completion", () => {
  it("refines closeout → closed without touching the top-level status", () => {
    const d = deal("post_sale_closed", "closeout");
    expect(d.auto("closed")).toBe(true);
    expect(d.at).toBe("post_sale_closed·closed");
    // Same top-level status, so no decided_at write, no log row, no email.
    expect(AUTO_ADVANCE_TARGETS.closed.exactFrom!.status).toBe("post_sale_closed");
  });

  it("is idempotent when a second package completes", () => {
    const d = deal("post_sale_closed", "closeout");
    d.auto("closed");
    expect(d.auto("closed")).toBe(false);
    expect(d.at).toBe("post_sale_closed·closed");
  });

  it("refuses to close a job that never reached closeout", () => {
    // This is the money bug. post_sale_closed is terminal, so writing it from
    // an earlier status stamps decided_at with today — and the dashboard's
    // win-rate denominator reads decided_at directly, so an old job being
    // closed would silently move a win into the wrong month.
    for (const from of [
      ["billing", "substantial_completion"],
      ["in_progress", "wip_on_site"],
      ["pre_sale_closed", "won"],
    ] as const) {
      const d = deal(from[0], from[1]);
      expect(d.auto("closed"), from.join("·")).toBe(false);
      expect(d.at).toBe(`${from[0]}·${from[1]}`);
    }
  });
});

describe("one write per request", () => {
  it("folds three proposals into a single move to the furthest state", () => {
    // A deal carrying a won R1, a sent R2 and a fresh R3 draft. Applying them
    // in sequence would write three log rows for stages it was never in.
    const target = foldAutoAdvanceTargets(
      ["won", "sent", "draft"].map((s) => targetForProposalStatus(s))
    );
    expect(target).toBe("won");
    const d = deal("qualifying", "solicitation");
    expect(d.auto(target!)).toBe(true);
    expect(d.at).toBe("pre_sale_closed·won");
  });
});

describe("the guard that ships to the database", () => {
  it("matches the in-process rule for every target and every state", () => {
    // canAutoAdvance is a fast pre-check; the filter on the UPDATE is the real
    // authority. If they ever disagree, the engine either silently does nothing
    // or writes a move it already decided against.
    const states: [string, string | null][] = [
      ["qualifying", "solicitation"],
      ["qualifying", "rfp"],
      ["qualifying", null],
      ["estimating", "estimating"],
      ["estimating", "proposal_pending_approval"],
      ["proposal", "sent"],
      ["proposal", "follow_up"],
      ["pre_sale_closed", "won"],
      ["pre_sale_closed", "lost"],
      ["pre_construction", "coordination"],
      ["in_progress", "wip_on_site"],
      ["billing", "substantial_completion"],
      ["post_sale_closed", "closeout"],
      ["post_sale_closed", "closed"],
    ];
    const matches = (filter: string, status: string, sub: string | null) =>
      (filter.match(/and\([^)]*\)|[^,]+/g) ?? []).some((c) => {
        const n = c.match(/^and\(status\.eq\.(\w+),sub_status\.is\.null\)$/);
        if (n) return status === n[1] && sub === null;
        const p = c.match(/^and\(status\.eq\.(\w+),sub_status\.eq\.(\w+)\)$/);
        if (p) return status === p[1] && sub === p[2];
        const o = c.match(/^status\.eq\.(\w+)$/);
        return o ? status === o[1] : false;
      });

    for (const key of ["estimating", "estimating_pending", "proposal", "won"] as const) {
      const t = AUTO_ADVANCE_TARGETS[key];
      const filter = advanceFromFilter(t.status, t.sub_status);
      for (const [status, sub] of states) {
        expect(matches(filter, status, sub), `${key} from ${status}/${sub}`).toBe(
          canAutoAdvance({ status, sub_status: sub }, key)
        );
      }
    }
  });
});
