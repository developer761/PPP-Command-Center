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

function block(...parts: Array<string | null | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join("\n");
}

/** "Sunrise Highway, Bay Shore, NY 11706" from its parts, skipping the blanks. */
function cityStateZip(
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined
): string {
  const left = [city?.trim(), state?.trim()].filter(Boolean).join(", ");
  return [left, zip?.trim()].filter(Boolean).join(" ");
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
  const street = opp.property_street?.trim();
  const sameAsName = !!street && street.toLowerCase() === dealName.trim().toLowerCase();
  return block(
    dealName,
    sameAsName ? null : street,
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
