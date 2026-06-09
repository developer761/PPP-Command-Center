import { NextResponse } from "next/server";
import { clearSalesforceCache, loadSalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * Snapshot pre-warm cron.
 *
 *   Vercel cron config: lives in the Vercel project UI (no vercel.json in
 *   this repo). Should be set to `*​/10 * * * *` or tighter. The snapshot
 *   has a 30-min TTL, so a 10-min cron gives a 20-min safety margin — even
 *   if one fire fails, the next has 10 min to land before users see cold.
 *
 * Purpose: keep the cross-instance shared Salesforce snapshot fresh so users
 * never hit the 7-12s cold-fetch path. Without this, the FIRST user to load
 * any page after the TTL window waits the full SF round-trip. With it, the
 * shared cache in Supabase is always warm (max age ~10 min in practice).
 *
 * Behavior:
 *   1. Clear the in-process memoization (so `cached()` doesn't return a stale
 *      value from this specific instance's RAM)
 *   2. Bump the generation counter so OTHER instances also re-fetch on their
 *      next request — keeps all serverless replicas in sync
 *   3. Call `loadSalesforceSnapshot()` which writes the fresh snapshot to the
 *      shared Supabase row
 *
 * Edge cases handled:
 *   - Unauthorized hit: require `Authorization: Bearer ${CRON_SECRET}`.
 *     Vercel cron sends this automatically when the env var is set; outside
 *     of that, only platform admins should be able to fire this.
 *   - SF auth failure: surface 500 + log; old cache remains valid so user
 *     traffic is unaffected.
 *   - Concurrent fires: idempotent — last write to the shared snapshot row
 *     wins, both produce identical data.
 *   - Concurrent admin writeback: the writeback's gen-bump invalidates the
 *     cron's snapshot if it crossed mid-fetch. Next user request re-fetches.
 *     Worst case: one wasted cron cycle, ~1k SF API calls over a day. Well
 *     within PPP's quota.
 *   - Vercel function timeout: cold snapshot is ~10-15s, max plan timeout is
 *     60s, so safely within budget. If a fetch ever times out, old cache
 *     still serves users on the next request.
 *
 * No request body. Returns timing + counts so we can see in Vercel cron logs
 * whether the warm is healthy.
 */

export const dynamic = "force-dynamic";
// Generous timeout — paint-color paging alone can take 8-10s on cold load.
export const maxDuration = 60;

export async function GET(request: Request) {
  // Bearer-token gate. Vercel cron auto-injects this when CRON_SECRET is set
  // in env. Required for any production fire — otherwise a random hit could
  // burn ~10 SF API calls + 10-15s of compute.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_not_configured" },
      { status: 500 }
    );
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    // Step 1: invalidate this instance's in-process memo + bump the cross-
    // instance generation counter. After this, ANY server reading the cached()
    // path sees the new generation and re-fetches from SF.
    await clearSalesforceCache();

    // Step 2: rebuild the shared snapshot. cached() writes the gzipped row to
    // Supabase, which all other instances pick up on their next request.
    const snapshot = await loadSalesforceSnapshot();

    const durationMs = Date.now() - startedAt;
    console.log(
      `[cron/snapshot-warm] ok in ${durationMs}ms — ${snapshot.workOrders.length} WO, ${snapshot.opportunities.length} opp, ${snapshot.accounts.length} acct, ${snapshot.woLineItems.length} WOLI`
    );
    return NextResponse.json({
      ok: true,
      durationMs,
      counts: {
        workOrders: snapshot.workOrders.length,
        opportunities: snapshot.opportunities.length,
        accounts: snapshot.accounts.length,
        quotes: snapshot.quotes.length,
        woLineItems: snapshot.woLineItems.length,
        reps: snapshot.reps.length,
        paintColors: snapshot.paintColors.length,
      },
      fetchedAt: snapshot.fetchedAt,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`[cron/snapshot-warm] failed after ${durationMs}ms:`, err);
    return NextResponse.json(
      {
        ok: false,
        error: "snapshot_refresh_failed",
        message: err instanceof Error ? err.message : String(err),
        durationMs,
      },
      { status: 500 }
    );
  }
}
