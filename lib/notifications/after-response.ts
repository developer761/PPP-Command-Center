import "server-only";

import { after } from "next/server";

/**
 * Run work AFTER the response, without it being thrown away.
 *
 * Every notification fan-out in Commercial is fire-and-forget — `void (async
 * () => { … })()` — so a server action returns the moment the database write
 * lands and the bell row, the Slack post and the email happen "later". On a
 * long-lived Node server that is fine. On Vercel it is not: the instance is
 * frozen as soon as the response is sent, and anything still awaiting is
 * dropped. No error, no log, no row — the notification simply never happened.
 *
 * That is the most likely explanation for notifications arriving only
 * sometimes, and it affects the lot: task assigned, note added, note mention,
 * status changed, all three invoice kinds, proposal sent, approval requested
 * and decided, team added.
 *
 * `after()` is the platform's answer — the work is registered as part of the
 * request and kept alive past the response.
 *
 * WHY THE TRY/CATCH. `after()` throws outside a request scope, and these same
 * functions are called from places that have none: the migration scripts, the
 * cron entry points, and the test suite. Falling back to a plain detached
 * promise there is correct — a script is not going to be frozen mid-await, and
 * its process stays up until the work finishes.
 *
 * Failures are LOGGED rather than swallowed. A `void` promise that rejects is
 * an unhandled rejection with no context; the whole point of this file is that
 * nothing disappears quietly.
 */
export function afterResponse(label: string, work: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await work();
    } catch (err) {
      console.warn(`[notify] ${label} failed:`, err instanceof Error ? err.message : err);
    }
  };
  try {
    after(run);
  } catch {
    // No request scope — a script, a cron handler, or a test. Run it detached;
    // the process is not about to be frozen.
    void run();
  }
}
