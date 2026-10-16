import { NextResponse } from "next/server";
import { runWriteBackTick } from "@/lib/salesforce/tomco-tick";
import { cronRequestAuthorized } from "@/lib/cron-auth";

/**
 * The Tomco write-back tick. Every minute (`vercel.json`, `* * * * *`).
 *
 * Katie, 2026-10-13: *"whenever we write in the commercial platform it should
 * immediately write back into their salesforce."* Karan, 2026-10-15: *"as soon
 * as a sold job is done"* — and then *"go and add the change orders too"*.
 *
 * WHAT MAKES IT IMMEDIATE WITHOUT PUTTING SALESFORCE IN THE CLICK
 *
 * Marking a job sold, or approving a change order, writes one row to
 * `commercial_tomco_writeback_queue` — an indexed local insert that cannot
 * hang and cannot fail the action. This route drains that queue within the
 * minute: it decides, writes, reads back, and verifies. A slow or unreachable
 * Salesforce delays the sync and never breaks the sale.
 *
 * The nightly sweep (`/api/cron/commercial-daily`) is the backstop for
 * anything that failed, was held and then cleared, or happened while
 * Salesforce was down.
 *
 * Bearer auth via CRON_SECRET, and FAILS CLOSED — with the variable unset the
 * route refuses rather than running open. An unauthenticated endpoint that can
 * write into another company's Salesforce is not a thing to be relaxed about.
 */
export const dynamic = "force-dynamic";
/*
 * Each entry does a handful of SOQL round trips plus a six-second wait for the
 * rollups before reading back, and a tick takes up to ten. 300s is the headroom
 * for the worst realistic tick; the queue is normally empty and the route
 * returns in milliseconds.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await runWriteBackTick({ apply: true });
    /*
     * A failed entry does NOT make this a 500. The entry is recorded as failed,
     * it will be retried, and anything Salesforce rejected has already gone to
     * the commercial Slack channel through `writeSf`. A 500 here would make
     * Vercel's cron log red once a minute for a condition that is already
     * reported where somebody reads it.
     */
    return NextResponse.json(r);
  } catch (err) {
    console.error("[cron/tomco-writeback]", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
