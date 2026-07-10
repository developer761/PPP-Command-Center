import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  OPPORTUNITY_SOURCES,
  opportunityStatusLabel,
  opportunitySourceLabel,
  getCommercialOpportunity,
  type OpportunitySource,
} from "@/lib/commercial/opportunities/db";
import { updateCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

/**
 * Edit opportunity page — mirrors the account edit pattern + new-opp
 * form shape. Pre-fills every field from the existing opp; on submit
 * runs updateCommercialOpportunity which patches only changed columns.
 *
 * Out of scope (use other surfaces):
 *   - Status changes → ChangeStatusCard on the detail Info tab
 *     (enforces the DAG + captures loss_reason + writes status_log)
 *   - Soft-delete → "Delete opportunity" two-step on the detail Info tab
 *   - Team / Tasks / Notes / Plans & Specs → respective tabs
 *
 * Bid values get dollar-string parsing (commas/$ stripped) symmetric
 * with the new-opp form so "$50,000" / "50000" / "50,000.50" all work.
 */

async function updateAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) redirect("/commercial/opportunities");

  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Title is required.")}`);
  }

  // Status is intentionally NOT editable from this form — that path
  // bypassed the DAG + loss-reason capture + status_log entry + decided_at
  // timestamp. All status changes route through ChangeStatusCard on the
  // Info tab. See lib/commercial/opportunities/status.changeOpportunityStatus.
  const sourceRaw = String(formData.get("source") ?? "");
  if (sourceRaw && !(OPPORTUNITY_SOURCES as readonly string[]).includes(sourceRaw)) {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Invalid source.")}`);
  }

  // Dollar-string parser — same as new-opp.
  const parseDollars = (raw: string): number | null | "invalid" => {
    const cleaned = raw.trim().replace(/[$,\s]/g, "");
    if (cleaned === "") return null;
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return "invalid";
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * 100);
  };
  const lowParsed = parseDollars(String(formData.get("bid_low") ?? ""));
  const highParsed = parseDollars(String(formData.get("bid_high") ?? ""));
  if (lowParsed === "invalid") {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Bid low must be a non-negative dollar amount.")}`);
  }
  if (highParsed === "invalid") {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Bid high must be a non-negative dollar amount.")}`);
  }

  const probabilityRaw = String(formData.get("probability_pct") ?? "").trim();
  let probability: number | null | undefined = undefined;
  if (probabilityRaw !== "") {
    const n = Number(probabilityRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Probability must be a number 0-100.")}`);
    }
    probability = Math.round(n);
  }

  const result = await updateCommercialOpportunity({
    id,
    title,
    description: (formData.get("description") as string)?.trim() || null,
    // status intentionally omitted — see comment above.
    source: sourceRaw ? (sourceRaw as OpportunitySource) : null,
    bid_value_low_cents: lowParsed as number | null,
    bid_value_high_cents: highParsed as number | null,
    probability_pct: probability,
    proposal_due_at: (formData.get("proposal_due_at") as string) || null,
    proposed_start_at: (formData.get("proposed_start_at") as string) || null,
    proposed_end_at: (formData.get("proposed_end_at") as string) || null,
    property_street: (formData.get("property_street") as string) ?? null,
    property_city: (formData.get("property_city") as string) ?? null,
    property_state: (formData.get("property_state") as string) ?? null,
    property_zip: (formData.get("property_zip") as string) ?? null,
    // Phase B — CEO structural fields. Empty strings → null so the
    // server-side validator sees a truly missing value instead of "".
    client_name: (formData.get("client_name") as string)?.trim() || null,
    location_short: (formData.get("location_short") as string)?.trim() || null,
    estimator_user_id: (formData.get("estimator_user_id") as string) || null,
    updated_by_user_id: user.id,
  });

  if (!result.ok) {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent(result.error)}`);
  }
  // Karan 2026-07-08: land on the OWNING ACCOUNT's Deals tab with the
  // saved deal pre-focused. The deal detail page as a landing surface
  // is being retired — everything about a deal lives under its account.
  const accId = (result as { opportunity?: { account_id: string } }).opportunity?.account_id ?? null;
  if (accId) {
    redirect(`/commercial/accounts/${accId}?tab=deals&deal=${id}&saved=1#deal-${id}`);
  }
  // Fallback: no account_id on the returned record → bounce through the
  // deal detail page which will itself redirect to the account.
  redirect(`/commercial/opportunities/${id}?edited=1`);
}

export default async function EditOpportunityPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const errorMessage = pickFirst(sp.error);

  const opp = await getCommercialOpportunity(id);
  if (!opp) notFound();

  // Karan 2026-07-08: bare navigation to /commercial/opportunities/[id]/edit
  // redirects to the account's slide-out edit sheet. The standalone
  // edit page is a shim now — any surface (bell notification, bookmark)
  // that GET's it lands the user on the account page with the sheet
  // pre-opened. The action + form below stay live so an in-flight POST
  // (from the sheet's form) still writes through this route.
  redirect(`/commercial/accounts/${opp.account_id}?tab=opportunities&edit=${opp.id}#deal-edit-sheet`);


  // Unreachable — redirect above throws. Kept as an assertion.
  return null;
}
