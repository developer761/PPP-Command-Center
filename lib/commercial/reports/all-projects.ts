import "server-only";

import { cache } from "react";
import { listProjects, type ProjectRow } from "@/lib/commercial/projects/db";

/**
 * EVERY deal — pre-sale bids, jobs in delivery, closed jobs — batched once and
 * memoised for the life of one request.
 *
 * `listProjects({ includeClosed: true, allDeals: true })` is ~10 batched
 * queries, and two reports now want exactly that set: Job costs and Jobs. On the
 * Reports index those two cards sit in the same folder (Manager holds every
 * report), so without this the page ran the whole thing twice, in parallel,
 * against the same tables, for the same answer.
 *
 * `cache` is React's per-request memo: two callers in one render share one
 * result; a later request gets fresh data. Nothing is cached across requests, so
 * this can't serve a stale number.
 */
export const listAllProjects = cache((): Promise<ProjectRow[]> =>
  listProjects({ includeClosed: true, allDeals: true })
);
