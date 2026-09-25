import { describe, it, expect } from "vitest";
import { ROLES } from "@/lib/commercial/guide/roles";
import {
  ACCOUNTING_PRIMARY_LABELS,
  ACCOUNTING_VIEWS,
} from "@/lib/commercial/accounting/tabs";

/**
 * The handbook's Accounting tab strip is the real tab strip.
 *
 * It used to be a second, hand-typed copy of the labels, and it went stale
 * without a sound. Payroll was added to the page on 2026-09-24 and Balance
 * owed some weeks before; the copy had neither. So Mary's chapter — the one
 * titled "The money", opening with "everything to do with money is on the
 * Accounting page" and claiming to walk her whole day — drew a bar missing two
 * tabs, and every `at:` index after Receivables pointed one or two places to
 * the left. Somebody counting along to "the third tab" pressed the wrong one.
 *
 * A handbook that is confidently wrong about which button to press is worse
 * than no handbook: it is read by the person who has least ability to tell.
 *
 * The strip now IS `ACCOUNTING_PRIMARY_LABELS` and each position is looked up
 * by label, so the drift is structurally impossible. These tests hold the rest
 * of the seam — that the positions resolve, that a surface sits on the tab it
 * claims, and that no primary tab is left undocumented.
 *
 * Asserted against the exported tab list rather than a literal, so a
 * deliberate reorder updates both sides at once and only a genuine mismatch
 * goes red.
 */

type Surface = {
  name: string;
  path: string;
  strip?: { boxes: readonly string[]; at: number };
};

const accountingSurfaces: Surface[] = ROLES.flatMap((g) =>
  g.chapters.flatMap((c) =>
    c.surfaces.filter((s) => s.path.startsWith("Accounting ›")),
  ),
);

describe("the handbook and the Accounting tab bar agree", () => {
  it("found the Accounting surfaces to check", () => {
    // A zero-length scan would make every assertion below pass vacuously.
    expect(accountingSurfaces.length).toBeGreaterThan(4);
    expect(ACCOUNTING_PRIMARY_LABELS.length).toBeGreaterThan(4);
  });

  it("draws the live bar, not a copy of it", () => {
    for (const s of accountingSurfaces) {
      if (!s.strip) continue;
      expect(
        [...s.strip.boxes],
        `${s.name} draws a tab bar that is not the Accounting bar`,
      ).toEqual([...ACCOUNTING_PRIMARY_LABELS]);
    }
  });

  it("highlights a tab that exists", () => {
    for (const s of accountingSurfaces) {
      if (!s.strip) continue;
      // -1 is what `accountingTabIndex` returns for a label that is no longer
      // on the bar — a renamed or removed tab, silently highlighting nothing.
      expect(
        s.strip.at,
        `${s.name} highlights position ${s.strip.at}, which is off the bar`,
      ).toBeGreaterThanOrEqual(0);
      expect(s.strip.at).toBeLessThan(ACCOUNTING_PRIMARY_LABELS.length);
    }
  });

  it("highlights the tab the surface is actually about", () => {
    for (const s of accountingSurfaces) {
      if (!s.strip) continue;
      expect(
        ACCOUNTING_PRIMARY_LABELS[s.strip.at],
        `${s.name} highlights "${ACCOUNTING_PRIMARY_LABELS[s.strip.at]}"`,
      ).toBe(s.name);
    }
  });

  it("documents every tab on the bar", () => {
    // The gap that started this: Payroll shipped on the bar and no chapter
    // mentioned it. A tab a person can see and the handbook cannot explain is
    // the handbook being wrong by omission.
    const documented = new Set(accountingSurfaces.map((s) => s.name));
    const missing = ACCOUNTING_PRIMARY_LABELS.filter((l) => !documented.has(l));
    expect(
      missing,
      "these Accounting tabs are on the bar and in no chapter",
    ).toEqual([]);
  });

  it("points every Accounting surface at a view the page serves", () => {
    const keys = new Set<string>(ACCOUNTING_VIEWS.map((v) => v.key));
    for (const s of ROLES.flatMap((g) =>
      g.chapters.flatMap((c) => c.surfaces),
    )) {
      const m = /\/commercial\/accounting\?view=([a-z-]+)/.exec(s.href);
      if (!m) continue;
      expect(keys.has(m[1]), `${s.name} links to ?view=${m[1]}, which is not a tab`).toBe(
        true,
      );
    }
  });
});
