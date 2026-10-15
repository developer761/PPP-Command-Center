import { NextResponse } from "next/server";

import { warmAllSnapshots } from "@/lib/salesforce/queries";
import { reportError } from "@/lib/observability";

/**
 * Snapshot warmer cron — keeps the shared Supabase snapshot cache fresh so
 * user requests rarely pay the full ~10-15s SF SOQL rebuild.
 *
 * Schedule (vercel.json): `0 6 * * *` — once daily at 6am (Vercel Hobby caps
 * cron frequency at once/day). The shared snapshot TTL is only 30 min, so this
 * daily run alone can't keep the cache warm all day — that gap is closed by
 * serve-stale-while-revalidate in readSharedSnapshot (queries.ts): a request
 * served a stale snapshot returns instantly AND kicks a background rebuild, so
 * cold instances never pay the 8-15s live rebuild. This cron is the guaranteed
 * daily fresh build + backstop. If PPP moves to Vercel Pro, bump the schedule
 * to e.g. `* /15 * * * *` to keep intraday data fresher without relying on
 * traffic-triggered revalidation.
 *
 * What it warms (all with forceRebuild so they genuinely refresh, not
 * serve-stale):
 *   - FULL snapshot (`snapshot-v6` key) — what the Overview dashboard reads
 *   - thin snapshot (`snapshot-thin-v1` key) — rep drill-ins / lighter surfaces
 *   - materials bundle (`materials-v1` key) — the materials page
 *
 * Bearer-token auth via CRON_SECRET. Same shape as commercial-daily.
 *
 * Errors are logged but the route always returns 200 so a transient SF blip
 * doesn't cause a Vercel cron retry storm.
 *
 * Speed pass 2026-06-29: pre-warm cron was referenced in code comments
 * (queries.ts:2340, materials.ts:150) but never actually registered. Every
 * cold serverless instance was paying the full SOQL pageload until first
 * user hit. This route closes that gap.
 */

export const dynamic = "force-dynamic";
/**
 * Measured on production 2026-10-15, from a genuine cold start:
 *
 *   COLD START (no shared cache) ......  0.0s
 *   Transaction__c, 62,258 rows ....... 11s
 *   WorkOrder, 20,230 rows .............. 6s
 *   everything else in parallel ......... 8s
 *   COLD-COMPLETE ..................... 24.9s
 *   write snapshot to shared cache .... +20s   (6.1 MB gzipped)
 *                                       ─────
 *                                       ~45s
 *
 * 60s left five seconds of headroom on a job that grows with PPP's data.
 * A warm that times out leaves the cache empty, which is the exact state
 * this cron exists to prevent.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  // Bearer auth — Vercel cron auto-injects when CRON_SECRET is set.
  const authHeader = request.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const tStart = Date.now();
  /**
   * ONE Salesforce pull, three caches.
   *
   * This used to be three sequential FORCED rebuilds — full, then thin,
   * then materials — each going back to Salesforce. But thin is the full
   * snapshot with eight arrays emptied, and the materials bundle is derived
   * from thin, so the second and third pulls were re-fetching rows the
   * first already had. Measured 2026-10-15:
   *
   *   [SF] snapshot COLD-COMPLETE in 22054ms
   *   [SF] snapshot(thin) COLD-COMPLETE in 15865ms   ← re-pulled
   *   [SF] materials-bundle built in 35ms
   *
   * Sixteen seconds and a second full set of SOQL calls, every twenty
   * minutes. warmAllSnapshots fetches full live and derives the other two.
   */
  const [warmRes] = await Promise.allSettled([warmAllSnapshots()]);
  const fullRes = warmRes;
  const thinRes = warmRes;
  const matsRes = warmRes;

  const result: Record<string, unknown> = {
    ok: true,
    duration_ms: Date.now() - tStart,
    full: fullRes.status === "fulfilled" ? "ok" : "failed",
    thin: thinRes.status === "fulfilled" ? "ok" : "failed",
    materials: matsRes.status === "fulfilled" ? "ok" : "failed",
  };

  if (fullRes.status === "rejected") {
    reportError({
      key: "warm_snapshot_full",
      message: `Pre-warm cron full snapshot rebuild failed: ${String(fullRes.reason?.message ?? fullRes.reason)}`,
      platform: "ppp_cc",
    });
    result.full_error = String(fullRes.reason?.message ?? fullRes.reason);
  }
  if (thinRes.status === "rejected") {
    reportError({
      key: "warm_snapshot_thin",
      message: `Pre-warm cron thin snapshot rebuild failed: ${String(thinRes.reason?.message ?? thinRes.reason)}`,
      platform: "ppp_cc",
    });
    result.thin_error = String(thinRes.reason?.message ?? thinRes.reason);
  }
  if (matsRes.status === "rejected") {
    reportError({
      key: "warm_snapshot_materials",
      message: `Pre-warm cron materials bundle rebuild failed: ${String(matsRes.reason?.message ?? matsRes.reason)}`,
      platform: "ppp_cc",
    });
    result.materials_error = String(matsRes.reason?.message ?? matsRes.reason);
  }

  return NextResponse.json(result);
}
