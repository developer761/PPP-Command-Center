import { NextResponse } from "next/server";
import { runDueActions } from "@/lib/messaging/scheduler";
import { schedulerDeps, reclaimStale } from "@/lib/messaging/scheduler-db";
import { reportError, reportWarn, reportInfo } from "@/lib/observability";
import { getSalesforceClient, isSalesforceConfigured } from "@/lib/salesforce/client";
import { pollSalesforceLeads, type PollSummary } from "@/lib/messaging/lead-poll";
import { sweepExitsFor, type SweepSummary } from "@/lib/messaging/exit-sweep";
import { messagingDb } from "@/lib/messaging/db";

/**
 * The messaging tick. Runs every TICK_SECONDS (60s, reply-delay.ts).
 *
 * WHAT ACTUALLY CALLS IT: vercel.json, `* * * * *`, on Vercel Pro. This
 * comment said something else for a while — 10-second ticks, and a once-daily
 * 07:00 UTC cron because Hobby rejects anything more frequent — and both halves
 * were stale after the Pro upgrade. Anyone reasoning about speed-to-lead from
 * the old text reached the wrong conclusion, which is the only reason a
 * comment being out of date is worth a line in a changelog.
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

  // NEW LEADS FIRST, so an opener enrolled this tick is already queued. In its
  // own try: Salesforce being down must never stop replies that are due from
  // going out. Throttled inside to once a minute. LEAD_POLL_DISABLED=true
  // switches it off without a deploy of code.
  let leads: PollSummary | { error: string } | null = null;
  let exits: SweepSummary | { error: string } | null = null;
  if (isSalesforceConfigured() && process.env.LEAD_POLL_DISABLED !== "true") {
    try {
      const conn = await getSalesforceClient();
      leads = await pollSalesforceLeads(messagingDb(), (soql, opts) =>
        (opts?.all
          // SOQL pages at 2,000 rows. The zip map is larger than that, and
          // without this it arrives quietly truncated.
          ? conn.query(soql, { autoFetch: true, maxFetch: 50_000 })
          : conn.query(soql)) as never);
      if (leads.failed > 0) {
        reportWarn({ key: "lead_poll_failed_rows", platform: "ppp_cc", message: `${leads.failed} lead(s) failed intake`, context: leads });
      }
    } catch (err) {
      leads = { error: err instanceof Error ? err.message : String(err) };
      reportWarn({ key: "lead_poll_failed", platform: "ppp_cc", message: `Salesforce lead poll failed: ${leads.error}` });
    }

    // AND THE OTHER DIRECTION: stop chasing anyone who has since booked, been
    // qualified, or opted out in Salesforce.
    //
    // Its own try, separate from the poll, because the two fail for different
    // reasons and losing new leads because a sweep broke — or the reverse —
    // is worse than either alone. Throttled inside to once every five minutes.
    //
    // This had NO CALLER AT ALL until now. sweepExitsWith was written, tested,
    // exposed as a server action and wired to nothing, so the only thing that
    // has ever ended a conversation is an inbound STOP — which means a
    // customer who booked an estimate still got the day-1 and day-3 chases
    // after somebody had already been to their house, while the Automations
    // screen displayed the exit rules under "And it stops when…".
    try {
      const conn = await getSalesforceClient();
      exits = await sweepExitsFor(messagingDb(), (soql) => conn.query(soql) as never);
      if (exits.ended > 0) {
        reportInfo({
          key: "exit_sweep_ended",
          platform: "ppp_cc",
          message: `Stopped chasing ${exits.ended} customer(s) whose exit rules now match`,
          context: { ended: exits.ended, considered: exits.considered },
        });
      }
    } catch (err) {
      exits = { error: err instanceof Error ? err.message : String(err) };
      reportWarn({ key: "exit_sweep_failed", platform: "ppp_cc", message: `Exit sweep failed: ${exits.error}` });
    }
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
    return NextResponse.json({ ok: true, reclaimed, ...summary, leads, exits });
  } catch (err) {
    reportError({ key: "messaging_tick_failed", platform: "ppp_cc", message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}
