import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Deleting a record must also retire the bells that point at it.
 *
 * The cascades were thorough about data — invoices, purchases, Field Ops jobs —
 * and silent about notifications. So the bell kept unread items whose only
 * action was to open something that no longer exists: 77 of 191 Commercial
 * notifications led nowhere, 29 unread and counting toward the badge.
 *
 * An unread count is a promise that there is something to do. A queue where two
 * in five items are dead ends is one people stop opening, which is the only
 * thing a notification system cannot survive.
 *
 * Asserted against the source because this is a seam: the delete lives in one
 * file, the bells in another, and nothing in the type system connects them.
 * Deleting the call compiles perfectly and reintroduces the bug in silence.
 */
const CASCADES: Array<[string, string]> = [
  ["lib/commercial/opportunities/mutations.ts", "softDeleteCommercialOpportunity"],
  ["lib/commercial/accounts/mutations.ts", "softDeleteCommercialAccount"],
];

describe("soft-delete retires the notifications too", () => {
  for (const [file, fn] of CASCADES) {
    const src = readFileSync(file, "utf8");

    it(`${fn} still cascades`, () => {
      // Guards the assertion below: if the function is renamed or gone, the
      // "calls retire" check would pass on an empty file.
      expect(src).toContain(fn);
    });

    it(`${fn} retires the bells`, () => {
      // The CALL, not the mention. The first version of this asserted
      // `src.includes("retireNotificationsFor")`, which the import line satisfies
      // on its own — so deleting the actual invocation left the test green. A
      // check that cannot fail is worse than no check.
      expect(
        /await\s+retireNotificationsFor\s*\(/.test(src),
        `${file} soft-deletes a record but never CALLS retireNotificationsFor, so the bell keeps unread items pointing at something that no longer exists.`
      ).toBe(true);
    });
  }

  it("the helper only ever marks read — it never deletes history", () => {
    const src = readFileSync("lib/notifications/retire.ts", "utf8");
    expect(src).toContain("read_at");
    // A notification is a true record of something that happened; only its
    // actionability expires.
    expect(src).not.toMatch(/\.delete\(\)/);
  });

  it("it leaves already-read bells alone", () => {
    // Without the null filter it would re-stamp read_at on old rows, churning
    // timestamps and reordering anyone's history.
    const src = readFileSync("lib/notifications/retire.ts", "utf8");
    expect(src).toContain('.is("read_at", null)');
  });
});
