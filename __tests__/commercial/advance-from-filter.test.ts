import { describe, it, expect } from "vitest";
import {
  advanceFromFilter,
  stageRank,
  subRank,
  SUB_STATUSES_BY_STATUS,
} from "@/lib/commercial/opportunities/constants";

/**
 * `advanceFromFilter` IS the forward-only guard. It ships as a string into the
 * WHERE clause of the automatic status write, so if it's wrong the engine
 * silently moves deals backwards — and status corruption doesn't announce
 * itself, it surfaces weeks later in the wrong month's numbers.
 *
 * These tests read the string back as a predicate and check it against
 * `stageRank` over every whitelisted state, rather than asserting on literal
 * text that would break on any harmless reordering.
 */

/** Re-implements PostgREST's reading of the filter, so we test meaning not text. */
function matches(filter: string, status: string, sub: string | null): boolean {
  const clauses = filter.match(/and\([^)]*\)|[^,]+/g) ?? [];
  return clauses.some((c) => {
    const isNull = c.match(/^and\(status\.eq\.(\w+),sub_status\.is\.null\)$/);
    if (isNull) return status === isNull[1] && sub === null;
    const pair = c.match(/^and\(status\.eq\.(\w+),sub_status\.eq\.(\w+)\)$/);
    if (pair) return status === pair[1] && sub === pair[2];
    const only = c.match(/^status\.eq\.(\w+)$/);
    if (only) return status === only[1];
    return false; // id.is.null — the match-nothing fallback
  });
}

const ALL_STATES: [string, string | null][] = [
  ...Object.entries(SUB_STATUSES_BY_STATUS).flatMap(([s, subs]) =>
    (subs as readonly string[]).map((sub) => [s, sub] as [string, string | null])
  ),
  // Rows in the wild carry NULL sub_status; the column is nullable.
  ...Object.keys(SUB_STATUSES_BY_STATUS).map((s) => [s, null] as [string, string | null]),
];

/** Every non-terminal state, usable as a target. */
const TARGETS = ALL_STATES.filter(([s, sub]) => sub !== null && stageRank(s, sub) !== null) as [
  string,
  string,
][];

describe("advanceFromFilter", () => {
  it("agrees with (stageRank, subRank) on every state, for every target", () => {
    for (const [ts, tsub] of TARGETS) {
      const filter = advanceFromFilter(ts, tsub);
      const targetRank = stageRank(ts, tsub)!;
      const targetSub = subRank(ts, tsub);
      for (const [status, sub] of ALL_STATES) {
        const r = stageRank(status, sub);
        const shouldMatch =
          r !== null &&
          (r < targetRank || (r === targetRank && status === ts && subRank(status, sub) < targetSub));
        expect(
          matches(filter, status, sub),
          `target=${ts}/${tsub} from ${status}/${sub} (rank ${r})`
        ).toBe(shouldMatch);
      }
    }
  });

  it("allows a step forward WITHIN a status", () => {
    // Both are rank 1. A pure rank compare would refuse this, and since nothing
    // ever moves backwards to correct it, the deal would sit at plain
    // "Estimating" for good.
    const f = advanceFromFilter("estimating", "proposal_pending_approval");
    expect(matches(f, "estimating", "estimating")).toBe(true);
    // …but not the reverse, and not sideways out of another status at the same rank.
    expect(matches(advanceFromFilter("estimating", "estimating"), "estimating", "proposal_pending_approval")).toBe(false);
  });

  it("fills in a NULL sub_status rather than leaving the deal stuck", () => {
    expect(matches(advanceFromFilter("estimating", "estimating"), "estimating", null)).toBe(true);
  });

  it("never lets a LOST bid be the source of an automatic move", () => {
    // The resurrection case: someone edits an old proposal on a dead deal and
    // the engine drags it back into the live pipeline.
    for (const [ts, tsub] of TARGETS) {
      expect(
        matches(advanceFromFilter(ts, tsub), "pre_sale_closed", "lost"),
        `target=${ts}/${tsub}`
      ).toBe(false);
    }
  });

  it("never lets a CLOSED job be the source of an automatic move", () => {
    for (const [ts, tsub] of TARGETS) {
      expect(
        matches(advanceFromFilter(ts, tsub), "post_sale_closed", "closed"),
        `target=${ts}/${tsub}`
      ).toBe(false);
    }
  });

  it("reads a NULL sub_status the way each CLOSED status defines it", () => {
    const f = advanceFromFilter("post_sale_closed", "closeout");
    // pre_sale_closed with no sub is neither won nor lost — ambiguous. It ranks
    // null, so the engine keeps its hands off rather than guessing.
    expect(matches(f, "pre_sale_closed", null)).toBe(false);
    // post_sale_closed with no sub is NOT 'closed', so it's still in closeout
    // (rank 7) — a job mid-closeout has to stay reachable by the closeout hook,
    // otherwise finishing it would leave it stuck forever.
    expect(matches(f, "post_sale_closed", null)).toBe(true);
    // A NULL sub on an ordinary status is matched too — there the rank doesn't
    // depend on the sub at all.
    expect(matches(f, "estimating", null)).toBe(true);
    expect(matches(f, "in_progress", null)).toBe(true);
  });

  it("accepts only the unset row at the very bottom of the ladder", () => {
    // Nothing is behind the first stage except a deal whose sub was never set,
    // and filling that in is a real forward move — not a no-op.
    const f = advanceFromFilter("qualifying", "solicitation");
    const accepted = ALL_STATES.filter(([s, sub]) => matches(f, s, sub));
    expect(accepted).toEqual([["qualifying", null]]);
  });

  it("is never empty, whatever the target", () => {
    for (const [ts, tsub] of TARGETS) {
      expect(advanceFromFilter(ts, tsub).length, `${ts}/${tsub}`).toBeGreaterThan(0);
    }
  });

  it("refuses to build a filter for a terminal target", () => {
    // 'Everything below a terminal state' is undefined. Closing a job is a
    // sub-status refinement with one exact source, not a climb — so this must
    // match nothing rather than guess at a range.
    expect(advanceFromFilter("post_sale_closed", "closed")).toBe("id.is.null");
    expect(advanceFromFilter("pre_sale_closed", "lost")).toBe("id.is.null");
  });

  it("emits only filter syntax PostgREST can parse", () => {
    // Values interpolate straight into the filter string. Anything outside
    // [a-z_] would need escaping — this fails loudly if a future sub-status
    // introduces a comma, dot or paren.
    for (const [ts, tsub] of TARGETS) {
      const clause = String.raw`(and\(status\.eq\.[a-z_]+,sub_status\.(eq\.[a-z_]+|is\.null)\)|status\.eq\.[a-z_]+)`;
      expect(advanceFromFilter(ts, tsub)).toMatch(new RegExp(`^${clause}(,${clause})*$`));
    }
  });

  it("widens monotonically as the target climbs", () => {
    // Advancing to a later stage can only ever accept MORE source states, never
    // swap them out. A non-monotonic filter would mean the ladder has a hole.
    const ladder = TARGETS.slice().sort(
      (a, b) => stageRank(a[0], a[1])! - stageRank(b[0], b[1])! || subRank(a[0], a[1]) - subRank(b[0], b[1])
    );
    let previous: string[] = [];
    for (const [ts, tsub] of ladder) {
      const f = advanceFromFilter(ts, tsub);
      const current = ALL_STATES.filter(([s, sub]) => matches(f, s, sub)).map(
        ([s, sub]) => `${s}/${sub}`
      );
      for (const state of previous) expect(current, `target=${ts}/${tsub}`).toContain(state);
      previous = current;
    }
  });
});
