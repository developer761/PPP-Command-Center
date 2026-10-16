import { describe, it, expect } from "vitest";
import type ExcelJSType from "exceljs";

/**
 * TWO THINGS A G702 CELL MUST NEVER HOLD: a control character, and a formula.
 *
 * Both shipped. Both were invisible to the existing suite, because the suite
 * checked the LABELS and the labels were fine — the damage happened on the way
 * into the workbook. So everything here BUILDS the workbook and reads it back:
 * the cells through exceljs, and the sheet XML directly for the formulas,
 * because "exceljs says the value is a Date" and "the file no longer contains
 * =TODAY()" are different claims and only the second one is the bug.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 1 · THE CARRIAGE RETURN (20 live accounts)
 *
 * Salesforce stores a suite on a second line INSIDE the street field —
 * "194 Morris Avenue\r\nSuite 3". `block()` joined parts with "\n" and
 * `fill()` split on "\n", so the "\r" rode through on the end of a part and
 * into a cell with `wrapText: false`, where it draws as a control glyph. And
 * the extra part turned a three-part block into four against three cells, so
 * the overflow branch merged the middles: "1998 Springdale Road⏎, Suite 101".
 * Seen on 4 live applications (2 of them paid) before the fix.
 *
 * 2 · THE LIVE FORMULA (4 live applications, 2 of them PAID)
 *
 * Her template computes three dates for itself — G702!I7 "PERIOD TO",
 * G703!I3 "APPLICATION DATE", G703!I4 "PERIOD TO" — and all three writes sat
 * behind `if (periodTo)`. With no period recorded the =TODAY() SURVIVED into
 * the exported file, so the certificate re-dated itself to whatever day the
 * GC opened it. A paid certificate is a settled record; one whose date moves
 * is evidence of nothing.
 */

const MONEY_ZERO = {
  originalContractCents: 25_000_00, netChangeOrdersCents: 0, salesTaxCents: 0,
  contractSumToDateCents: 25_000_00, totalCompletedStoredCents: 0, retainageCents: 0,
  totalEarnedLessRetainageCents: 0, previousCertificatesCents: 0, currentPaymentDueCents: 0,
  balanceToFinishCents: 25_000_00, percentCompleteBps: 0, sovVarianceCents: 0,
};

const LINES = [{
  id: "l1", item_no: "1", description: "Original Contract", scheduled_value_cents: 25_000_00,
  from_previous_cents: 0, this_period_cents: 0, materials_stored_cents: 0, position: 1000,
  change_order_id: null,
}];

type AppOverrides = Partial<{
  status: string; period_from: string | null; period_to: string | null;
  frozen_at: string | null; created_at: string;
}>;

async function build(labels: { owner: string; project: string; contractor: string }, app: AppOverrides = {}) {
  const { buildAiaWorkbookBuffer } = await import("@/lib/commercial/aia/export");
  return buildAiaWorkbookBuffer({
    application: {
      id: "a", opportunity_id: "o", account_id: "acc", application_number: 3,
      status: "draft", period_from: null, period_to: null,
      original_contract_cents: 25_000_00, retainage_pct: 10, notes: null,
      frozen_at: null, created_at: "2026-09-17T16:53:48.183446+00:00",
      ...app,
    },
    lines: LINES,
    g702: MONEY_ZERO,
    ownerLabel: labels.owner,
    projectLabel: labels.project,
    contractorLabel: labels.contractor,
  } as never);
}

async function sheets(buf: Buffer) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return {
    g: wb.getWorksheet("Loan G-702")!,
    s: wb.getWorksheet("G-703 Total Hard Cost ")!,
  };
}

/** Every <sheet>.xml in the written file, as text. Formulas live here, and
 *  exceljs's own object model is not the thing Excel opens. */
async function sheetXml(buf: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  let all = "";
  for (const name of Object.keys(zip.files)) {
    if (/sheet\d+\.xml$/.test(name)) all += await zip.files[name].async("string");
  }
  return all;
}

/**
 * Every piece of TEXT the workbook stores, as written — one entry per <t>.
 *
 * Reading a cell back through exceljs cannot see this bug: XML parsers
 * normalise a CR to LF on READ (XML 1.0 §2.11), so a "\r" written into the
 * file comes back as "\n" and an assertion phrased against "\r" passes on a
 * file that contains one. And the strings are not in the SHEET at all — Excel
 * keeps them in xl/sharedStrings.xml, so the first version of this scanned
 * sheet1/sheet2, found nothing, and could not have failed. (It didn't: run
 * against the pre-fix code it reported green while the CR sat in
 * "1998 Springdale Road\r, Suite 101" one file over.)
 *
 * So: every XML part, every <t> body, raw bytes and entity forms both.
 */
async function writtenStrings(buf: Buffer): Promise<string[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const out: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith(".xml")) continue;
    const xml = await zip.files[name].async("string");
    for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out.push(m[1]);
  }
  return out;
}

const text = (c: ExcelJSType.Cell) => (c.value == null ? "" : String(c.value));

describe("the header blocks carry no line break into a cell", () => {
  /*
   * The account as Salesforce actually stores it. `aiaOwnerLabel` is called
   * rather than hand-writing the label, because the CR has to survive the
   * whole path to be worth testing — the first version of this fed the
   * workbook a pre-split label and proved nothing about the label builder.
   */
  it("a suite on a second line of billing_street lands in its own cell", async () => {
    const { aiaOwnerLabel, aiaProjectLabel, aiaContractorLabel } = await import(
      "@/lib/commercial/aia/header-labels"
    );
    const owner = aiaOwnerLabel({
      company_name: "Above All Services",
      billing_street: "194 Morris Avenue\r\nSuite 3",
      billing_city: "Springfield", billing_state: "NJ", billing_zip: "07081",
    });
    expect(owner).toBe("Above All Services\n194 Morris Avenue\nSuite 3\nSpringfield, NJ 07081");

    const { g } = await sheets(
      await build({
        owner,
        project: aiaProjectLabel("7 Oser Avenue", {
          property_street: "7 Oser Avenue\r\nSuite B",
          property_city: "Hauppauge", property_state: "NY", property_zip: "11788",
        }),
        contractor: aiaContractorLabel({
          name: "Tomco Painting", legal_name: "Tomco Painting Inc.",
          address_line1: "77 Windsor Place, Ste. 13",
          city: "Central Islip", state: "NY", zip: "11722",
        }),
      })
    );

    // Four address parts into three cells: the middles merge, cleanly.
    expect(text(g.getCell("C5"))).toBe("Above All Services");
    expect(text(g.getCell("C6"))).toBe("194 Morris Avenue, Suite 3");
    expect(text(g.getCell("C7"))).toBe("Springfield, NJ 07081");

    // The project block names the job for the street (Brendan 2026-09-03), so
    // the duplicated FIRST line drops and the suite under it survives — the
    // old whole-field comparison missed the match and printed both.
    expect(text(g.getCell("E5"))).toBe("7 Oser Avenue");
    expect(text(g.getCell("E6"))).toBe("Suite B");
    expect(text(g.getCell("E7"))).toBe("Hauppauge, NY 11788");

    for (const ref of ["C5", "C6", "C7", "E5", "E6", "E7", "C12", "C14", "C15"]) {
      expect(text(g.getCell(ref)), `${ref} holds a control character`).not.toMatch(/[\r\n\t]/);
      expect(text(g.getCell(ref)), `${ref} has a stray comma`).not.toMatch(/,\s*$|,\s*,/);
    }
  }, 60_000);

  it("no string ANYWHERE in the written file holds a line break", async () => {
    const { aiaOwnerLabel } = await import("@/lib/commercial/aia/header-labels");
    const strings = await writtenStrings(
      await build({
        owner: aiaOwnerLabel({
          company_name: "The Bannett Group, Ltd.",
          billing_street: "1998 Springdale Road\r\nSuite 101",
          billing_city: "Cherry Hill Township", billing_state: "NJ", billing_zip: "08003",
        }),
        project: "Home Goods — Shirley, NY",
        contractor: "Tomco Painting Inc.",
      })
    );
    // The template's own boilerplate is long but single-line; nothing in this
    // workbook legitimately stores a break, so the rule is absolute.
    expect(strings.length, "found no strings — the scan is looking in the wrong place").toBeGreaterThan(20);
    const broken = strings.filter((t) => /\r|\n|&#13;|&#10;/.test(t));
    expect(broken, `these strings carry a line break into a wrapText:false cell`).toEqual([]);
  }, 60_000);
});

describe("a certificate's dates never move", () => {
  const TODAY_CELLS = ["G702!I7 (PERIOD TO)", "G703!I3 (APPLICATION DATE)", "G703!I4 (PERIOD TO)"];
  const labels = { owner: "Alta\n1 Sunrise Hwy\nBay Shore, NY 11706", project: "115 Connetquot Ave\nIslip, NY 11751", contractor: "Tomco Painting Inc." };

  it("a PAID application with no period_to carries NO formula", async () => {
    // The live shape: apps #2 and #3 on Creative Biolabs #2, both paid, both
    // with period_to null, all three dates still =TODAY() in the export.
    const buf = await build(labels, {
      status: "paid", period_to: null, period_from: "2026-04-20",
      frozen_at: "2026-09-25T18:41:12.393+00:00",
    });
    expect(
      await sheetXml(buf),
      `a date cell kept its =TODAY(): ${TODAY_CELLS.join(", ")}`
    ).not.toContain("TODAY()");

    const { g, s } = await sheets(buf);
    // PERIOD TO is a claim about what was billed. There is no period, so it
    // says nothing rather than inventing one.
    expect(g.getCell("I7").value).toBeNull();
    expect(s.getCell("I4").value).toBeNull();
    // APPLICATION DATE is a claim about the document, which always has one:
    // the instant it was frozen, in ET.
    expect(s.getCell("I3").value).toBeInstanceOf(Date);
    expect((s.getCell("I3").value as Date).toISOString().slice(0, 10)).toBe("2026-09-25");
  }, 60_000);

  it("a never-frozen DRAFT with no period falls back to the creation date", async () => {
    const buf = await build(labels, { status: "draft", period_to: null, frozen_at: null });
    expect(await sheetXml(buf)).not.toContain("TODAY()");
    const { g, s } = await sheets(buf);
    expect(g.getCell("I7").value).toBeNull();
    expect(s.getCell("I4").value).toBeNull();
    expect((s.getCell("I3").value as Date).toISOString().slice(0, 10)).toBe("2026-09-17");
  }, 60_000);

  it("with a period recorded, all three cells carry it", async () => {
    const buf = await build(labels, { status: "submitted", period_to: "2026-09-18", frozen_at: "2026-09-28T17:36:27.22+00:00" });
    expect(await sheetXml(buf)).not.toContain("TODAY()");
    const { g, s } = await sheets(buf);
    for (const c of [g.getCell("I7"), s.getCell("I3"), s.getCell("I4")]) {
      expect((c.value as Date).toISOString().slice(0, 10)).toBe("2026-09-18");
      expect(c.numFmt).toBe("mm/dd/yyyy");
    }
  }, 60_000);

  it("re-exporting the same application twice produces the same dates", async () => {
    // The defect was not "the wrong date" — it was a date that CHANGES. Two
    // builds of the same record have to agree, and a =TODAY() that survived
    // would agree today and disagree tomorrow, which is why the XML check
    // above is the load-bearing one and this is its companion.
    const opts = { status: "paid" as const, period_to: null, frozen_at: "2026-09-25T18:41:12.393+00:00" };

    // A formula is not a value, and comparing two of them by identity would
    // fail for the wrong reason (and `String(formulaObject)` is the same
    // "[object Object]" twice, which would PASS for the wrong reason). So:
    // reject anything that is not a date or a blank, then compare.
    const settled = (c: ExcelJSType.Cell, where: string) => {
      const v = c.value;
      expect(
        v === null || v instanceof Date,
        `${where} holds ${JSON.stringify(v)} — a certificate's date must be a fixed value, never a formula`
      ).toBe(true);
      return v instanceof Date ? v.toISOString() : null;
    };

    const a = await sheets(await build(labels, opts));
    const b = await sheets(await build(labels, opts));
    expect(settled(b.s.getCell("I3"), "G703!I3")).toBe(settled(a.s.getCell("I3"), "G703!I3"));
    expect(settled(b.g.getCell("I7"), "G702!I7")).toBe(settled(a.g.getCell("I7"), "G702!I7"));
    expect(settled(b.s.getCell("I4"), "G703!I4")).toBe(settled(a.s.getCell("I4"), "G703!I4"));
  }, 60_000);
});
