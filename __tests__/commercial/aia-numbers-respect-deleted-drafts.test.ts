import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * Stephanie 2026-09-24: *"It looks like the system automatically numbers the
 * AIA, even after a draft is deleted. I need to be able to change the
 * application numbers."*
 *
 * The editable number shipped that morning. It then turned out the clash check
 * could not see the thing it was checking against.
 *
 * `commercial_aia_applications` has `UNIQUE (opportunity_id,
 * application_number)` — migration 081, line 48 — with **no** `deleted_at`
 * filter. A soft-deleted draft therefore keeps its number for ever. Three
 * places read that number and two of them filtered the deleted rows out:
 *
 *   · the renumber clash check found no clash, let the UPDATE through, and the
 *     raw `duplicate key value violates unique constraint …` reached the user —
 *     the exact error the check exists to prevent;
 *   · the create-side max+1 could propose a number a deleted draft held, so the
 *     insert failed, silently retried, and produced a different number from the
 *     one the form had shown.
 *
 * AIREF Building #1 was in exactly that state while she was working in it: a
 * deleted Application 1 still holding the number, live 2, 3 and 5.
 *
 * These are source assertions on the SEAM between a query filter and a database
 * constraint — the unit suite has no database, and this class of bug is
 * invisible to it. Comments are stripped first: tests in this repo have matched
 * their own prose five times.
 */

const DB = stripComments(readFileSync("lib/commercial/aia/db.ts", "utf8"));

/** The body of one exported function, up to the next top-level export. */
function fn(name: string): string {
  const start = DB.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = DB.indexOf("\nexport ", start + 1);
  return DB.slice(start, next === -1 ? undefined : next);
}

describe("application numbers respect deleted drafts", () => {
  it("the renumber clash check does not filter out deleted rows", () => {
    const body = fn("updateAiaApplication");
    const check = body.slice(body.indexOf("application_number", body.indexOf("wanted")));
    const clause = check.slice(0, check.indexOf("if (clash)"));
    // The whole bug in one assertion: the constraint counts deleted rows, so
    // the query that stands in for it must not exclude them.
    expect(clause).toContain('.eq("application_number", wanted)');
    expect(clause).not.toContain('.is("deleted_at", null)');
  });

  it("tells the user the number is held by a deleted draft, not just 'taken'", () => {
    // "Already exists" sends someone looking for an application they cannot
    // see anywhere on the screen.
    expect(fn("updateAiaApplication")).toContain("deleted");
  });

  it("the create-side max does not filter out deleted rows either", () => {
    const body = fn("createAiaApplication");
    const query = body.slice(body.indexOf('.select("application_number")'));
    const upToLimit = query.slice(0, query.indexOf(".limit(1)"));
    expect(upToLimit).not.toContain('.is("deleted_at", null)');
  });

  it("the suggested next number is computed the same way", () => {
    const body = fn("nextAiaApplicationNumber");
    const query = body.slice(body.indexOf('.select("application_number")'));
    expect(query.slice(0, query.indexOf(".limit(1)"))).not.toContain('.is("deleted_at", null)');
  });

  it("the form asks for that number rather than counting live rows", () => {
    const tool = stripComments(
      readFileSync("app/commercial/accounts/[id]/aia/[dealId]/aia-tool.tsx", "utf8"),
    );
    expect(tool).toContain("nextAiaApplicationNumber(dealId)");
    // The old computation, which could only see live applications.
    expect(tool).not.toContain("(latestApp?.application_number ?? 0) + 1");
  });
});
