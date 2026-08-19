import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * clearSalesforceCache() costs four Supabase round-trips — three snapshot
 * deletes plus a generation bump. It used to run after EVERY successful record
 * write, so a customer submitting a 12-room house (12 line items + the work
 * order) paid ~52 sequential round-trips doing the identical thing, all on
 * their submit latency.
 *
 * The correctness half matters more than the speed half: dropping the shared
 * snapshot repeatedly MID-batch gives a concurrent reader a window to
 * repopulate it from half-written state and cache that.
 *
 * Asserted on the source because the alternative is mocking Supabase, jsforce
 * and the audit logger to observe a call count — a test that would break on
 * every unrelated refactor while proving less.
 */
const src = readFileSync(join(process.cwd(), "lib/salesforce/writeback.ts"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("batch writes invalidate the cache once", () => {
  it("defers the per-record invalidation inside a batch", () => {
    // The single-write path still invalidates — it has no batch to defer to.
    expect(code).toContain("if (!ctx.deferCacheInvalidation) await clearSalesforceCache();");
    expect(code).toMatch(/writeSf\(a,\s*\{\s*\.\.\.ctx,\s*deferCacheInvalidation:\s*true\s*\}\)/);
  });

  it("still invalidates once after the batch, including a partial one", () => {
    const batch = code.slice(code.indexOf("export async function writeSfBatch"));
    // `wroteAnything` (not "all succeeded"): records that DID land are stale in
    // the cache no matter what failed after them.
    expect(batch).toContain("if (r.ok) wroteAnything = true;");
    expect(batch).toMatch(/if \(wroteAnything\) \{[\s\S]*clearSalesforceCache\(\)/);
  });

  it("does not let a cache failure masquerade as a write failure", () => {
    const batch = code.slice(code.indexOf("export async function writeSfBatch"));
    const invalidation = batch.slice(batch.indexOf("if (wroteAnything)"));
    // The write already succeeded in Salesforce. Throwing here would report a
    // lie the caller acts on — e.g. telling a customer their colors didn't save.
    expect(invalidation).toMatch(/try \{[\s\S]*clearSalesforceCache\(\)[\s\S]*\} catch/);
  });
});
