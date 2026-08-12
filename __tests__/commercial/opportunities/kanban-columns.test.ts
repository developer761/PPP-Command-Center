import { describe, it, expect } from "vitest";
import {
  KANBAN_COLUMNS,
  OPEN_COLUMN_KEYS,
  TERMINAL_COLUMN_KEYS,
  COLUMN_TARGET,
  columnKeyForOpp,
  oppStatusDisplayLabel,
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
    // AUDIT 2026-08-12: this used to expect "qualifying", and that expectation
    // WAS the bug Karan reported — `qualifying` carries an `estimating`
    // sub-status, so picking Estimating left the deal reading as Qualifying.
    // Both tuples that mean "we are pricing it" now resolve to Estimating.
    expect(columnKeyForOpp("qualifying", "estimating")).toBe("estimating");
  });

  it("gives Pending Approval its own stage, and calls the next one Sent", () => {
    // Brendan 2026-08-12: "Then pending approval — this should trigger when the
    // estimator submits for approval. Then sent." Awaiting sign-off used to
    // fold into Proposal, which is exactly why moving a deal from pricing to
    // pending-approval left the progress bar untouched.
    expect(columnKeyForOpp("estimating", "proposal_pending_approval")).toBe("pending_approval");
    expect(columnKeyForOpp("estimating", "estimating")).toBe("estimating");
    expect(columnKeyForOpp("proposal", "sent")).toBe("sent");
    // Follow-Up is dropped as a stage: chasing a GC is still the proposal being
    // out. Old rows fold in rather than being migrated.
    expect(columnKeyForOpp("proposal", "follow_up")).toBe("sent");
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

  it("skips the DB narrowing hint where narrowing would lose rows", () => {
    // `sent` holds (proposal, sent) AND the legacy (proposal, follow_up);
    // `pending_approval` shares the `estimating` status with `estimating`
    // itself. Qualifying is the fallback column for unrecognised statuses, so
    // narrowing it would hide the very rows that fallback rescues. All three
    // must fetch wide and filter in memory.
    const WIDE = ["sent", "pending_approval", "estimating", "qualifying"];
    for (const key of WIDE) expect(columnDbStatusHint(key), key).toBeNull();
    for (const col of KANBAN_COLUMNS) {
      if (WIDE.includes(col.key)) continue;
      expect(columnDbStatusHint(col.key), col.key).toBe(
        COLUMN_TARGET[col.key].status
      );
    }
  });

  it("never narrows a column whose fallback rows would be excluded", () => {
    // Property: if a column can hold a row whose top-level status differs
    // from the hint, the hint must be null. Guards against a future column
    // being narrowed by accident.
    const LEGACY_AND_JUNK = ["rfp", "won", "lost", "proposal_sent", "solicitation", "nonsense"];
    for (const s of LEGACY_AND_JUNK) {
      const col = columnKeyForOpp(s, null);
      const hint = columnDbStatusHint(col);
      // Either we fetch wide, or the hint matches this row's real status.
      expect(hint === null || hint === s, `${s} → column ${col}, hint ${hint}`).toBe(true);
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

/**
 * AUDIT 2026-08-12 — Karan: "I put the status to RFP and it always says Status
 * updated to Qualifying. Then I put it into estimating and it brings it back to
 * qualifying."
 *
 * Both halves were real, and both came from the same place: the two-level model
 * has tuples that mean the same stage, and the label read the top level only.
 */
describe("the state a deal is IN is what it says it is", () => {
  it("names the stage, not the top-level status", async () => {
    const { oppStatusDisplayLabel } = await import("@/lib/commercial/opportunities/kanban-columns");
    // The exact complaint: setting RFP said "Qualifying".
    expect(oppStatusDisplayLabel("qualifying", "rfp")).toBe("RFP");
    // …and the same class of lie one stage along.
    expect(oppStatusDisplayLabel("estimating", "proposal_pending_approval")).toBe("Pending Approval");
    expect(oppStatusDisplayLabel("proposal", "sent")).toBe("Sent");
    expect(oppStatusDisplayLabel("qualifying", "solicitation")).toBe("Qualifying");
  });

  it("still says Won and Lost rather than Closed", () => {
    // The outcome is the useful word on a decided deal.
    expect(oppStatusDisplayLabel("pre_sale_closed", "won")).toBe("Won");
    expect(oppStatusDisplayLabel("pre_sale_closed", "lost")).toBe("Lost");
  });

  it("resolves BOTH tuples that mean 'we are pricing it' to Estimating", () => {
    expect(columnKeyForOpp("estimating", "estimating")).toBe("estimating");
    expect(columnKeyForOpp("qualifying", "estimating")).toBe("estimating");
  });
});
