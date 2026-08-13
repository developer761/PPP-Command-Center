import { describe, it, expect } from "vitest";
import { skippedStages, PRE_CONTRACT_COLUMNS } from "@/lib/commercial/opportunities/kanban-columns";

const SALES = PRE_CONTRACT_COLUMNS.map((c) => c.key);

/**
 * The progress bar's `stateFor` only ever returned passed/current/future, so a
 * deal that jumped stages showed every stage behind it with a completion tick
 * — claiming work nobody did, on the one screen people read to find out what
 * HAS been done. The first fix only covered "won without a win date".
 *
 * This is the general rule, and the interesting half of it is what it refuses
 * to conclude.
 */
describe("skippedStages", () => {
  it("marks a whole status the deal never entered", () => {
    // RFP straight to Sent: it was never `estimating`, so both stages backed
    // by that status were jumped.
    const log = [
      { from_status: "qualifying", to_status: "proposal" },
    ];
    const out = skippedStages(SALES, log);
    expect(out).toContain("estimating");
    expect(out).toContain("pending_approval");
  });

  it("does not accuse a stage the deal actually sat in", () => {
    const log = [
      { from_status: "qualifying", to_status: "estimating" },
      { from_status: "estimating", to_status: "proposal" },
    ];
    const out = skippedStages(SALES, log);
    expect(out).not.toContain("estimating");
    expect(out).not.toContain("pending_approval");
    expect(out).not.toContain("qualifying");
  });

  it("never accuses a SUB-stage, because nothing records one", () => {
    // Qualifying → RFP is a sub_status move and writes no log row. A deal
    // logged only as `qualifying` might have sat in either, so neither is
    // marked. Guessing here would print "skipped" on work that was done.
    const log = [{ from_status: null, to_status: "qualifying" }];
    const out = skippedStages(SALES, log);
    expect(out).not.toContain("qualifying");
    expect(out).not.toContain("rfp");
  });

  it("claims nothing at all for a deal with no log", () => {
    // Predates status logging. Marking everything skipped would trade
    // over-claiming for accusing, which is worse.
    expect(skippedStages(SALES, [])).toEqual([]);
  });

  it("credits the first row's from_status — the only record of where it began", () => {
    const log = [{ from_status: "estimating", to_status: "proposal" }];
    expect(skippedStages(SALES, log)).not.toContain("estimating");
  });

  it("treats won and lost as one status, since they share it", () => {
    const log = [
      { from_status: "proposal", to_status: "pre_sale_closed" },
    ];
    const out = skippedStages(SALES, log);
    expect(out).not.toContain("won");
    expect(out).not.toContain("lost");
  });
});
