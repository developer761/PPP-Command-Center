import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Investigates SF custom-field naming for fields the codebase needs:
 *   - User: GM Goal + Quarterly Draw (originally why this endpoint was built)
 *   - SubQuota__c + TotalQuota__c (scorecard quota investigation)
 *   - WorkOrder: WORKER NOTES field (Karan 2026-06-09 — `Description` is the
 *     scope template, NOT what workers write per-WO; need the real field).
 *
 * For WorkOrder: pass `?woId=<id>` to also sample one real row with each
 * candidate field SELECTed, so you can see actual content (e.g. the
 * J. Carleton WO `00303832` Karan flagged). Without `woId` you only get
 * the field list; with it you get values.
 *
 * Returns full describe() output + candidate matches so admin can confirm
 * what's actually in PPP's org.
 *
 * Admin-only.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const woId = url.searchParams.get("woId");
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

  // ── WorkOrder ── find PPP's actual worker-notes custom field. Standard
  // WorkOrder.Description is the scope-template boilerplate, NOT notes the
  // worker writes (Karan 2026-06-09). Patterns: anything matching
  // note/instruction/comment/scope/crew/foreman/internal/painter/production/
  // special. Pass `?woId=<id>` to also SELECT each candidate value from a
  // real row (otherwise field list only).
  let workOrderResult: Record<string, unknown> = { error: "not attempted" };
  try {
    const woMeta = await conn.sobject("WorkOrder").describe();
    const customFields = woMeta.fields
      .filter((f) => f.custom)
      .map((f) => ({ name: f.name, label: f.label, type: f.type }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Also include standard text-area fields — workers might use Tasks or
    // standard Description fields. Description we know is template; pull
    // anything else standard that looks like notes.
    const allTextish = woMeta.fields.filter((f) =>
      f.type === "textarea" || f.type === "string" || f.type === "encryptedstring"
    );

    const noteCandidates = [...customFields, ...allTextish.map((f) => ({
      name: f.name, label: f.label, type: f.type,
    }))].filter((f) => {
      const n = f.name.toLowerCase();
      const l = f.label.toLowerCase();
      return (
        /note|instruction|comment|scope|crew|foreman|internal|painter|production|special|memo|context|estimate|walkthrough|walkthru|measure|dimension|sqft|sq_ft|footage|size|field|site|takeoff|estimator|visit/.test(n) ||
        /note|instruction|comment|scope|crew|foreman|internal|painter|production|special|memo|context|estimate|walkthrough|walkthru|measure|dimension|sqft|sq_ft|footage|size|field|site|takeoff|estimator|visit/.test(l)
      );
    });
    // Dedupe by name
    const seen = new Set<string>();
    const dedupedCandidates = noteCandidates.filter((f) => {
      if (seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    });

    // If woId provided, sample one real row. We pull EVERY text-shaped
    // custom field (textarea / string / encryptedstring) PLUS Description
    // + Subject — not just the pattern-matched note candidates. PPP may
    // be writing per-WO context in fields that don't match note/scope/
    // instruction patterns (e.g. "Job_Summary__c", "Walkthrough_Recap__c").
    // Returning every value lets admin scan for non-null content.
    //
    // SOQL Id-shape gotcha: `WHERE Id = '00303832'` throws "invalid ID
    // field" because IDs must be 15/18 alphanumeric chars. Detect format
    // + use the right clause.
    let sampleWo: Record<string, unknown> | null = null;
    if (woId && /^[A-Za-z0-9]+$/.test(woId)) {
      const isIdShape = /^[A-Za-z0-9]{15}$|^[A-Za-z0-9]{18}$/.test(woId);
      const where = isIdShape
        ? `Id = '${woId}'`
        : `WorkOrderNumber = '${woId}'`;
      const allTextFields = woMeta.fields
        .filter((f) => f.custom && (f.type === "textarea" || f.type === "string" || f.type === "encryptedstring"))
        .map((f) => f.name);
      try {
        const fields = ["Id", "WorkOrderNumber", "Description", "Subject", ...allTextFields];
        // Dedupe in case anything overlaps + standard SF fields
        const uniqueFields = [...new Set(fields)];
        const q = await conn.query<Record<string, unknown>>(
          `SELECT ${uniqueFields.join(", ")} FROM WorkOrder WHERE ${where} LIMIT 1`
        );
        const row = q.records[0] ?? null;
        // Auto-surface non-null fields so admin doesn't have to eyeball
        // the whole dump. Standard SF system fields + the ones we know
        // about already are noisy — caller wants to find content they
        // didn't know about.
        let nonNullFields: Array<{ name: string; value: unknown }> = [];
        if (row) {
          for (const [k, v] of Object.entries(row)) {
            if (k === "attributes") continue;
            if (v == null) continue;
            if (typeof v === "string" && v.trim().length === 0) continue;
            nonNullFields.push({ name: k, value: v });
          }
        }
        sampleWo = {
          fieldsRequested: uniqueFields,
          matchedBy: isIdShape ? "Id" : "WorkOrderNumber",
          totalTextFieldsRequested: allTextFields.length,
          row,
          nonNullFields,
          hint: nonNullFields.length === 0
            ? "Every text field returned null/empty. This WO genuinely has no per-WO worker notes. Either workers don't use this WO's note fields, or they write context elsewhere (Tasks/Notes — see relatedNotes block below)."
            : `Found ${nonNullFields.length} non-null text field(s). Scan the nonNullFields list above — the one with worker-written content is your worker-notes field.`,
        };
      } catch (sampleErr) {
        sampleWo = { error: sampleErr instanceof Error ? sampleErr.message : String(sampleErr) };
      }
    }

    workOrderResult = {
      object: "WorkOrder",
      totalCustomFields: customFields.length,
      noteCandidates: dedupedCandidates,
      hint: dedupedCandidates.length === 0
        ? "No custom field on WorkOrder matches note/scope/instruction patterns. Workers may write per-WO notes via the SF Note / ContentNote object (related records, not a field on WO itself) or via Tasks. Check WorkOrder.ChildRelationships from /api/admin/wo-debug for Notes/Tasks subobjects."
        : `Found ${dedupedCandidates.length} candidate field(s). Pass ?woId=<wo-id-or-number> to sample real values (e.g. ?woId=00303832 for the J. Carleton WO Karan flagged).`,
      sampleWo,
    };
  } catch (err) {
    workOrderResult = {
      object: "WorkOrder",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── WOLI-level notes ── PPP workers might write per-room notes on the
  // WorkOrderLineItem itself instead of the WO. ColorNotes__c is already
  // pulled (we just restored it 2026-06-09) but there may be others.
  let woliResult: Record<string, unknown> = { error: "not attempted" };
  try {
    const woliMeta = await conn.sobject("WorkOrderLineItem").describe();
    const customFields = woliMeta.fields
      .filter((f) => f.custom)
      .map((f) => ({ name: f.name, label: f.label, type: f.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const noteCandidates = customFields.filter((f) => {
      const n = f.name.toLowerCase();
      const l = f.label.toLowerCase();
      return (
        /note|instruction|comment|scope|crew|foreman|internal|painter|production|special|memo|context|estimate|walkthrough|walkthru|measure|dimension|sqft|sq_ft|footage|size|field|site|takeoff|estimator|visit/.test(n) ||
        /note|instruction|comment|scope|crew|foreman|internal|painter|production|special|memo|context|estimate|walkthrough|walkthru|measure|dimension|sqft|sq_ft|footage|size|field|site|takeoff|estimator|visit/.test(l)
      );
    });
    // Sample WOLI rows for THIS WO with EVERY text field's value, so we
    // can find estimator measurement-notes content that may be at the
    // WOLI level (per-room) rather than the WO level (whole job). PPP
    // estimators write per-room dimensions/sqft/site-condition notes;
    // those likely live on the line item, not the parent WO.
    const allWoliTextFields = woliMeta.fields
      .filter((f) => f.custom && (f.type === "textarea" || f.type === "string" || f.type === "encryptedstring"))
      .map((f) => f.name);
    let sampleWoliRows: unknown = null;
    if (woId && /^[A-Za-z0-9]+$/.test(woId) && allWoliTextFields.length > 0) {
      const isIdShape = /^[A-Za-z0-9]{15}$|^[A-Za-z0-9]{18}$/.test(woId);
      try {
        // Resolve WO id first so we can filter WOLI rows by it.
        const woIdQ = await conn.query<{ Id: string }>(
          `SELECT Id FROM WorkOrder WHERE ${isIdShape ? `Id = '${woId}'` : `WorkOrderNumber = '${woId}'`} LIMIT 1`
        );
        const resolvedWoId = woIdQ.records[0]?.Id ?? null;
        if (resolvedWoId) {
          const fields = ["Id", "AreaLabel__c", ...allWoliTextFields];
          const uniqueFields = [...new Set(fields)];
          const rows = await conn.query<Record<string, unknown>>(
            `SELECT ${uniqueFields.join(", ")} FROM WorkOrderLineItem WHERE WorkOrderId = '${resolvedWoId}' LIMIT 5`
          );
          const enriched = rows.records.map((row) => {
            const nonNullFields: Array<{ name: string; value: unknown }> = [];
            for (const [k, v] of Object.entries(row)) {
              if (k === "attributes") continue;
              if (v == null) continue;
              if (typeof v === "string" && v.trim().length === 0) continue;
              nonNullFields.push({ name: k, value: v });
            }
            return { row, nonNullFields };
          });
          sampleWoliRows = {
            resolvedWoId,
            totalTextFieldsRequested: allWoliTextFields.length,
            rowsReturned: rows.records.length,
            rows: enriched,
            hint:
              enriched.length === 0
                ? "No WOLI rows found for this WO."
                : "Each row's nonNullFields lists every text field with content. The estimator's measurement notes (dimensions / sqft / site context) are likely in one of these.",
          };
        }
      } catch (sampleErr) {
        sampleWoliRows = { error: sampleErr instanceof Error ? sampleErr.message : String(sampleErr) };
      }
    }

    woliResult = {
      object: "WorkOrderLineItem",
      totalCustomFields: customFields.length,
      totalTextFields: allWoliTextFields.length,
      noteCandidates,
      sampleRows: sampleWoliRows,
      hint: "ColorNotes__c is already pulled. If other candidates or non-null text fields surface here, they may be worker-internal notes worth pulling into the snapshot too. Pass ?woId= to sample real values from up to 5 line items on a specific WO.",
    };
  } catch (err) {
    woliResult = {
      object: "WorkOrderLineItem",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Related-record notes paths ── workers may write notes via standard
  // SF objects attached to the WO, not on the WO itself. When ?woId= is
  // passed, probe each candidate path for actual records linked to that WO.
  // Candidates:
  //   - Note (legacy) — ParentId = WO.Id, Body has the text
  //   - ContentNote (modern) — joined via ContentDocumentLink.LinkedEntityId
  //   - Task — WhatId = WO.Id, Description has the text (Activity History)
  //   - FeedItem — ParentId = WO.Id (Chatter posts)
  let relatedNotesResult: Record<string, unknown> = woId
    ? { hint: "Probed for related-record notes on this WO." }
    : { hint: "Pass ?woId= to also probe related-record paths (Note / ContentNote / Task / FeedItem)." };

  if (woId && /^[A-Za-z0-9]+$/.test(woId)) {
    // Resolve WO.Id first if user passed a WorkOrderNumber. Same SOQL
    // Id-shape gotcha as the sampleWo query above — Id literals MUST be
    // 15 or 18 alphanumeric chars or SF throws "invalid ID field" and
    // the whole resolution fails. Pick the right predicate based on shape.
    let resolvedWoId: string | null = null;
    const isIdShape = /^[A-Za-z0-9]{15}$|^[A-Za-z0-9]{18}$/.test(woId);
    const resolveWhere = isIdShape
      ? `Id = '${woId}'`
      : `WorkOrderNumber = '${woId}'`;
    try {
      const woIdQ = await conn.query<{ Id: string }>(
        `SELECT Id FROM WorkOrder WHERE ${resolveWhere} LIMIT 1`
      );
      resolvedWoId = woIdQ.records[0]?.Id ?? null;
    } catch {
      // ignore — diagnostic only
    }

    if (resolvedWoId) {
      const probes: Record<string, unknown> = { resolvedWoId };

      // Note (legacy)
      try {
        const q = await conn.query<Record<string, unknown>>(
          `SELECT Id, Title, Body, CreatedDate, CreatedById FROM Note WHERE ParentId = '${resolvedWoId}' ORDER BY CreatedDate DESC LIMIT 10`
        );
        probes.legacyNotes = { count: q.records.length, records: q.records };
      } catch (e) {
        probes.legacyNotes = { error: e instanceof Error ? e.message : String(e) };
      }

      // ContentNote (modern)
      try {
        const q = await conn.query<Record<string, unknown>>(
          `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.LatestPublishedVersion.TextPreview FROM ContentDocumentLink WHERE LinkedEntityId = '${resolvedWoId}' LIMIT 10`
        );
        probes.contentNotes = { count: q.records.length, records: q.records };
      } catch (e) {
        probes.contentNotes = { error: e instanceof Error ? e.message : String(e) };
      }

      // Tasks (Activity History) — workers often write call/visit notes here
      try {
        const q = await conn.query<Record<string, unknown>>(
          `SELECT Id, Subject, Description, ActivityDate, Status, CreatedDate, OwnerId FROM Task WHERE WhatId = '${resolvedWoId}' ORDER BY CreatedDate DESC LIMIT 10`
        );
        probes.tasks = { count: q.records.length, records: q.records };
      } catch (e) {
        probes.tasks = { error: e instanceof Error ? e.message : String(e) };
      }

      // Chatter feed (FeedItem). SF restricts FeedItem queries — `WHERE
      // ParentId = '...'` throws "FeedItem requires a filter by Id". The
      // workaround is to use the Connect API's chatter/feeds endpoint
      // OR to filter by Id IN (subquery) via FeedAttachment or related
      // helper objects. Cheapest path: query for the Account's feed
      // when present, or skip with a clearer message. For now, just
      // surface the restriction so the caller knows it's a SF API quirk,
      // not a real "no Chatter posts" answer.
      try {
        // Best-effort: use the Connect API path that doesn't have the
        // restriction. If jsforce doesn't expose it, fall back to the
        // typed error so admin knows what's going on.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feedFn = (conn as any).chatter?.resource?.(`/feeds/record/${resolvedWoId}/feed-items`);
        if (feedFn && typeof feedFn.retrieve === "function") {
          const feedRes = await feedFn.retrieve();
          probes.chatterFeed = { count: Array.isArray((feedRes as { items?: unknown }).items) ? ((feedRes as { items: unknown[] }).items.length) : 0, raw: feedRes };
        } else {
          probes.chatterFeed = {
            error: "FeedItem direct SOQL is restricted by SF (requires filter by Id). Chatter Connect API path also not available in this jsforce version. If workers DO use Chatter on WOs we'd need to wire the Connect API via a custom resource — but legacyNotes/contentNotes/tasks above cover the common cases.",
          };
        }
      } catch (e) {
        probes.chatterFeed = { error: e instanceof Error ? e.message : String(e) };
      }

      relatedNotesResult = probes;
    } else {
      relatedNotesResult = { error: `Could not resolve WO id from "${woId}".` };
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    investigatingWhy: "Why did /api/admin/quota-coverage show 0 reps with full scorecard data? + Find PPP's worker-notes WorkOrder field (Karan 2026-06-09).",
    user: userResult,
    subQuota: subQuotaResult,
    totalQuota: totalQuotaResult,
    workOrder: workOrderResult,
    workOrderLineItem: woliResult,
    relatedNotes: relatedNotesResult,
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
