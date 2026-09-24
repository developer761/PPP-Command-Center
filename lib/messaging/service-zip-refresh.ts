/**
 * Copy PPP's Zip_Code__c rows into our own table, so a reply can read them.
 *
 * ── WHY THIS IS NOT PART OF THE LEAD POLL ───────────────────────────────
 *
 * processPendingLeads loads the zip map, but it does so AFTER returning early
 * when there are no pending leads. So on a quiet tick the map is never
 * touched, and a table written from that path would go stale exactly when
 * nothing was happening. Routing needs the map when a lead arrives; a reply
 * needs it whenever somebody texts, and those are different moments.
 *
 * It shares loadZipMap's cache, so on a tick where the poll already fetched,
 * this costs nothing extra.
 *
 * ── DELETION IS GUARDED ─────────────────────────────────────────────────
 *
 * A zip removed from Zip_Code__c should stop being serviceable here too, or a
 * de-scoped area stays bookable forever. But deleting against a SHORT read is
 * how you wipe the map because Salesforce returned a page and a half, so
 * nothing is deleted unless the fetch came back with a plausible number of
 * rows. Under that floor the refresh updates what it saw and deletes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadZipMap, type Query } from "./lead-poll";

/** Refresh no more often than this. The poll's own cache uses the same hour. */
export const REFRESH_EVERY_MS = 60 * 60_000;

/**
 * Below this many rows, the fetch is treated as incomplete and nothing is
 * deleted. PPP curates 2,194 zips; a read returning fewer than a thousand is
 * a truncated page or a failing query, not a business that halved its
 * footprint overnight.
 */
export const COMPLETE_ENOUGH_TO_DELETE = 1000;

/** Supabase rejects very large payloads, so the upsert goes in chunks. */
const CHUNK = 500;

export type RefreshResult = {
  skipped?: string;
  written?: number;
  removed?: number;
  error?: string;
};

export async function refreshServiceZips(
  sb: SupabaseClient,
  query: Query,
  now: Date = new Date()
): Promise<RefreshResult> {
  try {
    // Is our copy already fresh? One cheap read, and on most ticks this is
    // the whole function.
    const { data: newest, error: freshErr } = await sb.from("sms_service_zips")
      .select("refreshed_at").order("refreshed_at", { ascending: false }).limit(1).maybeSingle();
    if (freshErr) {
      // 42P01 is the migration not being applied yet. Everything else is a
      // real problem, but neither is a reason to stop the tick.
      return { skipped: `could not read the service zip table: ${freshErr.message}` };
    }
    if (newest?.refreshed_at) {
      const age = now.getTime() - new Date(newest.refreshed_at as string).getTime();
      if (age < REFRESH_EVERY_MS) return { skipped: "already fresh" };
    }

    const index = await loadZipMap(query, now.getTime());
    if (!index.size) {
      // loadZipMap answers with an empty map when Salesforce fails, on
      // purpose. Writing that would empty the table and make every zip
      // unserviceable, which is the failure this whole table exists to
      // prevent.
      return { skipped: "the zip map came back empty, so nothing was written" };
    }

    const stamp = now.toISOString();
    const rows = [...index.values()].map((r) => ({
      zip: r.zip,
      state: r.state,
      city: r.city,
      county: r.county,
      territory_name: r.territoryName,
      territory_active: r.territoryActive,
      refreshed_at: stamp,
    }));

    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { error } = await sb.from("sms_service_zips").upsert(slice, { onConflict: "zip" });
      if (error) return { written, error: `writing service zips: ${error.message}` };
      written += slice.length;
    }

    // Anything not in this fetch is gone from Salesforce. Only acted on when
    // the fetch was big enough to believe.
    let removed = 0;
    if (rows.length >= COMPLETE_ENOUGH_TO_DELETE) {
      const { data: gone, error } = await sb.from("sms_service_zips")
        .delete().lt("refreshed_at", stamp).select("zip");
      if (error) return { written, error: `removing stale service zips: ${error.message}` };
      removed = gone?.length ?? 0;
    }

    return { written, removed };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
