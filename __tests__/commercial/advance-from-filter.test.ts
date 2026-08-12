import { describe, it, expect } from "vitest";
import {
  advanceFromFilter,
  stageRank,
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

describe("advanceFromFilter", () => {
  it("agrees with stageRank on every state, for every target rank", () => {
    for (let target = 1; target <= 8; target++) {
      const filter = advanceFromFilter(target);
      for (const [status, sub] of ALL_STATES) {
        const r = stageRank(status, sub);
        const shouldMatch = r !== null && r < target;
        expect(
          matches(filter, status, sub),
          `target=${target} ${status}/${sub} (rank ${r})`
        ).toBe(shouldMatch);
      }
    }
  });

  it("never lets a LOST bid be the source of an automatic move", () => {
    // The resurrection case: someone edits an old proposal on a dead deal and
    // the engine drags it back into the live pipeline.
    for (let target = 1; target <= 8; target++) {
      expect(matches(advanceFromFilter(target), "pre_sale_closed", "lost"), `target=${target}`).toBe(
        false
      );
    }
  });

  it("never lets a CLOSED job be the source of an automatic move", () => {
    for (let target = 1; target <= 8; target++) {
      expect(
        matches(advanceFromFilter(target), "post_sale_closed", "closed"),
        `target=${target}`
      ).toBe(false);
    }
  });

  it("reads a NULL sub_status the way each CLOSED status defines it", () => {
    const f = advanceFromFilter(8);
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

  it("matches nothing at all when no state qualifies", () => {
    // Target rank 0 has nothing below it. The dangerous failure would be
    // returning "" and having the caller treat it as no constraint.
    const f = advanceFromFilter(0);
    expect(f).toBe("id.is.null");
    for (const [status, sub] of ALL_STATES) {
      expect(matches(f, status, sub), `${status}/${sub}`).toBe(false);
    }
  });

  it("is never empty, whatever the target", () => {
    for (let target = 0; target <= 8; target++) {
      expect(advanceFromFilter(target).length, `target=${target}`).toBeGreaterThan(0);
    }
  });

  it("emits only filter syntax PostgREST can parse", () => {
    // Values interpolate straight into the filter string. Anything outside
    // [a-z_] would need escaping — this fails loudly if a future sub-status
    // introduces a comma, dot or paren.
    for (let target = 1; target <= 8; target++) {
      const clause = String.raw`(and\(status\.eq\.[a-z_]+,sub_status\.(eq\.[a-z_]+|is\.null)\)|status\.eq\.[a-z_]+)`;
      expect(advanceFromFilter(target)).toMatch(new RegExp(`^${clause}(,${clause})*$`));
    }
  });

  it("widens monotonically as the target climbs", () => {
    // Advancing to a later stage can only ever accept MORE source states, never
    // swap them out. A non-monotonic filter would mean the ladder has a hole.
    let previous: string[] = [];
    for (let target = 1; target <= 8; target++) {
      const f = advanceFromFilter(target);
      const current = ALL_STATES.filter(([s, sub]) => matches(f, s, sub)).map(
        ([s, sub]) => `${s}/${sub}`
      );
      for (const state of previous) expect(current, `target=${target}`).toContain(state);
      previous = current;
    }
  });
});
