import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { currentFY } from "@/lib/fiscal-year";

/**
 * Diagnostic — for every field-standard rep (Profile `*Standard.Field`),
 * show whether they have:
 *   - A TotalQuota__c row for the current FY (drives the "% to Goal" card)
 *   - SubQuota__c monthly rows for the current FY (richer goal granularity)
 *   - User.Gross_Margin_Goal_Percent__c set (drives KPI 2 "vs target")
 *   - User.Quarterly_Draw__c set (drives KPI 9 commission "under/overpaid")
 *
 * Lets Katie / PPP IT see at-a-glance which reps need data entered in SF
 * before the corresponding scorecard cards light up. Until populated, the
 * scorecard renders "No quota set" / "No GM target" / "No draw" rather than
 * misleading 0% / $0 / Infinity.
 *
 * Admin-only.
 */
export async function GET() {
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

  const snapshot = await loadSalesforceSnapshot();
  const fy = currentFY();

  // Index quotas + sub-quotas by userId for fast lookup. PPP has ~11 quota
  // rows populated as $0 placeholders (workflow created the row but manager
  // hasn't entered the dollar amount). Track real ($ > 0) and placeholder
  // ($0) separately so Katie sees which reps need only the dollar amount
  // filled in vs which need the whole quota row created.
  const quotaByUser = new Map<string, number>(); // userId → quotaAssigned for current FY (any value, incl 0)
  const placeholderQuotaUsers = new Set<string>(); // users with quota row but $0
  for (const q of snapshot.quotas) {
    if (q.fy !== fy) continue;
    quotaByUser.set(q.userId, q.quotaAssigned);
    if (q.quotaAssigned === 0) placeholderQuotaUsers.add(q.userId);
  }
  const subQuotaCountByUser = new Map<string, number>();
  for (const sq of snapshot.subQuotas) {
    if (sq.fy === fy) {
      subQuotaCountByUser.set(sq.userId, (subQuotaCountByUser.get(sq.userId) ?? 0) + 1);
    }
  }

  const fieldReps = snapshot.reps.filter((r) => r.isFieldStandard);
  const rows = fieldReps.map((r) => {
    const quotaAmount = quotaByUser.get(r.id) ?? null;
    const isPlaceholder = placeholderQuotaUsers.has(r.id);
    const hasRealQuota = quotaAmount !== null && quotaAmount > 0;
    const subQuotaCount = subQuotaCountByUser.get(r.id) ?? 0;

    const missing: string[] = [];
    // Effective check — treat $0 placeholder as "needs the dollar amount filled in"
    if (!hasRealQuota) {
      missing.push(isPlaceholder ? "TotalQuota__c $ amount (row exists, $0)" : "TotalQuota__c row");
    }
    if (subQuotaCount === 0) missing.push("SubQuota__c (monthly)");
    if (r.gmGoalPercent === null) missing.push("Gross_Margin_Goal_Percent__c");
    if (r.quarterlyDraw === null) missing.push("Quarterly_Draw__c");

    return {
      repId: r.id,
      name: r.name,
      email: r.email,
      profileName: r.profileName,
      hasTotalQuotaRow: quotaAmount !== null,
      hasRealQuota,                    // row exists AND > $0
      isPlaceholderQuota: isPlaceholder, // row exists but $0
      totalQuotaAmount: quotaAmount,
      subQuotaCountCFY: subQuotaCount,
      hasGmGoal: r.gmGoalPercent !== null,
      gmGoalPercent: r.gmGoalPercent,
      hasQuarterlyDraw: r.quarterlyDraw !== null,
      quarterlyDraw: r.quarterlyDraw,
      readyForFullScorecard: missing.length === 0,
      missing,
    };
  });

  // Summary rollup — distinguish "row exists" from "row has real $ amount"
  const total = rows.length;
  const summary = {
    fy,
    totalFieldReps: total,
    withTotalQuotaRow: rows.filter((r) => r.hasTotalQuotaRow).length,
    withRealQuota: rows.filter((r) => r.hasRealQuota).length,
    withPlaceholderZeroQuota: rows.filter((r) => r.isPlaceholderQuota).length,
    withSubQuotaCFY: rows.filter((r) => r.subQuotaCountCFY > 0).length,
    withGmGoal: rows.filter((r) => r.hasGmGoal).length,
    withQuarterlyDraw: rows.filter((r) => r.hasQuarterlyDraw).length,
    readyForFullScorecard: rows.filter((r) => r.readyForFullScorecard).length,
  };

  // Sort so reps missing the most data are at the top — that's where Katie
  // needs to focus first.
  rows.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));

  return NextResponse.json({
    snapshotMeta: {
      fetchedAt: snapshot.fetchedAt,
      isSandbox: snapshot.isSandbox,
      totalQuotasPulled: snapshot.quotas.length,
      totalSubQuotasPulled: snapshot.subQuotas.length,
    },
    summary,
    reps: rows,
    actionsForKatie: {
      blocker_for_pct_to_goal_card: "Reps with hasTotalQuotaCFY=false won't see a % to Goal value — they get a 'No quota set' message instead.",
      blocker_for_gm_vs_target: "Reps with hasGmGoal=false see 'No GM target set on this user' on the KPI 2 card.",
      blocker_for_commissions_card: "Reps with hasQuarterlyDraw=false see 'No Quarterly_Draw__c set on this user'.",
      fix: "In Salesforce: Setup → Users → click each rep → fill the Gross_Margin_Goal_Percent__c + Quarterly_Draw__c fields. For quotas, create a TotalQuota__c record per rep per FY with Allocation__c='Owner', Status__c='Active', QuotaType__c='Field_Member'.",
    },
  });
}
