import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROPOSAL_ACTION_KINDS,
  PROPOSAL_ACTION_KINDS_ON_DELETE,
} from "@/lib/notifications/resolve-action-items";

/**
 * Deleting a deal must not leave a to-do pointing at it.
 *
 * The Action Needed bar reads UNREAD notifications of a few actionable kinds
 * and never re-checks whether the subject still exists. Two mechanisms keep it
 * honest, and between them was a gap:
 *
 *   retireNotificationsFor   anchors on the FINAL path segment, so it clears
 *                            links that END with the deal id. A proposal
 *                            deep-link ends with the PROPOSAL id, so it is not
 *                            caught here — deliberately, because without that
 *                            anchoring, deleting an ACCOUNT marked read every
 *                            live approval request underneath it.
 *   resolveActionItems       clears proposal to-dos by link, for a named list
 *                            of kinds.
 *
 * That list was `PROPOSAL_ACTION_KINDS`, which excludes `commercial_proposal_signed`
 * ON PURPOSE: it is the "superseded by SENDING" list, and sending a proposal
 * does not discharge a countersignature duty.
 *
 * Deleting the deal is a different question with a different answer — there is
 * nothing left to countersign — and reusing one list for both left
 * "A GC signed, waiting on our signature" on the bar, pointing at a proposal
 * on a deal that no longer exists. Exactly the bug the module exists to stop.
 *
 * Latent today: no `commercial_proposal_signed` row exists because nobody has
 * e-signed yet. The kind IS emitted, so it stops being latent on the first
 * signature.
 */

const ROOT = process.cwd();
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the two proposal kind lists", () => {
  it("the SEND list leaves a countersignature to-do standing", () => {
    // Sending does not discharge it. This is the behaviour that must not
    // regress while fixing the delete path.
    expect(PROPOSAL_ACTION_KINDS).not.toContain("commercial_proposal_signed");
  });

  it("the DELETE list clears it", () => {
    expect(PROPOSAL_ACTION_KINDS_ON_DELETE).toContain("commercial_proposal_signed");
  });

  it("the delete list is a superset of the send list", () => {
    for (const k of PROPOSAL_ACTION_KINDS) {
      expect(PROPOSAL_ACTION_KINDS_ON_DELETE).toContain(k);
    }
  });

  it("covers every proposal kind the Action Needed bar treats as actionable", () => {
    // The bar is the thing being protected, so it is the thing to measure
    // against — not a hand-kept copy of its list.
    const bar = strip(
      readFileSync(join(ROOT, "components/commercial/action-required-bar.tsx"), "utf8"),
    );
    const block = /ACTIONABLE_KINDS = new Set\(\[([\s\S]*?)\]\)/.exec(bar)?.[1] ?? "";
    const actionableProposalKinds = [...block.matchAll(/"(commercial_proposal_[a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(
      actionableProposalKinds.length,
      "could not read ACTIONABLE_KINDS — update this test",
    ).toBeGreaterThan(0);
    for (const k of actionableProposalKinds) {
      expect(
        PROPOSAL_ACTION_KINDS_ON_DELETE as readonly string[],
        `deleting a deal would leave a "${k}" to-do on the bar`,
      ).toContain(k);
    }
  });
});

describe("the delete cascade", () => {
  const src = strip(
    readFileSync(join(ROOT, "lib/commercial/opportunities/mutations.ts"), "utf8"),
  );

  it("uses the delete list, not the send list", () => {
    expect(src).toContain("PROPOSAL_ACTION_KINDS_ON_DELETE");
    expect(
      /kinds:\s*PROPOSAL_ACTION_KINDS\s*,/.test(src),
      "the send-path list leaves a signed proposal's to-do behind",
    ).toBe(false);
  });
});
