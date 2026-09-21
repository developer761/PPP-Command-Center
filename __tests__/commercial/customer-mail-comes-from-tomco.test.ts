import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Anything a CUSTOMER receives comes from a Tomco address.
 *
 * Brendan, 2026-09-21: an invoice "came from a precision painting email and
 * not a Tomco email." It had: the send fell through to the shared commercial
 * pool, `deals@orders.precisionpaintingplus.net`.
 *
 * Invoices and proposals were given their own addresses on 2026-09-17
 * (finance@ and estimating@, confirmed live on the production health report),
 * which fixed the two documents anyone had actually sent. It left three more
 * still pointing at the pool, unnoticed only because none had gone out since:
 *
 *   · the AR statement      → now finance@   (it is an invoice document)
 *   · the change order      → now estimating@ (a priced document the GC signs)
 *   · the signature request → now estimating@ (the worst one: the single email
 *     that asks a customer to SIGN, arriving from a domain they have no
 *     relationship with)
 *
 * Each keeps the pool as a last resort so an unset address still sends —
 * failing to send is worse than sending from the wrong name.
 *
 * THIS TEST EXISTS because the failure is silent. Nothing errors, nothing
 * logs, the email arrives; it just wears the wrong company. The only moment
 * anyone finds out is when a customer is already looking at it.
 */

const FILES: Array<[string, string, string]> = [
  // [path, which per-type address it must prefer, what it sends]
  ["lib/commercial/invoices/email.ts", "COMMERCIAL_INVOICE_FROM_ADDRESS", "the invoice"],
  ["lib/commercial/invoices/statement-email.ts", "COMMERCIAL_INVOICE_FROM_ADDRESS", "the AR statement"],
  ["lib/commercial/proposals/email.ts", "COMMERCIAL_PROPOSAL_FROM_ADDRESS", "the proposal"],
  ["lib/commercial/change-orders/email.ts", "COMMERCIAL_PROPOSAL_FROM_ADDRESS", "the change order"],
  ["lib/commercial/esign/workflow.ts", "COMMERCIAL_PROPOSAL_FROM_ADDRESS", "the signature request"],
];

describe("customer-facing commercial email", () => {
  for (const [path, expected, what] of FILES) {
    const src = readFileSync(join(process.cwd(), path), "utf8");

    it(`${what} prefers ${expected}`, () => {
      expect(src, `${path} must read ${expected}`).toContain(expected);
    });

    it(`${what} reads the per-type address BEFORE the shared pool`, () => {
      // Order is the whole fix. Reading the pool first means the per-type
      // address is dead config that looks set.
      const perType = src.indexOf(expected);
      const pool = src.indexOf("COMMERCIAL_RESEND_FROM_ADDRESS");
      expect(perType, `${path}: ${expected} not found`).toBeGreaterThan(-1);
      if (pool > -1) {
        expect(perType, `${path}: pool address is consulted first`).toBeLessThan(pool);
      }
    });

    it(`${what} still falls back, so an unset address cannot stop the send`, () => {
      // Not sending is worse than sending from the wrong name.
      expect(src).toMatch(/RESEND_FROM_ADDRESS/);
    });
  }

  it("no customer-facing sender reads ONLY the pool", () => {
    // The actual regression shape: a new document type copy-pasted from an
    // older one, inheriting the pool and nothing else.
    const offenders: string[] = [];
    for (const [path] of FILES) {
      const src = readFileSync(join(process.cwd(), path), "utf8");
      const hasPerType =
        src.includes("COMMERCIAL_INVOICE_FROM_ADDRESS") ||
        src.includes("COMMERCIAL_PROPOSAL_FROM_ADDRESS");
      if (!hasPerType) offenders.push(path);
    }
    expect(offenders, `these send to customers from the shared pool: ${offenders.join(", ")}`).toEqual([]);
  });
});
