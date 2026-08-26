import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { taxChoiceToColumns, columnsToTaxChoice } from "@/lib/commercial/tax/exemption";
import { tomcoDefaultIntro } from "@/lib/commercial/proposals/constants";
import { CLOSEOUT_ITEM_STATUS_LABEL, computeWarrantyEndDate } from "@/lib/commercial/closeout/constants";
import { computeG702 } from "@/lib/commercial/aia/constants";

/**
 * ONE GUARD FOR STEPHANIE'S WHOLE ROUND.
 *
 * Karan, after the work was done: "make sure again, re-audit, make sure all her
 * notes and issues are addressed and fixed."
 *
 * Ten of these fixes shipped with NO test — which is the exact gap that
 * produced the round in the first place. A fix nobody asserts is a fix waiting
 * to be undone by the next refactor, and neither of us would find out until she
 * reported it a second time.
 *
 * Behaviour is asserted where the logic is pure. Where a fix is a wiring or
 * layout decision, the SHAPE is asserted — the pattern from
 * proposal-pdf-shape.test.ts. Every assertion below fails against the code as
 * it stood before this round.
 */

// ── Sales tax ─────────────────────────────────────────────────────────────
describe("her note: add Capital Improvement to the job's sales-tax options", () => {
  it("capital improvement charges no tax and carries no certificate number", () => {
    // ST-124 is evidenced by a signed form from the customer, not a number we
    // hold — so keeping a stale cert number would put one on an invoice that
    // must not cite one.
    expect(taxChoiceToColumns("capital_improvement", "OLD-CERT-123")).toEqual({
      tax_exempt: true,
      tax_exempt_reason: "capital_improvement",
      tax_exempt_cert_number: null,
    });
  });

  it("a certificate exemption keeps its number", () => {
    expect(taxChoiceToColumns("exempt", " ST-119-88 ")).toEqual({
      tax_exempt: true,
      tax_exempt_reason: "certificate",
      tax_exempt_cert_number: "ST-119-88",
    });
  });

  it("taxable and inherit are distinct — false is an answer, not an absence", () => {
    // The whole reason the column is nullable: `false` means "taxable even
    // though the account is exempt", which is not the same as "unset".
    expect(taxChoiceToColumns("taxable").tax_exempt).toBe(false);
    expect(taxChoiceToColumns("inherit").tax_exempt).toBeNull();
  });

  it("round-trips, so the picker shows back what was saved", () => {
    for (const choice of ["inherit", "exempt", "capital_improvement", "taxable"] as const) {
      const cols = taxChoiceToColumns(choice, "C-1");
      expect(columnsToTaxChoice(cols), `"${choice}" did not round-trip`).toBe(choice);
    }
  });

  it("the proposal's NY notice follows the job, not a separate checkbox", () => {
    // The two controls used to be unconnected: tick the notice and the invoice
    // still charged tax; set exempt and the proposal printed no notice.
    const hydrate = readFileSync("lib/commercial/proposals/hydrate.ts", "utf8");
    expect(hydrate).toContain('show_capital_improvement_notice: opp.tax_exempt_reason === "capital_improvement"');
  });
});

// ── Proposal PDF ──────────────────────────────────────────────────────────
describe("her note: bid set date in the intro paragraph", () => {
  it("prints the date inside the opening sentence", () => {
    expect(tomcoDefaultIntro("January 11, 2026")).toContain(
      "following proposal based on plans dated January 11, 2026"
    );
  });

  it("reads correctly with no date rather than leaving a gap", () => {
    const intro = tomcoDefaultIntro(null);
    expect(intro).toContain("Tomco is pleased to provide the following proposal.");
    expect(intro).not.toContain("dated");
  });
});

describe("her note: it shows price per line whether or not that is chosen", () => {
  const SRC = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");

  it("the customer table honours the per-line checkbox once it is in use", () => {
    expect(SRC).toContain("const hidePrice = priceOnly && respectShowPrice === true && it.show_price === false");
  });

  it("...and only once in use, because migration 148 backfilled every line to false", () => {
    // Honouring it unconditionally would blank every price on every existing
    // proposal — the regression the old comment was guarding against.
    expect(SRC).toContain("const respectShowPrice = lineItems.some((i) => i.show_price === true)");
  });
});

describe("her note: make the sign off prettier", () => {
  const SRC = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");

  it("the estimator's details print inside the sign-off", () => {
    const at = SRC.indexOf("function SignatureBlock");
    expect(at, "SignatureBlock is gone").toBeGreaterThan(-1);
    const block = SRC.slice(at, SRC.indexOf("\nfunction ", at + 10));
    expect(block).toContain("PLEASE SIGN AND RETURN APPROVED COPY OF PROPOSAL");
    expect(block).toContain("Authorized Client Signature");
    // Her layout: name, then "Lead Estimator, Tomco Painting", then phone/email.
    expect(block).toContain("signContactName");
    // [\s\S] rather than the /s flag — tsconfig targets below es2018.
    expect(block).toMatch(/e\.title[\s\S]*company\?\.name|company\?\.name[\s\S]*e\.title/);
  });
});

describe("her note: put it on one page, or let me change font size and spacing", () => {
  const SRC = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");

  it("compact tightens type and spacing", () => {
    const m = /const COMPACT_PAGE = \{([\s\S]*?)\} as const;/.exec(SRC);
    expect(m, "COMPACT_PAGE is gone — the compact option no longer does anything").toBeTruthy();
    const compact = m![1];
    for (const key of ["fontSize", "lineHeight", "paddingTop", "paddingBottom"]) {
      expect(compact, `compact must set ${key}`).toContain(key);
    }
    // Smaller than the normal page, or it isn't compact.
    expect(Number(/fontSize:\s*([\d.]+)/.exec(compact)![1])).toBeLessThan(11);
  });

  it("is applied to the page, not merely defined", () => {
    expect(SRC).toContain("proposal.pdf_compact ? [styles.page, COMPACT_PAGE] : styles.page");
    // Asserts the page is LETTER at ordinary density — NOT the exact JSX. The
    // literal `<Page size="LETTER" …>` string used to be pinned here, and it
    // broke the moment the page size became a value (Karan 2026-08-26: the plan
    // report has to fit on one page, which is done by laying it out on a taller
    // sheet and scaling back to Letter). A test that pins markup fails on
    // rewrites and passes on regressions; this one reads what the size will
    // actually be.
    const m = /<Page\s+size=\{([\s\S]*?)\}\s+style=\{pageStyle\}>/.exec(SRC);
    expect(m, "the Page no longer takes pageStyle").toBeTruthy();
    expect(m![1], "an ordinary render must still be LETTER").toContain('"LETTER"');
  });

  it("page numbers still print when it runs over anyway", () => {
    expect(SRC).toMatch(/totalPages > 1 \?/);
  });
});

// ── Closeout ──────────────────────────────────────────────────────────────
describe("her note: checklist status — change 'received' to 'sent'", () => {
  it("reads Sent, while still STORING the value the CHECK constraint permits", () => {
    expect(CLOSEOUT_ITEM_STATUS_LABEL.received).toBe("Sent");
    // Renaming the stored value would have meant a migration plus a backfill to
    // change one word on screen.
    expect(Object.keys(CLOSEOUT_ITEM_STATUS_LABEL).sort()).toEqual(["na", "pending", "received"]);
  });
});

describe("her note: warranty through — where do I enter this date?", () => {
  it("is derived from substantial completion plus the term", () => {
    expect(computeWarrantyEndDate("2026-03-15", 1)).toBe("2027-03-15");
    expect(computeWarrantyEndDate("2026-03-15", 2)).toBe("2028-03-15");
  });

  it("is empty only because its input is, and the form now says so", () => {
    expect(computeWarrantyEndDate(null, 1)).toBeNull();
    const tool = readFileSync("app/commercial/accounts/[id]/closeout/[dealId]/closeout-tool.tsx", "utf8");
    expect(tool).toContain("set substantial completion below");
    expect(tool).toContain("The warranty runs from this date");
  });
});

// ── AIA ───────────────────────────────────────────────────────────────────
describe("her note: we need to bill for the retainage, they pay it separately", () => {
  /** A finished job: $100,000 completed, 5% held across two applications. */
  const lines = [
    { scheduled_value_cents: 100_000_00, from_previous_cents: 100_000_00, this_period_cents: 0, materials_stored_cents: 0 },
  ];

  it("a 0% application pays out EXACTLY the retainage that was held", () => {
    // This is why the feature needed no new math. Bill normally at 5%…
    const atFivePct = computeG702({
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 0,
    });
    expect(atFivePct.retainageCents).toBe(5_000_00);
    expect(atFivePct.currentPaymentDueCents).toBe(95_000_00);

    // …then the release: same completed work, retainage 0, previous
    // certificates = everything certified so far.
    const release = computeG702({
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 0,
      lines,
      previousCertificatesCents: atFivePct.totalEarnedLessRetainageCents,
    });
    expect(release.retainageCents).toBe(0);
    expect(release.currentPaymentDueCents).toBe(5_000_00); // the held retainage
    expect(release.balanceToFinishCents).toBe(0);
  });

  it("one release per job — a second would certify nothing", () => {
    const sql = readFileSync("supabase/migrations/162_aia_retainage_release.sql", "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("WHERE is_retainage_release");
  });

  it("the release forces 0% rather than trusting the caller", () => {
    const db = readFileSync("lib/commercial/aia/db.ts", "utf8");
    expect(db).toContain("const retainage = isRelease\n    ? 0");
  });
});

describe("her note: edit or delete an AIA after another was sent", () => {
  const db = readFileSync("lib/commercial/aia/db.ts", "utf8");

  it("names the blocking application instead of giving impossible advice", () => {
    // "delete the later drafts" is not something you can do when the later
    // application is SUBMITTED. Checked against the CODE, not the comments —
    // the file quotes the old wording while explaining why it went.
    const code = db.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("delete the later drafts before reopening it");
    expect(db).toContain("comes after this one and carries it forward");
    expect(db).toContain("work backwards");
  });
});

describe("her note: add lien waiver option to AIA billing just as it is under invoicing", () => {
  it("stores against the application, and treats a deleted file as absent", () => {
    const src = readFileSync("lib/commercial/aia/lien-waiver.ts", "utf8");
    expect(src).toContain('category: "lien_waiver"');
    expect(src).toContain("lien_waiver_document_id: uploaded.document.id");
    // A dangling link must read as "nothing on file", not a tick for a file
    // somebody removed from Documents.
    expect(src).toContain("return doc ?? null");
  });
});

// ── Alternates, estimating report ─────────────────────────────────────────
describe("her note: how do I add alternates to the price when billing?", () => {
  const page = readFileSync("app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8");

  it("accepting one creates an approved change order, not a proposal edit", () => {
    expect(page).toContain("async function acceptAlternateAction");
    expect(page).toContain("createChangeOrder");
  });

  it("uses the per-line override, so a discounted alternate goes on at its real price", () => {
    expect(page).toContain("line.line_total_override_cents ?? Math.round(Number(line.quantity) * line.unit_price_cents)");
  });
});

describe("her note: how do I access the estimating report after it is won?", () => {
  const page = readFileSync("app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx", "utf8");

  it("the Plan report link is no longer gated to pre-send statuses", () => {
    // It used to vanish the moment the proposal was sent — exactly when the
    // job started and people needed to price extras against it.
    expect(page).not.toContain('proposal.status === "pending_approval" ||\n                proposal.status === "approved") && (');
    expect(page).toContain("pdf?mode=internal");
  });

  it("and can be filed against the deal under its own category", () => {
    expect(page).toContain("async function fileEstimateReportAction");
    expect(page).toContain('category: "estimate_report"');
    const cats = readFileSync("lib/commercial/documents/categories.ts", "utf8");
    // Never "proposal": one is what the GC received, the other shows our
    // quantities and bid notes.
    expect(cats).toContain('"estimate_report"');
  });
});

// ── AIA grid keyboard ─────────────────────────────────────────────────────
describe("her note: arrow keys to move between cells on the AIA", () => {
  const src = readFileSync("components/commercial/aia-line-row.tsx", "utf8");

  it("up/down and Enter move down a column", () => {
    expect(src).toContain('const down = e.key === "ArrowDown" || e.key === "Enter"');
    expect(src).toContain('const up = e.key === "ArrowUp"');
  });

  it("left/right only leave the cell when the caret is already at the edge", () => {
    // Otherwise you could not arrow through a value to fix a typo, which would
    // be worse than the tabbing she was complaining about.
    expect(src).toContain('if (e.key === "ArrowLeft" && !atStart) return');
    expect(src).toContain('if (e.key === "ArrowRight" && !atEnd) return');
  });
});

// ── One number, one name ──────────────────────────────────────────────────
describe("the deal's margin is called the same thing on every tab", () => {
  const strip = readFileSync("lib/commercial/opportunities/stage-kpis.ts", "utf8");

  it("the stage strip uses the label the margin came with", () => {
    // It used to hardcode "Projected margin" in one block and "Margin so far" /
    // "Margin" in another, while the Costs tab called the same figure "Gross
    // margin" — one number, four names, depending which tab you were on.
    // docs/OPEN_BACKLOG §"Also confirmed-open" logged this as HIGH.
    const labels = [...strip.matchAll(/label: (i\.margin[^,]*|"[^"]*[Mm]argin[^"]*")/g)].map((m) => m[1]);
    expect(labels.length, "the margin tiles moved").toBeGreaterThanOrEqual(3);
    for (const l of labels) {
      // Either it defers to the source's label, or — on a closed job — it may
      // say "Final margin", but only behind the provisional check.
      const ok = l.includes("i.marginLabel") || l.includes("i.marginProvisional");
      expect(ok, `a margin tile hardcodes ${l} instead of using the source's label`).toBe(true);
    }
  });

  it("and shows the caveat rather than swallowing it", () => {
    // "Margin understated — 12 crew hours have no cost rate" is the difference
    // between a number you can quote and one you can't.
    expect(strip).toContain("i.marginCaveat ??");
  });
});
