import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * A READ THAT FAILED IS NOT AN EMPTY RESULT.
 *
 * supabase-js resolves with `{ data, error }` — it does not throw. So
 * `const { data } = await sb.from(...)` on a failed query gives `data = null`,
 * and the usual `(data ?? [])` turns a database outage into "there is nothing
 * here". Where the next step is a WRITE derived from that emptiness, the
 * failure is laundered into corrupt data with a success message on top.
 *
 * Three instances, found by audit on 2026-09-24 and pinned here:
 *
 *  1. `recomputeSubtotal` summed an unread line-item list to ZERO and wrote it.
 *     `total_cents` and `balance_cents` are GENERATED from `subtotal_cents`, so
 *     the invoice, the PDF the customer receives and every AR report went to
 *     $0 — from clicking "×" on one line item, which returned `{ ok: true }`.
 *
 *  2. `syncTimeEntry` read a painter's punches, got null, filtered to no
 *     punches, rounded to ZERO hours — and zero takes the `rounded > 0` branch,
 *     so NO time entry was written at all. The painter's screen said "clocked
 *     out". The row Approvals, the exports and payroll read never existed.
 *
 *  3. Both then wrote without checking the write either, so a rejected UPDATE
 *     left a stale total and a rejected INSERT left nothing, both silently.
 *
 * These are source assertions because the unit suite has no database and can
 * never observe a failed query. Comments are stripped first — tests here have
 * matched their own prose five times.
 */

const read = (p: string) => stripComments(readFileSync(p, "utf8"));

/** The body of a function, up to the next top-level declaration. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", start + 1);
  const alt = src.indexOf("\nasync function ", start + 1);
  const end = [next, alt].filter((n) => n > -1).sort((a, b) => a - b)[0];
  return src.slice(start, end === undefined ? undefined : end);
}

describe("a failed read must not become a write", () => {
  const INVOICES = read("lib/commercial/invoices/db.ts");
  const CLOCK = read("lib/commercial/field-ops/clock.ts");

  it("recomputeSubtotal captures the read error", () => {
    const fn = body(INVOICES, "export async function recomputeSubtotal(");
    // The exact shape of the bug: `{ data: items }` with no error beside it.
    expect(fn).toContain("error: readErr");
    expect(fn).not.toMatch(/const \{\s*data: items\s*\}/);
  });

  it("recomputeSubtotal returns before writing when the read failed", () => {
    const fn = body(INVOICES, "export async function recomputeSubtotal(");
    const beforeWrite = fn.slice(0, fn.indexOf(".update({ subtotal_cents"));
    expect(beforeWrite).toContain("if (readErr)");
    expect(beforeWrite).toContain("return {");
  });

  it("recomputeSubtotal reports a failed write instead of swallowing it", () => {
    const fn = body(INVOICES, "export async function recomputeSubtotal(");
    const afterWrite = fn.slice(fn.indexOf("subErr"));
    expect(afterWrite).toContain("ok: false");
  });

  it("the line-item callers surface a failed re-total", () => {
    // Both addLineItem and removeLineItem returned { ok: true } regardless.
    // A BARE call — one whose result goes nowhere — is the defect; the same
    // substring appears inside `const retotal = await …`, so match the start
    // of the statement rather than the call text.
    expect(INVOICES).not.toMatch(/\n\s*await recomputeSubtotal\(invoice_id\)/);
    expect(INVOICES).toContain("const retotal = await recomputeSubtotal(invoice_id)");
    expect(INVOICES).toContain("if (!retotal.ok) return { ok: false, error: retotal.error }");
  });

  it("syncTimeEntry captures the punch read error and stops", () => {
    const fn = body(CLOCK, "async function syncTimeEntry(");
    expect(fn).toContain("error: punchErr");
    const beforeMaths = fn.slice(0, fn.indexOf("const punches"));
    expect(beforeMaths).toContain("if (punchErr)");
  });

  it("syncTimeEntry checks both the update and the insert", () => {
    const fn = body(CLOCK, "async function syncTimeEntry(");
    expect(fn).toContain("error: updErr");
    expect(fn).toContain("error: insErr");
  });

  it("clocking out reports when the hours did not save", () => {
    // The painter's screen said "clocked out" while the payroll row was absent.
    expect(CLOCK).toContain("if (!synced.ok) return { ok: false, error: synced.error }");
  });
});
