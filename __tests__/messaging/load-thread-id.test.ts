import { describe, it, expect } from "vitest";
import { loadThread } from "@/lib/messaging/db";

/**
 * [conversationId] is a dynamic segment, so it catches every unmatched path
 * under /messaging. Visiting /messaging/reports — a stale link, the route is
 * /messaging/reporting — sent "reports" to Postgres as a uuid, which rejects
 * it with 22P02. loadThread threw, and the office was shown "This screen
 * could not load, something went wrong reading the data" with a reference
 * number: an outage, for a typo. not-found.tsx was right there, unreachable.
 *
 * No database is touched by any of these, which is the point — an id that is
 * not an id never gets that far.
 */
describe("loadThread — an id that cannot exist", () => {
  it("is not found rather than a system error", async () => {
    for (const id of ["reports", "settings", "dashboard", "favicon.ico", "", "../admin"]) {
      await expect(loadThread(id), id).resolves.toBeNull();
    }
  });
});
