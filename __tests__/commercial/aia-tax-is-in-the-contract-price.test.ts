import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hasLegacyTaxRow, taxReconcileMode } from "@/lib/commercial/aia/tax-inline";
import { computeG702 } from "@/lib/commercial/aia/constants";

/**
 * Sales tax rides INSIDE the contract price, not on a line of its own.
 *
 * Stephanie 2026-09-11: "Sales tax can't show as a separate line item. It has
 * to all be one contract price."
 *
 * This reverses my 2026-09-01 design, which gave tax its own G703 row so that
 * an exemption certificate arriving mid-job could be removed without restating
 * the Original Contract Sum. That trade-off is real and is pinned at the bottom
 * of this file so it is not rediscovered later as a bug — it is a decision, and
 * it is hers.
 *
 * Everything here guards one thing: a GC must never be charged the tax twice.
 */

describe("an application uses EITHER the legacy row or inline tax", () => {
  it("detects the legacy row by item number, case-insensitively", () => {
    expect(hasLegacyTaxRow([{ item_no: "1" }, { item_no: "TAX" }])).toBe(true);
    expect(hasLegacyTaxRow([{ item_no: "1" }, { item_no: " tax " }])).toBe(true);
    expect(hasLegacyTaxRow([{ item_no: "1" }, { item_no: "CO-001" }])).toBe(false);
    expect(hasLegacyTaxRow([])).toBe(false);
  });

  it("only inserts a tax row for the ITEMIZED shape, never the folded one", () => {
    // The double-charge to avoid: on a one-contract-line schedule the line is
    // already tax-inclusive, so a TAX row on top bills the tax twice. An
    // ITEMIZED schedule is the opposite problem — it has no single pre-tax
    // base to fold into, so without a row it carries no tax at all.
    //
    // So the insert may exist, but ONLY behind the itemized guard.
    const src = readFileSync("lib/commercial/aia/sales-tax.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const insertIdx = src.indexOf("item_no: AIA_TAX_ITEM_NO");
    if (insertIdx > -1) {
      // The insert must sit AFTER the refold early-return, so a folded
      // schedule can never reach it. Asserting on the ordering rather than on
      // a guard's wording — the wording changed once already and took these
      // assertions red with the behaviour unchanged.
      const refoldReturn = src.indexOf('if (mode === "refold")');
      expect(refoldReturn, "the refold early-return is gone").toBeGreaterThan(-1);
      expect(
        insertIdx > refoldReturn,
        "a TAX row can be inserted before the folded shape returns — that schedule would be taxed twice"
      ).toBe(true);
    }

    // It must still UPDATE one that already exists: a live application has
    // $437.50 billed against its tax row, and that is history on a certificate
    // the GC may be holding.
    expect(src).toMatch(/\.update\(/);
  });
});

describe("folded values are derived, never accumulated", () => {
  it("the seed folds tax from contractCents, not from the line's own value", () => {
    // Idempotence is the whole point: users can edit a scheduled value by
    // hand, and the reconcile runs again on every change-order approval. If
    // the fold read the line's current (already-inclusive) value as its base,
    // every run would compound the tax.
    const src = readFileSync("lib/commercial/aia/db.ts", "utf8");
    expect(src).toMatch(/taxInclusiveCents\(\{\s*opportunityId:[\s\S]{0,80}baseCents:\s*contractCents/);
    // Change-order lines derive from the CO's own amount, same reason.
    expect(src).toMatch(/baseCents:\s*Math\.round\(Number\(co\.amount_cents\)\)/);
  });

  it("change-order rows get distinct positions despite the async fold", () => {
    // The fold made these callbacks async. A mutable `pos` counter would be
    // read by every callback before any of them incremented it, landing N rows
    // on the same position — a schedule of values with no defined order.
    const src = readFileSync("lib/commercial/aia/db.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/position:\s*basePos \+ i \* 1000/);
    expect(
      /let pos = lines\.reduce/.test(src),
      "the mutable position counter is back, and the fold's await races it"
    ).toBe(false);
  });
});

/**
 * THE TRADE-OFF, recorded on purpose.
 *
 * With tax inside the contract price, an exemption certificate arriving
 * mid-job changes the Original Contract Sum on the next application — the GC
 * sees line 1 move even though the contract did not change. That is the exact
 * confusion Stephanie described about alternates surfacing as change orders,
 * and it is the cost of the separate line going away.
 *
 * She chose it knowing the separate line was the worse problem in practice.
 * If a GC ever queries a moving line 1, this is why — not a bug.
 */
describe("the known consequence", () => {
  it("is written down where the next person will find it", () => {
    const src = readFileSync("lib/commercial/aia/tax-inline.ts", "utf8");
    // Whitespace-tolerant: the sentence wraps across comment lines, and a
    // single-line regex would fail on a reflow rather than on a real deletion.
    expect(src.replace(/\s*\n\s*\*?\s*/g, " ")).toMatch(/restate the Original Contract Sum/);
  });
});

/**
 * THE SHEET HAS TO FOOT.
 *
 * Folding tax into the schedule's lines made the G703 column total
 * tax-inclusive while G702 line 1 still came back pre-tax off the contract
 * ladder. On a $25,000 Suffolk job that is a $2,187.50 gap between two sheets
 * of the SAME certificate, and a GC's AP system rejects that outright.
 *
 * I shipped that gap. Every other check was green: tsc passed, 2,936 unit tests
 * passed, all 97 pages returned 200, and the two new guards both verified the
 * fold was happening — none of them ever added the two sheets up.
 *
 * `sovVarianceCents` existed the whole time and is exactly the number that
 * catches it. Nothing was asserting on it.
 */
describe("the two sheets add up to each other", () => {
  const foot = (originalContractCents: number, lines: Array<{ item_no: string; scheduled_value_cents: number }>) => {
    return computeG702({
      originalContractCents,
      netChangeOrdersCents: 0,
      retainagePct: 10,
      previousCertificatesCents: 0,
      lines: lines.map((l) => ({ ...l, from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0 })) as never,
    });
  };

  it("a tax-inclusive schedule needs a tax-inclusive line 1", () => {
    // $25,000 + 8.75% Suffolk = $27,187.50 on the contract line.
    const good = foot(27_187_50, [{ item_no: "1", scheduled_value_cents: 27_187_50 }]);
    expect(good.contractSumToDateCents).toBe(27_187_50);
    expect(good.sovVarianceCents, "G702 line 3 and the G703 total must agree").toBe(0);
  });

  it("catches the mismatch I shipped: inclusive lines, pre-tax line 1", () => {
    // The state that went to production. Kept as a test so the failure mode is
    // named rather than rediscovered.
    const bad = foot(25_000_00, [{ item_no: "1", scheduled_value_cents: 27_187_50 }]);
    expect(bad.sovVarianceCents).toBe(-218750);
  });

  it("still foots on an exempt job, where nothing is folded at all", () => {
    const exempt = foot(25_000_00, [{ item_no: "1", scheduled_value_cents: 25_000_00 }]);
    expect(exempt.sovVarianceCents).toBe(0);
  });

  it("resolveG702 adds tax to line 1 ONLY when there is no legacy tax row", () => {
    // With a legacy row present, computeG702 already folds its value into line
    // 3 via salesTaxCents — adding tax to line 1 as well would bill it twice.
    const src = readFileSync("lib/commercial/aia/db.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/if \(!lines\.some\(\(l\) => isAiaTaxLine\(l\)\)\)/);
    expect(src).toMatch(/originalContractCents: line1Cents/);
  });
});

/**
 * A tax change MIDWAY through the job has to reach the sheet.
 *
 * Stephanie 2026-09-11: "Tax settings aren't sticking if changed midway through
 * the job."
 *
 * Folding tax at SEED time alone regressed exactly this. The old code
 * recomputed a tax ROW on every draft reconcile, so a certificate arriving late
 * took the tax off; folded-at-seed, the draft kept its tax-inclusive figure
 * forever and the exemption never landed. Her report was about a behaviour I
 * had removed in the same batch that was meant to fix her other tax item.
 */
describe("a certificate arriving mid-job still comes off", () => {
  const src = readFileSync("lib/commercial/aia/sales-tax.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the draft reconcile RE-DERIVES the folded values, it doesn't only seed them", () => {
    // The CALL, not the definition. `/refoldInlineTax\(/` matches
    // `async function refoldInlineTax(` too, so it stayed green with the call
    // deleted — a check that cannot fail, which is worse than no check.
    expect(src).toMatch(/await refoldInlineTax\(applicationId/);
    // Re-derived from an authoritative PRE-TAX base, never the line's own
    // current value — that is what makes re-running safe.
    expect(src).toMatch(/baseCents: Math\.round\(Number\(seed\.total_cents/);
    expect(src).toMatch(/baseCents: Math\.round\(Number\(co\.amount_cents\)\)/);
  });

  it("only re-folds the ONE-contract-line shape", () => {
    // An itemized schedule has no single pre-tax base per row; the seed spread
    // the contract across N rows proportionally, so re-deriving one is a guess.
    expect(src).toMatch(/baseLines\.length !== 1/);
  });
});

describe("an ITEMIZED schedule is not left untaxed", () => {
  const src = readFileSync("lib/commercial/aia/sales-tax.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("keeps the separate tax row for the breakdown case", () => {
    // The fold was added ONLY to the single-line branch while the row stopped
    // being created for everyone — so an itemized schedule carried no tax at
    // all and under-billed the GC. Worse than a line item the GC asked for the
    // detail of anyway.
    // Decided by taxReconcileMode, exercised exhaustively further down.
    expect(taxReconcileMode({ hasLegacyTaxRow: false, baseLineCount: 3 })).toBe("row");
    // ...and the row path really does create one.
    expect(src).toMatch(/item_no: AIA_TAX_ITEM_NO/);
  });
});


/**
 * WHICH mechanism, decided once and exhaustively.
 *
 * The bug this exists to prevent was pure control flow and invisible to every
 * source check I had: the folded shape fell through into the ROW path, which
 * returns early when a job is exempt — `want` is null and there is no row to
 * find. So a certificate arriving mid-job never took the tax off, which is the
 * exact scenario the re-fold had just been written for. My first version of
 * that fix did not work for the one case it was for, and three source-level
 * guards all stayed green.
 */
describe("taxReconcileMode", () => {
  it("a folded schedule re-folds — including when the job is now exempt", () => {
    expect(taxReconcileMode({ hasLegacyTaxRow: false, baseLineCount: 1 })).toBe("refold");
  });

  it("a legacy row always wins, whatever the shape", () => {
    // One live application has $437.50 billed against its row. Re-folding it
    // would restate a certificate the GC may already hold.
    expect(taxReconcileMode({ hasLegacyTaxRow: true, baseLineCount: 1 })).toBe("row");
    expect(taxReconcileMode({ hasLegacyTaxRow: true, baseLineCount: 5 })).toBe("row");
  });

  it("an itemized schedule uses the row", () => {
    // No single pre-tax base per line to re-derive from.
    expect(taxReconcileMode({ hasLegacyTaxRow: false, baseLineCount: 2 })).toBe("row");
  });

  it("an empty schedule does not take the row path", () => {
    // Zero base lines is a freshly created application, not an itemized one.
    expect(taxReconcileMode({ hasLegacyTaxRow: false, baseLineCount: 0 })).toBe("refold");
  });

  it("never returns both, for any combination", () => {
    for (const hasLegacyTaxRow of [true, false]) {
      for (let baseLineCount = 0; baseLineCount <= 4; baseLineCount++) {
        const m = taxReconcileMode({ hasLegacyTaxRow, baseLineCount });
        expect(["refold", "row"]).toContain(m);
        // The invariant that stops a double charge: a legacy row is NEVER
        // folded, because computeG702 already counts it into line 3.
        if (hasLegacyTaxRow) expect(m).toBe("row");
      }
    }
  });
});

/**
 * EITHER/OR at INSERT time, not just at reconcile time.
 *
 * Found by exporting nine live certificates and adding up each one's two
 * sheets. A draft came out exactly -$21.88 — the tax on its $250 change order.
 *
 * That application still carries a legacy TAX row, which taxes the whole sheet.
 * The change-order row builder folded tax in as well, so the G703 row carried
 * amount+tax while G702 line 2 used the raw amount. The certificate was short
 * by precisely one change order's tax.
 *
 * Neither tsc, nor 2,951 unit tests, nor 97 pages at 200 could see it. Adding
 * the two sheets up could.
 */
describe("a change-order row is folded ONLY on a folded application", () => {
  const src = readFileSync("lib/commercial/aia/db.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("checks for a legacy TAX row before folding", () => {
    expect(src).toMatch(/const foldsInline = !lines\.some\(/);
    expect(src).toMatch(/"TAX"/);
  });

  it("uses the RAW change-order amount when a legacy row is present", () => {
    // The row already taxes the whole sheet; folding here charges it twice.
    expect(src).toMatch(/foldsInline[\s\S]{0,200}: Math\.round\(Number\(co\.amount_cents\)\)/);
  });
});

/**
 * The insert that could never succeed.
 *
 * `reconcileDraftChangeOrderRows` appended rows with
 * `onConflict: "application_id,change_order_id"`, and no unique index covering
 * those columns existed. Postgres answered 42P10 — "no unique or exclusion
 * constraint matching the ON CONFLICT specification" — on EVERY attempt, into a
 * console.error. The reconcile returned normally, the page rendered, and the
 * change order never reached the G703 while G702 line 2 counted it.
 *
 * That is Stephanie's "change orders aren't showing up if approved after the
 * draft is generated", and it is not what I first diagnosed it as.
 */
describe("the change-order insert survives a missing index", () => {
  const src = readFileSync("lib/commercial/aia/db.ts", "utf8");

  it("falls back to a plain insert on 42P10", () => {
    // Migrations here are applied by hand, so the code must work before
    // migration 200 lands as well as after.
    expect(src).toMatch(/insErr\.code === "42P10"/);
    expect(src).toMatch(/from\("commercial_aia_line_items"\)\.insert\(rows\)/);
  });

  it("does not treat a genuine duplicate as a failure", () => {
    // 23505 is the race the upsert existed to absorb: two renders reconciling
    // the same draft at once.
    expect(src).toMatch(/plainErr\.code !== "23505"/);
  });

  it("migration 200 creates the index it wanted all along", () => {
    const mig = readFileSync("supabase/migrations/200_aia_co_line_unique.sql", "utf8");
    expect(mig).toMatch(/CREATE UNIQUE INDEX/i);
    expect(mig).toMatch(/\(application_id, change_order_id\)/);
    // Partial: change_order_id is NULL on the contract line and the TAX row,
    // and several of those legitimately coexist.
    expect(mig).toMatch(/WHERE change_order_id IS NOT NULL/i);
  });
});
