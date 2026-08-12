import { describe, it, expect } from "vitest";
import {
  AUTO_ADVANCE_TARGETS,
  targetForProposalStatus,
  foldAutoAdvanceTargets,
  canAutoAdvance,
  proposalTrailsDeal,
  type AutoAdvanceTargetKey,
} from "@/lib/commercial/opportunities/auto-advance-targets";
import { advanceFromFilter } from "@/lib/commercial/opportunities/constants";
import { humanDecidedMoreRecently } from "@/lib/commercial/opportunities/auto-advance";
import { etDateOf } from "@/lib/date-et";

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

describe("a human decision outranks the system", () => {
  const T = (iso: string) => new Date(iso).toISOString();

  it("defers to a person who moved the deal after the proposal reached its stage", () => {
    // The admin re-qualify case: a deal at Proposal gets dragged back to
    // Qualifying. The proposal is still 'sent', so forward-only alone would
    // happily shove the deal forward again on the next page load — undoing them
    // on a render they didn't even make.
    expect(
      humanDecidedMoreRecently(T("2026-08-10T12:00:00Z"), T("2026-08-01T12:00:00Z"))
    ).toBe(true);
  });

  it("lets a newer artifact win", () => {
    // They moved it back, then the proposal was actually sent again. The
    // proposal is now the more current statement about where the deal is.
    expect(
      humanDecidedMoreRecently(T("2026-08-01T12:00:00Z"), T("2026-08-10T12:00:00Z"))
    ).toBe(false);
  });

  it("does not block when nobody has ever set the status by hand", () => {
    expect(humanDecidedMoreRecently(null, T("2026-08-01T12:00:00Z"))).toBe(false);
  });

  it("defers to any human decision when there is no artifact clock", () => {
    expect(humanDecidedMoreRecently(T("2026-08-01T12:00:00Z"), null)).toBe(true);
  });
});

describe("the decision date follows the event, not the clock", () => {
  it("stamps the day the proposal was sent, not the day we noticed", () => {
    // pre_sale_closed is terminal, so advancing to Won writes decided_at — and
    // the dashboard builds its win-rate denominator from that column raw. A
    // reconcile pass catching up in August must not restate a March win as an
    // August one.
    expect(etDateOf("2026-03-14T20:00:00Z")).toBe("2026-03-14");
  });

  it("uses the ET calendar day, so an evening close lands in the right month", () => {
    // 2026-04-01 00:30 UTC is still March 31st in New York. Stamping the UTC
    // day would move this win into the next month — and the next quarter.
    expect(etDateOf("2026-04-01T00:30:00Z")).toBe("2026-03-31");
  });

  it("falls back rather than inventing a date", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
      expect(etDateOf(bad), String(bad)).toBeNull();
    }
  });
});

describe("the badge for a proposal that trails its deal", () => {
  const at = (status: string, sub: string | null) => ({ status, sub_status: sub });

  it("flags the R2-draft-on-a-sent-deal case", () => {
    // The state forward-only deliberately leaves alone: R1 really was sent, so
    // the deal belongs at Proposal — but the proposals board shows a Draft, and
    // without saying so the two screens look broken.
    expect(proposalTrailsDeal(at("proposal", "sent"), "draft")).toBe(true);
    expect(proposalTrailsDeal(at("proposal", "follow_up"), "draft")).toBe(true);
  });

  it("says nothing when the proposal is level with the deal", () => {
    expect(proposalTrailsDeal(at("proposal", "sent"), "sent")).toBe(false);
    expect(proposalTrailsDeal(at("estimating", "estimating"), "draft")).toBe(false);
  });

  it("says nothing when the proposal is AHEAD — the engine will catch the deal up", () => {
    expect(proposalTrailsDeal(at("estimating", "estimating"), "sent")).toBe(false);
    expect(proposalTrailsDeal(at("qualifying", "solicitation"), "won")).toBe(false);
  });

  it("catches a trailing proposal within a single stage", () => {
    // Both rank 1: the deal is at pending-approval, the proposal went back to
    // draft. Same stage, so only the sub ladder can tell.
    expect(proposalTrailsDeal(at("estimating", "proposal_pending_approval"), "draft")).toBe(true);
  });

  it("stays quiet on a decided deal", () => {
    // Won and lost are settled — the proposal's state is no longer something
    // anyone needs to reconcile.
    expect(proposalTrailsDeal(at("pre_sale_closed", "won"), "draft")).toBe(false);
    expect(proposalTrailsDeal(at("pre_sale_closed", "lost"), "draft")).toBe(false);
    expect(proposalTrailsDeal(at("post_sale_closed", "closed"), "draft")).toBe(false);
  });

  it("stays quiet for proposal states that imply no stage", () => {
    for (const s of ["superseded", "expired", "lost", null, undefined, ""]) {
      expect(proposalTrailsDeal(at("proposal", "sent"), s), String(s)).toBe(false);
    }
  });

  it("never fires where the engine would advance instead", () => {
    // The two must be mutually exclusive: if an automatic move is available,
    // the mismatch is temporary and doesn't warrant a badge.
    const states: [string, string][] = [
      ["qualifying", "solicitation"],
      ["estimating", "estimating"],
      ["estimating", "proposal_pending_approval"],
      ["proposal", "sent"],
      ["proposal", "follow_up"],
      ["in_progress", "wip_on_site"],
    ];
    for (const [status, sub] of states) {
      for (const ps of ["draft", "pending_approval", "approved", "sent", "won"]) {
        const key = targetForProposalStatus(ps)!;
        const advances = canAutoAdvance({ status, sub_status: sub }, key);
        const trails = proposalTrailsDeal({ status, sub_status: sub }, ps);
        expect(advances && trails, `${status}/${sub} vs ${ps}`).toBe(false);
      }
    }
  });
});

describe("A2 — one authority", () => {
  it("will not resurrect a lost deal when a proposal is marked won", () => {
    // markProposalOutcome used to run a SECOND, unguarded deal write after the
    // engine: DAG check off, no source, no forward-only guard, and a skip list
    // that covered post-sale but not pre_sale_closed. So on a deal already
    // closed as LOST, marking a proposal won made the engine correctly decline
    // — a lost deal is terminal — and the second writer flipped lost → won
    // behind it. Reversing a dead deal is a person's decision.
    const d = deal("pre_sale_closed", "lost");
    expect(d.auto("won")).toBe(false);
    expect(d.at).toBe("pre_sale_closed·lost");
  });

  it("still wins a deal that is genuinely still open", () => {
    const d = deal("proposal", "sent");
    expect(d.auto("won")).toBe(true);
    expect(d.at).toBe("pre_sale_closed·won");
  });

  it("folds a deal's proposals to the furthest one, not the newest", () => {
    // A won R1 with a fresh R3 draft belongs at Won. Reading only the newest
    // proposal says Estimating, and only forward-only stops that from walking a
    // won deal backwards — which means a deal that has fallen BEHIND its own won
    // proposal never catches up.
    const target = foldAutoAdvanceTargets(
      ["won", "sent", "draft"].map((s) => targetForProposalStatus(s))
    );
    expect(target).toBe("won");
    const d = deal("qualifying", "solicitation");
    expect(d.auto(target!)).toBe(true);
    expect(d.at).toBe("pre_sale_closed·won");
  });
});

describe("R27 — the badge must not fire on Follow-Up", () => {
  it("says nothing when a sent proposal explains the deal's state", () => {
    // `follow_up` MEANS "a sent proposal we're chasing", so a sent proposal is
    // not behind it. Treating it as behind put a navy "R2 Sent" badge beside
    // the amber "Follow-Up" one — two labels contradicting each other on the
    // card the badge exists to make clearer.
    expect(proposalTrailsDeal({ status: "proposal", sub_status: "follow_up" }, "sent")).toBe(false);
  });

  it("still flags a genuinely stale proposal on a Follow-Up deal", () => {
    expect(proposalTrailsDeal({ status: "proposal", sub_status: "follow_up" }, "draft")).toBe(true);
  });

  it("keeps the estimating sub-ladder, where the step is real progress", () => {
    expect(
      proposalTrailsDeal({ status: "estimating", sub_status: "proposal_pending_approval" }, "draft")
    ).toBe(true);
  });
});
