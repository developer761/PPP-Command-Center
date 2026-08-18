import "server-only";

import { getChangeOrder, netApprovedChangeOrderCents } from "./db";
import { formatChangeOrderNumber, CHANGE_ORDER_STATUS_META } from "./constants";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer, getBrandSignatureBuffer } from "@/lib/commercial/operating-company/assets";

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

  const [account, opp, base, netApproved, company, logo, signature] = await Promise.all([
    getCommercialAccount(co.account_id),
    getCommercialOpportunity(co.opportunity_id),
    getEffectiveContractBaseCents(co.opportunity_id),
    netApprovedChangeOrderCents(co.opportunity_id),
    getOperatingCompany(),
    getBrandLogoBuffer().catch(() => null),
    getBrandSignatureBuffer().catch(() => null),
  ]);
  if (!account || !opp) return { ok: false };

  // Contract adjustment — shown only when a contract sum is known AND this CO
  // could actually move it (pending = proposed, approved = applied). A DECLINED
  // CO never adjusts the contract, so printing a "revised contract sum" for it
  // would be a number that will never happen.
  // `netApproved` already includes THIS CO when it's approved, so back it out to
  // get the "prior" sum, then add it once to get "revised".
  const contractToDate = base + netApproved;
  const thisApproved = co.status === "approved";
  const showAdjustment = base > 0 && co.status !== "declined";
  const priorContractCents = showAdjustment
    ? contractToDate - (thisApproved ? co.amount_cents : 0)
    : null;
  const revisedContractCents =
    priorContractCents != null ? priorContractCents + co.amount_cents : null;

  const billTo: string[] = [];
  const street = [account.billing_street, account.billing_street2]
    .map((s) => s?.trim())
    .filter(Boolean) as string[];
  billTo.push(...street);
  const cityLine = [
    [account.billing_city?.trim(), account.billing_state?.trim()].filter(Boolean).join(", "),
    account.billing_zip?.trim(),
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
