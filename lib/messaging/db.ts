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

export async function loadInbox(bucket: InboxBucket, workspaceId?: string, search?: string) {
  const sb = messagingDb();
  let q = sb
    .from("sms_conversations")
    .select("id, customer_phone, customer_name, state, outcome, owning_agent, last_message_at, sms_sub_accounts(name)")
    .in("state", STATE_FOR[bucket])
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  // Name or number. Someone hunting a conversation has one or the other in
  // front of them — usually the number, off a missed call.
  if (search?.trim()) {
    const t = search.trim().replace(/[%,()]/g, "");
    q = q.or(`customer_name.ilike.%${t}%,customer_phone.ilike.%${t}%`);
  }
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

/* ─────────────────────────── thread view ─────────────────────────── */

export type ThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  body: string;
  subject: string | null;
  sent_by_agent: string | null;
  delivery_status: string | null;
  created_at: string;
};

export async function loadThread(id: string) {
  const sb = messagingDb();
  const { data: conv } = await sb
    .from("sms_conversations")
    .select("id, customer_phone, customer_name, customer_email, state, outcome, owning_agent, consent_basis, sf_lead_id, sf_opportunity_id, created_at, sms_sub_accounts(name, phone_e164)")
    .eq("id", id)
    .maybeSingle();
  if (!conv) return null;
  const { data: msgs } = await sb
    .from("sms_messages")
    .select("id, direction, channel, body, subject, sent_by_agent, delivery_status, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  const ws = conv.sms_sub_accounts as unknown as { name: string; phone_e164: string | null } | null;
  return {
    conversation: { ...conv, workspace_name: ws?.name ?? "—", workspace_phone: ws?.phone_e164 ?? null },
    messages: (msgs ?? []) as ThreadMessage[],
  };
}

/* ─────────────────────────── dashboard ───────────────────────────── */

/**
 * The same five numbers Hatch reports per workspace — Active, Completed,
 * Success, Drop Off, Take Over — so the shadow-run comparison in Stage 7 is
 * like-for-like instead of needing a mapping nobody trusts.
 *
 * Hatch's own definitions, read off its dashboard:
 *   Active     conversations still in flight
 *   Completed  conversations that reached a terminal state
 *   Success    of those completed, the share that ended in a booking
 *   Drop Off   customer stopped replying
 *   Take Over  a human stepped in
 */
export type AgentStats = {
  workspace: string;
  active: number;
  completed: number;
  successPct: number;
  dropOffPct: number;
  takeOverPct: number;
};

export async function agentStats(): Promise<AgentStats[]> {
  const sb = messagingDb();
  const { data } = await sb
    .from("sms_conversations")
    .select("state, outcome, sms_sub_accounts(name)");
  const by = new Map<string, { active: number; completed: number; success: number; drop: number; take: number }>();
  for (const r of data ?? []) {
    const ws = (r.sms_sub_accounts as unknown as { name: string } | null)?.name ?? "—";
    const e = by.get(ws) ?? { active: 0, completed: 0, success: 0, drop: 0, take: 0 };
    if (r.state !== "ended") e.active++;
    else {
      e.completed++;
      if (r.outcome === "success") e.success++;
      if (r.outcome === "lost" || r.outcome === "discard") e.drop++;
      if (r.outcome === "transferred") e.take++;
    }
    by.set(ws, e);
  }
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  return [...by.entries()]
    .map(([workspace, e]) => ({
      workspace, active: e.active, completed: e.completed,
      successPct: pct(e.success, e.completed),
      dropOffPct: pct(e.drop, e.completed),
      takeOverPct: pct(e.take, e.completed),
    }))
    .sort((a, b) => b.completed - a.completed || a.workspace.localeCompare(b.workspace));
}

export async function readinessChecks() {
  const sb = messagingDb();
  const [{ count: optOuts }, { count: workspaces }, { count: campaigns }, { data: numbered }] = await Promise.all([
    sb.from("sms_opt_outs").select("*", { count: "exact", head: true }),
    sb.from("sms_sub_accounts").select("*", { count: "exact", head: true }).eq("is_active", true),
    sb.from("sms_campaigns").select("*", { count: "exact", head: true }).eq("is_active", true),
    sb.from("sms_sub_accounts").select("phone_e164").eq("is_active", true),
  ]);
  const missingNumbers = (numbered ?? []).filter((w) => !w.phone_e164).length;
  return {
    optOuts: optOuts ?? 0,
    activeWorkspaces: workspaces ?? 0,
    activeCampaigns: campaigns ?? 0,
    missingNumbers,
    cronSecret: !!process.env.CRON_SECRET,
  };
}


/* ─────────────────────────── sidebar ─────────────────────────────── */

/** Hatch lists 32 workspaces flat and alphabetical, so AM - Dallas TX lands
 *  above every New York inbox. Grouping by region is the one place worth
 *  diverging: "which of my regions needs me" should not be a scan. */
function regionOf(name: string): string {
  if (/^NY |^NYC |LI |Queens|Wstch/i.test(name)) return "New York";
  if (/^NJ /i.test(name)) return "New Jersey";
  if (/^FL |SoFlo/i.test(name)) return "Florida";
  if (/^CT |WC CT/i.test(name)) return "Connecticut";
  if (/^CA /i.test(name)) return "California";
  if (/^CO /i.test(name)) return "Colorado";
  if (/^AM - /i.test(name)) return "Account management";
  return "Other";
}

export async function sidebarWorkspaces() {
  const sb = messagingDb();
  const [{ data: ws }, { data: convs }] = await Promise.all([
    sb.from("sms_sub_accounts").select("id, name").eq("is_active", true).order("name"),
    sb.from("sms_conversations").select("workspace_id").eq("state", "human_active"),
  ]);
  const unread = new Map<string, number>();
  for (const c of convs ?? []) unread.set(c.workspace_id, (unread.get(c.workspace_id) ?? 0) + 1);
  // AM workspaces are a different job from lead inboxes, so they sit in their
  // own group at the end rather than interleaved by state.
  const order = ["New York", "New Jersey", "Florida", "Connecticut", "California", "Colorado", "Account management", "Other"];
  return (ws ?? [])
    .map((w) => ({ id: w.id, name: w.name, region: regionOf(w.name), unread: unread.get(w.id) ?? 0 }))
    .sort((a, b) => order.indexOf(a.region) - order.indexOf(b.region) || a.name.localeCompare(b.name));
}
