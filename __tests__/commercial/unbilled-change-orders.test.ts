import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * "Approved, never invoiced" has to mean the platform's own definition of
 * invoiced.
 *
 * Deleting or VOIDING the invoice is how you un-bill a change order here —
 * `change-orders/db.ts` tells the operator to do exactly that, in those words,
 * on three separate guards. `liveInvoiceIds` is the rule: an invoice counts
 * only while it is neither soft-deleted nor void.
 *
 * `change-orders-vendors.ts` had a fourth, hand-written copy that asked only
 * `status === "draft"`. So a change order un-billed the supported way looked
 * billed forever and dropped out of the one report that exists to find it.
 * Measured 2026-10-16: 14 change orders / $61,967.79 reported against 17 /
 * $110,375.79 actual — $48,408 invisible, a 78% understatement, feeding the
 * amber banner, Accounting, the CSV export, the report cards and Alex's daily
 * digest.
 *
 * Four copies of one sentence is why this is a test and not just a fix.
 */

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

describe("the unbilled-change-order report uses the shared rule", () => {
  const SRC = "lib/commercial/reports/change-orders-vendors.ts";
  const src = read(SRC);

  it("is still the report it claims to be", () => {
    expect(src.length, `${SRC} is empty`).toBeGreaterThan(1000);
    expect(src).toContain("unbilledCents");
  });

  it("imports liveInvoiceIds rather than re-deciding", () => {
    expect(src).toMatch(
      /import \{[^}]*liveInvoiceIds[^}]*\} from "@\/lib\/commercial\/change-orders\/db"/
    );
    expect(src).toContain("liveInvoices.has(");
  });

  it("keeps no local notion of which invoices disqualify", () => {
    // The shape that drifted. A set built here from a status string is a
    // second rule by definition, however it is spelled.
    expect(src, "a local draft set is back").not.toContain("draftInvoiceIds");
    expect(
      src,
      "this file is deciding invoice liveness from status again — use liveInvoiceIds"
    ).not.toMatch(/status === "(draft|void)"/);
  });
});

describe("liveInvoiceIds is the one place that definition lives", () => {
  const src = read("lib/commercial/change-orders/db.ts");

  it("disqualifies BOTH a deleted and a void invoice", () => {
    const at = src.indexOf("export async function liveInvoiceIds");
    expect(at, "liveInvoiceIds is gone — the shared rule has moved").toBeGreaterThan(-1);
    const rest = src.slice(at + 1);
    const next = rest.search(/^(?:export\s+)?(?:async\s+)?(?:function|const|type|interface)\s/m);
    expect(next, "nothing follows liveInvoiceIds — the slice would run to EOF").toBeGreaterThan(-1);
    const body = src.slice(at, at + 1 + next);

    // Both halves, named. Dropping either is the bug this file exists to stop:
    // without `deleted_at` a removed invoice still counts as billed; without
    // `void` a voided one does.
    expect(body, "liveInvoiceIds no longer checks deleted_at").toContain("deleted_at");
    expect(body, "liveInvoiceIds no longer excludes void").toContain("void");
    expect(body).toContain("new Set");
  });
});
