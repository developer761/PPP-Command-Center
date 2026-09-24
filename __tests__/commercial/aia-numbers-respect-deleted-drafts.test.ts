import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * Stephanie 2026-09-24, twice in one morning.
 *
 * First: *"It looks like the system automatically numbers the AIA, even after
 * a draft is deleted. I need to be able to change the application numbers."*
 * The editable number shipped — and the clash check could not see the thing it
 * was checking against, because `UNIQUE (opportunity_id, application_number)`
 * (migration 081, line 48) has no `deleted_at` filter while the check did. So
 * it found no clash, let the UPDATE through, and the raw `duplicate key value
 * violates unique constraint …` reached the user.
 *
 * Then, an hour later: *"I deleted the AIA draft #1. Now trying to redraft AIA
 * #1 and it is telling me I can't use #1 because it is reserved to a deleted
 * AIA."*
 *
 * Making the refusal honest was not the fix. Deleting a draft and starting it
 * again is the ordinary way to correct a mistake before anything is sent, and
 * the number should simply be free. Migration 20260924160000 replaces the
 * constraint with a PARTIAL unique index (`where deleted_at is null`), so a
 * deleted application releases its number — and every query that stands in for
 * that index filters the same way.
 *
 * These are source assertions on the SEAM between a query filter and a database
 * constraint: the two must agree, and the unit suite has no database to catch
 * them drifting. Comments are stripped first — tests in this repo have matched
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
  it("the index only constrains LIVE applications", () => {
    const sql = readFileSync(
      "supabase/migrations/20260924160000_aia_number_released_on_delete.sql",
      "utf8",
    );
    expect(sql).toContain("drop constraint if exists");
    expect(sql.toLowerCase()).toContain("where deleted_at is null");
  });

  it("the renumber clash check filters the same way the index does", () => {
    const body = fn("updateAiaApplication");
    const check = body.slice(body.indexOf("application_number", body.indexOf("wanted")));
    const clause = check.slice(0, check.indexOf("if (clash)"));
    expect(clause).toContain('.eq("application_number", wanted)');
    // A deleted draft reserves nothing, so it must not be counted as a clash —
    // that is the refusal Stephanie hit on a number she had just freed.
    expect(clause).toContain('.is("deleted_at", null)');
  });

  it("the create-side max counts live applications only", () => {
    const body = fn("createAiaApplication");
    const query = body.slice(body.indexOf('.select("application_number")'));
    expect(query.slice(0, query.indexOf(".limit(1)"))).toContain('.is("deleted_at", null)');
  });

  it("the suggested next number re-offers a freed number", () => {
    // Delete No. 1 and the form should propose No. 1 again, not No. 2.
    const body = fn("nextAiaApplicationNumber");
    const query = body.slice(body.indexOf('.select("application_number")'));
    expect(query.slice(0, query.indexOf(".limit(1)"))).toContain('.is("deleted_at", null)');
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
