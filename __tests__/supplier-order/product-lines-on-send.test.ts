/**
 * Product_Lines__c is written when the ORDER GOES OUT.
 *
 * Kate 2026-10-09 asked for the product-line selector to come off the AMs'
 * Internal Entry form. That selector was the only writer of this field (her
 * own R6.2), so it had to gain a new source before it could lose the old one.
 *
 * These are seam tests on purpose. The value crosses a fetch boundary, and the
 * first version of this change read `body.mainMaterialType` — the name the
 * field has in the build payload — while the client posts `materialType`. It
 * type-checked, it shipped nothing, and no test would have caught it: the
 * route had never read that field before. That is the exact failure AGENTS.md
 * names first, "a form posting a field its action never read".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const ROUTE = "app/api/admin/supplier-order/send/route.ts";
const CLIENT = "components/order-fulfillment-view.tsx";

describe("the send route writes what was ordered", () => {
  it("writes Product_Lines__c on the WorkOrder", () => {
    const r = strip(read(ROUTE));
    expect(r).toMatch(/sObject:\s*"WorkOrder"/);
    expect(r).toMatch(/Product_Lines__c:\s*productLines/);
  });

  it("never touches MaterialType__c", () => {
    // That field stays the estimator's answer from the quote, so what was
    // SOLD can be read next to what was ORDERED. Writing it destroys the
    // comparison and was failing silently for months before R6.2.
    expect(strip(read(ROUTE))).not.toContain("MaterialType__c:");
  });

  it("derives the lines from the per-color picks, not a single field", () => {
    const r = strip(read(ROUTE));
    expect(r).toMatch(/productLinesFromOrder\(/);
    expect(r).toMatch(/materialTypeOverrides:\s*body\.materialTypeOverrides/);
  });

  /* ── The seam ─────────────────────────────────────────────────────── */

  it("reads the field names the client actually posts", () => {
    // Both sides, compared. A rename on either one breaks this.
    const client = strip(read(CLIENT));
    const route = strip(read(ROUTE));
    const posts = (name: string) =>
      new RegExp(`\\b${name}:\\s`).test(client.slice(client.indexOf("supplier-order/send")));
    expect(posts("materialTypeOverrides"), "client stopped posting materialTypeOverrides").toBe(true);
    expect(posts("materialType"), "client stopped posting materialType").toBe(true);
    expect(route).toContain("body.materialTypeOverrides");
    expect(route).toContain("body.materialType");
    // The trap: reading the payload's name instead of the wire's name.
    expect(route, "route reads body.mainMaterialType, which the client never sends")
      .not.toContain("body.mainMaterialType");
  });

  /* ── It must never take the send down ─────────────────────────────── */

  it("treats a failed write as a soft warning, not a failed send", () => {
    // The email is already gone and the order row already exists by this
    // point. Nothing here may throw a 500 at someone whose order DID send.
    const r = strip(read(ROUTE));
    expect(r).toMatch(/productLinesWritten/);
    expect(r).toMatch(/productLinesError/);
    expect(r).toMatch(/catch \(err\)[\s\S]{0,200}productLinesError/);
  });

  it("inspects the RESULT, because writeSf returns {ok:false} rather than throwing", () => {
    const r = strip(read(ROUTE));
    expect(r).toMatch(/if \(res\?\.ok\)/);
  });

  it("honors the writeback mode gate", () => {
    // Writeback can be off, or the WO outside the allowlist. Skipping has to
    // be a decision, not an accident.
    expect(strip(read(ROUTE))).toMatch(/decideWriteback\(/);
    expect(strip(read(ROUTE))).toMatch(/decision\.shouldWrite/);
  });
});
