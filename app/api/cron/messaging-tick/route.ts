import { NextResponse } from "next/server";
import { runDueActions } from "@/lib/messaging/scheduler";
import { sweepStalled } from "@/lib/messaging/stalled-db";
import { schedulerDeps, reclaimStale } from "@/lib/messaging/scheduler-db";
import { reportError, reportWarn, reportInfo } from "@/lib/observability";
import { getSalesforceClient, isSalesforceConfigured } from "@/lib/salesforce/client";
import { pollSalesforceLeads, type PollSummary } from "@/lib/messaging/lead-poll";
import { sweepExitsFor, type SweepSummary } from "@/lib/messaging/exit-sweep";
import { refreshServiceZips, type RefreshResult } from "@/lib/messaging/service-zip-refresh";
import { runOptOutWriteback, writebackEnabled, type WritebackSummary } from "@/lib/messaging/optout-writeback-run";
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
  //
  // THAT FLAG GATES THE POLL AND NOTHING ELSE, which it did not until now. It
  // sat on the whole Salesforce block, so setting a variable called
  // LEAD_POLL_DISABLED also silenced the exit sweep and the service-area
  // refresh. Somebody pausing intake — a bad routing change, a migration —
  // would have stopped the thing that notices a customer has since booked,
  // and the campaign would have carried on chasing them: exactly the harm the
  // sweep below was added to prevent, reintroduced by a flag named after
  // something else. The sweep and the refresh are guarded by Salesforce being
  // configured, and each already survives Salesforce being down on its own.
  let leads: PollSummary | { error: string } | null = null;
  let exits: SweepSummary | { error: string } | null = null;
  let zips: RefreshResult | null = null;
  let writeback: WritebackSummary | { error: string } | null = null;
  if (isSalesforceConfigured()) {
    const pollLeads = process.env.LEAD_POLL_DISABLED !== "true";
    if (pollLeads) try {
      const conn = await getSalesforceClient();
      leads = await pollSalesforceLeads(messagingDb(), (soql, opts) =>
        (opts?.all
          // SOQL pages at 2,000 rows. The zip map is larger than that, and
          // without this it arrives quietly truncated.
          ? conn.query(soql, { autoFetch: true, maxFetch: 50_000 })
          : conn.query(soql)) as never);
      if (leads.failed > 0) {
        reportWarn({
          key: "lead_poll_failed_rows", platform: "ppp_cc",
          message: `${leads.failed} lead(s) failed intake`,
          context: { ...leads, overlaps: leads.overlaps?.join(" | ") ?? null },
        });
      }
      // TWO WORKFLOWS MATCHED ONE LEAD, which by Karan's rule cannot happen:
      // overlapping entry criteria in one workspace. Enrolment takes the first
      // match so nobody is texted twice, but which campaign they got came down
      // to row order. chooseWorkflow has always worked this out and the value
      // was read by nothing, so it has never once been said out loud.
      if (leads.overlaps?.length) {
        reportWarn({
          key: "workflow_entry_overlap", platform: "ppp_cc",
          message: `Entry rules overlap: ${leads.overlaps.join(" | ")}`,
          context: { count: leads.overlaps.length, detail: leads.overlaps.join(" | ") },
        });
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

    // THE SERVICE AREA MAP, WHERE A REPLY CAN READ IT.
    //
    // A2 has to be checked when a customer gives us a zip mid-conversation,
    // not only when a lead arrives. The 2,194 Zip_Code__c rows only existed
    // in a cache inside this process, and asking Salesforce from the reply
    // path would put it back in the way of replies — which is the thing the
    // separate try blocks above exist to avoid.
    //
    // Its own try, for the same reason as the others: Salesforce being down
    // must not stop replies. Throttled to once an hour inside, and it shares
    // the poll's cache, so on most ticks this is one small read.
    try {
      const conn = await getSalesforceClient();
      zips = await refreshServiceZips(messagingDb(), (soql, opts) =>
        conn.query(soql, { autoFetch: opts?.all === true, maxFetch: 50_000 }) as never
      );
      if (zips.error) {
        reportWarn({
          key: "service_zips_not_refreshed", platform: "ppp_cc",
          message: `The service area map could not be refreshed: ${zips.error}`,
        });
      }
    } catch (err) {
      zips = { error: err instanceof Error ? err.message : String(err) };
    }

    // TELLING SALESFORCE SOMEBODY OPTED OUT.
    //
    // The only thing in this system that WRITES to Salesforce, which is why it
    // has its own switch and is off until SF_OPTOUT_WRITEBACK=true. Off, this
    // is exactly today's behaviour: the suppression list holds, nobody is
    // texted, and Salesforce is simply not told.
    //
    // On, it removes the hand-transcription step behind Kate's numbers — 213
    // opt-outs Salesforce could not match, 55 of them with the record sitting
    // right there. Its own try, like the other two: a write that fails must
    // not stop replies going out.
    if (writebackEnabled()) {
      try {
        const conn = await getSalesforceClient();
        writeback = await runOptOutWriteback(
          messagingDb(),
          (soql) => conn.query(soql) as never,
          async (sObject, id, fields) => { await conn.sobject(sObject).update({ Id: id, ...fields }); }
        );
        if (writeback.failed > 0) {
          reportWarn({
            key: "optout_writeback_failed_rows",
            platform: "ppp_cc",
            message: `${writeback.failed} opt-out(s) could not be written back to Salesforce`,
            context: writeback,
          });
        }
      } catch (err) {
        writeback = { error: err instanceof Error ? err.message : String(err) };
        reportWarn({ key: "optout_writeback_failed", platform: "ppp_cc", message: `Opt-out writeback failed: ${writeback.error}` });
      }
    }
  }

  try {
    // Rows abandoned by a dead worker come back first, or the queue silently
    // gets shorter and nothing says why.
    const reclaimed = await reclaimStale();
    const summary = await runDueActions(schedulerDeps());

    /**
     * A44 — QUEUE THE CADENCE FOR CONVERSATIONS THAT HAVE GONE QUIET.
     *
     * After the due actions, not before: a conversation that gets a reply
     * this same tick is no longer stalled, and sweeping first would queue
     * three follow-ups we would immediately have to cancel.
     *
     * In its own try. The baseline this beats is 208 of 237 stalled
     * conversations receiving NOTHING, so a sweep that throws must not also
     * take down the replies that were about to go out.
     *
     * Idempotent by construction — the unique index on
     * (conversation_id, stall_step) means running it every minute cannot
     * chase anybody twice.
     */
    let stalls: Awaited<ReturnType<typeof sweepStalled>> | { error: string } | null = null;
    try {
      stalls = await sweepStalled(messagingDb());
      /**
       * A conversation the sweep WANTED to queue and could not is an alarm,
       * not a statistic. It went unnoticed for a full deploy cycle once.
       */
      if (stalls.failed > 0) {
        reportError({
          key: "stall_cadence_insert_failed", platform: "ppp_cc",
          message: `${stalls.failed} stalled conversation(s) could not be queued — ${JSON.stringify(stalls.skipped)}`,
        });
      }
      if (stalls.queued > 0) {
        reportWarn({
          key: "stall_cadence_queued", platform: "ppp_cc",
          message: `${stalls.queued} stalled conversation(s) entered the follow-up cadence`,
          // Flattened: the warn context takes scalars, and `skipped` is a map.
          context: { scanned: stalls.scanned, queued: stalls.queued, skipped: JSON.stringify(stalls.skipped) },
        });
      }
    } catch (err) {
      stalls = { error: err instanceof Error ? err.message : String(err) };
      reportError({ key: "stall_sweep_failed", platform: "ppp_cc", message: `stall sweep: ${stalls.error}` });
    }

    // Assert on VOLUME, not just errors. A tick that processed nothing and a
    // tick where everything failed must not look alike to whatever is watching.
    if (summary.failed > 0) {
      reportWarn({ key: "messaging_tick_actions_failed", platform: "ppp_cc", message: `${summary.failed} scheduled action(s) failed`, context: summary });
    }
    /**
     * A HEARTBEAT, BECAUSE "NOTHING HAPPENED" AND "NOTHING RAN" LOOK ALIKE.
     *
     * With no active campaigns and an empty queue, a tick running every
     * minute and correctly doing nothing leaves exactly the same trace in the
     * database as a tick that never fired: none. On 2026-09-26 the only place
     * that could answer "is this alive?" was Vercel's cron panel, and I got
     * the answer wrong twice before looking at it.
     *
     * Written on EVERY run including the empty ones — an empty run is the
     * thing this exists to make visible. Reuses commercial_settings rather
     * than adding a table, the same way commercial-daily does, so there is
     * one heartbeat mechanism rather than two.
     *
     * Never fails the tick over its own bookkeeping.
     */
    try {
      const { setCommercialSetting } = await import("@/lib/commercial/settings");
      await setCommercialSetting("messaging_tick_last_run", {
        at: new Date().toISOString(),
        reclaimed,
        claimed: summary.claimed,
        drafted: summary.drafted,
        sent: summary.sent,
        failed: summary.failed,
        stallsQueued: stalls && !("error" in stalls) ? stalls.queued : null,
        // Recorded in the heartbeat too: "queued 0, failed 3" is a very
        // different state from "queued 0", and only one of them is fine.
        stallsFailed: stalls && !("error" in stalls) ? stalls.failed : null,
      }, null);
    } catch (err) {
      console.warn("[cron/messaging-tick] heartbeat write failed:", err);
    }

    return NextResponse.json({ ok: true, reclaimed, ...summary, stalls, leads, exits, writeback, zips });
  } catch (err) {
    reportError({ key: "messaging_tick_failed", platform: "ppp_cc", message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}
