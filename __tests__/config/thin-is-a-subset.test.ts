/**
 * THE DERIVED THIN SNAPSHOT MUST MATCH A BUILT ONE.
 *
 * The warm cron used to pull Salesforce twice — once for the full snapshot
 * and again for the thin one — when thin is just the full snapshot with
 * eight arrays emptied. Measured 2026-10-15:
 *
 *   [SF] snapshot COLD-COMPLETE in 22054ms
 *   [SF] snapshot(thin) COLD-COMPLETE in 15865ms
 *
 * `deriveThinFromFull` removes that second pull. Which creates exactly one
 * way to be wrong: someone adds a NINTH query that `thin` skips, the
 * derivation does not know about it, and the "thin" snapshot the cron
 * writes silently still carries data a real thin build would have dropped.
 * Nothing would fail — the extra data is harmless to read, so the bug is
 * invisible until it is a memory or payload problem.
 *
 * So this reads both sides out of the source and compares them. It is a
 * source assertion on purpose: the thing being checked IS the agreement
 * between two pieces of code, and there is no artifact that shows it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveThinFromFull } from "@/lib/salesforce/queries";
import type { SalesforceSnapshot } from "@/lib/salesforce/queries";
import { stripComments } from "../helpers/strip-comments";

const src = stripComments(readFileSync(
  join(__dirname, "..", "..", "lib/salesforce/queries.ts"),
  "utf8"
));

/**
 * Snapshot fields the BUILDER drops when thin, read from the
 * `const xPromise: ... = thin ? <empty> : …` lines.
 */
function thinSkippedFields(): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/const (\w+)Promise\s*:[^=]+=\s*thin\s*\?/g)) {
    // oppsPromise → opportunities; everything else is the plain name.
    out.add(m[1] === "opps" ? "opportunities" : m[1]);
  }
  return [...out].sort();
}

/** Fields the DERIVATION overrides. */
function derivationOverrides(): string[] {
  const fn = src.slice(src.indexOf("export function deriveThinFromFull"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  return [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]).sort();
}

describe("deriveThinFromFull covers everything the builder skips", () => {
  it("found both lists — neither parser is silently returning nothing", () => {
    expect(thinSkippedFields().length, "no `thin ?` queries found").toBeGreaterThanOrEqual(8);
    expect(derivationOverrides().length, "derivation parsed as empty").toBeGreaterThanOrEqual(8);
  });

  it("empties exactly the fields a real thin build leaves empty", () => {
    expect(derivationOverrides()).toEqual(thinSkippedFields());
  });

  it("keeps everything else byte-identical to the full snapshot", () => {
    // The point of deriving rather than re-querying: the rows the materials
    // bundle needs must survive untouched.
    const full = {
      reps: [{ id: "r1" }],
      workOrders: [{ id: "w1" }],
      accounts: [{ id: "a1" }],
      woLineItems: [{ id: "li1" }],
      paintColors: [{ id: "c1" }],
      opportunities: [{ id: "o1" }],
      transactions: [{ id: "t1" }],
      quotes: [{ id: "q1" }],
      quotas: [{ id: "qa1" }],
      subQuotas: [{ id: "sq1" }],
      reviews: [{ id: "rv1" }],
      cases: [{ id: "cs1" }],
      leadStats: { total: 9, converted: 4 },
      fetchedAt: "2026-10-15T00:00:00.000Z",
      revenueFieldUsed: "X__c",
      workOrderRevenueField: "Y__c",
      isSandbox: false,
      instanceUrl: "https://example.my.salesforce.com",
    } as unknown as SalesforceSnapshot;

    const thin = deriveThinFromFull(full);

    // Carried through.
    expect(thin.reps).toBe(full.reps);
    expect(thin.workOrders).toBe(full.workOrders);
    expect(thin.accounts).toBe(full.accounts);
    expect(thin.woLineItems).toBe(full.woLineItems);
    expect(thin.paintColors).toBe(full.paintColors);
    expect(thin.fetchedAt).toBe(full.fetchedAt);
    expect(thin.isSandbox).toBe(full.isSandbox);
    expect(thin.revenueFieldUsed).toBe(full.revenueFieldUsed);

    // Dropped.
    expect(thin.opportunities).toEqual([]);
    expect(thin.transactions).toEqual([]);
    expect(thin.quotes).toEqual([]);
    expect(thin.leadStats).toEqual({ total: 0, converted: 0 });
  });

  it("does not mutate the full snapshot it was given", () => {
    // The cron keeps using `full` after deriving thin from it.
    const full = {
      opportunities: [{ id: "o1" }],
      transactions: [{ id: "t1" }],
      leadStats: { total: 3, converted: 1 },
    } as unknown as SalesforceSnapshot;
    deriveThinFromFull(full);
    expect(full.opportunities).toHaveLength(1);
    expect(full.transactions).toHaveLength(1);
    expect(full.leadStats).toEqual({ total: 3, converted: 1 });
  });
});

describe("the warm cron pulls Salesforce once", () => {
  it("uses the single-pull path", () => {
    const cron = stripComments(readFileSync(
      join(__dirname, "..", "..", "app/api/cron/warm-snapshot/route.ts"),
      "utf8"
    ));
    expect(cron).toContain("warmAllSnapshots");
    // The two extra forced SF pulls are gone.
    expect(cron).not.toMatch(/thin: true, forceRebuild: true/);
    expect(cron).not.toMatch(/materials: true, forceRebuild: true/);
  });
});

describe("the warm actually finishes writing before it reports success", () => {
  /**
   * Measured 2026-10-15, with per-step timing added for the purpose:
   *
   *   shared-cache write "snapshot-v6": 6.1MB gz → 8.1MB b64 ·
   *     serialize 1636ms · encode 4ms · upload 52560ms
   *
   * The base64 everyone suspects costs four milliseconds. It is the upload.
   *
   * And the write was fire-and-forget: warmAllSnapshots logged "complete" at
   * 22:20:47 while that write did not land until 22:21:23 — 36 seconds after
   * the function said it was done. A serverless function that has returned
   * can be killed, so the cron could report success and leave the cache
   * empty, which is the "COLD START — no shared cache" seen hours after a
   * good warm.
   *
   * A user request still must not wait on it. Only the cron awaits.
   */
  const queries = stripComments(readFileSync(
    join(__dirname, "..", "..", "lib/salesforce/queries.ts"),
    "utf8"
  ));

  it("awaits the shared write when asked to", () => {
    expect(queries).toMatch(/if \(opts\?\.awaitSharedWrite\) \{\s*\n\s*await writeSharedSnapshot\(cacheKey, snapshot\);/);
  });

  it("still does NOT make a normal request wait", () => {
    // The else branch has to stay fire-and-forget.
    expect(queries).toMatch(/\} else \{\s*\n\s*void writeSharedSnapshot\(cacheKey, snapshot\);/);
  });

  it("the cron opts in", () => {
    expect(queries).toMatch(/loadSalesforceSnapshot\(\{ forceRebuild: true, awaitSharedWrite: true \}\)/);
  });

  it("the cron has time for the writes it now waits on", () => {
    // ~22s fetch + ~68s of uploads. 60s would kill it mid-write, which is
    // the exact failure this change exists to prevent.
    const cron = stripComments(readFileSync(
      join(__dirname, "..", "..", "app/api/cron/warm-snapshot/route.ts"),
      "utf8"
    ));
    const m = /export const maxDuration = (\d+)/.exec(cron);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(180);
  });

  it("logs each step, so the next regression is measurable not guessable", () => {
    expect(queries).toMatch(/serialize \$\{msSerialize\}ms · encode \$\{msEncode\}ms · upload \$\{msUpload\}ms/);
  });
});
