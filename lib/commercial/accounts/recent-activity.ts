import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  opportunityStatusLabel,
  opportunityLossReasonLabel,
  type OpportunityStatus,
  type OpportunityLossReason,
} from "@/lib/commercial/opportunities/db";

/**
 * Recent Activity feed for the Account 360 Info tab. Pulls the last
 * N events across this account's opportunities — status changes,
 * note adds, task completions. Each entry carries enough context to
 * make sense out of context ("Estimating → Proposal sent on St. Joseph
 * Lobby Repaint, 2d ago").
 *
 * Data sources (UNIONed in app code, not SQL — keeps Postgres planning
 * trivial and the per-source filters explicit):
 *   - commercial_opportunity_status_log (status changes)
 *   - commercial_opportunity_notes (notes added; not edits)
 *   - commercial_opportunity_tasks (completed tasks only)
 *
 * Scope: only events on opportunities belonging to this account, and
 * only on opps that aren't soft-deleted. The opp's title is joined in
 * once per source so the UI can write "on St. Joseph Lobby Repaint."
 */

export type AccountActivityEntry = {
  id: string; // source-prefixed so React keys never collide
  kind: "status_change" | "note_added" | "task_completed";
  occurred_at: string; // ISO timestamp
  opportunity_id: string;
  opportunity_title: string;
  // status_change specifics
  from_status?: OpportunityStatus | null;
  to_status?: OpportunityStatus;
  loss_reason?: OpportunityLossReason | null;
  // common — short text excerpt for note + task title
  excerpt?: string | null;
};

const DEFAULT_LIMIT = 10;

export async function getAccountRecentActivity(
  account_id: string,
  limit: number = DEFAULT_LIMIT
): Promise<AccountActivityEntry[]> {
  const sb = commercialDb();
  // Resolve this account's non-deleted opps once so each source query
  // can scope cheaply via .in("opportunity_id", oppIds).
  const { data: oppsRaw } = await sb
    .from("commercial_opportunities")
    .select("id, title")
    .eq("account_id", account_id)
    .is("deleted_at", null);
  const opps = (oppsRaw ?? []) as Array<{ id: string; title: string }>;
  if (opps.length === 0) return [];
  const oppIds = opps.map((o) => o.id);
  const titleById = new Map(opps.map((o) => [o.id, o.title]));

  // Pull more than `limit` from each source so the post-merge sort can
  // pick the absolute most-recent across all three. 3× limit is plenty
  // at PPP's scale and keeps the round-trips bounded.
  const perSource = Math.max(limit, 30);
  const [statusRows, noteRows, taskRows] = await Promise.all([
    sb
      .from("commercial_opportunity_status_log")
      .select("id, opportunity_id, from_status, to_status, changed_at, note, loss_reason")
      .in("opportunity_id", oppIds)
      .order("changed_at", { ascending: false })
      .limit(perSource),
    sb
      .from("commercial_opportunity_notes")
      .select("id, opportunity_id, created_at, body")
      .in("opportunity_id", oppIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(perSource),
    sb
      .from("commercial_opportunity_tasks")
      .select("id, opportunity_id, title, completed_at")
      .in("opportunity_id", oppIds)
      .not("completed_at", "is", null)
      .is("deleted_at", null)
      .order("completed_at", { ascending: false })
      .limit(perSource),
  ]);

  const out: AccountActivityEntry[] = [];

  for (const r of (statusRows.data ?? []) as Array<{
    id: string;
    opportunity_id: string;
    from_status: OpportunityStatus | null;
    to_status: OpportunityStatus;
    changed_at: string;
    note: string | null;
    loss_reason: OpportunityLossReason | null;
  }>) {
    out.push({
      id: `status:${r.id}`,
      kind: "status_change",
      occurred_at: r.changed_at,
      opportunity_id: r.opportunity_id,
      opportunity_title: titleById.get(r.opportunity_id) ?? "(untitled)",
      from_status: r.from_status,
      to_status: r.to_status,
      loss_reason: r.loss_reason,
      excerpt: r.note ? truncate(r.note, 120) : null,
    });
  }
  for (const r of (noteRows.data ?? []) as Array<{
    id: string;
    opportunity_id: string;
    created_at: string;
    body: string;
  }>) {
    out.push({
      id: `note:${r.id}`,
      kind: "note_added",
      occurred_at: r.created_at,
      opportunity_id: r.opportunity_id,
      opportunity_title: titleById.get(r.opportunity_id) ?? "(untitled)",
      excerpt: truncate(r.body, 120),
    });
  }
  for (const r of (taskRows.data ?? []) as Array<{
    id: string;
    opportunity_id: string;
    title: string;
    completed_at: string;
  }>) {
    out.push({
      id: `task:${r.id}`,
      kind: "task_completed",
      occurred_at: r.completed_at,
      opportunity_id: r.opportunity_id,
      opportunity_title: titleById.get(r.opportunity_id) ?? "(untitled)",
      excerpt: r.title,
    });
  }

  out.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return out.slice(0, limit);
}

/**
 * Short human-readable summary of an activity entry. Used by the
 * Info-tab feed render so the prose stays consistent.
 */
export function describeActivity(entry: AccountActivityEntry): string {
  if (entry.kind === "status_change") {
    if (!entry.from_status) {
      return `Created as ${opportunityStatusLabel(entry.to_status!)}`;
    }
    const base = `Moved ${opportunityStatusLabel(entry.from_status)} → ${opportunityStatusLabel(entry.to_status!)}`;
    if (entry.loss_reason) {
      return `${base} (${opportunityLossReasonLabel(entry.loss_reason)})`;
    }
    return base;
  }
  if (entry.kind === "note_added") return "Note added";
  if (entry.kind === "task_completed") return "Task completed";
  return "Activity";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
