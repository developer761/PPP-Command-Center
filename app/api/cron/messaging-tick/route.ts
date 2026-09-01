import { NextResponse } from "next/server";
import { runDueActions } from "@/lib/messaging/scheduler";
import { schedulerDeps, reclaimStale } from "@/lib/messaging/scheduler-db";
import { reportError, reportWarn } from "@/lib/observability";

/**
 * The messaging tick. Runs every minute.
 *
 * ONE cron for the whole system, however many agents or campaigns exist,
 * because the schedule lives in sms_scheduled_actions.run_at rather than in a
 * cron expression. A cron cannot say "this conversation, fifteen minutes after
 * its own last message".
 *
 * Bearer auth via CRON_SECRET, the same shape as commercial-daily. FAILS
 * CLOSED: with the env var unset the route refuses rather than running open,
 * matching how ADMIN_EMAILS is treated. An unauthenticated endpoint that can
 * text customers is not a thing to be relaxed about.
 *
 * Nothing here can reach a carrier today — activeTransport() returns the
 * logging fake until an adapter is deliberately wired. The queue drains, the
 * gate runs, the drafts are recorded, and no customer hears from us.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    reportWarn({ key: "messaging_tick_no_secret", platform: "ppp_cc", message: "CRON_SECRET unset — messaging tick refused to run" });
    return NextResponse.json({ ok: false, error: "cron_secret_unset" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    // Rows abandoned by a dead worker come back first, or the queue silently
    // gets shorter and nothing says why.
    const reclaimed = await reclaimStale();
    const summary = await runDueActions(schedulerDeps());

    // Assert on VOLUME, not just errors. A tick that processed nothing and a
    // tick where everything failed must not look alike to whatever is watching.
    if (summary.failed > 0) {
      reportWarn({ key: "messaging_tick_actions_failed", platform: "ppp_cc", message: `${summary.failed} scheduled action(s) failed`, context: summary });
    }
    return NextResponse.json({ ok: true, reclaimed, ...summary });
  } catch (err) {
    reportError({ key: "messaging_tick_failed", platform: "ppp_cc", message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}
