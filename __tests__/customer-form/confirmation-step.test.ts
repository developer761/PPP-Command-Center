/**
 * Kate 2026-10-09: "For customers, when they click 'Submit my colors' we want
 * them to see a confirmation screen that shows them their selections and
 * states something like, 'By clicking Confirm my selections I affirm that
 * I've reviewed these selections and approve of the use of these for my
 * project.'"
 *
 * An affirmation is only worth anything if it describes what was actually on
 * screen when it was agreed to, and what then gets sent. Most of these guard
 * that, not the markup.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const src = () => strip(read("components/customer-form-view.tsx"));

describe("the confirmation step", () => {
  it("uses her affirmation wording", () => {
    const s = read("components/customer-form-view.tsx");
    expect(s).toMatch(/I affirm that I&rsquo;ve reviewed\s*\n?\s*these selections and approve of the use of these for my project/);
  });

  it("names the button the affirmation names", () => {
    // The sentence says "By clicking 'Confirm my selections'". If the button
    // says anything else the sentence points at nothing.
    const s = src();
    expect(s).toContain('"Confirm my selections"');
    expect(s).toMatch(/confirming\s*\n?\s*\?\s*"Confirm my selections"/);
  });

  it("intercepts the submit instead of sending", () => {
    const s = src();
    expect(s).toMatch(/if \(!isStaffEntry && !confirming\) \{[\s\S]{0,200}setConfirming\(true\)/);
    // And returns — otherwise it shows the panel AND submits.
    const at = s.indexOf("if (!isStaffEntry && !confirming)");
    expect(s.slice(at, at + 400)).toMatch(/\n\s*return;/);
  });

  it("runs AFTER validation, so the list shown is a sendable one", () => {
    // Showing somebody a summary and then refusing it for a stale catalog
    // would be worse than no summary.
    const s = src();
    const catalogGuard = s.indexOf('catalog.status !== "ready"');
    const gate = s.indexOf("if (!isStaffEntry && !confirming)");
    expect(catalogGuard).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(catalogGuard);
  });

  it("is customers only — staff never affirm on a homeowner's behalf", () => {
    expect(src()).toMatch(/!isStaffEntry && !confirming/);
  });

  /* ── The half that matters ───────────────────────────────────────── */

  it("RETRACTS on any edit", () => {
    // Agreeing to a list and then changing it before sending would submit an
    // approval of something the customer never read.
    const s = src();
    for (const handler of ["updateSurfacePick", "updateLineNotes", "applyColorToAll"]) {
      const at = s.indexOf(`const ${handler} = `);
      expect(at, `${handler} not found`).toBeGreaterThan(-1);
      expect(
        s.slice(at, at + 420),
        `${handler} does not retract the affirmation`
      ).toMatch(/setConfirming\(false\)/);
    }
  });

  it("retracts when the notes are edited too", () => {
    const s = src();
    const edits = s.match(/onChange=\{\(e\) => \{ setConfirming\(false\); setGlobalNotes/g) ?? [];
    expect(edits.length, "a notes box that does not retract").toBeGreaterThanOrEqual(2);
  });

  it("offers a way back without submitting", () => {
    const s = src();
    expect(s).toMatch(/onClick=\{\(\) => setConfirming\(false\)\}/);
    expect(s).toContain("Go back and change something");
  });

  it("shows the colors, not just the room names", () => {
    const s = src();
    const at = s.indexOf("Please check your selections");
    const panel = s.slice(at, at + 2200);
    expect(panel).toMatch(/pick!\.colorName \|\| pick!\.colorId/);
    expect(panel).toMatch(/pick!\.finish/);
    expect(panel).toMatch(/roomTitle\(li, i \+ 1\)/);
  });

  it("leaves out surfaces the customer skipped", () => {
    const s = src();
    const at = s.indexOf("Please check your selections");
    expect(s.slice(at, at + 2200)).toMatch(/!x\.pick\.skipped/);
  });
});
