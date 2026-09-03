import "server-only";
import { commercialDb } from "@/lib/commercial/db";
import { AIA_TAX_ITEM_NO, isAiaTaxLine } from "./constants";

/**
 * The sales-tax row on a payment application's schedule of values.
 *
 * Stephanie 2026-09-01: "The sales tax needs to appear within the totals of the
 * scheduled values. With that, if we change the sales tax status because they
 * provided a cert later into the job if not after, we need the status to change
 * the values within the AIA."
 *
 * Both halves matter, and the second decided the design. A certificate can turn
 * up mid-job, and the tax then has to come off. Had tax been folded into the
 * contract, taking it off would restate the Original Contract Sum — telling the
 * GC the contract changed when it did not. That is the same confusion she
 * described with alternates surfacing as change orders, so tax gets its own row
 * instead: outside line 1, inside line 3, removable without touching either the
 * contract or the change orders.
 *
 * Draft applications only. A certificate that has been issued is a document the
 * GC is holding a printed copy of; re-taxing it after the fact would restate a
 * number they have already paid against.
 */

/** What the tax row SHOULD be worth on this application, in cents. Zero when
 *  the job is exempt — which is also what a cert arriving mid-job produces. */
export async function aiaSalesTaxCents(opts: {
  opportunityId: string;
  /** The taxable base: contract + approved change orders, pre-tax. */
  baseCents: number;
}): Promise<{ cents: number; label: string } | null> {
  if (!Number.isFinite(opts.baseCents) || opts.baseCents <= 0) return null;
  const { loadProposalTaxLine } = await import(
    "@/lib/commercial/proposals/proposal-tax-load"
  );
  // Same resolver the proposal and the invoice use — ZIP → jurisdiction, with
  // the job's and the account's exemptions applied. One source, so the three
  // documents a GC receives cannot quote three different rates.
  const line = await loadProposalTaxLine({
    opportunityId: opts.opportunityId,
    priceCents: opts.baseCents,
  });
  if (!line) return null; // exempt, or no jurisdiction for the ZIP
  return { cents: line.taxCents, label: line.label };
}

/**
 * Bring the tax row in step with the job's CURRENT tax status.
 *
 * Called from the same reconcile the change-order rows use, so "they sent the
 * cert" and "they approved a CO" both land the same way: reopen the draft, the
 * numbers are right.
 */
export async function reconcileAiaTaxRow(applicationId: string): Promise<void> {
  const sb = commercialDb();
  const { data: appRow } = await sb
    .from("commercial_aia_applications")
    .select("id, opportunity_id, status")
    .eq("id", applicationId)
    .maybeSingle();
  const app = appRow as { id: string; opportunity_id: string; status: string } | null;
  if (!app || app.status !== "draft") return;

  const { data: lineRows } = await sb
    .from("commercial_aia_line_items")
    .select("id, item_no, scheduled_value_cents, from_previous_cents, this_period_cents, materials_stored_cents")
    .eq("application_id", applicationId);
  const lines =
    (lineRows as Array<{
      id: string;
      item_no: string | null;
      scheduled_value_cents: number;
      from_previous_cents: number;
      this_period_cents: number;
      materials_stored_cents: number;
    }> | null) ?? [];

  const existing = lines.find((l) => isAiaTaxLine(l));
  // Tax rides on everything else on the sheet — the contract AND the approved
  // change orders — because a CO on a taxable job is taxable too.
  const baseCents = lines
    .filter((l) => !isAiaTaxLine(l))
    .reduce((sum, l) => sum + Math.round(l.scheduled_value_cents), 0);

  const want = await aiaSalesTaxCents({ opportunityId: app.opportunity_id, baseCents });

  if (!want || want.cents <= 0) {
    // Exempt now — the cert arrived. Drop the row only if nothing has been
    // billed against it; a row carrying billed value is history on a
    // certificate the GC already holds, and zeroing it silently would make an
    // earlier application unexplainable.
    if (!existing) return;
    const billed =
      Math.round(existing.from_previous_cents) +
      Math.round(existing.this_period_cents) +
      Math.round(existing.materials_stored_cents);
    if (billed > 0) {
      console.warn(
        `[aia-tax] ${applicationId} is now exempt but its tax row has ${billed} cents billed — left in place; credit it with a change order rather than deleting history.`
      );
      return;
    }
    await sb.from("commercial_aia_line_items").delete().eq("id", existing.id);
    return;
  }

  if (existing) {
    if (Math.round(existing.scheduled_value_cents) === want.cents) return;
    await sb
      .from("commercial_aia_line_items")
      .update({ scheduled_value_cents: want.cents, description: want.label })
      .eq("id", existing.id);
    return;
  }

  // Last row on the sheet: tax comes after the contract and its change orders,
  // which is where a GC's AP department expects to find it.
  const maxPos = lines.reduce((m, _l, i) => Math.max(m, (i + 1) * 1000), 0);
  await sb.from("commercial_aia_line_items").insert({
    application_id: applicationId,
    position: maxPos + 1000,
    item_no: AIA_TAX_ITEM_NO,
    description: want.label,
    scheduled_value_cents: want.cents,
    from_previous_cents: 0,
    this_period_cents: 0,
    materials_stored_cents: 0,
    change_order_id: null,
  });
}
