import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A CAPPED READ WITH NO SORT, AND AN UNCAPPED READ WITH NO PAGING.
 *
 * paging.ts states both rules in its own comments and they were not applied
 * everywhere:
 *
 *   "`build` MUST order by something unique. PostgREST ranges without a
 *    stable sort do not return the rows the previous page missed; they return
 *    an arbitrary window, so pages overlap and skip. That exact omission is
 *    what made the PII sweep report ALL CLEAN over planted data, twice."
 *
 * Two live instances, both latent only because production is small:
 *
 *   exit-sweep        `.limit(SWEEP_LIMIT)` with no order, so WHICH 400 live
 *                     conversations got swept was whatever Postgres handed
 *                     back. 6 live conversations today against a limit of 400.
 *   faq-import-write  two unbounded selects, errors discarded. PostgREST caps
 *                     an unbounded select at 1,000 SILENTLY, and the second
 *                     read is what the importer compares against to skip a
 *                     duplicate — so every FAQ past the cap reads as absent
 *                     and gets written again. 0 FAQs today, and Kate's store
 *                     is the entire point of the feature.
 *
 * Structural, because neither DB path has a test that drives it: what was
 * wrong is the QUERY, and that is what these assert.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("a limited read says which rows it wants", () => {
  const src = () => stripComments(readFileSync("lib/messaging/exit-sweep.ts", "utf8"));

  it("orders the live-conversation read", () => {
    const s = src();
    const read = s.match(/from\("sms_conversations"\)[\s\S]{0,400}?limit\(SWEEP_LIMIT\)/);
    expect(read, "the live-conversation read moved or changed shape").toBeTruthy();
    expect(read![0], "a LIMIT with no ORDER BY returns an arbitrary window")
      .toMatch(/\.order\(/);
  });

  /**
   * And on something UNIQUE. An order on a non-unique column alone still
   * leaves ties arbitrary, which is the same bug in a smaller window.
   */
  it("breaks ties on a unique column", () => {
    const read = src().match(/from\("sms_conversations"\)[\s\S]{0,400}?limit\(SWEEP_LIMIT\)/)![0];
    expect(read).toMatch(/\.order\("id"\)/);
  });

  /**
   * NOT on a nullable column. created_at is NOT NULL; last_message_at is
   * nullable, and Postgres sorts NULLs LAST in an ascending order — so a
   * conversation with no messages yet would sort into the starved end of the
   * window while being the kind most likely to have unsent steps behind it.
   */
  it("orders on a column that cannot be null", () => {
    const read = src().match(/from\("sms_conversations"\)[\s\S]{0,400}?limit\(SWEEP_LIMIT\)/)![0];
    expect(read, "last_message_at is nullable — see the comment on this read")
      .not.toMatch(/order\("last_message_at"/);
    const schema = readFileSync("supabase/migrations/180_sms_conversations.sql", "utf8");
    // Whatever it orders on, assert the column really is NOT NULL.
    const col = read.match(/\.order\("([a-z_]+)",\s*\{\s*ascending/)?.[1];
    expect(col, "no ascending order found to check").toBeTruthy();
    expect(schema, `${col} must be NOT NULL to order on safely`)
      .toMatch(new RegExp(`${col}\\s+TIMESTAMPTZ NOT NULL`));
  });

  /** And a window has to admit it is one. */
  it("reports when the cap was reached", () => {
    const s = src();
    expect(s).toMatch(/truncated\s*=\s*liveIds\.length\s*>=\s*SWEEP_LIMIT/);
    expect(s, "truncated is computed and never returned").toMatch(/return \{[^}]*truncated/);
  });
});

describe("the FAQ import reads every row, and notices when it cannot", () => {
  const src = () => stripComments(readFileSync("lib/messaging/faq-import-write.ts", "utf8"));

  it("pages both reads instead of trusting an unbounded select", () => {
    const s = src();
    // Two reads in each of two functions: workspaces and stored FAQs.
    expect((s.match(/selectAll</g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("leaves no unbounded select on the FAQ table", () => {
    const s = src();
    /**
     * The shape that was wrong, and it reads perfectly naturally: a select
     * with no range and no limit, whose error is dropped on the floor by
     * destructuring only `data`.
     */
    expect(s, "an unbounded read of the FAQ table is back")
      .not.toMatch(/\{\s*data:\s*\w+\s*\}\s*=\s*await\s+sb\s*\.?\s*from\("sms_workspace_faqs"\)/);
    expect(s).not.toMatch(/from\("sms_workspace_faqs"\)\.select\([^)]*\)\s*,/);
  });

  it("orders every paged read on a unique column", () => {
    for (const call of src().matchAll(/selectAll<[^>]*>\(\s*\(from, to\) =>([\s\S]{0,300}?)"(?:the [^"]+)"/g)) {
      expect(call[1], `a paged read without .order("id"): ${call[1].trim().slice(0, 120)}`)
        .toMatch(/\.order\("id"\)/);
    }
  });
});
