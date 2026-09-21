import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Sent" has to mean somebody received it.
 *
 * Stephanie, relaying Brendan, 2026-09-21: "as soon as it was generated, it
 * marked the invoice as sent without actually sending the invoice. Then when he
 * did send it, he did not get cc'd even though the system prompted an automatic
 * cc."
 *
 * Both were real, and they are two different defects:
 *
 *  1. `createCommercialInvoice({ issue: true })` stamped `sent_at` and wrote a
 *     status log saying "Issued on create". INV-0024 was created 21:46:19 with
 *     `sent_at` already set; the email did not leave until 21:49. Had nobody
 *     emailed it, the invoice would have claimed delivery forever while the
 *     customer waited for a bill that never came — a collection risk, not a
 *     cosmetic one.
 *
 *     The status stays `sent`, because that is what puts an invoice into AR
 *     (BILLABLE_INVOICE_STATUSES) and issuing genuinely does mean money is
 *     owed. `sent_at` is what changed meaning: it now records delivery only.
 *
 *  2. The send sheet said "Brendan + ops are BCC'd" as FIXED TEXT, while the
 *     real list had been mary@ + developer@ since Katie moved invoice copies on
 *     2026-09-17. So the UI promised Brendan a copy the code never sent him.
 *
 * Source-shape assertions: the suite is DB-free and cannot create an invoice or
 * send mail. What it can do is stop `sent_at` being re-stamped at creation and
 * stop the recipient promise going back to hard-coded names.
 */

const db = readFileSync(join(process.cwd(), "lib/commercial/invoices/db.ts"), "utf8");
const email = readFileSync(join(process.cwd(), "lib/commercial/invoices/email.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "app/commercial/invoices/[id]/page.tsx"), "utf8");

describe("creating an invoice", () => {
  it("does NOT stamp sent_at", () => {
    // THE REGRESSION, verbatim: `sent_at: input.issue ? nowIso : null`.
    expect(db).not.toMatch(/sent_at:\s*input\.issue\s*\?\s*nowIso/);
    expect(db).toMatch(/sent_at:\s*null,/);
  });

  it("still stamps issued_at, because the money IS owed", () => {
    // The fix must not go too far the other way: an issued invoice belongs in
    // AR from the moment it is raised.
    expect(db).toMatch(/issued_at:\s*input\.issue\s*\?\s*nowIso\s*:\s*null/);
    expect(db).toMatch(/status:\s*input\.issue\s*\?\s*"sent"\s*:\s*"draft"/);
  });

  it("says in the log that nothing has been emailed", () => {
    expect(db).toContain("Issued on create — not emailed yet");
  });
});

describe("emailing an invoice", () => {
  it("records the send even when the invoice was ALREADY live", () => {
    // The old code only stamped on a draft→sent flip. An invoice issued on
    // create is already `sent`, so that branch never ran for it — and once
    // create stopped stamping optimistically, a genuinely emailed invoice
    // would have shown no send date at all.
    const tail = email.slice(email.indexOf("RECORD THE SEND"));
    expect(tail, "the non-draft branch must exist").toMatch(/}\s*else\s*{/);
    expect(tail).toMatch(/sent_at:\s*nowIso/);
  });

  it("does not drag a part-paid invoice back to 'sent'", () => {
    // A re-send must not rewrite the status — only record that mail went out.
    const tail = email.slice(email.indexOf("RECORD THE SEND"));
    const elseBlock = tail.slice(tail.indexOf("} else {"));
    expect(elseBlock).not.toMatch(/to_status:\s*"sent"/);
  });

  it("backfills issued_at only when it is missing", () => {
    const tail = email.slice(email.indexOf("RECORD THE SEND"));
    expect(tail).toMatch(/invoice\.issued_at \? \{\} : \{ issued_at: nowIso \}/);
  });
});

describe("the send sheet's promise about who gets a copy", () => {
  it("names the REAL list instead of hard-coded people", () => {
    expect(page).toContain("INVOICE_COPY_EMAILS");
    // THE REGRESSION: a fixed sentence naming somebody who isn't on the list.
    expect(page).not.toContain("Brendan + ops are BCC");
  });

  it("imports that list from the module that actually sends", () => {
    expect(page).toMatch(/import \{ INVOICE_COPY_EMAILS \} from "@\/lib\/commercial\/invoices\/email"/);
    expect(email).toMatch(/export const INVOICE_COPY_EMAILS/);
  });

  it("handles an empty list honestly rather than promising a copy", () => {
    expect(page).toContain("No internal copies are configured");
  });

  it("explains that a BCC is invisible", () => {
    // The other half of the confusion: Mary DID receive it, Brendan couldn't
    // see that she had, and concluded the invoice went to her instead of the
    // customer. It went to the customer; the BCC is just unobservable.
    expect(page).toMatch(/recipient can't see them/);
  });
});

describe("who is copied on an invoice", () => {
  /**
   * Karan, 2026-09-21: "Yes he should get an email." Brendan runs the jobs
   * these bill for, and the first anyone knew he was not on the list was a
   * customer-facing send. Added alongside Mary, not instead of her — she is
   * finance and needs every invoice.
   *
   * Asserted on the DEFAULT rather than on env, because
   * COMMERCIAL_INVOICE_COPY_EMAILS is not set in Vercel: the literal below IS
   * what production sends to, so an edit here changes who gets paid attention.
   */
  const defaultList = email.slice(
    email.indexOf("process.env.COMMERCIAL_INVOICE_COPY_EMAILS"),
    email.indexOf(".split(\",\")")
  );

  it("includes Brendan", () => {
    expect(defaultList).toContain("brendan@tomcopainting.com");
  });

  it("still includes Mary — he was added, not swapped in", () => {
    expect(defaultList).toContain("mary@tomcopainting.com");
  });

  it("keeps the ops inbox copy", () => {
    expect(defaultList).toContain("developer@precisionpaintingplus.net");
  });

  it("is a comma list the parser will actually accept", () => {
    // The list is split on commas and each address must pass EMAIL_RE, so a
    // stray space or a missing comma silently drops somebody — which is the
    // exact failure being fixed. Parse it the way the module does.
    const literal = defaultList.match(/"([^"]+)"/)?.[1] ?? "";
    const parsed = literal.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    expect(parsed.length, "every address must survive the parse").toBe(3);
    for (const a of parsed) expect(EMAIL_RE.test(a), a).toBe(true);
  });
});

describe("the invoice header", () => {
  it("shows when an invoice has NOT been emailed", () => {
    expect(page).toContain("Not emailed yet");
  });

  it("only says that for a live invoice, never a draft or a void", () => {
    const i = page.indexOf("Not emailed yet");
    const around = page.slice(Math.max(0, i - 900), i);
    expect(around).toMatch(/invoice\.status !== "draft"/);
    expect(around).toMatch(/!isVoid/);
  });
});
