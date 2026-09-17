import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { createCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { ensureProjectForOpportunity } from "@/lib/commercial/projects/ensure";
import { createJob } from "@/lib/commercial/field-ops/jobs";
import type { CommercialJob } from "@/lib/commercial/field-ops/jobs";

/**
 * A one-off work order — small job, no bid, straight to the crew.
 *
 * Karan 2026-09-17: "if it's a one-off work order it makes a job/opp
 * automatically with some information and tags it as one-off work order and has
 * like all the info."
 *
 * ── WHY THE OPPORTUNITY IS NOT OPTIONAL ───────────────────────────────────
 *
 * `createJob` has always accepted a null `opportunity_id`, so a standalone job
 * is already creatable from Field Ops → Jobs. It is a trap, and a quiet one:
 *
 *   · scheduling and hours key on `commercial_jobs.id`, so the job books and
 *     works completely normally — nothing looks wrong;
 *   · every money table keys on `opportunity_id`, and
 *     `commercial_invoices.opportunity_id` is NOT NULL, so that job can never
 *     be invoiced;
 *   · the Costs tool is mounted on the opportunity, so its materials and its
 *     labor payouts have nowhere to be entered;
 *   · so it appears in no cost, margin, AR or profitability report.
 *
 * You would find out when you went to bill it. There are zero such rows on the
 * live book today, so this closes the trap rather than cleaning up after it.
 *
 * The opportunity created here is an ORDINARY opportunity in every respect but
 * one flag, which is the point: costs, invoicing and every report keep working
 * without learning a new shape.
 */

/**
 * The shared account every one-off hangs off.
 *
 * Karan's call, 2026-09-17, over requiring a real customer per one-off. The
 * trade is stated plainly because it will be felt: account-level totals, AR and
 * the Balance Owed report roll every one-off up under this single name.
 *
 * MITIGATED, not ignored — the customer typed on the form is written to the
 * opportunity's `client_name`, which `derivedOppName` puts in the job's
 * displayed name. So the individual customer is still on the row, the invoice
 * and the AR line; it is only the ACCOUNT grouping that is shared.
 */
export const ONE_OFF_ACCOUNT_NAME = "Direct / One-off";

async function ensureOneOffAccount(
  actorUserId: string | null,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: found, error: findErr } = await sb
    .from("commercial_accounts")
    .select("id")
    .eq("company_name", ONE_OFF_ACCOUNT_NAME)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (findErr) return { ok: false, error: findErr.message };
  if (found) return { ok: true, id: (found as { id: string }).id };

  const { data: created, error: insErr } = await sb
    .from("commercial_accounts")
    .insert({
      company_name: ONE_OFF_ACCOUNT_NAME,
      created_by_user_id: actorUserId,
    })
    .select("id")
    .maybeSingle();
  // A concurrent create loses the insert race; re-read rather than fail, so two
  // people logging a one-off at once do not end up with two shared accounts.
  if (insErr || !created) {
    const { data: retry } = await sb
      .from("commercial_accounts")
      .select("id")
      .eq("company_name", ONE_OFF_ACCOUNT_NAME)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (retry) return { ok: true, id: (retry as { id: string }).id };
    return {
      ok: false,
      error: insErr?.message ?? "Could not create the one-off account.",
    };
  }
  return { ok: true, id: (created as { id: string }).id };
}

/**
 * Mark the opportunity as a one-off.
 *
 * Separate from the create, and tolerant of the column not existing, because
 * this repo has NO migration runner — SQL is pasted into the Supabase editor by
 * hand, and the README requires the app to work before that happens. Folding
 * the flag into the insert would make every one-off fail on an environment
 * where 20260917180000 has not been run, which is a worse outcome than an
 * untagged one.
 */
async function markOneOff(oppId: string): Promise<{ tagged: boolean }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_opportunities")
    .update({ is_one_off: true })
    .eq("id", oppId);
  if (error) {
    console.warn(
      "[one-off] could not set is_one_off (migration 20260917180000 not applied?):",
      error.message,
    );
    return { tagged: false };
  }
  return { tagged: true };
}

export type CreateOneOffInput = {
  /** What the work is — becomes both the job name and the opportunity title. */
  name: string;
  /** Who it is for. Kept on the opportunity as `client_name`. */
  customerName?: string | null;
  site_address?: string | null;
  site_city?: string | null;
  site_state?: string | null;
  site_zip?: string | null;
  target_start?: string | null;
  target_end?: string | null;
  estimated_labor_hours?: number | null;
  prevailing_wage?: boolean;
  notes?: string | null;
  /** Passed straight through to the job, so nothing the form collected is lost. */
  status?: string | null;
  division_tag?: string | null;
  actorUserId: string | null;
};

export async function createOneOffWorkOrder(
  input: CreateOneOffInput,
): Promise<
  | { ok: true; opportunityId: string; job: CommercialJob; tagged: boolean }
  | { ok: false; error: string }
> {
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "A name for the work is required." };

  const acct = await ensureOneOffAccount(input.actorUserId);
  if (!acct.ok) return acct;

  /**
   * Created as WORK IN PROGRESS, not as a bid.
   *
   * A one-off exists because the work is already agreed — there was no
   * solicitation, no estimate and no proposal, and starting it at `qualifying`
   * would put it in the pipeline as something to chase and in every
   * open-bid figure as money we might win. `in_progress` is the honest state,
   * and it is what makes the delivery tools (costs, invoicing) available
   * immediately, which is the entire reason for creating the opportunity.
   */
  const opp = await createCommercialOpportunity({
    account_id: acct.id,
    title: name,
    client_name: (input.customerName ?? "").trim() || null,
    status: "in_progress",
    sub_status: "wip_on_site",
    property_street: (input.site_address ?? "").trim() || null,
    property_city: (input.site_city ?? "").trim() || null,
    property_state: (input.site_state ?? "").trim() || null,
    property_zip: (input.site_zip ?? "").trim() || null,
    // The dates are known here, unlike on a bid — the crew is going on a day.
    proposed_start_at: input.target_start || null,
    proposed_end_at: input.target_end || null,
    description: (input.notes ?? "").trim() || null,
    created_by_user_id: input.actorUserId,
  });
  if (!opp.ok) return { ok: false, error: opp.error };

  const { tagged } = await markOneOff(opp.opportunity.id);

  // The project row is what costs and invoices hang off. Best-effort in the
  // same sense the status-change path treats it: a failure here leaves a real
  // opportunity that the normal ensure-on-status-change will fix, rather than
  // failing a work order the crew is waiting on.
  await ensureProjectForOpportunity(opp.opportunity.id, {
    actingUserId: input.actorUserId,
  }).catch(() => undefined);

  const job = await createJob({
    // Blank on purpose: `createJob` generates a reportable code from the name
    // when none is given, and a one-off is exactly the case where nobody wants
    // to invent one. The code still exists, so labor rolls up per work order in
    // payroll and the reports.
    job_code: "",
    name,
    opportunity_id: opp.opportunity.id,
    account_id: acct.id,
    customer_name: (input.customerName ?? "").trim() || null,
    site_address: (input.site_address ?? "").trim() || null,
    site_city: (input.site_city ?? "").trim() || null,
    site_state: (input.site_state ?? "").trim() || null,
    site_zip: (input.site_zip ?? "").trim() || null,
    status: (input.status as never) ?? "ready_to_schedule",
    estimated_labor_hours: input.estimated_labor_hours ?? null,
    target_start: input.target_start || null,
    target_end: input.target_end || null,
    prevailing_wage: input.prevailing_wage ?? false,
    division_tag: (input.division_tag as never) ?? "commercial",
    notes: (input.notes ?? "").trim() || null,
    actor_user_id: input.actorUserId,
  });
  if (!job.ok) {
    // The opportunity is real and usable on its own, so it is NOT rolled back —
    // deleting it would throw away the project and the address the user just
    // typed. Report the half that failed and let them retry the job from the
    // deal, which is a normal thing to do.
    return {
      ok: false,
      error: `The job was created as an opportunity, but the work order failed: ${job.error}`,
    };
  }

  return { ok: true, opportunityId: opp.opportunity.id, job: job.job, tagged };
}
