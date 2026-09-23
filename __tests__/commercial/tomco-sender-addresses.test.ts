import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";
import { COMMERCIAL_TOMCO_DEFAULT_FROM } from "@/lib/email/resend";

/**
 * Brendan 2026-09-23: "Make sure emails are sending from proper tomco ones."
 *
 * This has bitten once already, in front of a customer: INV-0024 went to
 * ssaliani@aboveallservices.com from deals@orders.precisionpaintingplus.net —
 * a Tomco invoice, from a Precision Painting address, to Tomco's GC.
 *
 * The senders Katie set on 2026-09-17: invoices from finance@, proposals from
 * estimating@ (Kim's inbox — a proposal should come from whoever priced it).
 *
 * Each was written as "env var, falling back to the PPP domain" because
 * tomcopainting.com was not verified in Resend yet. It was verified that same
 * day, and the env vars were never set — so proposals had been going out from
 * finance@ for six days. Nobody could see it: the From address only appears on
 * the GC's copy.
 *
 * Hence the default lives in CODE. A setting that must be set in Vercel for
 * the right thing to happen is a setting that is wrong by default.
 */
const PROPOSAL = stripComments(readFileSync("lib/commercial/proposals/email.ts", "utf8"));
const INVOICE = stripComments(readFileSync("lib/commercial/invoices/email.ts", "utf8"));

describe("Tomco mail comes from Tomco", () => {
  it("the commercial channel default is a Tomco address", () => {
    expect(COMMERCIAL_TOMCO_DEFAULT_FROM).toContain("@tomcopainting.com");
    expect(COMMERCIAL_TOMCO_DEFAULT_FROM).not.toContain("precisionpaintingplus");
  });

  it("a proposal comes from estimating@, with or without the env var", () => {
    expect(PROPOSAL).toContain('"estimating@tomcopainting.com"');
  });

  it("an invoice comes from finance@, with or without the env var", () => {
    expect(INVOICE).toContain('"finance@tomcopainting.com"');
  });

  it("neither falls back to a Precision Painting address", () => {
    // The exact string that reached a GC on INV-0024. It must not be reachable
    // as a default from either path again.
    expect(PROPOSAL, "proposal mail can still default to a PPP address").not.toContain(
      "orders.precisionpaintingplus.net"
    );
    expect(INVOICE, "invoice mail can still default to a PPP address").not.toContain(
      "orders.precisionpaintingplus.net"
    );
  });
});
