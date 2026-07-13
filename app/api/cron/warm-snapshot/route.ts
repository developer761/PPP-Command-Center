import { NextResponse } from "next/server";

import { loadDashboardData } from "@/lib/data-source";
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
export const maxDuration = 60; // SOQL rebuild can take 10-15s; give headroom

export async function GET(request: Request) {
  // Bearer auth — Vercel cron auto-injects when CRON_SECRET is set.
  const authHeader = request.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const tStart = Date.now();
  // Empty searchParams is fine — loadDashboardData uses sp only for
  // role/view-as resolution which the cron doesn't need.
  const sp: Record<string, string | string[] | undefined> = {};

  // Rebuild each cache SEQUENTIALLY: full → thin → materials. Two reasons:
  // (1) we never hammer the SF API with concurrent full-snapshot pulls, and
  // (2) the materials bundle re-derives from the thin snapshot, so rebuilding
  // thin first means materials reuses the fresh thin (warm in this instance's
  // in-memory cache) instead of triggering its own thin pull. forceRebuild
  // makes each bypass serve-stale so they genuinely refresh.
  const [fullRes] = await Promise.allSettled([
    loadDashboardData(sp, { forceRebuild: true }),
  ]);
  const [thinRes] = await Promise.allSettled([
    loadDashboardData(sp, { thin: true, forceRebuild: true }),
  ]);
  const [matsRes] = await Promise.allSettled([
    loadDashboardData(sp, { materials: true, forceRebuild: true }),
  ]);

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
