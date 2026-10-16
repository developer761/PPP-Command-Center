import "server-only";

/**
 * The three identity blocks at the top of a G702.
 *
 * Stephanie 2026-09-11:
 *   · "To Owner: GC/Builder name and address"
 *   · "Project: Project name and address"
 *   · "From Contractor: Tomco Painting and address"
 *
 * All three carried the NAME only. On a real AIA application these blocks are
 * the parties to the contract, and an architect or a lender reading the
 * certificate needs to be able to identify each one — a company name with no
 * address does not do that.
 *
 * Lives here rather than in either caller because there are TWO export paths —
 * the AIA tool's auto-file and the download route — and a label built twice is
 * a label that drifts. That exact seam has already produced a two-page invoice,
 * a two-page proposal and an unfitted transmittal in this codebase.
 *
 * Newline-separated: the template's cells are tall enough for a block, and a
 * one-line run-on of name, street, city, state and ZIP is unreadable at the
 * font these forms print at.
 */

/*
 * ONE LINE PER PART, and a field holding two lines counts as two.
 *
 * `.trim()` only strips the ENDS, so an interior line break inside a single
 * field survived into the joined label. 20 live accounts store the suite on a
 * second line inside `billing_street` — "194 Morris Avenue\r\nSuite 3",
 * imported that way from Salesforce — and the stray CR travelled all the way
 * onto the certificate: export.ts split this label on "\n", which left
 * "194 Morris Avenue\r" as one part, and its cells are `wrapText: false`, so
 * the GC's copy drew a control glyph mid-address. Worse than the character,
 * the extra part pushed the block from three parts to four against three
 * cells, and the overflow merge produced "1998 Springdale Road⏎, Suite 101".
 *
 * Splitting here means the label leaves this file already normalised: one
 * address line per "\n"-separated part, no CR anywhere, so every consumer
 * counting parts counts the real number of lines.
 */
const LINE_BREAK = /\r\n|\r|\n/;

function block(...parts: Array<string | null | undefined>): string {
  return parts
    .flatMap((p) => (p ?? "").split(LINE_BREAK))
    // Collapse runs of interior whitespace too: "555 Madison Ave " and
    // "555  Madison   Ave" are the same address line, and tabs from a paste
    // render as wide gaps in a fixed-width form cell.
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** "Sunrise Highway, Bay Shore, NY 11706" from its parts, skipping the blanks.
 *
 *  Deliberately ONE line: a break inside the city or state collapses to a
 *  space here rather than splitting the town away from its state and ZIP. */
function cityStateZip(
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined
): string {
  const flat = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const left = [flat(city), flat(state)].filter(Boolean).join(", ");
  return [left, flat(zip)].filter(Boolean).join(" ");
}

/** TO OWNER — the GC or builder Tomco is billing. */
export function aiaOwnerLabel(account: {
  company_name: string;
  billing_street?: string | null;
  billing_street2?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
}): string {
  return block(
    account.company_name,
    account.billing_street,
    account.billing_street2,
    cityStateZip(account.billing_city, account.billing_state, account.billing_zip)
  );
}

/**
 * PROJECT — the job's name and where the work is.
 *
 * Was `name · street`, joined with a middot. The street was there; the city,
 * state and ZIP were not, so the block named a road without saying which town.
 */
export function aiaProjectLabel(
  dealName: string,
  opp: {
    property_street?: string | null;
    property_city?: string | null;
    property_state?: string | null;
    property_zip?: string | null;
  }
): string {
  // Don't print the street twice. Brendan 2026-09-03 made the job NAME the
  // address ("I'd say it's should be the the address"), so on most jobs
  // dealName and property_street are now the same string — and naively
  // stacking them produced:
  //
  //     115 Connetquot Ave
  //     115 Connetquot Ave
  //     Islip, NY 11751
  //
  // on the document a GC's AP department reads. Found by rendering the
  // workbook and looking at it, not by reading this function.
  //
  // Compared against the FIRST line of the street, because three live jobs
  // store the suite on a second line inside `property_street` ("7 Oser
  // Avenue\r\nSuite B"). Comparing the whole field found no match, so the job
  // name AND the street printed, and the duplicate this guard exists to stop
  // came back with a line break in it. Only the duplicated line is dropped —
  // the suite under it is part of the address and still belongs on the form.
  const streetLines = (opp.property_street ?? "")
    .split(LINE_BREAK)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const name = dealName.replace(/\s+/g, " ").trim().toLowerCase();
  const rest = streetLines[0]?.toLowerCase() === name ? streetLines.slice(1) : streetLines;
  return block(
    dealName,
    ...rest,
    cityStateZip(opp.property_city, opp.property_state, opp.property_zip)
  );
}

/** FROM CONTRACTOR — Tomco. Legal name when one is set: this block is the
 *  party to the contract, and "Tomco Painting Inc." is who signs it. */
export function aiaContractorLabel(oc: {
  name: string;
  legal_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  return block(
    oc.legal_name?.trim() || oc.name,
    oc.address_line1,
    oc.address_line2,
    cityStateZip(oc.city, oc.state, oc.zip)
  );
}
