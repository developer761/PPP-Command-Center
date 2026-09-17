import { describe, it, expect } from "vitest";

import { stageMeaningFor, STAGE_MEANING, columnKeyForOpp } from "@/lib/commercial/opportunities/kanban-columns";

/**
 * The "where it is now" line describes the stage the deal is at.
 *
 * Found answering Karan's "what is in stage vs status?" (2026-09-17). They are
 * not two fields — `status` + `sub_status` is what the database stores, and the
 * stage is the single word the UI shows for that tuple. The mapping is not 1:1
 * in either direction: two statuses collapse into Estimating, and one status
 * splits into Estimating and Pending Approval.
 *
 * Both call sites indexed STAGE_MEANING with a raw `status`, and the map is
 * keyed by STAGE. `Record<string, string>` takes any string and gives back
 * undefined, and `?? null` swallowed it, so the defect was invisible in the
 * source and on the page: deals at Sent, Won and Lost showed no line at all,
 * an RFP showed the retired "Qualifying" wording, and a deal awaiting internal
 * sign-off was told it was still being priced.
 */

describe("stageMeaningFor", () => {
  it("gives Won and Lost a meaning at all", () => {
    // THE REGRESSION: `STAGE_MEANING["pre_sale_closed"]` is undefined, so every
    // won and lost deal — most of the book — had a blank legend.
    expect(stageMeaningFor("pre_sale_closed", "won")).toBe(STAGE_MEANING.won);
    expect(stageMeaningFor("pre_sale_closed", "lost")).toBe(STAGE_MEANING.lost);
    expect(stageMeaningFor("pre_sale_closed", "won")).toBeTruthy();
  });

  it("gives Sent a meaning", () => {
    // `STAGE_MEANING["proposal"]` is also not a key.
    expect(stageMeaningFor("proposal", "sent")).toBe(STAGE_MEANING.sent);
    expect(stageMeaningFor("proposal", "follow_up")).toBe(STAGE_MEANING.sent);
  });

  it("calls an RFP an RFP, not Qualifying", () => {
    // This one is worse than a blank: `qualifying` IS a key, so it returned
    // confident, wrong text. Qualifying was retired in Aug 2026.
    const rfp = stageMeaningFor("qualifying", "rfp");
    expect(rfp).toBe(STAGE_MEANING.rfp);
    expect(rfp).not.toBe(STAGE_MEANING.qualifying);
  });

  it("separates Pending Approval from Estimating", () => {
    // One status, two stages — the case that proves this must read the tuple
    // and not the status alone.
    expect(stageMeaningFor("estimating", "estimating")).toBe(STAGE_MEANING.estimating);
    expect(stageMeaningFor("estimating", "proposal_pending_approval")).toBe(STAGE_MEANING.pending_approval);
    expect(stageMeaningFor("estimating", "estimating")).not.toBe(
      stageMeaningFor("estimating", "proposal_pending_approval")
    );
  });

  it("has a meaning for EVERY stage a deal can be in", () => {
    // The real guard. Without this, adding a stage tomorrow silently
    // reintroduces the blank line for whichever deals land in it.
    const tuples: [string, string | null][] = [
      ["qualifying", "solicitation"],
      ["qualifying", "rfp"],
      ["qualifying", "estimating"],
      ["qualifying", null],
      ["estimating", "estimating"],
      ["estimating", "proposal_pending_approval"],
      ["proposal", "sent"],
      ["proposal", "follow_up"],
      ["pre_sale_closed", "won"],
      ["pre_sale_closed", "lost"],
      ["pre_construction", "coordination"],
      ["pre_construction", "ready_to_mobilize"],
      ["in_progress", "wip_on_site"],
      ["in_progress", "wip_on_hold"],
      ["billing", "substantial_completion"],
      ["billing", "completed_and_invoiced"],
      ["post_sale_closed", "closeout"],
      ["post_sale_closed", "closed"],
    ];
    const blank = tuples.filter(([s, sub]) => !stageMeaningFor(s, sub));
    expect(blank).toEqual([]);
    // And prove the lookup is really going through the stage mapper, so this
    // cannot pass by accident if someone re-keys the map by status.
    for (const [s, sub] of tuples) {
      expect(stageMeaningFor(s, sub)).toBe(STAGE_MEANING[columnKeyForOpp(s, sub)]);
    }
  });
});
