import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * One-shot diagnostic: hits Salesforce DIRECTLY and reports how many
 * WorkOrderLineItem rows actually have Sq_Footage__c (or its fallback
 * Wall_Surface_Area__c) populated, vs. NULL / 0.
 *
 * Karan 2026-06-13: Materials view shows "Manual qty" badges on a lot of
 * WOs. Question: is the underlying SF data really that sparse, or is the
 * command-center failing to read it? This endpoint answers definitively
 * by querying SF directly and counting fill rates.
 *
 * Returns:
 *   - Overall: total WOLI rows, % with sqFt, % with wallArea, % with EITHER
 *   - Per-WO breakdown: number/% of WOLI rows per WO that have sqFt
 *
 * Admin-only.
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
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Number.parseInt(limitParam ?? "500", 10) || 500, 2000);

  const conn = await getSalesforceClient();
  const startedAt = Date.now();

  // Pull the most-recent N OPEN WOs (Status not in completed/canceled set),
  // joined to their WOLIs. We mirror the materials-page status filter so the
  // probe answers the question the user actually has: "of the WOs I see in
  // Materials Ordering today, how many actually have sqft in SF?"
  //
  // Note: keep this in lockstep with materials.ts `workTypeRequiresMaterials`
  // and the WOLI status filter in queries.ts. If those drift the probe
  // numbers will drift too, but for a first-cut signal on data quality this
  // is good enough.

  type WoLi = {
    Id: string;
    WorkOrderId: string;
    AreaLabel__c: string | null;
    Status: string | null;
    Sq_Footage__c: number | null;
    Wall_Surface_Area__c: number | null;
  };
  type Wo = {
    Id: string;
    WorkOrderNumber: string;
    Subject: string | null;
    Status: string;
    CreatedDate: string;
    AccountId: string | null;
    Account: { Name: string | null } | null;
  };

  // Pull recent OPEN WOs.
  const woRes = await conn.query<Wo>(
    `SELECT Id, WorkOrderNumber, Subject, Status, CreatedDate, AccountId, Account.Name
     FROM WorkOrder
     WHERE Status NOT IN ('Completed', 'Canceled', 'Closed', 'Cannot Complete')
     ORDER BY CreatedDate DESC
     LIMIT ${limit}`
  );
  const wos: Wo[] = woRes.records;
  const woIds = wos.map((w) => w.Id);
  if (woIds.length === 0) {
    return NextResponse.json({ wos_found: 0, message: "No open WOs returned by SF." });
  }

  // Pull all WOLI rows for those WOs.
  const liRecords: WoLi[] = [];
  const BATCH = 200;
  for (let i = 0; i < woIds.length; i += BATCH) {
    const chunk = woIds.slice(i, i + BATCH);
    const inClause = chunk.map((id) => `'${id}'`).join(",");
    let res = await conn.query<WoLi>(
      `SELECT Id, WorkOrderId, AreaLabel__c, Status, Sq_Footage__c, Wall_Surface_Area__c
       FROM WorkOrderLineItem
       WHERE WorkOrderId IN (${inClause})`
    );
    liRecords.push(...res.records);
    while (!res.done && res.nextRecordsUrl) {
      res = await conn.queryMore<WoLi>(res.nextRecordsUrl);
      liRecords.push(...res.records);
    }
  }

  // Same filter materials view uses.
  const HIDDEN_STATUSES = new Set([
    "Canceled",
    "Cancelled",
    "Closed",
    "Completed",
    "Cannot Complete",
    "Pending REMOVE",
  ]);
  const visibleLi = liRecords.filter(
    (li) => !HIDDEN_STATUSES.has((li.Status ?? "").trim())
  );

  // Overall counts.
  const total = visibleLi.length;
  const hasSqft = visibleLi.filter((li) => (li.Sq_Footage__c ?? 0) > 0).length;
  const hasWallArea = visibleLi.filter((li) => (li.Wall_Surface_Area__c ?? 0) > 0).length;
  const hasEither = visibleLi.filter(
    (li) => (li.Sq_Footage__c ?? 0) > 0 || (li.Wall_Surface_Area__c ?? 0) > 0
  ).length;

  // Per-WO breakdown.
  const byWo = new Map<string, { rows: number; withSqft: number; withWall: number; withEither: number }>();
  for (const li of visibleLi) {
    const m = byWo.get(li.WorkOrderId) ?? { rows: 0, withSqft: 0, withWall: 0, withEither: 0 };
    m.rows++;
    if ((li.Sq_Footage__c ?? 0) > 0) m.withSqft++;
    if ((li.Wall_Surface_Area__c ?? 0) > 0) m.withWall++;
    if ((li.Sq_Footage__c ?? 0) > 0 || (li.Wall_Surface_Area__c ?? 0) > 0) m.withEither++;
    byWo.set(li.WorkOrderId, m);
  }

  // WO-level bucket: WO is "fully covered" only if EVERY visible WOLI has sqft.
  let wosFullyCovered = 0;
  let wosFullyMissing = 0;
  let wosPartial = 0;
  let wosWithZeroRooms = 0;
  for (const wo of wos) {
    const m = byWo.get(wo.Id);
    if (!m || m.rows === 0) {
      wosWithZeroRooms++;
      continue;
    }
    if (m.withEither === m.rows) wosFullyCovered++;
    else if (m.withEither === 0) wosFullyMissing++;
    else wosPartial++;
  }

  // Sample 25 WOs that are FULLY missing sqft — give Karan concrete examples
  // to spot-check in SF.
  const fullyMissingSample = wos
    .filter((wo) => {
      const m = byWo.get(wo.Id);
      return m && m.rows > 0 && m.withEither === 0;
    })
    .slice(0, 25)
    .map((wo) => ({
      wo_number: wo.WorkOrderNumber,
      subject: wo.Subject,
      account: wo.Account?.Name ?? null,
      visible_rows: byWo.get(wo.Id)!.rows,
    }));

  const ms = Date.now() - startedAt;
  return NextResponse.json({
    elapsed_ms: ms,
    sample_size: { wos_pulled: wos.length, limit_param: limit },
    visible_wolis: {
      total,
      with_sqft: hasSqft,
      with_wall_area: hasWallArea,
      with_either: hasEither,
      pct_with_sqft: total > 0 ? +((hasSqft / total) * 100).toFixed(1) : 0,
      pct_with_wall_area: total > 0 ? +((hasWallArea / total) * 100).toFixed(1) : 0,
      pct_with_either: total > 0 ? +((hasEither / total) * 100).toFixed(1) : 0,
    },
    wos: {
      total: wos.length,
      with_zero_visible_rooms: wosWithZeroRooms,
      fully_covered: wosFullyCovered,
      fully_missing: wosFullyMissing,
      partial: wosPartial,
      pct_fully_missing:
        wos.length > 0 ? +((wosFullyMissing / wos.length) * 100).toFixed(1) : 0,
    },
    note:
      "If pct_with_either is low (e.g. <30%), the data really is missing in SF — not a bug in this command-center. The Materials view falls back to manual qty entry when sqft is zero.",
    fully_missing_sample: fullyMissingSample,
  });
}
