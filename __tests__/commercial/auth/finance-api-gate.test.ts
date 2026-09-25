import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { financeApiDenied } from "@/lib/commercial/auth";

/**
 * A MONEY route needs the money predicate, not the access predicate.
 *
 * `apiAccessDenied` answers "may this login use the commercial platform at
 * all". Every sales rep passes it. Accounting's server actions know this and
 * say so at length — every one of them calls `requireFinanceViewer` (admin or
 * account manager) because "a rep replaying the action id could record
 * payments, edit AR rows, and cost and POST a whole payroll week onto every
 * job — while being unable to approve a single hour."
 *
 * Then the slow Deposited button was replaced with a fast checkbox posting to
 * /api/commercial/payments/deposited, and the new route gated on commercial
 * access alone. The hole that comment describes was reopened by its own
 * performance fix: the write moved out of the guarded action into an unguarded
 * route, and nothing failed, because the gate that was dropped was a DIFFERENT
 * predicate from the one still being called.
 *
 * The bank-reconciliation tick is the worst column to leave open. A wrong tick
 * there does not look wrong — it looks reconciled.
 *
 * Proven to fail by restoring the route's old `.select(...)` and deleting the
 * `financeApiDenied` call: the route test below goes red on both counts.
 */

const ROOT = process.cwd();
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("financeApiDenied", () => {
  it("allows an admin", async () => {
    expect(await financeApiDenied("a@x.com", { role: "admin", is_admin: true })).toBe(null);
  });

  it("allows an account manager — Mary's role, which owns every money surface", async () => {
    expect(await financeApiDenied("mary@x.com", { role: "account_manager", is_admin: false })).toBe(
      null,
    );
  });

  it("denies a sales rep", async () => {
    const res = await financeApiDenied("rep@x.com", { role: "rep", is_admin: false });
    expect(res).not.toBe(null);
    expect(res!.status).toBe(403);
  });

  it("denies a regional manager — money is admin/AM, not seniority", async () => {
    const res = await financeApiDenied("rm@x.com", { role: "regional_manager", is_admin: false });
    expect(res!.status).toBe(403);
  });

  it("denies a row with no role at all rather than defaulting open", async () => {
    expect((await financeApiDenied(null, null))!.status).toBe(403);
    expect((await financeApiDenied(null, {}))!.status).toBe(403);
  });

  /**
   * The env allowlist is the reason `email` is a parameter. An admin added
   * through PPP_ADMIN_EMAILS has `is_admin` null in the database; the payroll
   * CSV route already hit this exact case and named it in its own comment.
   */
  it("falls back to the admin email allowlist when is_admin is null", async () => {
    const prev = process.env.PPP_ADMIN_EMAILS;
    process.env.PPP_ADMIN_EMAILS = "envadmin@x.com";
    try {
      expect(await financeApiDenied("envadmin@x.com", { role: null, is_admin: null })).toBe(null);
      expect((await financeApiDenied("someoneelse@x.com", { role: null, is_admin: null }))!.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.PPP_ADMIN_EMAILS;
      else process.env.PPP_ADMIN_EMAILS = prev;
    }
  });

  it("returns JSON, so a fetch from the checkbox can read it", async () => {
    const res = await financeApiDenied("rep@x.com", { role: "rep" });
    expect(res!.headers.get("content-type")).toContain("application/json");
    expect(await res!.json()).toEqual({ error: "forbidden" });
  });
});

/**
 * The seam, not the file: the route has to actually call it, and has to SELECT
 * the columns it needs to answer. Selecting only the access columns and then
 * asking about role is the silent version of this bug — `role` comes back
 * undefined, normalizeRole falls to "rep", and every finance user is locked out
 * instead of every rep being let in. Both halves are pinned.
 */
describe("the deposited route is finance-gated", () => {
  const ROUTE = "app/api/commercial/payments/deposited/route.ts";
  const src = stripComments(readFileSync(join(ROOT, ROUTE), "utf8"));

  /**
   * The CALL, not the identifier. The first cut asserted
   * `src.includes("financeApiDenied")` and stayed green when the call was
   * deleted, because the import line still carried the word — the same
   * mistake as a cascade guard that matched its own import.
   */
  it("calls the finance gate, and returns what it gives back", () => {
    const body = src.replace(/^import[\s\S]*?;$/gm, "");
    expect(
      /await financeApiDenied\(/.test(body),
      `${ROUTE} writes the bank-reconciliation tick; commercial access alone lets every rep do it`,
    ).toBe(true);
    // A gate whose Response is computed and dropped is not a gate.
    expect(body).toMatch(/if \(denied\) return denied;/);
  });

  it("selects the columns the gate reads", () => {
    expect(src).toMatch(/\.select\([^)]*\brole\b/);
    expect(src).toMatch(/\.select\([^)]*\bis_admin\b/);
  });

  it("still checks commercial access first", () => {
    expect(src).toContain("apiAccessDenied");
  });
});

/**
 * Both tabs that tick a payment use ONE control.
 *
 * Deposits got the fast checkbox on 2026-09-17; Transactions kept the server-
 * action button that Karan had just called unusable ("this Deposited button
 * takes so long to load"). One page, one action, two controls, two names and
 * two speeds — and Mary's handbook had to teach both.
 */
describe("one control for ticking a payment", () => {
  const ledger = stripComments(
    readFileSync(join(ROOT, "components/commercial/transactions-ledger.tsx"), "utf8"),
  );

  it("the ledger uses the same checkbox the Deposits tab uses", () => {
    expect(ledger).toContain("DepositCheckbox");
  });

  it("does not post a server action per tick", () => {
    // revalidatePath on this page re-runs receivables, job costs, the project
    // rollups and the whole ledger. Thirty ticks is thirty rebuilds.
    expect(/depositAction/.test(ledger)).toBe(false);
    expect(/<form action=/.test(ledger)).toBe(false);
  });

  /**
   * And the handbook names the control that is actually on the screen.
   *
   * Scoped to the DEPOSIT tick. "Mark paid" (reimbursements) and "Mark sent"
   * (closeout) are still real buttons with those exact labels, and the first
   * cut of this assertion banned the word outright and failed on both — the
   * ban has to name the sending surface, not the word.
   */
  it("Mary's handbook does not send her looking for a Mark button on the bank tick", () => {
    const roles = stripComments(
      readFileSync(join(ROOT, "lib/commercial/guide/roles.ts"), "utf8"),
    );
    expect(
      /Click Mark[^"]*cleared the bank/.test(roles),
      "the Mark button was replaced by the Cleared checkbox; the printed steps still named it",
    ).toBe(false);
    expect(
      /"Deposited",\s*does:/.test(roles),
      "a ticked payment reads Cleared, not Deposited — Deposited is the column it sits in",
    ).toBe(false);
  });
});
