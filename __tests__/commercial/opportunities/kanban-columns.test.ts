import { describe, it, expect } from "vitest";
import {
  KANBAN_COLUMNS,
  OPEN_COLUMN_KEYS,
  TERMINAL_COLUMN_KEYS,
  COLUMN_TARGET,
  columnKeyForOpp,
  columnDbStatusHint,
  resolveColumnTarget,
  auditKanbanColumnMap,
  isFollowUpCard,
  isDraftedCard,
} from "@/lib/commercial/opportunities/kanban-columns";
import {
  SUB_STATUSES_BY_STATUS,
  OPPORTUNITY_STATUSES,
} from "@/lib/commercial/opportunities/constants";

/**
 * The kanban columns are a display layer over the (status, sub_status)
 * tuple. These tests pin the two invariants that make that safe:
 *
 *   1. Every valid tuple shows in exactly one column (nothing vanishes).
 *   2. Every column writes a tuple that shows in that same column
 *      (drop-and-land agree — no card that bounces back on refresh).
 *
 * Both were real bugs before the flatten: the old bucketer had no final
 * `else`, so a legacy v1 row silently disappeared from the board.
 */
describe("kanban column map", () => {
  it("passes its own self-audit", () => {
    expect(auditKanbanColumnMap()).toEqual([]);
  });

  it("places every whitelisted tuple in exactly one known column", () => {
    const keys = new Set(KANBAN_COLUMNS.map((c) => c.key));
    for (const [status, subs] of Object.entries(SUB_STATUSES_BY_STATUS)) {
      for (const sub of subs as readonly string[]) {
        const col = columnKeyForOpp(status, sub);
        expect(keys.has(col), `(${status}, ${sub}) → "${col}"`).toBe(true);
      }
    }
  });

  it("never drops a card, even for junk or legacy statuses", () => {
    const keys = new Set(KANBAN_COLUMNS.map((c) => c.key));
    // v1 values that escaped migration 052, plus outright garbage.
    for (const s of ["rfp", "follow_up", "won", "lost", "", "nonsense"]) {
      expect(keys.has(columnKeyForOpp(s, null))).toBe(true);
    }
    expect(keys.has(columnKeyForOpp(null, null))).toBe(true);
  });

  it("promotes RFP out of Qualifying without swallowing its siblings", () => {
    expect(columnKeyForOpp("qualifying", "rfp")).toBe("rfp");
    expect(columnKeyForOpp("qualifying", "solicitation")).toBe("qualifying");
    expect(columnKeyForOpp("qualifying", "estimating")).toBe("qualifying");
  });

  it("merges drafted + sent + follow-up into one Proposal column", () => {
    expect(columnKeyForOpp("estimating", "proposal_pending_approval")).toBe("proposal");
    expect(columnKeyForOpp("proposal", "sent")).toBe("proposal");
    expect(columnKeyForOpp("proposal", "follow_up")).toBe("proposal");
    // …but plain Estimating stays its own stage.
    expect(columnKeyForOpp("estimating", "estimating")).toBe("estimating");
  });

  it("tags the two Proposal-column states that still differ", () => {
    expect(isFollowUpCard("proposal", "follow_up")).toBe(true);
    expect(isFollowUpCard("proposal", "sent")).toBe(false);
    expect(isDraftedCard("estimating", "proposal_pending_approval")).toBe(true);
    expect(isDraftedCard("proposal", "sent")).toBe(false);
  });

  it("defaults a malformed closed tuple to Lost, never to Won", () => {
    // migration 059 dropped the CHECK constraints, so junk can exist. A
    // stray row must not inflate the win column.
    expect(columnKeyForOpp("pre_sale_closed", "won")).toBe("won");
    expect(columnKeyForOpp("pre_sale_closed", "lost")).toBe("lost");
    expect(columnKeyForOpp("pre_sale_closed", null)).toBe("lost");
    expect(columnKeyForOpp("pre_sale_closed", "garbage")).toBe("lost");
  });

  it("refuses to resolve a bare pre_sale_closed", () => {
    // Ambiguous (won vs lost). It used to silently resolve to Won and skip
    // the debrief side-effects entirely.
    expect(resolveColumnTarget("pre_sale_closed")).toBeNull();
    expect(resolveColumnTarget("not_a_column")).toBeNull();
  });

  it("resolves every column key and every real status to a valid target", () => {
    for (const col of KANBAN_COLUMNS) {
      const target = resolveColumnTarget(col.key);
      expect(target, col.key).not.toBeNull();
      expect(
        (SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[
          target!.status
        ]
      ).toContain(target!.sub_status);
    }
    for (const s of OPPORTUNITY_STATUSES) {
      if (s === "pre_sale_closed") continue; // deliberately ambiguous
      expect(resolveColumnTarget(s), s).not.toBeNull();
    }
  });

  it("only skips the DB narrowing hint for the column that spans statuses", () => {
    // Proposal holds both (proposal, *) and (estimating, pending approval),
    // so it can't be expressed as a single .eq() — callers must filter in
    // memory. Every other column narrows cleanly.
    expect(columnDbStatusHint("proposal")).toBeNull();
    for (const col of KANBAN_COLUMNS) {
      if (col.key === "proposal") continue;
      expect(columnDbStatusHint(col.key), col.key).toBe(
        COLUMN_TARGET[col.key].status
      );
    }
  });

  it("keeps the hint consistent with the in-memory filter", () => {
    // A column's DB hint must not exclude any tuple that belongs to it,
    // or the pre-narrowing silently drops cards the filter would keep.
    for (const [status, subs] of Object.entries(SUB_STATUSES_BY_STATUS)) {
      for (const sub of subs as readonly string[]) {
        const col = columnKeyForOpp(status, sub);
        const hint = columnDbStatusHint(col);
        if (hint !== null) expect(hint, `(${status}, ${sub})`).toBe(status);
      }
    }
  });

  it("partitions the columns into open + terminal with no overlap", () => {
    const open = new Set(OPEN_COLUMN_KEYS);
    const terminal = new Set(TERMINAL_COLUMN_KEYS);
    for (const k of open) expect(terminal.has(k)).toBe(false);
    // post_sale_closed is deliberately in neither — it lives in the
    // overflow drawer rather than as a drop zone on the board.
    const covered = new Set([...open, ...terminal, "post_sale_closed"]);
    for (const c of KANBAN_COLUMNS) expect(covered.has(c.key), c.key).toBe(true);
  });
});
