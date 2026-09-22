import "server-only";

import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { netApprovedChangeOrderCents } from "@/lib/commercial/change-orders/db";

/**
 * THE contract value of a deal. One definition, for every surface that needs
 * the single number.
 *
 * Stephanie, 2026-09-22: "There is something weird going on with the contract
 * amounts on jobs with change orders." She was right, and the cause was not one
 * bad line of arithmetic — it was that `base + net approved change orders` is
 * spelled out by hand at half a dozen call sites. Each spelling is correct
 * until one of them isn't, and the one that drifts produces a number that looks
 * entirely plausible: right order of magnitude, right currency, wrong contract.
 * It took a person noticing to find it.
 *
 * So the rule lives here now, and anything that needs "the contract" calls this
 * rather than re-deriving it. That matters most for writers that leave the
 * platform — a Salesforce sync pushing its own idea of the contract into PPP's
 * org would be the same bug again, except the disagreement would be between two
 * systems and nobody would see it from either side.
 *
 * The two halves stay separately exported for the surfaces that genuinely need
 * them apart: the G702 prints the original sum on line 1 and net change orders
 * on line 2, and a change-order PDF shows what the contract was before and
 * after. Those are not re-derivations, they are the form.
 */
export async function contractValueCents(opportunityId: string): Promise<number> {
  const [baseCents, changeOrderCents] = await Promise.all([
    getEffectiveContractBaseCents(opportunityId),
    netApprovedChangeOrderCents(opportunityId),
  ]);
  return baseCents + changeOrderCents;
}

/**
 * The same number, with its parts, for callers that must SHOW the breakdown —
 * and so that a caller wanting both never has to add them up itself.
 */
export async function contractValueParts(opportunityId: string): Promise<{
  baseCents: number;
  changeOrderCents: number;
  contractCents: number;
}> {
  const [baseCents, changeOrderCents] = await Promise.all([
    getEffectiveContractBaseCents(opportunityId),
    netApprovedChangeOrderCents(opportunityId),
  ]);
  return { baseCents, changeOrderCents, contractCents: baseCents + changeOrderCents };
}
