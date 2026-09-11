import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const strip = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * Stephanie's 2026-09-11 round.
 *
 * Three of her reports were the same bug wearing different clothes — "a value I
 * chose didn't stick." The live data carried the fingerprint in each case:
 * zero of eighteen proposals with a bid set date, and three AIA applications
 * with one period date saved and the other null, because the server writes BOTH
 * period columns on every save and the half she hadn't reached yet went in as
 * null.
 */

describe("a discrete edit saves NOW, not in 2.5 seconds", () => {
  it("the save-now event has one definition, not a literal in two files", () => {
    // Same reason AUTOSAVE_FLAG is a constant: that one went missing from two
    // surfaces for a month because it was a bare string matched by eye.
    const src = readFileSync("lib/commercial/save-now-event.ts", "utf8");
    expect(src).toMatch(/export const SAVE_NOW_EVENT/);
    for (const f of [
      "components/commercial/autosave-proposal-form.tsx",
      // Its sibling, which hosts the Work Order and Closeout tools. DateField
      // dispatches from ONE place, so a listener on only one of the two forms
      // leaves the other with the 2.5s window — the exact drift AUTOSAVE_FLAG
      // suffered, where a fix reached one surface and not the other and the
      // complaint stayed live for a month.
      "components/commercial/autosave-form.tsx",
      "components/commercial/exclusion-picker.tsx",
      "components/commercial/date-field.tsx",
    ]) {
      expect(strip(f), `${f} should import the constant`).toContain("SAVE_NOW_EVENT");
      expect(
        /["'`]commercial:save-now["'`]/.test(strip(f)),
        `${f} hardcodes the event name instead of importing it`
      ).toBe(false);
    }
  });

  it("BOTH autosave forms flush on it instead of restarting the debounce", () => {
    for (const f of [
      "components/commercial/autosave-proposal-form.tsx",
      "components/commercial/autosave-form.tsx",
    ]) {
      const src = strip(f);
      expect(src, `${f} does not listen`).toMatch(/addEventListener\(SAVE_NOW_EVENT/);
      // It must clear the pending timer and fire — scheduling again would just
      // reintroduce the delay under a new name.
      expect(src, `${f} re-schedules instead of flushing`).toMatch(
        /clearTimeout\(timerRef\.current\)[\s\S]{0,160}fireSave\(\)/
      );
    }
  });

  it("picking a date and picking an exclusion both emit it", () => {
    expect(strip("components/commercial/date-field.tsx")).toMatch(/dispatchEvent\(new Event\(SAVE_NOW_EVENT/);
    expect(strip("components/commercial/exclusion-picker.tsx")).toMatch(/dispatchEvent\(new Event\(SAVE_NOW_EVENT/);
  });
});

describe("the AIA settings panel no longer saves on blur alone", () => {
  const src = strip("components/commercial/aia-settings-form.tsx");

  it("debounces on change", () => {
    // Blur alone lost the edit: the guard skips saving while focus is still
    // inside the panel, so picking both period dates is one uninterrupted edit
    // with no save between — and pressing Generate unmounts it.
    expect(src).toMatch(/setTimeout\([\s\S]{0,160}AUTOSAVE_DEBOUNCE_MS\)/);
  });

  it("also flushes on unmount", () => {
    expect(src).toMatch(/return \(\) => \{[\s\S]{0,200}dirty\.current[\s\S]{0,60}saveRef\.current\(\)/);
  });

  it("saves the LATEST values, not the ones captured when it was scheduled", () => {
    // A timer and an unmount handler both fire outside the render that created
    // them. Reading `vals` directly would send a stale snapshot.
    expect(src).toMatch(/const v = valsRef\.current;/);
    expect(
      /fd\.set\("period_from", vals\./.test(src),
      "the save still reads `vals` directly — a debounced save would send stale values"
    ).toBe(false);
  });
});

describe("an approved change order reaches the draft certificate", () => {
  it("the decision PUSHES into drafts rather than waiting for a render", () => {
    // reconcileDraftChangeOrderRows was correct and only ran while rendering
    // the AIA tool. Approving happens on a different screen, so a draft sat
    // with an approved $250 CO missing from its schedule.
    const src = strip("lib/commercial/change-orders/db.ts");
    expect(src).toMatch(/reconcileDraftChangeOrderRows/);
    expect(src).toMatch(/status === "draft"/);
  });

  it("a failure there cannot fail the decision itself", () => {
    const src = strip("lib/commercial/change-orders/db.ts");
    const i = src.indexOf("reconcileDraftChangeOrderRows");
    expect(src.slice(Math.max(0, i - 400), i)).toMatch(/try \{/);
  });
});

describe("the proposal editor repeats its actions at the bottom", () => {
  const src = readFileSync(
    "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8"
  );

  it("has Customer PDF, Plan report and Send for approval TWICE", () => {
    // "to avoid excessive scrolling" — a long page you work down, with the
    // finishing controls back at the top.
    for (const label of ["Customer PDF", "Plan report", "Send for approval"]) {
      expect(
        src.split(label).length - 1,
        `"${label}" should appear at the top AND the bottom`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("the bottom copy is gated exactly like the top one", () => {
    // Two controls for the same action that disagree about when they apply is
    // worse than one control in the wrong place.
    expect(src.split('proposal.status === "draft" && hasPdfBody').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("the bid set date sits next to the sentence it prints in", () => {
  const src = readFileSync(
    "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8"
  );

  it("lives in the Intro section, not the Header panel", () => {
    const intro = src.indexOf('title="Intro paragraph"');
    const field = src.indexOf('name="bid_set_date"');
    const header = src.indexOf('name="gc_company"');
    expect(field).toBeGreaterThan(-1);
    expect(intro).toBeGreaterThan(-1);
    expect(
      field > intro,
      "bid_set_date is back above the Intro section — she asked three times because the control was two panels from its output"
    ).toBe(true);
    expect(field).toBeGreaterThan(header);
  });

  it("warns that a custom intro suppresses it", () => {
    // The trap that made the field look broken: a custom paragraph REPLACES
    // the default sentence, so the date silently stops printing.
    expect(src).toMatch(/custom intro below replaces the default sentence/);
  });
});
