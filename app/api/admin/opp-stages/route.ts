import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * Diagnostic — distribution of Opportunity.StageName values + IsWon / IsClosed
 * flags across the snapshot's opp universe. Investigates Karan's flag that
 * the rep "Conversion Rate" KPI shows ~98.7%, which suggests either:
 *   1. PPP's data really has ~98% won-to-created ratio (per integration
 *      guide §4.5: "PPP's stages have no 'Closed Lost' type, so IsWon /
 *      IsClosed reads ~100%"), or
 *   2. There IS a signal for "lost" deals we're not using (e.g., a Status
 *      column, a stage name suffix, an `Is_Dead__c` custom field)
 *
 * Use this to enumerate the actual signal so we can build a more honest
 * close-rate metric for PPP staff. Returns:
 *   - stages: { stageName: { total, won, closed, openExample? } }
 *   - rollups: total count + IsWon% + IsClosed%
 *   - perRep[]: same numbers grouped by ownerId (top 10 reps by opp count)
 *   - sampleNonWonClosed: 5 opp ids where IsClosed=true && IsWon=false (if any)
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
  const total = snapshot.opportunities.length;

  const stages = new Map<string, {
    total: number;
    won: number;
    closed: number;
    openSample?: string;
    closedNotWonSample?: string;
  }>();

  let totalWon = 0;
  let totalClosed = 0;
  let totalClosedNotWon = 0;
  const closedNotWonSample: Array<{ id: string; stageName: string; accountName: string | null; amount: number }> = [];

  for (const o of snapshot.opportunities) {
    const s = o.stageName ?? "(null)";
    const row = stages.get(s) ?? { total: 0, won: 0, closed: 0 };
    row.total += 1;
    if (o.isWon) row.won += 1;
    if (o.isClosed) row.closed += 1;
    if (!o.isClosed && !row.openSample) row.openSample = o.id;
    if (o.isClosed && !o.isWon && !row.closedNotWonSample) row.closedNotWonSample = o.id;
    stages.set(s, row);

    if (o.isWon) totalWon += 1;
    if (o.isClosed) totalClosed += 1;
    if (o.isClosed && !o.isWon) {
      totalClosedNotWon += 1;
      if (closedNotWonSample.length < 10) {
        closedNotWonSample.push({
          id: o.id,
          stageName: o.stageName,
          accountName: o.accountName,
          amount: o.amount,
        });
      }
    }
  }

  // Per-rep rollup. Computes THREE close-rate definitions side-by-side so
  // Katie can compare:
  //   - oppsWithWO         = OLD naive proxy (any linked WO; includes Estimate
  //                          WOs so trends ~100%)
  //   - oppsWithRealSaleWO = NEW filter (Estimate / Cancelled WOs excluded —
  //                          this is what the leaderboard now uses)
  //   - oppsWon            = IsWon flag (KPI 3 spec definition; PPP's data
  //                          quirk makes this ~95%+ too)
  // Mirrors lib/salesforce/derive.ts isRealSaleWO() — kept in sync via the
  // same WorkType + Status filter.
  const oppsWithWOSet = new Set(snapshot.workOrders.map((w) => w.opportunityId).filter(Boolean));
  const oppsWithRealSaleSet = new Set<string>();
  for (const w of snapshot.workOrders) {
    if (!w.opportunityId) continue;
    const wt = (w.workTypeName ?? "").toLowerCase();
    if (wt.includes("estimate") || wt.includes("appointment") || wt.includes("inspection") || wt.includes("consultation")) continue;
    const s = (w.status ?? "").toLowerCase();
    if (s.includes("cancel") || s.includes("void") || s.includes("abandon") || s.includes("dead") || s.includes("lost")) continue;
    oppsWithRealSaleSet.add(w.opportunityId);
  }

  const perRep = new Map<string, {
    name: string;
    oppsTotal: number;
    oppsWon: number;
    oppsClosed: number;
    oppsWithWO: number;
    oppsWithRealSaleWO: number;
  }>();
  const repName = new Map(snapshot.reps.map((r) => [r.id, r.name]));
  for (const o of snapshot.opportunities) {
    if (!o.ownerId) continue;
    const row = perRep.get(o.ownerId) ?? {
      name: repName.get(o.ownerId) ?? "(non-rep owner)",
      oppsTotal: 0,
      oppsWon: 0,
      oppsClosed: 0,
      oppsWithWO: 0,
      oppsWithRealSaleWO: 0,
    };
    row.oppsTotal += 1;
    if (o.isWon) row.oppsWon += 1;
    if (o.isClosed) row.oppsClosed += 1;
    if (oppsWithWOSet.has(o.id)) row.oppsWithWO += 1;
    if (oppsWithRealSaleSet.has(o.id)) row.oppsWithRealSaleWO += 1;
    perRep.set(o.ownerId, row);
  }

  return NextResponse.json({
    snapshotMeta: {
      fetchedAt: snapshot.fetchedAt,
      isSandbox: snapshot.isSandbox,
      totalOpps: total,
    },
    rollup: {
      totalOpps: total,
      totalWon,
      totalClosed,
      totalClosedNotWon,
      pctIsWon: total > 0 ? +(totalWon / total * 100).toFixed(1) : 0,
      pctIsClosed: total > 0 ? +(totalClosed / total * 100).toFixed(1) : 0,
      pctClosedNotWon: total > 0 ? +(totalClosedNotWon / total * 100).toFixed(1) : 0,
    },
    // Key question — does IsWon ever differ from IsClosed? If pctClosedNotWon
    // is 0 across the board, PPP has no "lost deal" representation in their
    // standard SF fields and we need to either:
    //   1. Find a stage-name signal (look at this response's stages map),
    //   2. Find a custom field (run /api/admin/opp-fields to enumerate), or
    //   3. Accept that the close-rate metric in PPP's data IS ~100% and
    //      relabel the Conversion Rate KPI accordingly.
    closedNotWonSample,
    stages: Array.from(stages.entries())
      .map(([name, row]) => ({
        stageName: name,
        ...row,
        pctWon: row.total > 0 ? +(row.won / row.total * 100).toFixed(1) : 0,
      }))
      .sort((a, b) => b.total - a.total),
    perRep: Array.from(perRep.entries())
      .map(([ownerId, row]) => ({
        ownerId,
        ...row,
        // OLD inflated metric — any linked WO (the 98.7% you saw)
        oldConversionRateProxy: row.oppsTotal > 0
          ? +(row.oppsWithWO / row.oppsTotal * 100).toFixed(1)
          : 0,
        // NEW shipped metric — what the leaderboard now shows (Estimate +
        // cancelled WOs excluded)
        newRealSaleRate: row.oppsTotal > 0
          ? +(row.oppsWithRealSaleWO / row.oppsTotal * 100).toFixed(1)
          : 0,
        // PPP canonical KPI 3 — won / created (in fiscal-quarter Scorecard)
        kpi3CloseRate: row.oppsTotal > 0
          ? +(row.oppsWon / row.oppsTotal * 100).toFixed(1)
          : 0,
      }))
      .sort((a, b) => b.oppsTotal - a.oppsTotal)
      .slice(0, 20),
  });
}
