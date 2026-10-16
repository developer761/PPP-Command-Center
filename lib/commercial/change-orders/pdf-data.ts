import "server-only";

import { getChangeOrder, listChangeOrders } from "./db";
import { formatChangeOrderNumber, CHANGE_ORDER_STATUS_META } from "./constants";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer, getBrandSignatureBuffer } from "@/lib/commercial/operating-company/assets";

/** The shape of a sibling change order the ladder needs. */
export type ChangeOrderLadderRow = {
  co_number: number;
  amount_cents: number;
  status: string;
};

/**
 * PRIOR → REVISED CONTRACT SUM FOR **THIS** CHANGE ORDER.
 *
 * Pure, and exported, because it is the number a GC signs against and it was
 * wrong on live documents for want of a test it could have had.
 *
 * WHAT WAS WRONG. It read `base + netApprovedChangeOrderCents(opportunity)` and
 * backed THIS one out of it — i.e. the deal's contract sum TODAY, which is the
 * same figure on every change order of the deal whatever its position or
 * amount. Measured 2026-10-16: all seven change orders on LMJ Cipla printed
 * "Revised contract sum $100,127.09", so CO-002 (+$1,200) claimed $100,127.09
 * where the chain says $69,000 → $70,200 — $29,927.09 overstated. VCA West
 * Islip CO-001 (+$2,250) was over by $20,375 the same way.
 *
 * WHAT IT DOES NOW. prior = the contract base plus the APPROVED change orders
 * that PRECEDE this one; revised = prior + this one. CO-001's revised is then
 * CO-002's prior and the stack reads as one chain, which is the invariant a
 * GC's AP department checks across a set of them.
 *
 * ORDERED BY `co_number`, NOT `decided_at`:
 *
 *  · co_number is the document's own identity — the number printed at the top
 *    of the page — so it is the only ordering under which the chain a reader
 *    sees matches the order they read it in.
 *  · it is the only TOTAL order available. co_number is NOT NULL and unique per
 *    live deal (the partial unique index); `decided_at` is null on older
 *    approvals and ties freely — seven of LMJ Cipla's were decided inside
 *    twenty minutes of one morning, two of them 45 seconds apart. Sorting those
 *    by timestamp hands the same stack a different ladder on a clock skew, and
 *    leaves the null rows to be guessed at. Under co_number a null `decided_at`
 *    is simply not consulted.
 *
 * THE CASES, each one live-data-shaped:
 *  · PENDING or DECLINED siblings are not in the ladder at all — only an
 *    approved change order has moved the contract.
 *  · a PENDING subject still prints its own revised figure: "approve this and
 *    the contract becomes X" is exactly what the document is asking for.
 *  · a DECLINED subject prints no adjustment at all (handled by the caller) —
 *    a revised sum that will never happen is worse than none.
 *  · a DEDUCT needs no special case: the amount is signed, so it lowers the
 *    revised sum and every later rung starts from the lower number.
 *  · an out-of-order approval (CO-003 approved while CO-002 is still pending)
 *    leaves CO-003's prior at the base: this document's ladder is positional,
 *    and claiming an unapproved CO-002's money inside CO-003's "prior" would
 *    bill for a change nobody has agreed to.
 */
export function changeOrderContractLadder(args: {
  /** The contract base before any change order — getEffectiveContractBaseCents. */
  baseCents: number;
  /** The change order this document is FOR. */
  co: ChangeOrderLadderRow;
  /** Every LIVE change order on the deal, this one included. Order irrelevant. */
  siblings: ChangeOrderLadderRow[];
}): { priorContractCents: number | null; revisedContractCents: number | null } {
  const { baseCents, co, siblings } = args;
  // No known contract sum → no adjustment block, rather than an adjustment off
  // an imagined $0 contract. A declined CO never moves the contract.
  if (!(baseCents > 0) || co.status === "declined") {
    return { priorContractCents: null, revisedContractCents: null };
  }
  const priorApproved = siblings
    .filter((s) => s.status === "approved" && s.co_number < co.co_number)
    .reduce((n, s) => n + s.amount_cents, 0);
  const priorContractCents = baseCents + priorApproved;
  return { priorContractCents, revisedContractCents: priorContractCents + co.amount_cents };
}

/**
 * Assemble everything the change-order PDF needs, from an id.
 *
 * Extracted from the PDF route when emailing a change order shipped (Stephanie
 * 2026-08-18). Both paths render the SAME document, so both have to resolve the
 * contract adjustment, the bill-to block and the letterhead identically — and a
 * second copy of that logic is exactly how two surfaces start printing
 * different revised contract sums for one change order.
 *
 * Returns null when the CO, its account or its opportunity is missing or
 * soft-deleted. That's the chain-of-trust guard the route already had: both
 * loaders hard-filter `deleted_at`, and without the check a bookmarked URL
 * streamed a full-letterhead change order addressed to "Customer" with no
 * bill-to, long after the deal was removed.
 */
export async function buildChangeOrderPdfInput(changeOrderId: string): Promise<
  | { ok: true; input: Parameters<typeof import("./pdf").renderChangeOrderPdf>[0]; fileBase: string }
  | { ok: false }
> {
  const co = await getChangeOrder(changeOrderId);
  if (!co) return { ok: false };

  const [account, opp, base, siblings, company, logo, signature] = await Promise.all([
    getCommercialAccount(co.account_id),
    getCommercialOpportunity(co.opportunity_id),
    getEffectiveContractBaseCents(co.opportunity_id),
    listChangeOrders(co.opportunity_id),
    getOperatingCompany(),
    getBrandLogoBuffer().catch(() => null),
    getBrandSignatureBuffer().catch(() => null),
  ]);
  if (!account || !opp) return { ok: false };

  // THIS change order's rung of the ladder — see changeOrderContractLadder
  // above for why it is positional and why it is ordered by co_number.
  const { priorContractCents, revisedContractCents } = changeOrderContractLadder({
    baseCents: base,
    co,
    siblings,
  });

  const billTo: string[] = [];
  /*
   * ONE ADDRESS LINE PER ENTRY — a street field can hold more than one.
   *
   * 20 live accounts store the suite on a second line inside `billing_street`
   * ("4250 Old William Penn Highway\r\nSuite 2"), imported that way from
   * Salesforce. `.trim()` leaves an interior CRLF untouched, so the bill-to
   * block carried a literal line break into a single PDF text run and the GC
   * saw a control glyph mid-address. Split it instead: the renderer already
   * draws one line per array entry.
   */
  const street = [account.billing_street, account.billing_street2]
    .flatMap((s) => (s ?? "").split(/\r\n|\r|\n/))
    .map((s) => s.trim())
    .filter(Boolean);
  billTo.push(...street);
  // Same treatment for the city line: this one IS a single line, so a stray
  // break collapses to a space rather than splitting the town off its state.
  const oneLine = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const cityLine = [
    [oneLine(account.billing_city), oneLine(account.billing_state)].filter(Boolean).join(", "),
    oneLine(account.billing_zip),
  ]
    .filter(Boolean)
    .join(" ");
  if (cityLine) billTo.push(cityLine);

  return {
    ok: true,
    fileBase: formatChangeOrderNumber(co.co_number).replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40),
    input: {
      coNumber: formatChangeOrderNumber(co.co_number),
      title: co.title,
      description: co.description,
      amountCents: co.amount_cents,
      isDeduct: co.amount_cents < 0,
      status: CHANGE_ORDER_STATUS_META[co.status]?.label ?? co.status,
      dateIso: co.decided_at ?? co.created_at ?? null,
      accountName: account.company_name ?? "Customer",
      billTo,
      dealName: derivedOppName(opp, account.company_name ?? null),
      priorContractCents,
      revisedContractCents,
      company: {
        name: company.name,
        phone: company.phone,
        website: company.website,
        signature_name: company.signature_name,
        signature_title: company.signature_title,
      },
      logo,
      signature,
    },
  };
}
