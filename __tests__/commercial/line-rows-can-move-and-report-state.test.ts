import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const EDITOR = readFileSync(
  "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx",
  "utf8"
);
const BUTTON = readFileSync("components/commercial/row-save-button.tsx", "utf8");

/**
 * Two of Stephanie's line-item complaints, which turned out to be the same
 * kind of problem: a control that was there but could not be operated.
 */

describe('"Is there a way to convert an alternate into part of the scope?"', () => {
  it("the row's alternate flag is a control, not a hidden field", () => {
    // It was `<input type="hidden" name="is_alternate">` — read by the update
    // action, writable by nothing. Moving a line between Inclusions and
    // Alternates meant Remove and re-add, losing quantity, price, phase and the
    // product link with it.
    expect(EDITOR).toContain('type="checkbox"\n                name="is_alternate"');
  });

  it("rides the row's existing Save rather than a second action", () => {
    // One save, one optimistic-lock check. A separate move action would be a
    // second write path to keep in step with this one.
    expect(EDITOR).toContain('is_alternate: formData.get("is_alternate") === "on"');
  });

  it("is not offered on labour rows", () => {
    // The add form already refuses labour-as-an-alternate (`is_labor &&
    // !is_alternate`); the edit row must not quietly allow what create forbids.
    expect(EDITOR).toContain("{r.is_labor ? (");
  });
});

describe(`"'save row' implied I can click and save and I can't"`, () => {
  it("says Saved until something in the row actually changes", () => {
    expect(BUTTON).toContain('dirty ? "Save row" : "Saved"');
  });

  it("is disabled when there is nothing to save", () => {
    // Which is the honest answer to her complaint: pressing it did nothing
    // because there was nothing to do.
    expect(BUTTON).toContain("disabled={pending || !dirty}");
  });

  it("watches the FORM, not React state", () => {
    // Every field in the row is uncontrolled, and sibling widgets (the product
    // chip) write hidden inputs directly. Only listening on the form catches
    // edits this component knows nothing about.
    expect(BUTTON).toContain('form.addEventListener("input", mark)');
    expect(BUTTON).toContain('form.addEventListener("change", mark)');
  });

  it("goes clean again once a save completes", () => {
    expect(BUTTON).toContain("if (wasPending.current && !pending) setDirty(false)");
  });
});
