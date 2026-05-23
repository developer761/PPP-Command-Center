import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { deriveRepScorecard } from "@/lib/salesforce/rep-scorecard";
import { currentFY, currentFiscalQuarter, fyLabel } from "@/lib/fiscal-year";

/**
 * Rep KPI validation endpoint — admin-only. Walks the deltas between the
 * Command Center's per-rep scorecard and PPP's FPRC_* Salesforce reports so
 * Katie can confirm every number BEFORE PPP staff start relying on them.
 *
 * For a given rep + fiscal period, returns:
 *   1. The full scorecard (all 9 KPIs computed)
 *   2. The INPUT counts feeding each KPI (how many WOs / Opps / Transactions /
 *      Reviews / Cases the rep owns in the period) — so a "zero" in the
 *      scorecard can be triaged as "rep had zero" vs "we pulled zero".
 *   3. Field-level data-coverage flags (e.g., "5 of 12 completed WOs have
 *      Gross_Margin_Percent__c populated") so Katie can spot FLS gaps or
 *      incomplete data entry on PPP's side.
 *
 * Usage:
 *   GET /api/admin/rep-validation?repId=005XXXXXXXXXXXXXX
 *   GET /api/admin/rep-validation?repId=005XXXXXXXXXXXXXX&fy=2026&q=2
 *   GET /api/admin/rep-validation?email=alex@precisionpaintingplus.net
 *
 * Defaults: current FY + current fiscal quarter (PPP FY = Feb 1 → Jan 31).
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const repIdParam = url.searchParams.get("repId");
  const emailParam = url.searchParams.get("email");
  const fyParam = url.searchParams.get("fy");
  const qParam = url.searchParams.get("q");

  if (!repIdParam && !emailParam) {
    return NextResponse.json({
      error: "missing_param",
      hint: "Pass ?repId=<sf-user-id> or ?email=<rep-email>",
    }, { status: 400 });
  }

  const snapshot = await loadSalesforceSnapshot();

  // Resolve repId from either direct id or email.
  let repId = repIdParam ?? null;
  if (!repId && emailParam) {
    const target = emailParam.toLowerCase();
    const match = snapshot.reps.find((r) => (r.email ?? "").toLowerCase() === target);
    if (!match) {
      return NextResponse.json({
        error: "rep_not_found",
        hint: `No rep with email ${emailParam} in the snapshot. Active reps available via /dashboard/rep.`,
      }, { status: 404 });
    }
    repId = match.id;
  }

  const rep = snapshot.reps.find((r) => r.id === repId);
  if (!rep || !repId) {
    return NextResponse.json({
      error: "rep_not_found",
      hint: `No rep with id ${repIdParam} in the snapshot. The rep may be inactive or excluded from the Profile=*Standard.Field filter.`,
    }, { status: 404 });
  }

  // Period defaults — current fiscal quarter.
  const fy = fyParam ? Number(fyParam) : currentFY();
  const q = qParam ? (Number(qParam) as 1 | 2 | 3 | 4) : currentFiscalQuarter();
  if (q && (q < 1 || q > 4)) {
    return NextResponse.json({ error: "bad_quarter", hint: "q must be 1-4" }, { status: 400 });
  }

  const scorecard = deriveRepScorecard(snapshot, repId, { fy, q });
  if (!scorecard) {
    return NextResponse.json({ error: "scorecard_failed" }, { status: 500 });
  }

  // INPUT counts — what the snapshot actually contains for this rep in this period.
  // These let Katie verify a "0" KPI is genuine ("rep ran no appointments")
  // vs. a data pipeline gap ("we pulled 0 appointment-bearing opps").
  const inRangeIso = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= scorecard.period.start.getTime() && t < scorecard.period.end.getTime();
  };

  const repOpps = snapshot.opportunities.filter((o) => o.ownerId === repId);
  const repWos = snapshot.workOrders.filter((w) => w.ownerId === repId);
  const repTxns = snapshot.transactions.filter((t) => t.workOrderOwnerId === repId);

  // Field-coverage stats on the rep's completed WOs (data-quality signal).
  const completedInPeriod = repWos.filter((w) => {
    const s = (w.status ?? "").toLowerCase();
    const completed = s === "closed" || s === "complete paid in full" || s === "complete balance owed";
    return completed && inRangeIso(w.endDate ?? w.closeDate);
  });
  const woFieldCoverage = {
    completed: completedInPeriod.length,
    withGmPercent: completedInPeriod.filter((w) => w.grossMarginPercent !== null).length,
    withTotalNonBillablePurchases: completedInPeriod.filter((w) => w.totalNonBillablePurchases > 0).length,
    withEndDate: completedInPeriod.filter((w) => w.endDate !== null).length,
    withAttendanceLogged: completedInPeriod.filter((w) => (w.laborDaysActual ?? 0) > 0).length,
  };

  return NextResponse.json({
    rep: {
      id: rep.id,
      name: rep.name,
      email: rep.email,
      profileName: rep.profileName,
      isFieldStandard: rep.isFieldStandard,
      gmGoalPercent: rep.gmGoalPercent,
      quarterlyDraw: rep.quarterlyDraw,
    },
    period: {
      fy,
      q,
      label: fyLabel(fy, q),
      start: scorecard.period.start.toISOString(),
      end: scorecard.period.end.toISOString(),
    },
    scorecard,
    inputs: {
      // What the rep owns IN the snapshot (lifetime/365d window — snapshot scope)
      opportunities: repOpps.length,
      workOrders: repWos.length,
      transactions: repTxns.length,
      // What feeds each KPI for THIS period
      kpi1_oppsWonInPeriod: repOpps.filter((o) => o.isWon && inRangeIso(o.closeDate)).length,
      kpi2_completedWosInPeriod: completedInPeriod.length,
      kpi3_oppsCreatedInPeriod: repOpps.filter((o) => inRangeIso(o.createdDate)).length,
      kpi5_appointmentsScheduledInPeriod: repOpps.filter((o) => inRangeIso(o.appointmentDate)).length,
      kpi6_openOppsNow: repOpps.filter((o) => !o.isClosed).length,
      kpi7_reviewsByRepAccount: snapshot.reviews.filter(
        (r) => r.accountOwnerId === repId && !r.isRemoved && inRangeIso(r.createdDate)
      ).length,
      kpi7_complaintsByRepOpp: snapshot.cases.filter(
        (c) => c.opportunityOwnerId === repId && inRangeIso(c.createdDate)
      ).length,
      kpi8_transactionsInPeriod: repTxns.filter((t) => inRangeIso(t.date)).length,
    },
    fieldCoverage: woFieldCoverage,
    snapshotMeta: {
      fetchedAt: snapshot.fetchedAt,
      isSandbox: snapshot.isSandbox,
      revenueFieldUsed: snapshot.revenueFieldUsed,
      workOrderRevenueField: snapshot.workOrderRevenueField,
      totalReps: snapshot.reps.length,
      fieldStandardReps: snapshot.reps.filter((r) => r.isFieldStandard).length,
      totalQuotas: snapshot.quotas.length,
      totalSubQuotas: snapshot.subQuotas.length,
      totalTransactions: snapshot.transactions.length,
      totalReviews: snapshot.reviews.length,
      totalCases: snapshot.cases.length,
    },
    validationGuide: {
      against: "PPP Salesforce FPRC_* report folder",
      kpi1: "Compare totalSales to FPRC_KPI1_Revenue_By_Rep filtered to this rep + fiscal period.",
      kpi2: "Compare avgGmPct to FPRC_KPI2 (uses Gross_Margin_Percent__c, EndDate-anchored).",
      kpi3: "Compare close-rate cells to FPRC_KPI3 self-gen / marketing split (Opp.LeadGroup__c).",
      kpi4: "Pricing/materials: re-run the same denominator in SF — restrict to LaborDaysActual > 0.",
      kpi5: "Appointments: COUNT(Opp) where AppointmentDate__c in period.",
      kpi6: "Stale pipeline: open Opps with Date_Estimate_Sent__c < TODAY-30.",
      kpi7: "Reviews by Account.OwnerId; Complaints by Opportunity.OwnerId (different anchors).",
      kpi8: "Transaction__c by WorkOrder.OwnerId, Date__c in period, record type buckets.",
      kpi9: "Commissions Earned = SUM(Payment_Out where Payee.Name = rep.Name) — watch for shadow Users.",
    },
  });
}
