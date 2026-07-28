import { NextResponse } from "next/server";

import { runOverdueTasksReminder } from "@/lib/commercial/cron/overdue-tasks";
import { runExpiringDocumentsReminder } from "@/lib/commercial/cron/expiring-documents";
import { runHotDealsCoolingReminder } from "@/lib/commercial/cron/hot-deals-cooling";
import { runCustomNotificationRules } from "@/lib/commercial/cron/custom-notification-rules";
import { runDebriefOverdueReminder } from "@/lib/commercial/cron/debrief-overdue";
import { runInvoiceDunningReminder } from "@/lib/commercial/cron/invoice-dunning";
import { reportError, reportWarn } from "@/lib/observability";

/**
 * Commercial daily cron — fires the three "what's drifting?" reminders.
 *
 * Bearer-token auth via CRON_SECRET. Vercel cron auto-injects this
 * header when the env var is set.
 *
 * Schedule (vercel.json): `0 12 * * *` — 12:00 UTC year-round. That's
 * 8am EDT (summer) / 7am EST (winter) so the reminder lands BEFORE
 * Alex's first call of the day regardless of DST. All three jobs share
 * one cron slot (Vercel Pro caps at 40 crons total).
 *
 * Architecture:
 *   - Each job is its own pure function in lib/commercial/cron/.
 *   - This route is a thin orchestrator: parse auth → run all three
 *     via Promise.allSettled → aggregate counts + errors → return JSON.
 *   - `allSettled` so a transient failure on one job doesn't stop the
 *     other two (e.g. document query fails but overdue tasks fire).
 *   - Returns 200 on partial or full success (some sends happened or
 *     nothing was due). Returns 500 only when ALL THREE jobs reported
 *     ok:false AND nothing was sent — that's a real outage worth
 *     paging on. Vercel cron retries non-200 with exponential backoff;
 *     dedup windows make re-fires safe so a 500 → retry chain
 *     auto-recovers when the underlying issue clears.
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
  const [tasksRes, docsRes, hotRes, rulesRes, debriefRes, dunningRes] = await Promise.allSettled([
    runOverdueTasksReminder(),
    runExpiringDocumentsReminder(),
    runHotDealsCoolingReminder(),
    runCustomNotificationRules(),
    runDebriefOverdueReminder(),
    runInvoiceDunningReminder(),
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
  const rules =
    rulesRes.status === "fulfilled"
      ? rulesRes.value
      : { ok: false, found: 0, sent: 0, skipped: 0, errors: [String(rulesRes.reason)] };
  const debrief =
    debriefRes.status === "fulfilled"
      ? debriefRes.value
      : { ok: false, found: 0, sent: 0, skipped: 0, errors: [String(debriefRes.reason)] };
  const dunning =
    dunningRes.status === "fulfilled"
      ? dunningRes.value
      : { ok: false, found: 0, sent: 0, skipped: 0, errors: [String(dunningRes.reason)] };

  const durationMs = Date.now() - startedAt;
  const totalSent = tasks.sent + docs.sent + hot.sent + rules.sent + debrief.sent + dunning.sent;
  const totalFound = tasks.found + docs.found + hot.found + rules.found + debrief.found + dunning.found;
  const totalSkipped = tasks.skipped + docs.skipped + hot.skipped + rules.skipped + debrief.skipped + dunning.skipped;
  const totalErrors =
    tasks.errors.length + docs.errors.length + hot.errors.length + rules.errors.length + debrief.errors.length + dunning.errors.length;

  console.log(
    `[cron/commercial-daily] ${durationMs}ms — found ${totalFound} (tasks=${tasks.found} docs=${docs.found} hot=${hot.found} rules=${rules.found} debrief=${debrief.found} dunning=${dunning.found}) · sent ${totalSent} · skipped ${totalSkipped} · errors ${totalErrors}`
  );
  if (totalErrors > 0) {
    console.warn(
      `[cron/commercial-daily] errors: tasks=${JSON.stringify(tasks.errors)} docs=${JSON.stringify(docs.errors)} hot=${JSON.stringify(hot.errors)} rules=${JSON.stringify(rules.errors)} debrief=${JSON.stringify(debrief.errors)} dunning=${JSON.stringify(dunning.errors)}`
    );
  }

  // Wipe-out detection: every job reported ok=false AND nothing was sent.
  // That means SELECT failed across the board (e.g. Supabase down) and
  // not a single notification landed. Worth returning 500 so Vercel cron
  // retries + so monitoring can page on it. A partial failure (one job
  // ok=false, others ok=true) stays 200 so a single Supabase blip on
  // one query doesn't trigger noisy retries that would re-attempt the
  // already-successful jobs.
  const totalWipeout =
    !tasks.ok && !docs.ok && !hot.ok && !rules.ok && !debrief.ok && !dunning.ok && totalSent === 0;
  const partialFailure =
    !totalWipeout && (!tasks.ok || !docs.ok || !hot.ok || !rules.ok || !debrief.ok || !dunning.ok);
  const status = totalWipeout ? 500 : 200;

  // Stage 3.5: page Slack on real failures. Total wipe-out is critical
  // (nothing went out today). Partial failure is a warn (most landed).
  // PII-safe context only: counts + job ok-flags, no opp/account names.
  if (totalWipeout) {
    reportError({
      key: "commercial_daily_total_wipeout",
      message: "Daily commercial cron: total wipe-out, no notifications sent",
      platform: "commercial_cc",
      context: {
        found: totalFound,
        errors: totalErrors,
        tasks_errs: tasks.errors.length,
        docs_errs: docs.errors.length,
        hot_errs: hot.errors.length,
        rules_errs: rules.errors.length,
        debrief_errs: debrief.errors.length,
        dunning_errs: dunning.errors.length,
        duration_ms: durationMs,
      },
    });
  } else if (partialFailure) {
    reportWarn({
      key: "commercial_daily_partial_failure",
      message: "Daily commercial cron: one or more jobs degraded",
      platform: "commercial_cc",
      context: {
        sent: totalSent,
        found: totalFound,
        tasks_ok: tasks.ok,
        docs_ok: docs.ok,
        hot_ok: hot.ok,
        rules_ok: rules.ok,
        debrief_ok: debrief.ok,
        dunning_ok: dunning.ok,
      },
    });
  }

  return NextResponse.json(
    {
      ok: !totalWipeout,
      degraded:
        !totalWipeout && (!tasks.ok || !docs.ok || !hot.ok || !rules.ok || !debrief.ok || !dunning.ok),
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
      customRules: rules,
      debriefOverdue: debrief,
      invoiceDunning: dunning,
    },
    { status }
  );
}
