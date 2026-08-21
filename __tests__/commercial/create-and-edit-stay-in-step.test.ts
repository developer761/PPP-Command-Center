import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A create form and its edit form must handle the same fields, the same way.
 *
 * docs/OPEN_BACKLOG_2026_08_12.md §2, titled "THE RECURRING PATTERN — worth its
 * own line": three separate times in one day, a change made to a create form
 * was not made to the edit form beside it. Once it caused DATA LOSS — every
 * save on the deal edit sheet wiped the stored proposed start/end dates.
 * Another left the account edit page reading exactly backwards: the toggle said
 * "Same as company address" while copying billing INTO the company address,
 * because it inherited the new label and kept the old behaviour.
 *
 * Both are fixed. Neither was guarded, so the class stayed open — and the
 * backlog says as much: "1.2 above is the last KNOWN instance."
 *
 * Nothing about TypeScript can see this: two files, two independent objects
 * built from FormData, each internally consistent. It only shows up as a field
 * that silently stops saving.
 */

const NEW = readFileSync("app/commercial/accounts/new/page.tsx", "utf8");
const EDIT = readFileSync("app/commercial/accounts/[id]/edit/page.tsx", "utf8");

/** The account fields a page writes, from the object it hands the mutation. */
function writtenFields(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/^\s+(billing_[a-z_]+|site_[a-z_]+|company_name|dba|rating|is_key_relationship):/gm)].map(
      (m) => m[1]
    )
  );
}

describe("account create ↔ account edit", () => {
  it("write the same set of fields", () => {
    const a = writtenFields(NEW);
    const b = writtenFields(EDIT);
    expect(a.size, "found no fields — did the mutation call change shape?").toBeGreaterThan(8);

    const onlyCreate = [...a].filter((f) => !b.has(f)).sort();
    const onlyEdit = [...b].filter((f) => !a.has(f)).sort();
    expect(
      { onlyCreate, onlyEdit },
      "A field handled by one form and not the other is the shape that wiped the " +
        "deal's proposed start/end dates on every save. Add it to both, or to neither."
    ).toEqual({ onlyCreate: [], onlyEdit: [] });
  });

  it('copy "same as company address" in the SAME direction', () => {
    // The bug was the direction, not the presence: billing must copy FROM the
    // company (site) address. The reverse overwrites the company address with
    // billing, under a label promising the opposite.
    for (const [name, src] of [["create", NEW], ["edit", EDIT]] as const) {
      const copies = [...src.matchAll(/billing_(street|city|state|zip):\s*([^,\n]+)/g)];
      expect(copies.length, `${name}: no billing copy lines found`).toBeGreaterThanOrEqual(4);
      for (const c of copies) {
        expect(
          c[2],
          `${name} page copies billing_${c[1]} from the wrong side — ` +
            `"Same as company address" must read site_${c[1]}, not the other way round.`
        ).toContain(`site_${c[1]}`);
      }
    }
  });

  it("agree on the checkbox that drives it", () => {
    // Same input name on both, or one form's toggle silently does nothing.
    expect(NEW).toContain('site_same_as_billing');
    expect(EDIT).toContain('site_same_as_billing');
  });
});
