import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Katie items 15 + 16, 2026-09-08: "list it under PO number only, not PPP-WO,
 * just the string of numbers", and "PO should = WO Number. Once the WO number
 * is listed under PO, we can remove the standalone WO line."
 *
 * The PO number is not just a label — TWO things parse it, and both would have
 * broken silently:
 *
 *   · the Mail inbox, which reads the WO number out of it to label a message;
 *   · the inbound webhook, which threads a supplier's REPLY onto the right
 *     order by finding the PO in the subject. That one fails invisibly: the
 *     reply lands in the unmatched bucket and nobody is told.
 */
const ROOT = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The webhook's matcher, mirrored, then pinned to the shipped file below. */
function findPo(subject: string): string | null {
  const m =
    subject.match(/PPP-WO[A-Z0-9]+(?:-[A-Z]+-\d+)?(?:-\d+)?/i) ??
    subject.match(/PPP Order\s+(\d{5,}(?:-\d+)?)/i);
  return m ? (m[1] ?? m[0]) : null;
}

describe("supplier replies still thread after the PO format change", () => {
  it("finds the bare number in a new subject", () => {
    expect(findPo("Re: PPP Order 00316046 — Jane Doe")).toBe("00316046");
    expect(findPo("Re: PPP Order 00316046-2 — Jane Doe")).toBe("00316046-2");
  });

  it("still finds a legacy PPP-WO subject", () => {
    // Orders already placed carry these; they must keep threading.
    expect(findPo("Re: PPP Order PPP-WO00316046 — Jane")).toBe("PPP-WO00316046");
    expect(findPo("Re: PPP-WO00284666-ABO-000123")).toBe("PPP-WO00284666-ABO-000123");
  });

  it("does not grab a stray number out of a reply", () => {
    // Anchored on our own subject text. An unanchored digit run would match a
    // phone number or an invoice in the vendor's reply and thread onto whatever
    // order happened to own it.
    expect(findPo("Re: your order — call me on 5165550123")).toBeNull();
    expect(findPo("Invoice 00316046 attached")).toBeNull();
  });

  it("returns the NUMBER, not the whole matched phrase", () => {
    // Taking match[0] on the anchored pattern yields "PPP Order 00316046",
    // which finds no row — threading stops and nothing says so.
    expect(findPo("PPP Order 00316046 — Jane")).not.toContain("PPP Order");
  });

  it("the shipped webhook uses the capture group", () => {
    expect(read("app/api/webhooks/resend-inbound/route.ts")).toMatch(/poMatch\[1\] \?\? poMatch\[0\]/);
  });

  it("the inbox reads the WO number out of BOTH formats", () => {
    const src = read("app/api/admin/inbox/route.ts");
    expect(src).toMatch(/\(\?:WO\)\?\(\\d\{5,\}\)/);
    const re = /(?:WO)?(\d{5,})/;
    expect(re.exec("00316046")?.[1]).toBe("00316046");
    expect(re.exec("PPP-WO00316046")?.[1]).toBe("00316046");
    expect(re.exec("00316046-2")?.[1]).toBe("00316046");
  });
});

describe("the email stops printing the job twice", () => {
  const t = read("lib/supplier-order/templates.ts");

  it("the standalone Work Order line is gone", () => {
    expect(t).not.toMatch(/Work Order: #\{\{wo_number\}\}/);
  });

  it("and the subject no longer repeats it either", () => {
    expect(t).not.toMatch(/\(WO \{\{wo_number\}\}\)/);
  });

  it("deliver-on replaces required-by, with a time", () => {
    expect(t).toMatch(/Deliver on: \{\{required_by_date\}\}, by \{\{delivery_time\}\}/);
    expect(t).not.toMatch(/Required by:/);
  });

  it("the PPP account number stays — that is Katie's customer number", () => {
    expect(t).toMatch(/PPP Account: \{\{ppp_account_number\}\}/);
  });

  it("the customer reads as a sentence, not a field", () => {
    expect(t).toMatch(/This order is for \{\{customer_name\}\}/);
    expect(t).not.toMatch(/^Customer: \{\{customer_name\}\}/m);
  });
});
