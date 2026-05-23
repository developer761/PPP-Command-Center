import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Investigates the three blocker fields/objects revealed by the quota-coverage
 * diagnostic (only 0 of 29 reps had GM goal / Quarterly draw / SubQuota data):
 *
 *   1. Does `SubQuota__c` exist? What's its actual schema (field names,
 *      relationship names)? If it exists but has 0 records → PPP just doesn't
 *      use it. If the object/fields are different from our query → fix query.
 *
 *   2. Does `User.Gross_Margin_Goal_Percent__c` exist on PPP's User object?
 *      Or is it named something else (Gross_Margin_Goal__c / GM_Target__c)?
 *      Or do they not track per-rep GM targets in SF at all?
 *
 *   3. Does `User.Quarterly_Draw__c` exist? Or named differently
 *      (Quarterly_Draw_Amount__c / Draw__c / Commission_Draw__c)?
 *
 * Returns full describe() output + candidate field-name matches so Katie
 * can confirm what's actually in PPP's org. If the fields just don't exist,
 * we can either ask PPP IT to add them or skip those KPI cards entirely.
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

  const conn = await getSalesforceClient();

  // ── USER ── enumerate custom fields + check for GM Goal / Draw candidates
  let userResult: Record<string, unknown> = { error: "describe failed" };
  try {
    const userMeta = await conn.sobject("User").describe();
    const customFields = userMeta.fields
      .filter((f) => f.custom)
      .map((f) => ({ name: f.name, label: f.label, type: f.type }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Candidate matchers — look for ANY field that smells like GM target or draw.
    const gmGoalCandidates = customFields.filter((f) => {
      const n = f.name.toLowerCase();
      const l = f.label.toLowerCase();
      return (
        n.includes("gross_margin") ||
        n.includes("gm_") ||
        n.includes("margin_goal") ||
        n.includes("margin_target") ||
        l.includes("gross margin") ||
        l.includes("margin goal") ||
        l.includes("margin target")
      );
    });
    const drawCandidates = customFields.filter((f) => {
      const n = f.name.toLowerCase();
      const l = f.label.toLowerCase();
      return (
        n.includes("draw") ||
        n.includes("quarterly_") ||
        n.includes("commission_draw") ||
        n.includes("commission_base") ||
        l.includes("draw") ||
        l.includes("quarterly")
      );
    });

    // Sample one User record to see actual values (sanity-check FLS).
    let sampleUser: Record<string, unknown> | null = null;
    try {
      // Pull the named fields we care about + any candidate ones.
      const candidateNames = [
        "Gross_Margin_Goal_Percent__c",
        "Quarterly_Draw__c",
        ...gmGoalCandidates.map((c) => c.name),
        ...drawCandidates.map((c) => c.name),
      ];
      // Deduplicate; only request fields that actually exist on User.
      const existingNames = new Set(userMeta.fields.map((f) => f.name));
      const validNames = [...new Set(candidateNames)].filter((n) => existingNames.has(n));
      if (validNames.length > 0) {
        // Pick one rep that should have data — Sean Cunningham (highest quota)
        // or fall back to any active Standard.Field user.
        const sampleQuery = await conn.query<Record<string, unknown>>(
          `SELECT Id, Name, ${validNames.join(", ")} FROM User WHERE IsActive=true AND Profile.Name LIKE '%Standard.Field%' LIMIT 5`
        );
        sampleUser = {
          fieldsRequested: validNames,
          rows: sampleQuery.records,
        };
      }
    } catch (sampleErr) {
      sampleUser = { error: sampleErr instanceof Error ? sampleErr.message : String(sampleErr) };
    }

    userResult = {
      object: "User",
      totalCustomFields: customFields.length,
      gmGoalCandidates,
      drawCandidates,
      hasExpectedGmGoalField: customFields.some((f) => f.name === "Gross_Margin_Goal_Percent__c"),
      hasExpectedDrawField: customFields.some((f) => f.name === "Quarterly_Draw__c"),
      sampleUser,
      allCustomFields: customFields, // full list for browsing
    };
  } catch (err) {
    userResult = {
      object: "User",
      error: err instanceof Error ? err.message : String(err),
      hint: "If 'INSUFFICIENT_ACCESS', the OAuth user can't describe User — needs View Setup permission.",
    };
  }

  // ── SubQuota__c ── does it exist? what fields?
  let subQuotaResult: Record<string, unknown> = { error: "not attempted" };
  try {
    const sqMeta = await conn.sobject("SubQuota__c").describe();
    const customFields = sqMeta.fields
      .filter((f) => f.custom)
      .map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        ...(f.referenceTo && f.referenceTo.length > 0 ? { referenceTo: f.referenceTo, relationshipName: f.relationshipName } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Count rows without ANY filter — does PPP even use SubQuota?
    let totalRows = 0;
    let rowsForFY26 = 0;
    let sampleRow: Record<string, unknown> | null = null;
    try {
      const countAll = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM SubQuota__c`);
      totalRows = countAll.records[0]?.cnt ?? 0;
      // Sample 1 row to see actual values + field naming on parent
      if (totalRows > 0) {
        const customNames = customFields.slice(0, 20).map((f) => f.name).join(", ");
        const sample = await conn.query<Record<string, unknown>>(
          `SELECT Id, ${customNames} FROM SubQuota__c LIMIT 1`
        );
        sampleRow = sample.records[0] ?? null;
      }
      // Check if there's a FiscalMonth/Month/Period field that we should be using
      // to scope to a fiscal period.
      const monthLikeField = customFields.find(
        (f) => /month|period|fiscal/i.test(f.name) && (f.type === "double" || f.type === "int" || f.type === "string")
      );
      if (monthLikeField && totalRows > 0) {
        try {
          const cfyCount = await conn.query<{ cnt: number }>(
            `SELECT COUNT(Id) cnt FROM SubQuota__c WHERE CreatedDate = THIS_FISCAL_YEAR`
          );
          rowsForFY26 = cfyCount.records[0]?.cnt ?? 0;
        } catch {
          // ignore — diagnostic only
        }
      }
    } catch (countErr) {
      console.warn("[diag] SubQuota count failed:", countErr);
    }

    subQuotaResult = {
      object: "SubQuota__c",
      exists: true,
      totalCustomFields: customFields.length,
      totalRowsInOrg: totalRows,
      rowsCreatedThisFiscalYear: rowsForFY26,
      allCustomFields: customFields,
      sampleRow,
      ourCurrentQueryFields: [
        "Id", "TotalQuota__c", "TotalQuota__r.User__c", "TotalQuota__r.FY__c",
        "Assigned__c", "Attained__c", "FiscalMonth__c",
      ],
      diagnosis: totalRows === 0
        ? "PPP doesn't use SubQuota__c — 0 rows in entire org. Annual-only quota model. Scorecard KPI 1 should rely on TotalQuota__c only (already does as fallback)."
        : "SubQuota__c has rows but our query filter is dropping them all. Check ourCurrentQueryFields vs allCustomFields above for field-name mismatch.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    subQuotaResult = {
      object: "SubQuota__c",
      exists: false,
      error: msg,
      diagnosis: msg.includes("INVALID_TYPE") || msg.includes("does not exist")
        ? "SubQuota__c object does NOT exist in PPP's org. Remove the pull from queries.ts; scorecard KPI 1 will use TotalQuota__c annual only (which is what PPP has)."
        : msg.includes("INSUFFICIENT_ACCESS")
        ? "OAuth user doesn't have read access to SubQuota__c. Ask PPP IT to grant FLS on the Sales_Team_Member permission set."
        : "Unknown error — see message.",
    };
  }

  // ── TotalQuota__c ── sanity-check on rows we DID pull
  let totalQuotaResult: Record<string, unknown> = { error: "not attempted" };
  try {
    const tqMeta = await conn.sobject("TotalQuota__c").describe();
    const customFields = tqMeta.fields
      .filter((f) => f.custom)
      .map((f) => ({ name: f.name, label: f.label, type: f.type }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Look for "real quota set" — non-zero, non-null, current FY
    let realQuotaCount = 0;
    let zeroQuotaCount = 0;
    try {
      const real = await conn.query<{ cnt: number }>(
        `SELECT COUNT(Id) cnt FROM TotalQuota__c WHERE Allocation__c='Owner' AND Status__c='Active' AND QuotaType__c='Field_Member' AND QuotaAssigned__c > 0`
      );
      realQuotaCount = real.records[0]?.cnt ?? 0;
      const zero = await conn.query<{ cnt: number }>(
        `SELECT COUNT(Id) cnt FROM TotalQuota__c WHERE Allocation__c='Owner' AND Status__c='Active' AND QuotaType__c='Field_Member' AND QuotaAssigned__c = 0`
      );
      zeroQuotaCount = zero.records[0]?.cnt ?? 0;
    } catch (cntErr) {
      console.warn("[diag] TotalQuota count failed:", cntErr);
    }

    totalQuotaResult = {
      object: "TotalQuota__c",
      realQuotaRowsAcrossAllFY: realQuotaCount,
      placeholderZeroRowsAcrossAllFY: zeroQuotaCount,
      allCustomFields: customFields,
      diagnosis: zeroQuotaCount > realQuotaCount
        ? "More $0 placeholder rows than real quotas. Either reps were never assigned real quota dollars, or the workflow leaves rows at $0 by default."
        : "Healthy mix — real quotas outnumber $0 placeholders.",
    };
  } catch (err) {
    totalQuotaResult = {
      object: "TotalQuota__c",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    investigatingWhy: "Why did /api/admin/quota-coverage show 0 reps with full scorecard data?",
    user: userResult,
    subQuota: subQuotaResult,
    totalQuota: totalQuotaResult,
    nextSteps: {
      ifGmGoalFieldDoesNotExist: "Ask Katie if PPP tracks per-rep GM targets at all. If not, remove the 'vs target' sub-stat from the GM scorecard card.",
      ifGmGoalFieldExistsAsDifferentName: "Update queries.ts SfUserRow type + usersPromise SELECT to use the correct field name found in user.gmGoalCandidates above. Then rebuild.",
      ifDrawFieldDoesNotExist: "Same as GM — ask Katie if quarterly draws are tracked in SF. If not, remove the Draw line from the Commissions card and just show 'Earned' alone.",
      ifSubQuotaDoesNotExist: "Remove the SubQuota__c pull from queries.ts. Annual TotalQuota__c is all PPP uses. The quarterly goal in the scorecard can be derived as (annual quota / 4).",
      ifSubQuotaExistsButZeroRows: "PPP just doesn't fill monthly sub-quotas. Same fix — use annual/4 for quarterly goal.",
      forZeroPlaceholderQuotas: "Update quota-coverage to treat hasTotalQuotaCFY=true with quotaAmount=$0 as effectively 'no quota set'. Currently shipped fix in queries.ts treats 0 as 'set'.",
    },
  });
}
