/**
 * Pure work-order (job) enums + label helpers — NO "server-only", NO DB. Split
 * out of jobs.ts (which is server-only) so client components (the Status board's
 * move-dropdown, the Calendar's status badges) can import the vocabulary without
 * dragging the server-only DB layer into the browser bundle. jobs.ts re-exports
 * all of these for existing server callers.
 */

export const JOB_STATUSES = [
  "estimating",
  "ready_to_schedule",
  "scheduled",
  "in_progress",
  "almost_done",
  "complete",
  "closed",
  "on_hold",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export function jobStatusLabel(s: JobStatus): string {
  return {
    estimating: "Estimating",
    ready_to_schedule: "Ready to schedule",
    scheduled: "Scheduled",
    in_progress: "In progress",
    almost_done: "Almost done",
    complete: "Complete",
    closed: "Closed",
    on_hold: "On hold",
  }[s];
}

export const DIVISION_TAGS = ["commercial", "ppp", "other"] as const;
export type DivisionTag = (typeof DIVISION_TAGS)[number];
export function divisionLabel(d: string | null): string {
  return d === "ppp" ? "PPP" : d === "other" ? "Other" : d === "commercial" ? "Commercial" : "—";
}
