/**
 * "LIVE · SYNCED JUST NOW" WAS A CLOCK, NOT A SYNC INDICATOR.
 *
 * components/topbar.tsx had this, since the first version of the page:
 *
 *     const [syncedAt] = useState<Date>(() => new Date());
 *
 * — the moment the React component mounted in the browser. It never
 * touched the Salesforce snapshot. So every fresh page load rendered
 * "Live · synced just now" under a pulsing green dot, whether the data
 * behind it came from Salesforce three seconds earlier or out of a
 * 60-minute-old cache row; and the serve-stale path lets that row reach 26
 * HOURS before a live rebuild is forced. A tab left open overnight showed
 * "synced 16h ago" while the warm cron had rebuilt twenty minutes before —
 * which is how this was spotted.
 *
 * The state it could never show is the only one worth showing: the warm
 * cron has stopped and these numbers are old.
 *
 * The fix reads snapshot_cache.fetched_at — the timestamp columns ONLY.
 * Reading the row's payload to find out how old the row is would cost
 * 3.6-8.1MB on every dashboard load, which is the trade that left the chip
 * lying in the first place, so that is asserted here too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

const root = join(__dirname, "..", "..");
const read = (p: string) => stripComments(readFileSync(join(root, p), "utf8"));

describe("the sync chip reports the data's age, not the page's", () => {
  const topbar = read("components/topbar.tsx");

  it("no longer treats mount time as the sync time", () => {
    // The exact line that shipped. Mount time survives only as the
    // FALLBACK (`useState(() => new Date())` feeding a setter), so what
    // must be gone is the frozen, un-settable binding.
    expect(topbar).not.toMatch(/const\s*\[\s*syncedAt\s*\]\s*=\s*useState/);
    expect(topbar).toMatch(/const\s*\[\s*syncedAt\s*,\s*setSyncedAt\s*\]\s*=\s*useState/);
  });

  it("asks the server when Salesforce was actually pulled", () => {
    expect(topbar).toContain("/api/sf-sync-status");
    expect(topbar).toMatch(/setSyncedAt\(/);
  });

  it("can say the data is stale, which it previously could not", () => {
    expect(topbar).toMatch(/STALE_AFTER_MS/);
    // The chip renders only when stale — it is an alarm, not furniture.
    expect(topbar).toMatch(/\{isStale && \(/);
  });

  it("the staleness threshold is past the cron interval, not under it", () => {
    // Warm cron every 20 min, snapshot TTL 60 min. A threshold at or below
    // 60 would light the alarm during normal operation and train everyone
    // to ignore it.
    const m = topbar.match(/STALE_AFTER_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
    expect(m, "STALE_AFTER_MS is no longer expressed in minutes").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(60);
  });

  it("the everyday reading and the manual refresh still exist, in the menu", () => {
    // Karan, 2026-10-16: "the top needs to be cleaner, it's all so
    // clustered, do we really need the sync button up there?" — removing
    // the control entirely would have cost mobile users any way to force a
    // refresh, so it moved rather than vanished.
    const menu = read("components/user-menu.tsx");
    expect(menu).toContain("/api/admin/sf-refresh-cache");
    expect(menu).toContain("Refresh from Salesforce");
    expect(menu).toMatch(/syncedAgo/);
    expect(topbar).toMatch(/syncedAgo=\{/);
  });
});

describe("finding out the age does not cost the payload", () => {
  it("readSnapshotAge selects timestamps, never the blob", () => {
    const src = read("lib/salesforce/queries.ts");
    const at = src.indexOf("export async function readSnapshotAge");
    expect(at, "readSnapshotAge is gone").toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("\n}", at));
    expect(fn).toMatch(/\.select\(\s*"key,\s*fetched_at"\s*\)/);
    expect(
      fn,
      "payload_gz is 3.6-8.1MB of base64 — reading it to find a timestamp " +
        "re-creates the cost this endpoint exists to avoid"
    ).not.toContain("payload_gz");
  });

  it("reports the OLDER of the two snapshots, never the fresher", () => {
    const src = read("lib/salesforce/queries.ts");
    const at = src.indexOf("export async function readSnapshotAge");
    const fn = src.slice(at, src.indexOf("\n}", at));
    // Math.min on epoch ms = the oldest timestamp. The chip must never
    // claim the data is fresher than it is.
    expect(fn).toMatch(/Math\.min\(/);
    expect(fn).not.toMatch(/Math\.max\(/);
  });

  it("the route is signed-in only and does not cache across users", () => {
    const route = read("app/api/sf-sync-status/route.ts");
    expect(route).toMatch(/auth\.getUser\(\)/);
    expect(route).toMatch(/status:\s*401/);
    expect(route).toMatch(/"Cache-Control":\s*"private/);
  });
});
