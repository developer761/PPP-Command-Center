/**
 * One chronology for a job, plus what is still ahead of it.
 *
 * The Activity rail, from Karan's Salesforce Quote screenshot: *Upcoming &
 * Overdue* pinned at the top, history grouped by month beneath it.
 *
 * **This is a READ of data that already exists** — the status log, notes, tasks
 * and the email archive. It has no store of its own, and it must not acquire
 * one: an activity feed that needs its own table is a feed that can disagree
 * with the records it claims to describe.
 *
 * Today the Timeline tab shows the status log alone, which is why nobody opens
 * it — a job's real story is "we sent it, she asked for a revision, we chased
 * her twice". The value here is the *merge*, and the fact that the top of it
 * answers the one question no other surface does: what is about to be late.
 *
 * Pure. Rows in, groups out, `todayIso` injected — so the ordering and the
 * overdue rule are testable without a clock or a database.
 */

export type ActivityKind = "status" | "note" | "task" | "email" | "proposal";

export type ActivityEntry = {
  id: string;
  kind: ActivityKind;
  /** ISO timestamp the entry happened (or is due, for upcoming work). */
  at: string;
  title: string;
  detail?: string | null;
  /** Set on tasks only. Drives the Upcoming & Overdue block. */
  dueAt?: string | null;
  done?: boolean;
};

export type ActivityMonth = {
  /** "2026-08" — stable for keys and sorting. */
  key: string;
  /** "August 2026", or "This month" for the current one. */
  label: string;
  entries: ActivityEntry[];
};

export type ActivityFeed = {
  /** Open tasks, soonest first. Overdue ones lead. */
  upcoming: ActivityEntry[];
  overdueCount: number;
  months: ActivityMonth[];
  total: number;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ET calendar date of an ISO timestamp. Matches every other elapsed figure on
 *  the platform — subtracting raw timestamps shifts the day across DST. */
function etDay(iso: string): string {
  return iso.slice(0, 10);
}

export function buildActivityFeed(
  entries: ActivityEntry[],
  todayIso: string
): ActivityFeed {
  // ── Ahead of us ─────────────────────────────────────────────────────────
  // Open tasks with a due date. Overdue first, then soonest — the order
  // someone would work them in, rather than the order they were created.
  const upcoming = entries
    .filter((e) => e.kind === "task" && !e.done && e.dueAt)
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const overdueCount = upcoming.filter((e) => etDay(String(e.dueAt)) < todayIso).length;

  // ── Behind us ───────────────────────────────────────────────────────────
  // Everything that has happened, newest first, grouped by the month it
  // happened in. An open task appears in BOTH — above as work to do, below as
  // the day somebody created it — because those are two different facts.
  const past = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  const byMonth = new Map<string, ActivityEntry[]>();
  for (const e of past) {
    const key = e.at.slice(0, 7);
    const list = byMonth.get(key);
    if (list) list.push(e);
    else byMonth.set(key, [e]);
  }

  const thisMonth = todayIso.slice(0, 7);
  const months: ActivityMonth[] = [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => ({
      key,
      label:
        key === thisMonth
          ? "This month"
          : `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`,
      entries: list,
    }));

  return { upcoming, overdueCount, months, total: entries.length };
}

/** "in 3 days" · "due today" · "4 days overdue" — for the Upcoming block. */
export function dueLabel(dueIso: string, todayIso: string): { text: string; overdue: boolean } {
  const d = daysBetween(todayIso, etDay(dueIso));
  if (d < 0) return { text: `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} overdue`, overdue: true };
  if (d === 0) return { text: "due today", overdue: false };
  if (d === 1) return { text: "due tomorrow", overdue: false };
  return { text: `due in ${d} days`, overdue: false };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Gather one job's activity from the records that already hold it.
 *
 * Five reads, in parallel, all scoped to this deal. Every failure degrades to
 * an empty list rather than taking the page down — a chronology missing its
 * emails is far better than a job page that won't open because the email
 * archive is unhappy.
 */
export async function loadActivityEntries(oppId: string): Promise<ActivityEntry[]> {
  const [log, notes, tasks, proposals] = await Promise.all([
    import("./status").then((m) => m.listOpportunityStatusLog(oppId)).catch(() => []),
    import("./notes").then((m) => m.listOpportunityNotes(oppId)).catch(() => []),
    import("./tasks").then((m) => m.listOpportunityTasks(oppId)).catch(() => []),
    import("../proposals/db").then((m) => m.listProposalsForOpp(oppId)).catch(() => []),
  ]);
  const { opportunityStatusLabel } = await import("./db");
  const out: ActivityEntry[] = [];

  for (const l of log) {
    out.push({
      id: `status:${l.id}`,
      kind: "status",
      at: l.changed_at,
      title: l.from_status
        ? `${opportunityStatusLabel(l.from_status)} → ${opportunityStatusLabel(l.to_status)}`
        : opportunityStatusLabel(l.to_status),
      detail: l.note ?? null,
    });
  }
  for (const n of notes) {
    out.push({ id: `note:${n.id}`, kind: "note", at: n.created_at, title: "Note", detail: n.body });
  }
  for (const t of tasks) {
    out.push({
      id: `task:${t.id}`,
      kind: "task",
      at: t.created_at,
      title: t.title,
      detail: t.description,
      dueAt: t.due_at,
      done: !!t.completed_at,
    });
  }
  for (const p of proposals) {
    // The proposal's own milestones, not every edit — "sent" and "decided" are
    // the two moments anyone recalls when reconstructing what happened.
    if (p.sent_at) {
      out.push({
        id: `prop-sent:${p.id}`,
        kind: "proposal",
        at: p.sent_at,
        title: `Proposal R${p.revision_number} sent`,
      });
    }
    if ((p.status === "won" || p.status === "lost") && p.updated_at) {
      out.push({
        id: `prop-${p.status}:${p.id}`,
        kind: "proposal",
        at: p.updated_at,
        title: `Proposal R${p.revision_number} ${p.status}`,
      });
    }
  }
  return out;
}
