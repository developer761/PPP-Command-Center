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

describe('"click off the items that were approved and not approved"', () => {
  const DB = readFileSync("lib/commercial/proposals/db.ts", "utf8");
  const MIG = readFileSync("supabase/migrations/167_proposal_line_customer_approved.sql", "utf8");

  it("has three states, because 'nobody has said' is not 'declined'", () => {
    // A boolean NOT NULL DEFAULT false would record every line of every
    // proposal ever written as "the customer declined it".
    expect(MIG).toContain("ADD COLUMN IF NOT EXISTS customer_approved boolean");
    expect(MIG).not.toMatch(/customer_approved boolean\s+NOT NULL/i);
    expect(DB).toContain("customer_approved: boolean | null");
  });

  it("is written by a path that is exempt from the draft-only guard", () => {
    // Every other line-item writer calls assertProposalDraft, correctly — the
    // sent document must not change. This field is not part of that document,
    // and can only be answered once it has gone out, so guarding it the same
    // way would make it unreachable exactly when it means something.
    const fn = DB.slice(DB.indexOf("export async function setLineCustomerApproved"));
    const body = fn.slice(0, fn.indexOf("\nexport async function", 10));
    expect(body).not.toContain("assertProposalDraft");
    // …and the exemption is why it may touch nothing else.
    expect(body).toContain("update({ customer_approved: approved })");
  });

  it("only appears once the proposal has actually gone out", () => {
    // Nobody can have answered before it was sent.
    expect(EDITOR).toContain("hasBeenSent\n                  ? { accountId, dealId, proposalId, action: setLineApprovedAction }");
  });

  it("verifies the line belongs to this proposal before flipping it", () => {
    const fn = EDITOR.slice(EDITOR.indexOf("async function setLineApprovedAction"));
    expect(fn.slice(0, 2000)).toContain("if (!lines.some((l) => l.id === lineId))");
  });
});
