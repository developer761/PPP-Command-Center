import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client for the messaging tables.
 *
 * Every sms_* table has RLS on with NO client policy — the browser cannot read
 * a conversation or write the suppression list, by design. So all access runs
 * through the service key here, server-side, and the pages that call it are
 * gated by app/messaging/layout.tsx.
 */
export function messagingDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type InboxBucket = "needs_human" | "active" | "waiting" | "ended";

/** The buckets the office actually triages by, in the order they matter.
 *  "Needs human" is first because an escalation nobody sees is an escalation
 *  that failed. */
export const BUCKETS: { key: InboxBucket; label: string; short: string }[] = [
  { key: "needs_human", label: "Needs human", short: "Needs you" },
  { key: "active",      label: "AI working",  short: "AI" },
  { key: "waiting",     label: "Awaiting customer", short: "Waiting" },
  { key: "ended",       label: "Ended",       short: "Ended" },
];

export type InboxRow = {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  state: string;
  outcome: string | null;
  owning_agent: string | null;
  last_message_at: string | null;
  workspace_name: string;
};

const STATE_FOR: Record<InboxBucket, string[]> = {
  needs_human: ["human_active"],
  active: ["ai_active"],
  waiting: ["awaiting_customer"],
  ended: ["ended"],
};

export async function loadInbox(bucket: InboxBucket, workspaceId?: string) {
  const sb = messagingDb();
  let q = sb
    .from("sms_conversations")
    .select("id, customer_phone, customer_name, state, outcome, owning_agent, last_message_at, sms_sub_accounts(name)")
    .in("state", STATE_FOR[bucket])
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q;
  if (error) return { rows: [] as InboxRow[], error: error.message };
  const rows: InboxRow[] = (data ?? []).map((r) => {
    const ws = r.sms_sub_accounts as unknown as { name: string } | null;
    return {
      id: r.id, customer_phone: r.customer_phone, customer_name: r.customer_name,
      state: r.state, outcome: r.outcome, owning_agent: r.owning_agent,
      last_message_at: r.last_message_at, workspace_name: ws?.name ?? "—",
    };
  });
  return { rows, error: null as string | null };
}

/** Counts per bucket, for the filter chips. One query, not four. */
export async function bucketCounts(workspaceId?: string) {
  const sb = messagingDb();
  let q = sb.from("sms_conversations").select("state");
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data } = await q;
  const counts: Record<InboxBucket, number> = { needs_human: 0, active: 0, waiting: 0, ended: 0 };
  for (const r of data ?? []) {
    for (const b of BUCKETS) if (STATE_FOR[b.key].includes(r.state)) counts[b.key]++;
  }
  return counts;
}

export async function activeWorkspaces() {
  const sb = messagingDb();
  const { data } = await sb
    .from("sms_sub_accounts")
    .select("id, name, phone_e164")
    .eq("is_active", true)
    .order("name");
  return data ?? [];
}
