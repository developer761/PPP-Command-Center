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


/**
 * Source with COMMENTS STRIPPED.
 *
 * Every positional or "must not contain" assertion in this file has to run
 * against code. The docblocks here deliberately quote the old PPP address to
 * explain what went wrong, so a naive `not.toContain("precisionpaintingplus")`
 * goes red against a correct file — which it did, and it is the third time
 * today a check in this repo matched its own explanation. Assert on code.
 */
function codeOf(path: string): string {
  const raw = readFileSync(join(process.cwd(), path), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("customer-facing commercial email", () => {
  for (const [path, expected, what] of FILES) {
    const src = readFileSync(join(process.cwd(), path), "utf8");

    it(`${what} prefers ${expected}`, () => {
      expect(src, `${path} must read ${expected}`).toContain(expected);
    });

    it(`${what} never SENDS from the Precision Painting pool domain`, () => {
      /**
       * Scoped to the sending domain on purpose. The first version of this
       * banned "precisionpaintingplus" anywhere in the file and went red on
       * four correct files: the copy lists legitimately BCC
       * developer@precisionpaintingplus.net (the ops inbox keeps a copy) and
       * e-sign legitimately falls back to hub.precisionpaintingplus.net for
       * the app origin. Neither is a SENDER. A check that cannot tell a
       * recipient from a sender would just get deleted the first time it was
       * inconvenient.
       */
      expect(codeOf(path), `${path} sends from the PPP pool`).not.toMatch(/orders\.precisionpaintingplus\.net/);
    });

    it(`${what} has NO Precision Painting fallback`, () => {
      // Karan 2026-09-21: "can we change all tomco emails to go from tomco."
      // These used to end their chain at COMMERCIAL_RESEND_FROM_ADDRESS, which
      // holds the old PPP pool address — so an unset per-type address silently
      // put Precision Painting on a Tomco document. They now read only the
      // per-type address; unset falls through to the commercial channel
      // default in lib/email/resend.ts, which is Tomco's.
      expect(codeOf(path), `${path} still chains to the PPP pool`).not.toContain("COMMERCIAL_RESEND_FROM_ADDRESS");
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

/**
 * …and the CHANNEL default, which is what everything else uses.
 *
 * Work orders and schedules to crew, bell notifications, the daily digest and
 * the AR email pass no `from` at all, so they resolve to the commercial
 * channel default. That default was the PPP pool, which is why a subcontractor
 * received a Tomco work order from precisionpaintingplus.net.
 */
describe("the commercial channel default", () => {
  const resend = readFileSync(join(process.cwd(), "lib/email/resend.ts"), "utf8");
  const resendCode = codeOf("lib/email/resend.ts");

  it("is a Tomco address", () => {
    expect(resend).toMatch(/TOMCO_DEFAULT_FROM\s*=\s*"[^"]*@tomcopainting\.com>"/);
  });

  it("wins over the legacy PPP pool env var", () => {
    // COMMERCIAL_RESEND_FROM_ADDRESS still holds the old PPP address in
    // Vercel. If it were read first, this whole change would be inert.
    const block = resendCode.slice(resendCode.indexOf("const TOMCO_DEFAULT_FROM"), resendCode.indexOf("if (!apiKey)"));
    const tomco = block.indexOf("TOMCO_DEFAULT_FROM ||");
    const pool = block.indexOf("COMMERCIAL_RESEND_FROM_ADDRESS");
    expect(tomco).toBeGreaterThan(-1);
    if (pool > -1) expect(tomco, "the PPP pool is consulted first").toBeLessThan(pool);
  });

  it("still lets an explicit per-document sender win", () => {
    // invoices → finance@, proposals/COs/e-sign → estimating@.
    expect(resend).toMatch(/const from = input\.from \?\? defaultFrom/);
  });

  it("leaves the RESIDENTIAL channel alone", () => {
    // Precision Painting's own mail must keep its own sender.
    const block = resendCode.slice(resendCode.indexOf("const defaultFrom"), resendCode.indexOf("if (!apiKey)"));
    expect(block).toMatch(/:\s*process\.env\.RESEND_FROM_ADDRESS;/);
  });
});
