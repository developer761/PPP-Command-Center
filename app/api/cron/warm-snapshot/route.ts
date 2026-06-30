import { NextResponse } from "next/server";

import { loadDashboardData } from "@/lib/data-source";
import { reportError } from "@/lib/observability";

/**
 * Snapshot warmer cron — keeps the shared Supabase snapshot cache fresh so
 * user requests rarely pay the full ~10-15s SF SOQL rebuild.
 *
 * Schedule (vercel.json): `* /10 * * * *` — every 10 minutes. The shared
 * cache TTL is 30 min, so a 10-min cadence guarantees we re-write the blob
 * twice before it expires under normal load. Going more frequent (`* /3`)
 * would 3x the cost for zero TTI win because Vercel function instances
 * spin down after ~5 min idle anyway — the win is the SHARED Supabase
 * cache being warm, not function warmth.
 *
 * What it warms:
 *   - thin snapshot (`snapshot-thin-v1` key) — what the dashboard reads
 *   - materials bundle (`materials-v1` key) — what the materials page reads
 *
 * Bearer-token auth via CRON_SECRET. Same shape as commercial-daily.
 *
 * Cost: ~144 invocations/day × ~12s wall × 1024MB ≈ ~30 GB-s/day, well
 * inside Vercel Pro's included budget. Errors are logged but the route
 * always returns 200 so a transient SF blip doesn't cause Vercel cron
 * retry storms (the next scheduled tick is only 10 min away).
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

  // Warm thin snapshot + materials bundle in parallel. Both fill their
  // own cache layers (`snapshot-thin-v1` + `materials-v1` in
  // snapshot_cache table). If one fails, the other still warms.
  const [thinRes, matsRes] = await Promise.allSettled([
    loadDashboardData(sp, { thin: true }),
    loadDashboardData(sp, { materials: true }),
  ]);

  const result: Record<string, unknown> = {
    ok: true,
    duration_ms: Date.now() - tStart,
    thin: thinRes.status === "fulfilled" ? "ok" : "failed",
    materials: matsRes.status === "fulfilled" ? "ok" : "failed",
  };

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
