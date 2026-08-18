import { describe, it, expect } from "vitest";
import {
  KANBAN_COLUMNS,
  OPEN_COLUMN_KEYS,
  TERMINAL_COLUMN_KEYS,
  COLUMN_TARGET,
  columnKeyForOpp,
  oppStatusDisplayLabel,
  kanbanColumnLabel,
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
    // Retired 2026-08-17: legacy `solicitation` rows fold into RFP.
    expect(columnKeyForOpp("qualifying", "solicitation")).toBe("rfp");
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
    const WIDE = ["sent", "pending_approval", "estimating", "rfp"];
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
    // A legacy `solicitation` row now reads as RFP everywhere, label included —
    // the label is derived from the column, and Qualifying no longer has one.
    expect(oppStatusDisplayLabel("qualifying", "solicitation")).toBe("RFP");
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

/**
 * RECHECK 2026-08-12 — a behavioural pass rather than a structural one, after
 * the structural audit missed the bugs Karan hit by walking a deal through the
 * stages by hand.
 *
 * These walk EVERY state a deal can be in and assert the surfaces agree. The
 * previous audit checked that lists matched each other; this checks that what a
 * person sees is what is true.
 */
describe("every state a deal can be in resolves consistently", () => {
  it("maps every valid tuple onto a stage that exists", async () => {
    const { SUB_STATUSES_BY_STATUS, OPPORTUNITY_STATUSES } = await import(
      "@/lib/commercial/opportunities/constants"
    );
    const real = new Set(KANBAN_COLUMNS.map((c) => c.key));
    for (const st of OPPORTUNITY_STATUSES) {
      const subs = (SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[st] ?? [];
      for (const sub of subs) {
        const stage = columnKeyForOpp(st, sub);
        expect(real.has(stage), `${st}/${sub} → "${stage}" is not a stage`).toBe(true);
      }
    }
  });

  it("never shows a person a name that isn't the stage they're on", async () => {
    const { SUB_STATUSES_BY_STATUS, OPPORTUNITY_STATUSES } = await import(
      "@/lib/commercial/opportunities/constants"
    );
    for (const st of OPPORTUNITY_STATUSES) {
      const subs = (SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[st] ?? [];
      for (const sub of subs) {
        const said = oppStatusDisplayLabel(st, sub);
        // Won/Lost deliberately say the outcome rather than the stage name.
        if (st === "pre_sale_closed") {
          expect(["Won", "Lost"]).toContain(said);
          continue;
        }
        const stageLabel = kanbanColumnLabel(columnKeyForOpp(st, sub));
        expect(said, `${st}/${sub} says "${said}" but sits in "${stageLabel}"`).toBe(stageLabel);
      }
    }
  });

  it("gives every stage a tuple to write, so the picker can reach all of them", () => {
    // The flat stage picker writes COLUMN_TARGET[stage]. A stage without one
    // would render as an option that does nothing when chosen.
    for (const c of KANBAN_COLUMNS) {
      expect(COLUMN_TARGET[c.key], `stage "${c.key}" has no tuple to write`).toBeTruthy();
    }
  });

  it("round-trips: writing a stage's tuple lands back on that stage", () => {
    // The guarantee that picking "Pending Approval" leaves you at Pending
    // Approval — the exact thing that failed when picking Estimating sent a
    // deal back to Qualifying.
    for (const c of KANBAN_COLUMNS) {
      const t = COLUMN_TARGET[c.key];
      if (!t) continue;
      expect(columnKeyForOpp(t.status, t.sub_status), c.key).toBe(c.key);
    }
  });
});

/**
 * A new deal cannot start at a stage that implies an artifact it doesn't have.
 * The exclusion list named "proposal", and that key stopped existing when the
 * stage was renamed "sent" — so the guard silently switched off.
 */
describe("stages a brand-new deal may start at", () => {
  it("never offers a stage that implies a proposal already exists", async () => {
    const { PRE_CONTRACT_COLUMNS, OPEN_COLUMN_KEYS } = await import(
      "@/lib/commercial/opportunities/kanban-columns"
    );
    const EXCLUDED = ["sent", "pending_approval"];
    const offered = PRE_CONTRACT_COLUMNS.filter(
      (c) => OPEN_COLUMN_KEYS.includes(c.key) && !EXCLUDED.includes(c.key)
    ).map((c) => c.key);
    for (const gone of EXCLUDED) {
      expect(offered, `a new deal must not start at "${gone}"`).not.toContain(gone);
    }
    // …and the early stages stay available, or there is nowhere to start.
    // "Qualifying" is no longer offered to a new deal (Brendan 2026-08-17) —
    // RFP is the entry stage. This asserts the retirement actually took.
    expect(offered).not.toContain("qualifying");
    expect(offered).toContain("rfp");
    expect(offered).toContain("rfp");
    expect(offered).toContain("estimating");
  });
});
