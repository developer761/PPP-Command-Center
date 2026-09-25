import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * Brendan 2026-09-23: "For the approver make it so they can edit it and make
 * changes even if it's sent out for approval. Make sure no edge cases or bugs
 * or issues that come with this." And: "Only approvers unlock to edit."
 *
 * The lock exists so a proposal cannot move under somebody relying on it. The
 * approver is the person it was sent TO — they are not surprised by their own
 * edit, and the alternative is rejecting it, waiting for one number to change,
 * and reviewing the whole thing again.
 *
 * The edges that matter, and are asserted below:
 *
 *  · the ESTIMATOR is still locked out at pending_approval. That is the point
 *    of sending it.
 *  · everything AFTER approval stays locked. Once approved or with the GC the
 *    document is a promise; that is what revisions are for.
 *  · the UI mirrors the rule but does not implement it — the server decides,
 *    so a disagreement is a visible error and never a silent write.
 */
const DB = stripComments(readFileSync("lib/commercial/proposals/db.ts", "utf8"));
const PAGE = stripComments(
  readFileSync("app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8")
);

describe("an approver can edit a proposal that is out for approval", () => {
  const fn = DB.slice(DB.indexOf("async function assertProposalEditable"));
  const body = fn.slice(0, fn.indexOf("\nasync function", 10));

  it("allows a draft to anyone, as before", () => {
    expect(body).toContain('if (row.status === "draft") return { ok: true };');
  });

  it("allows pending_approval ONLY to an approver", () => {
    expect(body).toContain('row.status === "pending_approval"');
    expect(body).toContain("isProposalApprover(actorUserId)");
  });

  it("refuses everything else — approved and sent are promises", () => {
    // The fall-through must stay a refusal. If this ever returns ok, a sent
    // proposal could be edited under the customer.
    expect(body).toContain("Only draft proposals can be edited");
  });

  it("is reached by every line-item writer, not just one", () => {
    // create, update and delete all go through it. A writer that skips the
    // gate is an unlocked door nobody can see.
    const calls = DB.split("assertProposalEditable(").length - 1;
    expect(calls, "a line-item writer is bypassing the editable gate").toBeGreaterThanOrEqual(4);
  });
});

describe("only an approver unlocks an approved proposal", () => {
  const fn = DB.slice(DB.indexOf("export async function unlockApprovedProposal"));
  const body = fn.slice(0, fn.indexOf("\nexport async function", 10));

  it("checks the flag server-side", () => {
    expect(body).toContain("isProposalApprover(input.actor_user_id)");
  });

  it("still clears the approval, so it cannot be sent without a fresh one", () => {
    expect(body).toContain("approved_by_user_id: null");
  });
});

describe("the editor mirrors the rule rather than inventing one", () => {
  it("shows the controls to an approver at pending_approval", () => {
    expect(PAGE).toContain('proposal.status === "pending_approval" && viewerIsApprover');
  });

  it("hides Unlock from everyone else", () => {
    // Hidden rather than shown-and-refused: a button that exists only to tell
    // you off is the dead click this platform keeps being told about.
    expect(PAGE).toContain("{viewerIsApprover && (");
  });
});
