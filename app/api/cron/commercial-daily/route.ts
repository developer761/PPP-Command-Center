import { NextResponse } from "next/server";

import { runOverdueTasksReminder } from "@/lib/commercial/cron/overdue-tasks";
import { runExpiringDocumentsReminder } from "@/lib/commercial/cron/expiring-documents";
import { runHotDealsCoolingReminder } from "@/lib/commercial/cron/hot-deals-cooling";

/**
 * Commercial daily cron — fires the three "what's drifting?" reminders.
 *
 * Bearer-token auth via CRON_SECRET (same env var as
 * /api/cron/snapshot-warm). Vercel cron auto-injects this header when
 * the env var is set.
 *
 * Schedule (vercel.json): `0 13 * * *` — 13:00 UTC = 8am US Eastern
 * during DST, 9am Eastern outside DST. Karan picked early morning so
 * reminders land in the inbox before the workday starts, and so all
 * three jobs share a single cron quota slot (Vercel Pro caps at 40
 * crons total).
 *
 * Architecture:
 *   - Each job is its own pure function in lib/commercial/cron/.
 *   - This route is a thin orchestrator: parse auth → run all three
 *     via Promise.allSettled → aggregate counts + errors → return JSON.
 *   - `allSettled` so a transient failure on one job doesn't stop the
 *     other two (e.g. document query fails but overdue tasks fire).
 *   - The route always returns 200 if SOME work happened; 500 only on
 *     the auth failure or a total wipe-out. Vercel cron retries on
 *     non-200 — keeping us at 200 prevents double-fire on partial
 *     success.
 *
 * Notification dedup is per-job (24h tasks / 30d docs / 7d hot-deals)
 * so re-runs from a Vercel retry or manual hit are safe — the bell
 * row check inside each helper prevents duplicate sends.
 */

export const dynamic = "force-dynamic";
// Each job is a single SELECT + small loop. Generous timeout in case
// PPP's commercial dataset grows + Resend gets slow under load.
export const maxDuration = 60;

export async function GET(request: Request) {
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
  const [tasksRes, docsRes, hotRes] = await Promise.allSettled([
    runOverdueTasksReminder(),
    runExpiringDocumentsReminder(),
    runHotDealsCoolingReminder(),
  ]);

  // Settled-shape unwrap. allSettled → fulfilled.value | rejected.reason.
  // Each job's result already has its own ok flag + errors; rejection
  // here means an UNCAUGHT throw (rare — every job wraps its body in
  // try/catch). Convert rejection to the same shape so the response is
  // uniform.
  const tasks =
    tasksRes.status === "fulfilled"
      ? tasksRes.value
      : { ok: false, found: 0, sent: 0, skipped: 0, errors: [String(tasksRes.reason)] };
  const docs =
    docsRes.status === "fulfilled"
      ? docsRes.value
      : { ok: false, found: 0, sent: 0, skipped: 0, errors: [String(docsRes.reason)] };
  const hot =
    hotRes.status === "fulfilled"
      ? hotRes.value
      : { ok: false, found: 0, sent: 0, skipped: 0, errors: [String(hotRes.reason)] };

  const durationMs = Date.now() - startedAt;
  const totalSent = tasks.sent + docs.sent + hot.sent;
  const totalFound = tasks.found + docs.found + hot.found;
  const totalSkipped = tasks.skipped + docs.skipped + hot.skipped;
  const totalErrors = tasks.errors.length + docs.errors.length + hot.errors.length;

  console.log(
    `[cron/commercial-daily] ${durationMs}ms — found ${totalFound} (tasks=${tasks.found} docs=${docs.found} hot=${hot.found}) · sent ${totalSent} · skipped ${totalSkipped} · errors ${totalErrors}`
  );
  if (totalErrors > 0) {
    console.warn(
      `[cron/commercial-daily] errors: tasks=${JSON.stringify(tasks.errors)} docs=${JSON.stringify(docs.errors)} hot=${JSON.stringify(hot.errors)}`
    );
  }

  return NextResponse.json({
    ok: true,
    durationMs,
    summary: {
      found: totalFound,
      sent: totalSent,
      skipped: totalSkipped,
      errorCount: totalErrors,
    },
    tasks,
    documents: docs,
    hotDeals: hot,
  });
}
