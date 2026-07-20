import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { insertCommercialTaskAssignedNotification } from "@/lib/notifications/commercial-events";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * Per-opportunity tasks — to-dos with assignee + due_at + completion
 * tracking. Notification cron lives separately (notified_at flag here
 * is what the cron writes after firing the bell to dedupe re-runs).
 */

export type OpportunityTask = {
  id: string;
  opportunity_id: string;
  title: string;
  description: string | null;
  assigned_user_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  completed_by_user_id: string | null;
  notified_at: string | null;
  created_at: string;
  created_by_user_id: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
  deleted_at: string | null;
};

/** All open + completed tasks for one opp, sorted open-first
 *  (by due_at asc, NULLS last), then completed (most recent first). */
export async function listOpportunityTasks(
  opportunity_id: string
): Promise<OpportunityTask[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_tasks")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null);
  if (error) {
    console.warn("[commercial/opportunities/tasks] list failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as OpportunityTask[];
  return rows.sort((a, b) => {
    const aOpen = a.completed_at === null;
    const bOpen = b.completed_at === null;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (aOpen) {
      if (a.due_at === b.due_at) return a.created_at.localeCompare(b.created_at);
      if (a.due_at === null) return 1;
      if (b.due_at === null) return -1;
      return a.due_at.localeCompare(b.due_at);
    }
    return (b.completed_at ?? "").localeCompare(a.completed_at ?? "");
  });
}

/** Bulk: open task counts per opp, with overdue/due-soon breakdowns
 *  so the list page can render badges without an N+1 fan-out. */
export async function listOpenTaskStatsByOpp(
  opportunity_ids: string[]
): Promise<Map<string, { open: number; overdue: number; due_soon: number }>> {
  if (opportunity_ids.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_tasks")
    .select("opportunity_id, due_at")
    .in("opportunity_id", opportunity_ids)
    .is("deleted_at", null)
    .is("completed_at", null);
  if (error) {
    console.warn("[commercial/opportunities/tasks] listOpenTaskStatsByOpp:", error.message);
    return new Map();
  }
  const today = new Date().toISOString().slice(0, 10);
  // "Due soon" = within 7 days of today (inclusive of today, exclusive
  // of overdue — overdue takes precedence).
  const soonCutoff = new Date();
  soonCutoff.setDate(soonCutoff.getDate() + 7);
  const soonStr = soonCutoff.toISOString().slice(0, 10);
  const out = new Map<string, { open: number; overdue: number; due_soon: number }>();
  for (const row of (data ?? []) as Array<{ opportunity_id: string; due_at: string | null }>) {
    const cur = out.get(row.opportunity_id) ?? { open: 0, overdue: 0, due_soon: 0 };
    cur.open += 1;
    if (row.due_at) {
      const d = row.due_at.slice(0, 10);
      if (d < today) cur.overdue += 1;
      else if (d <= soonStr) cur.due_soon += 1;
    }
    out.set(row.opportunity_id, cur);
  }
  return out;
}

export type CreateOpportunityTaskInput = {
  opportunity_id: string;
  title: string;
  description?: string | null;
  assigned_user_id?: string | null;
  due_at?: string | null;
  created_by_user_id?: string | null;
};

export async function createOpportunityTask(
  input: CreateOpportunityTaskInput
): Promise<{ ok: true; task: OpportunityTask } | { ok: false; error: string }> {
  const title = input.title?.trim() ?? "";
  if (!title) return { ok: false, error: "Title is required." };
  if (title.length > 200) return { ok: false, error: "Title too long (max 200 chars)." };

  const sb = commercialDb();
  const { data: opp } = await sb
    .from("commercial_opportunities")
    // Phase B: pull client_name + property_street so we can compute the
    // derived opp name for the task_assigned notification body.
    .select("id, account_id, title, client_name, property_street, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || opp.deleted_at) return { ok: false, error: "Opportunity not found." };
  const { data: acct } = await sb
    .from("commercial_accounts")
    // Phase B: pull company_name so derivedOppName can format it.
    .select("id, company_name, deleted_at")
    .eq("id", opp.account_id)
    .maybeSingle();
  if (!acct || acct.deleted_at) return { ok: false, error: "Account not found." };

  // If an assignee was supplied, verify they're active + have access.
  if (input.assigned_user_id) {
    const { data: assignee } = await sb
      .from("profiles")
      .select("user_id, is_active, has_new_platform_access")
      .eq("user_id", input.assigned_user_id)
      .maybeSingle();
    if (!assignee) return { ok: false, error: "Assignee not found." };
    if (assignee.is_active === false) {
      return { ok: false, error: "Can't assign an inactive staff member." };
    }
    if (!assignee.has_new_platform_access) {
      return { ok: false, error: "Assignee doesn't have Commercial CC access." };
    }
  }

  const { data, error } = await sb
    .from("commercial_opportunity_tasks")
    .insert({
      opportunity_id: input.opportunity_id,
      title,
      description: input.description?.trim() || null,
      assigned_user_id: input.assigned_user_id ?? null,
      due_at: input.due_at ?? null,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const task = data as OpportunityTask;
  await logInsert("commercial_opportunity_tasks", task.id, task, input.created_by_user_id);

  // Heads-up to the assignee — fire-and-forget so a notification
  // hiccup never breaks the task write. Self-skip + inactive skip are
  // handled inside the helper. Resolving the assigner name is a single
  // profiles lookup; if it errors we fall back to "PPP admin" so the
  // email/bell still goes out.
  if (task.assigned_user_id) {
    void (async () => {
      try {
        let assignerName = "PPP admin";
        if (input.created_by_user_id) {
          const { data: actor } = await sb
            .from("profiles")
            .select("sf_user_name, email")
            .eq("user_id", input.created_by_user_id)
            .maybeSingle();
          const a = actor as { sf_user_name?: string | null; email?: string | null } | null;
          assignerName = a?.sf_user_name || a?.email || "PPP admin";
        }
        // Phase B: derived opp name so the bell + email body reads
        // {account} - {client} - {location} when the CEO structural
        // fields are populated. Falls back to opp.title otherwise.
        const oppRow = opp as {
          title: string;
          client_name: string | null;
          property_street: string | null;
        };
        const acctRow = acct as { company_name: string };
        const displayName = derivedOppName(oppRow, acctRow.company_name);
        await insertCommercialTaskAssignedNotification({
          taskId: task.id,
          opportunityId: task.opportunity_id,
          taskTitle: task.title,
          dueAt: task.due_at,
          oppTitle: displayName,
          recipientUserId: task.assigned_user_id!,
          actingUserId: input.created_by_user_id ?? null,
          assignerName,
        });
      } catch (err) {
        console.warn("[tasks] task_assigned notify failed:", err instanceof Error ? err.message : String(err));
      }
    })();
  }
  return { ok: true, task };
}

export async function completeOpportunityTask(
  opportunity_id: string,
  task_id: string,
  completed_by_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_tasks")
    .select("*")
    .eq("id", task_id)
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Task not found." };
  if ((before as OpportunityTask).completed_at) {
    return { ok: true }; // friendly no-op
  }
  const { data: after, error } = await sb
    .from("commercial_opportunity_tasks")
    .update({
      completed_at: new Date().toISOString(),
      completed_by_user_id: completed_by_user_id ?? null,
      updated_by_user_id: completed_by_user_id ?? null,
    })
    .eq("id", task_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_opportunity_tasks", task_id, before, after, completed_by_user_id);
  return { ok: true };
}

export async function uncompleteOpportunityTask(
  opportunity_id: string,
  task_id: string,
  acting_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_tasks")
    .select("*")
    .eq("id", task_id)
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Task not found." };
  if (!(before as OpportunityTask).completed_at) return { ok: true };
  const { data: after, error } = await sb
    .from("commercial_opportunity_tasks")
    .update({
      completed_at: null,
      completed_by_user_id: null,
      updated_by_user_id: acting_user_id ?? null,
    })
    .eq("id", task_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_opportunity_tasks", task_id, before, after, acting_user_id);
  return { ok: true };
}

export async function deleteOpportunityTask(
  opportunity_id: string,
  task_id: string,
  deleted_by_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_tasks")
    .select("*")
    .eq("id", task_id)
    .eq("opportunity_id", opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Task not found." };
  const { data: after, error } = await sb
    .from("commercial_opportunity_tasks")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: deleted_by_user_id ?? null,
    })
    .eq("id", task_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_opportunity_tasks", task_id, before, deleted_by_user_id);
  void after;
  return { ok: true };
}
