import { describe, it, expect } from "vitest";
import { wasWonInPeriod, WARN_TRANSITIONS } from "@/lib/commercial/opportunities/constants";

/**
 * `decided_at` means the day a deal was WON or LOST — one meaning, for the whole
 * life of the deal. It was wrong in four ways that were really one bug: it was
 * stamped on entry to any TERMINAL status, and only then.
 *
 * These pin the counting rule. The stamping rule lives in `changeOpportunityStatus`
 * and is exercised through it.
 */
describe("wasWonInPeriod", () => {
  const MARCH = "2026-03-01";
  const won = (over: Record<string, unknown> = {}) => ({
    status: "pre_construction",
    sub_status: "coordination",
    decided_at: "2026-03-14",
    ...over,
  });

  it("counts a job won in the period", () => {
    expect(wasWonInPeriod(won(), MARCH)).toBe(true);
  });

  it("does not count a job won before the period", () => {
    expect(wasWonInPeriod(won({ decided_at: "2026-02-27" }), MARCH)).toBe(false);
  });

  it("counts a CLOSED job in the month it was won, not the month it finished", () => {
    // The bug this whole cluster is about: close-out overwrote the win date, so
    // a March win closed out in August became an August win. With the two dates
    // separated, a finished job still belongs to March.
    expect(
      wasWonInPeriod(
        { status: "post_sale_closed", sub_status: "closed", decided_at: "2026-03-14", closed_out_at: "2026-08-02" },
        MARCH
      )
    ).toBe(true);
    // …and it does NOT leak into the month it was closed out.
    expect(
      wasWonInPeriod(
        { status: "post_sale_closed", sub_status: "closed", decided_at: "2026-03-14", closed_out_at: "2026-08-02" },
        "2026-08-01"
      )
    ).toBe(false);
  });

  it("still refuses to count a legacy closed job whose date can't be trusted", () => {
    // Before migration 129 a closed deal's `decided_at` holds the CLOSE-OUT
    // date. Counting it would put the win in the wrong month, so a row with no
    // `closed_out_at` — i.e. one never written by the new code — stays excluded
    // exactly as it is today.
    expect(
      wasWonInPeriod(
        { status: "post_sale_closed", sub_status: "closed", decided_at: "2026-08-02", closed_out_at: null },
        "2026-08-01"
      )
    ).toBe(false);
  });

  it("never counts a deal that was lost", () => {
    expect(wasWonInPeriod({ status: "pre_sale_closed", sub_status: "lost", decided_at: "2026-03-14" }, MARCH)).toBe(
      false
    );
  });

  it("never counts a deal still being sold", () => {
    for (const s of ["qualifying", "estimating", "proposal"]) {
      expect(wasWonInPeriod({ status: s, sub_status: null, decided_at: "2026-03-14" }, MARCH), s).toBe(false);
    }
  });

  it("does not count a won deal with no decision date at all", () => {
    // A deal dragged straight into delivery used to land here — won, working,
    // and invisible to every win metric. The stamping fix stops new ones; this
    // pins that an undated row is not silently counted as won today.
    expect(wasWonInPeriod(won({ decided_at: null }), MARCH)).toBe(false);
  });
});

/**
 * R14 — the board's lane-jump warning. `WARN_TRANSITIONS` is the shared set the
 * status picker has always consulted and the drag-and-drop board never did.
 */
describe("WARN_TRANSITIONS covers the lane jump", () => {
  it("flags a pre-sale deal dropped straight into delivery or Completed", () => {
    // Crossing the contract divider without ever being recorded as won: a close
    // date gets stamped and the deal skips the Win/Loss debrief.
    for (const from of ["qualifying", "estimating", "proposal"]) {
      for (const to of ["pre_construction", "in_progress", "billing", "post_sale_closed"]) {
        expect(WARN_TRANSITIONS.has(`${from}→${to}`), `${from}→${to}`).toBe(true);
      }
    }
  });

  it("does not nag on the ordinary path through the pipeline", () => {
    for (const pair of [
      "qualifying→estimating",
      "estimating→proposal",
      "proposal→pre_sale_closed",
      "pre_construction→in_progress",
      "billing→post_sale_closed",
    ]) {
      expect(WARN_TRANSITIONS.has(pair), pair).toBe(false);
    }
  });
});
