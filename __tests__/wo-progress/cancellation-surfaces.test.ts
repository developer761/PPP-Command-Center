import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R5.5 was reported on three surfaces. It was on five.
 *
 * Kate saw a cancelled order still reading "ordered" on the Materials list,
 * under the Ordered filter, and on the progress bar. The same omission was in
 * the activity feed and the customer history timeline — both showed "Order sent
 * to Aboffs" with nothing after it, so a reader scans recent activity and sees
 * an order that looks live. In the activity feed `status` was even already
 * being selected and never read.
 *
 * The rule this locks: any surface that reads supplier_orders must account for
 * cancellation. It is a state a reader can act on wrongly — chasing a vendor,
 * or assuming materials are coming.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Every non-Commercial place that reads the supplier_orders table. */
const READERS = [
  "lib/materials-page-data.ts",
  "lib/wo-progress/derive.ts",
  "app/api/admin/sent/route.ts",
  "app/api/admin/activity/route.ts",
  "app/api/admin/customer/[accountId]/route.ts",
  "app/api/admin/sent/resend/route.ts",
  "app/api/admin/supplier-order/status/route.ts",
];

describe("every supplier_orders reader accounts for cancellation", () => {
  it.each(READERS)("%s", (rel) => {
    const src = read(rel);
    expect(src).toContain("supplier_orders");
    // Must FETCH it, not merely mention it. A first version of this test
    // matched `cancelled_at` anywhere in the file, and a lone type declaration
    // satisfied it — so deliberately breaking the activity feed still passed.
    // You cannot handle a column you did not select.
    const selects = [...src.matchAll(/\.select\(([\s\S]{0,400}?)\)/g)].map((m) => m[1]);
    const fetchesIt = selects.some(
      (sel) => /cancelled_at/.test(sel) || /ORDER_STAGE_COLUMNS/.test(sel)
    );
    expect(
      fetchesIt,
      `${rel} reads supplier_orders but never SELECTS cancelled_at`
    ).toBe(true);
  });

  it("finds the readers it means to check", () => {
    // Guards the guard: a renamed file would otherwise silently drop out and
    // this suite would pass while checking less.
    for (const rel of READERS) {
      expect(() => read(rel), `${rel} moved — update this list`).not.toThrow();
    }
  });
});

/**
 * The sharpest one, because R5.8 CREATED it: cancelled orders became visible in
 * the Sent tab so the Cancelled filter had something to match, and cancelling
 * does not clear delivery_status — so a bounced-then-cancelled order arrived
 * wearing a Re-send button. Pressing it would email a vendor an order PPP had
 * withdrawn.
 */
describe("a cancelled order cannot be re-sent", () => {
  const route = read("app/api/admin/sent/resend/route.ts");
  const view = read("components/inbox-view.tsx");

  it("is refused by the API, not just hidden in the UI", () => {
    // The UI is a courtesy; this is the boundary. Making a row visible must
    // never make an action on it reachable by accident.
    expect(route).toMatch(/cancelled_at/);
    expect(route).toMatch(/error: "order_cancelled"/);
  });

  it("does not offer a button whose only outcome is an error", () => {
    expect(view).toMatch(/deliveryStatus === "bounced" && !message\.cancelledAt/);
  });

  it("explains what to do instead", () => {
    expect(route).toMatch(/Build a new order on the work order instead/);
  });
});
