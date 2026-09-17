import { describe, it, expect } from "vitest";

import { accountingBack, costToolHref, moneyInHref } from "@/lib/commercial/reports/tomco/accounting-links";
import { resolveToolBack } from "@/components/commercial/tool-back-header";

/**
 * The seam: a job link BUILDS a `?back=`, and the deal page WHITELISTS it.
 *
 * Karan 2026-09-16: "if I go onto purchases and click a job I want it to bring
 * me to the place where I can put purchases, and then a back button so I can
 * cleanly go back to the accounting page."
 *
 * Both halves shipped correct once already and the button still did nothing,
 * because the link and the whitelist are written in different files and neither
 * one fails when they disagree: an unrecognised `?back=` renders no button and
 * says nothing. That is the failure this pins — not that the helper returns a
 * string, but that the string it returns is one the deal page will accept.
 *
 * It can fail: change the whitelist to require a trailing slash, or the helper
 * to emit `?tab=`, and every case below goes red.
 */

const OPP = "0e7fe988-ea75-4faf-b294-a873c01f8425";

/** Every Accounting tab whose rows link a job, and where each one lands. */
const TABS = [
  { view: "purchases", href: () => costToolHref(OPP, "purchases"), label: "Purchases" },
  { view: "labor-out", href: () => costToolHref(OPP, "labor-out"), label: "Labor payments" },
  { view: "costs", href: () => costToolHref(OPP, "costs"), label: "Job costs" },
  { view: "transactions", href: () => costToolHref(OPP, "transactions"), label: "Transactions" },
  { view: "owed", href: () => moneyInHref(OPP, "owed"), label: "Balance owed" },
  { view: "deposits", href: () => moneyInHref(OPP, "deposits"), label: "Deposits" },
  { view: "receivables", href: () => null, label: "Receivables" },
];

/** What the deal page does: read `back` out of the URL the way Next would. */
function backParamOf(href: string): string | undefined {
  const qs = href.slice(href.indexOf("?") + 1);
  return new URLSearchParams(qs).get("back") ?? undefined;
}

describe("a job clicked on an Accounting tab comes back to that tab", () => {
  for (const tab of TABS) {
    const href = tab.href();
    if (href) {
      it(`${tab.view}: the link's ?back= resolves, and names the tab`, () => {
        const back = backParamOf(href);
        expect(back, "the link carries a ?back=").toBeTruthy();
        const resolved = resolveToolBack(back);
        expect(resolved, `the deal page rejected ${back} — the back button would not render`).not.toBeNull();
        expect(resolved!.path).toBe(`/commercial/accounting?view=${tab.view}`);
        expect(resolved!.label).toBe(tab.label);
      });
    }

    // Receivables builds its own link inside the table component (it is shared
    // with /commercial/reports/receivables, which must NOT get a back), so pin
    // the shape that component appends rather than the helper.
    it(`${tab.view}: the bare tab URL is accepted as a back target`, () => {
      const resolved = resolveToolBack(decodeURIComponent(accountingBack(tab.view)));
      expect(resolved).not.toBeNull();
      expect(resolved!.label).toBe(tab.label);
    });
  }

  it("lands on a surface that does the work, not the deal's front page", () => {
    // A purchase gets recorded in the costs tool; a payment in, on invoices.
    expect(costToolHref(OPP, "purchases")).toContain("tab=project&sub=transactions");
    expect(moneyInHref(OPP, "owed")).toContain("tab=invoices");
  });

  it("a row with no job on it links nowhere rather than to a broken page", () => {
    expect(costToolHref(null, "purchases")).toBeNull();
    expect(moneyInHref(null, "owed")).toBeNull();
  });

  it("still refuses a back target that is not ours", () => {
    expect(resolveToolBack("https://evil.example/commercial/accounting")).toBeNull();
    expect(resolveToolBack("/commercial/accounting?view=purchases&next=//evil")).toBeNull();
  });
});
