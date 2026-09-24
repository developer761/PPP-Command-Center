import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * 2026-09-23. The nightly Salesforce reconcile reported job 00287819 as
 * $0.00 collected against Salesforce's $66,833.31 — the whole book-level
 * "collected" gap, on one job.
 *
 * Nobody had broken the sync. Invoice SF-00287819 ($286,695, with $66,833.31
 * already collected) had been deleted on the platform that morning, and:
 *
 *   · the "Delete invoice" button was the ONLY destructive control on that
 *     page with no confirmation — Void, right beside it, has one — so a
 *     quarter-million-dollar invoice went in a single click with no warning
 *     that money was attached to it;
 *   · `commercial_audit_log` had ZERO invoice deletions in it, all time, next
 *     to 28 other invoice events. `softDeleteInvoice` wrote only to
 *     `commercial_invoice_status_log`, which you can reach only by opening the
 *     invoice — and a deleted invoice is hidden everywhere. The one event
 *     worth looking up was the one that could not be looked up.
 *
 * Answering "who removed this, and when" took a direct database query.
 *
 * Seam assertions: the unit suite is pure-logic and cannot click a button or
 * read a table. Comments are stripped first — tests in this repo have matched
 * their own prose five times.
 */

const read = (p: string) => stripComments(readFileSync(p, "utf8"));

describe("deleting an invoice leaves a trail", () => {
  const STATUS = read("lib/commercial/invoices/status.ts");
  const PAGE = read("app/commercial/invoices/[id]/page.tsx");

  it("writes the deletion to the platform-wide audit log, not just the invoice's own log", () => {
    const fn = STATUS.slice(
      STATUS.indexOf("export async function softDeleteInvoice"),
      STATUS.indexOf("export async function restoreInvoice"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("logDelete");
  });

  it("captures the whole row, because a delete logs before_json and nothing else", () => {
    const fn = STATUS.slice(
      STATUS.indexOf("export async function softDeleteInvoice"),
      STATUS.indexOf("export async function restoreInvoice"),
    );
    // Selecting only `status, deleted_at` would record a deletion with no
    // amount and no paid_cents — a trail that cannot answer the question it
    // exists for.
    expect(fn).toContain('.select("*")');
  });

  it("logs the undo too, so the trail cannot show money removed that came back", () => {
    const fn = STATUS.slice(STATUS.indexOf("export async function restoreInvoice"));
    expect(fn).toContain("logUpdate");
  });

  it("asks before deleting, and says so when money has been collected", () => {
    const form = PAGE.slice(PAGE.indexOf("action={deleteDraftAction}"));
    const button = form.slice(0, form.indexOf("</form>"));
    expect(button).toContain("ConfirmSubmitButton");
    // The confirmation has to READ the collected amount, not just exist — a
    // generic "are you sure?" is the dialog everybody clicks through.
    expect(button).toContain("paid_cents");
  });
});
