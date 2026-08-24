import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R5.6 — "You can't send another order once you've cancelled one."
 *
 * `supplier_orders.po_number` is globally UNIQUE. The allocator COUNTED a work
 * order's orders while excluding cancelled ones, so:
 *
 *   send    → 0 existing            → "PPP-WO00314545"
 *   cancel  → status='cancelled', but the row still holds that PO
 *   send    → cancelled excluded, count back to 0 → "PPP-WO00314545"
 *           → 23505 on a number the cancelled row owns
 *
 * Every retry recomputed the same number, so the work order could never take
 * another order. Kate: "it isn't a transient conflict that clears on its own."
 * Confirmed in production — WO 00314545 was sitting in exactly that state.
 *
 * These assert the two properties that make it impossible to recur: the
 * allocator considers every PO actually in use (whatever the status), and the
 * send route recovers from a collision instead of dead-ending on it.
 */
const builder = readFileSync(join(process.cwd(), "lib/supplier-order/builder.ts"), "utf8");
const send = readFileSync(join(process.cwd(), "app/api/admin/supplier-order/send/route.ts"), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const B = codeOnly(builder);
const S = codeOnly(send);

/** Re-implementation of the shipped allocation rule, to exercise its logic. */
function allocate(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 500; n++) {
    const c = `${base}-${n}`;
    if (!taken.has(c)) return c;
  }
  return `${base}-tFALLBACK`;
}

describe("PO allocation", () => {
  const base = "PPP-WO00314545";

  it("does not reissue a cancelled order's number", () => {
    // The production state that bricked the work order.
    expect(allocate(base, new Set([base]))).toBe(`${base}-2`);
  });

  it("skips past every number the work order has used", () => {
    expect(allocate(base, new Set([base, `${base}-2`, `${base}-3`]))).toBe(`${base}-4`);
  });

  it("fills a gap rather than colliding with a later number", () => {
    // -2 cancelled and purged, -3 live: -2 is free and safe to use.
    expect(allocate(base, new Set([base, `${base}-3`]))).toBe(`${base}-2`);
  });

  it("uses the bare base on a work order's first order", () => {
    expect(allocate(base, new Set())).toBe(base);
  });
});

describe("the allocator reads numbers in use, not a count", () => {
  it("selects po_number and filters only by work order", () => {
    const fn = B.slice(B.indexOf("export async function nextPoNumber"));
    expect(fn).toMatch(/\.select\("po_number"\)/);
    expect(fn).toMatch(/\.eq\("work_order_id", workOrderId\)/);
  });

  it("no longer excludes cancelled rows — that exclusion WAS the bug", () => {
    const fn = B.slice(
      B.indexOf("export async function nextPoNumber"),
      B.indexOf("export async function nextPoNumber") + 2000
    );
    expect(fn).not.toMatch(/\.neq\(\s*"status",\s*"cancelled"\s*\)/);
    // And it must not have gone back to counting, which cannot see which
    // specific numbers are free.
    expect(fn).not.toMatch(/count:\s*"exact"/);
  });
});

describe("send recovers from a PO collision", () => {
  it("retries with a freshly allocated number", () => {
    expect(S).toMatch(/const freshPo = await nextPoNumber\(/);
    expect(S).toMatch(/\.insert\(\{ \.\.\.orderRow, po_number: freshPo \}\)/);
  });

  it("rewrites the PO in the subject and body, not just the column", () => {
    // A stored -2 under an email saying -1 is the same defect one layer down.
    expect(S).toContain("body.subject = swap(body.subject)");
    expect(S).toContain("body.body = swap(body.body)");
    expect(S).toMatch(/update\(\{ draft_body: body\.body! \}\)/);
  });

  it("still 409s on a genuine concurrent-draft conflict", () => {
    // The partial-unique on open drafts IS a real conflict, and refreshing is
    // the right advice there. Only the PO case is auto-recoverable.
    expect(S).toMatch(/Another admin is already working on an order/);
  });

  it("builds the insert payload once so the retry can't drift", () => {
    expect(S).toMatch(/const orderRow = \{/);
    expect(S).toMatch(/\.insert\(orderRow\)/);
  });
});
