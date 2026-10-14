/**
 * THE PREVIEW HAS TO SHOW WHAT THE CUSTOMER SEES.
 *
 * Settings → Test Color Form exists so a PPP person can open a customer's
 * form without emailing anyone or writing to Salesforce. It is the only way
 * to look at that form at all: every real token in the table is expired or
 * submitted, and minting one means mailing a homeowner.
 *
 * It was showing them a different form. `isStaffEntry = isPreview ||
 * isInternal` put a preview on the staff path, so the preview had:
 *
 *   - no "Confirm my selections" step (Kate's explicit ask),
 *   - surface pickers still on a multi-room line (Kate's explicit ask),
 *   - finishes autofilled, which no customer gets (Kate, 2026-10-01),
 *   - no liability notice and no edit-deadline notice.
 *
 * Opening it on 2026-10-14 and pressing Submit went straight to "Got it —
 * thanks!". The affirmation never appeared, in the one place built to check
 * that it does. A test tool that shows a different screen than the thing it
 * tests is worse than no test tool: it produces confident wrong answers.
 *
 * Preview now means see exactly what the customer sees, save nothing. Saving
 * is refused twice over, which is what makes that safe — asserted below,
 * because the fix leans on it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finishSeedPolicy } from "@/lib/customer-form/finish-seed-policy";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const view = () => strip(read("components/customer-form-view.tsx"));

describe("a preview is not staff entry", () => {
  it("does not fold preview into the staff-entry flag", () => {
    // The whole bug in one expression.
    expect(view()).not.toMatch(/isStaffEntry\s*=\s*isPreview\s*\|\|\s*isInternal/);
  });

  it("treats only internal entry as staff entry", () => {
    expect(view()).toMatch(/const isStaffEntry = isInternal;/);
  });
});

describe("the customer's own steps are on the preview path", () => {
  const src = () => view();

  it("the confirmation step is reached by anyone who is not doing data entry", () => {
    // The gate Kate's affirmation hangs off. With preview on the staff side
    // this could never fire for the person checking it.
    expect(src()).toMatch(/if \(!isStaffEntry && !confirming\)/);
  });

  it("multi-room surface pickers hide for everyone but data entry", () => {
    expect(src()).toMatch(/const hideSurfaces = isMultiRoom && !isStaffEntry/);
  });

  it("finish autofill is off for a customer and on for data entry", () => {
    // The policy itself, not the wiring — the wiring is asserted above.
    expect(finishSeedPolicy({ isStaffEntry: true, hasOwnSubmission: false }).onColorPick).toBe(true);
    expect(finishSeedPolicy({ isStaffEntry: false, hasOwnSubmission: false }).onColorPick).toBe(false);
    expect(finishSeedPolicy({ isStaffEntry: false, hasOwnSubmission: false }).fromSalesforce).toBe(false);
  });
});

describe("and it still cannot save — which is what makes the above safe", () => {
  it("the browser does not autosave a preview", () => {
    const s = view();
    expect(s).toMatch(/if \(isPreview\) return;/);
    expect(s).toMatch(/if \(isPreview \|\| submitted\) return;/);
  });

  it("the server refuses a preview submission before it writes anything", () => {
    // The real guarantee. The client could be wrong and nothing would land.
    const route = strip(read("app/api/customer-form/submit/[token]/route.ts"));
    const at = route.indexOf('status.token.kind === "preview"');
    expect(at, "no preview guard in the submit route").toBeGreaterThan(-1);
    // It must return before the write section, not merely mention preview.
    const after = route.slice(at, at + 600);
    expect(after).toMatch(/return NextResponse\.json\(/);
    expect(after).toMatch(/preview: true/);
  });

  it("the preview banner still says so on screen", () => {
    expect(view()).toMatch(/\{isPreview && \(/);
  });
});
