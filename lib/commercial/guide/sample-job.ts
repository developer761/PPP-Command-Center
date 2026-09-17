import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * A real job for the walkthrough to open.
 *
 * The first version of the guide wrote every job-scoped surface as
 * `/commercial/opportunities` — the LIST. So "Try it out" on a card headed
 * "The job › Proposals" dropped you on a table of every job and then explained
 * the proposals tab you could not see. It was not a thin walkthrough, it was a
 * wrong one, and it was wrong on nine surfaces.
 *
 * A job page needs a job id, and the guide cannot know one at author time. So
 * the surfaces carry a `:job` placeholder and this resolves it, once, against
 * the real book:
 *
 *   wonId — a job past the win, which is the only kind that HAS a Project tab.
 *           Submittals, change orders, AIA and closeout all live there, so
 *           Stephanie's whole walkthrough depends on getting one.
 *   anyId — any live job, for the surfaces that exist before the win.
 *
 * Both may be null on an empty database. A surface that cannot be resolved is
 * dropped from the tour rather than pointed at a placeholder URL — a step that
 * 404s teaches somebody the platform is broken.
 */

export type SampleJob = { wonId: string | null; anyId: string | null };

/** The statuses that carry a Project tab — a job at or past the win. */
const WON_OR_DELIVERING = ["pre_construction", "in_progress", "billing"];

export async function getSampleJob(): Promise<SampleJob> {
  const sb = commercialDb();
  // Newest first: a recent job is the one most likely to have real paperwork on
  // it, and an empty Project tab teaches nothing.
  const [won, any] = await Promise.all([
    sb
      .from("commercial_opportunities")
      .select("id")
      .in("status", WON_OR_DELIVERING)
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from("commercial_opportunities")
      .select("id")
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    wonId: (won.data as { id: string } | null)?.id ?? null,
    anyId: (any.data as { id: string } | null)?.id ?? null,
  };
}

/**
 * Put a real id into a surface's href.
 *
 * `:job` wants any live job; `:wonjob` needs one past the win. Returns null
 * when the book has nothing that fits, which is the caller's signal to leave
 * that surface out of the tour.
 */
export function resolveJobHref(href: string, sample: SampleJob): string | null {
  if (href.includes(":wonjob")) {
    return sample.wonId ? href.replace(":wonjob", sample.wonId) : null;
  }
  if (href.includes(":job")) {
    return sample.anyId ? href.replace(":job", sample.anyId) : null;
  }
  return href;
}
