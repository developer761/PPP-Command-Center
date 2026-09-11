import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hasLegacyTaxRow } from "@/lib/commercial/aia/tax-inline";
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

  it("the reconcile no longer INSERTS a tax row", () => {
    // The double-charge that would happen if it did: the contract line is
    // already tax-inclusive at seed, so adding a TAX row on top bills the tax
    // a second time. Asserted on the source because the insert is the thing
    // that must not exist, and an integration test would need a live draft.
    const src = readFileSync("lib/commercial/aia/sales-tax.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(
      /\.insert\(\s*\{[\s\S]*?item_no:\s*AIA_TAX_ITEM_NO/.test(src),
      "sales-tax.ts inserts a TAX row again — an application whose lines are already tax-inclusive would bill tax twice"
    ).toBe(false);

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
