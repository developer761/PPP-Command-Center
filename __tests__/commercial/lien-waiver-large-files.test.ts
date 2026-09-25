import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * A scanned lien waiver over ~4 MB could not be filed as a waiver at all.
 *
 * The four waiver slots posted the file's bytes to a route, so they inherited
 * Vercel's ~4.5 MB request-body cap — proved against production on 2026-09-23:
 * a 100 KB POST returns 401 (our auth), a 6 MB POST returns 413 (the platform,
 * before our code). A waiver from a GC is routinely 5–15 MB.
 *
 * The browser guard refused those files with advice to use the Documents tab,
 * where the file landed but was never linked — so the slot still read
 * "Missing" with the waiver sitting three feet away. Explaining a trap is not
 * fixing it.
 *
 * These are COVERAGE GUARDS over the seam, not proof the flow works: the link
 * itself is database work, which this suite deliberately cannot reach (see
 * vitest.config.ts). They exist to stop the pieces quietly coming apart.
 */
const LINK = stripComments(readFileSync("lib/commercial/invoices/lien-waiver-link.ts", "utf8"));
const ROUTE = stripComments(readFileSync("app/api/commercial/lien-waivers/link/route.ts", "utf8"));
const FORM = stripComments(readFileSync("components/commercial/lien-waiver-upload.tsx", "utf8"));

describe("filing a large lien waiver", () => {
  it("the form sends big files to Storage instead of refusing them", () => {
    // The old behaviour was `multipartOversizeError` → setError → stop. If that
    // returns, waivers over 4 MB are unfileable again.
    expect(FORM).toContain("directUploadDocument");
    expect(FORM).toContain("sendLarge");
    expect(FORM).not.toContain("multipartOversizeError");
  });

  it("small files still take the original route", () => {
    // Not everything should change transport: a 200 KB waiver has no reason to
    // make two round trips.
    expect(FORM).toContain("f.size <= SAFE_MULTIPART_BYTES");
  });

  it("files above the platform limit are still refused, with the real number", () => {
    expect(FORM).toContain("MAX_UPLOAD_BYTES");
    expect(FORM).toContain("tooLargeMessage");
  });
});

describe("linking a document as a waiver checks scope", () => {
  it("refuses a document belonging to another job", () => {
    // THE security property. A document id is user-supplied: without this a
    // person could link any file on the platform into their own waiver slot
    // and then download it through the waiver route.
    expect(LINK).toContain('doc.parent_type !== "opportunity"');
    expect(LINK).toContain("doc.parent_id !== targetRow.opportunityId");
  });

  it("covers all four slots, since they all hold lien_waiver_document_id", () => {
    for (const table of [
      "commercial_invoices",
      "commercial_aia_applications",
      "commercial_invoice_milestones",
      "commercial_invoice_payments",
    ]) {
      expect(LINK, `${table} is not reachable through the link path`).toContain(table);
    }
  });

  it("retires the waiver it replaces, as the byte path does", () => {
    expect(LINK).toContain("softDeleteDocument");
  });

  it("writes an audit row — a waiver changing hands should leave a trace", () => {
    expect(LINK).toContain("logUpdate");
  });

  it("the route validates the target and both ids before touching data", () => {
    expect(ROUTE).toContain("TARGETS.has(target)");
    expect(ROUTE).toContain("UUID_RE.test");
    // Same auth as the routes it replaces — a new door must not be a weaker one.
    expect(ROUTE).toContain("denyCrewApi");
    expect(ROUTE).toContain("has_new_platform_access");
  });
});
