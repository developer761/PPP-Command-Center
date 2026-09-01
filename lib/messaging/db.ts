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

/* ─────────────────────── agent config + training ─────────────────── */

export type AgentConfig = {
  id: string;
  workspace_id: string | null;
  persona_name: string;
  persona_role: string;
  required_flow: string[];
  services_included: string | null;
  services_excluded: string | null;
  offsite_rules: string | null;
  tone_rules: string | null;
  office_location: string | null;
  service_area_note: string | null;
  confidence_threshold: number;
  autosend: boolean;
  max_turns: number;
  booking_hours: Record<string, { open: string; close: string }>;
};

export async function loadAgentConfig(workspaceId?: string) {
  const sb = messagingDb();
  const { data: rows } = await sb.from("sms_agent_configs").select("*");
  const all = (rows ?? []) as unknown as AgentConfig[];
  const override = workspaceId ? all.find((c) => c.workspace_id === workspaceId) : undefined;
  const base = all.find((c) => c.workspace_id === null);
  return { config: override ?? base ?? null, isOverride: !!override, hasDefault: !!base };
}

/** Every terminal state Emily can reach, with what each one means. Verbatim
 *  from PPP's prompt so the screen uses the office's own words. */
export const END_STATES: { key: string; label: string; when: string }[] = [
  { key: "success", label: "Success", when: "Details, address, contact and availability collected. Checking the schedule." },
  { key: "phone_pricing", label: "Phone Pricing", when: "Qualifies for an off-site quote and everything needed is collected." },
  { key: "schedule_follow_up", label: "Schedule Follow-up", when: "Asked for a call, cannot talk now, or does not know their availability yet." },
  { key: "transferred", label: "Transferred", when: "Text-only preference, another language, or asked to meet at the office." },
  { key: "lost", label: "Lost", when: "Not moving forward." },
  { key: "bailout", label: "Bailout", when: "Wrong person, chose another company, something negative, or vulgar language." },
  { key: "discard", label: "Discard", when: "Not an estimate request, or work we do not cover." },
  { key: "area_not_serviced", label: "Area not serviced", when: "Zip outside the active service areas." },
  { key: "bot_suspected", label: "Bot Suspected", when: "Asked whether they are talking to a bot." },
  { key: "msg_liked_loved", label: "Msg Liked/Loved", when: "Reacted to a message rather than replying." },
];

export async function trainingStats() {
  const sb = messagingDb();
  const { data } = await sb
    .from("sms_training_examples")
    .select("conduct, outcome, approved, pii_scrubbed, source");
  const rows = data ?? [];
  const usable = rows.filter((r) => r.approved && r.pii_scrubbed);
  const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  return {
    total: rows.length,
    usable: usable.length,
    needsScrub: count((r) => !r.pii_scrubbed),
    needsReview: count((r) => r.pii_scrubbed && !r.approved),
    byConduct: {
      good: count((r) => r.conduct === "good"),
      mixed: count((r) => r.conduct === "mixed"),
      bad: count((r) => r.conduct === "bad"),
      unlabelled: count((r) => !r.conduct),
    },
    booked: count((r) => r.outcome === "success"),
    // The pair that matters: handled well but did not book, and booked despite
    // being handled badly. If both are non-zero, conduct and outcome genuinely
    // disagree and training on outcome alone would teach the model luck.
    goodButLost: count((r) => r.conduct === "good" && r.outcome !== "success" && !!r.outcome),
    badButBooked: count((r) => r.conduct === "bad" && r.outcome === "success"),
  };
}

/* ─────────────────────────── the board ───────────────────────────── */

/**
 * Hatch's Conversations view is a board, not a list: Inbox / Scheduled for F/U
 * in SF / Awaiting Update From Field / Sold, scoped to one workspace.
 *
 * Three of those four are derivable from what we store. The fourth is not, and
 * is marked as such rather than faked — "awaiting update from field" is a state
 * about the ESTIMATOR, not the customer, and PPP has not yet said what puts a
 * conversation into it or takes it out. Guessing would produce a column that
 * looks right and is always empty, or worse, quietly wrong.
 */
export type BoardColumnKey = "inbox" | "followup" | "field" | "sold";

export const BOARD_COLUMNS: {
  key: BoardColumnKey; label: string; hint: string; derivable: boolean;
}[] = [
  { key: "inbox",    label: "Inbox",                     hint: "Live, nobody has taken it", derivable: true },
  { key: "followup", label: "Scheduled for F/U in SF",   hint: "Ended as schedule follow-up", derivable: true },
  { key: "field",    label: "Awaiting Update From Field", hint: "Needs a definition from PPP", derivable: false },
  { key: "sold",     label: "Sold",                      hint: "Ended as success", derivable: true },
];

export type BoardCard = {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  owning_agent: string | null;
  outcome: string | null;
  last_message_at: string | null;
  preview: string | null;
  direction: string | null;
};

export async function loadBoard(workspaceId?: string) {
  const sb = messagingDb();
  let q = sb
    .from("sms_conversations")
    .select("id, customer_phone, customer_name, state, outcome, owning_agent, last_message_at")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data: convs } = await q;
  const rows = convs ?? [];

  // One query for the newest message per conversation, rather than N.
  const ids = rows.map((r) => r.id);
  const { data: msgs } = ids.length
    ? await sb.from("sms_messages").select("conversation_id, body, direction, created_at")
        .in("conversation_id", ids).order("created_at", { ascending: false })
    : { data: [] };
  const newest = new Map<string, { body: string; direction: string }>();
  for (const m of msgs ?? []) {
    if (!newest.has(m.conversation_id)) newest.set(m.conversation_id, { body: m.body, direction: m.direction });
  }

  const columns: Record<BoardColumnKey, BoardCard[]> = { inbox: [], followup: [], field: [], sold: [] };
  for (const r of rows) {
    const card: BoardCard = {
      id: r.id, customer_phone: r.customer_phone, customer_name: r.customer_name,
      owning_agent: r.owning_agent, outcome: r.outcome, last_message_at: r.last_message_at,
      preview: newest.get(r.id)?.body ?? null,
      direction: newest.get(r.id)?.direction ?? null,
    };
    if (r.state !== "ended") columns.inbox.push(card);
    else if (r.outcome === "schedule_follow_up") columns.followup.push(card);
    else if (r.outcome === "success") columns.sold.push(card);
    // Everything else ended in a way none of Hatch's four columns describes —
    // lost, bailout, discard, area not serviced. Hatch presumably has more
    // columns than the four visible in the screenshot; those conversations are
    // not invented into a column they do not belong in.
  }
  return columns;
}

/* ─────────────────────── human agent stats ───────────────────────── */

/**
 * Hatch's Human Agents table. Same columns, including the voice ones we cannot
 * yet fill — see the note on `voice` below.
 */
export type HumanAgentStats = {
  name: string;
  conversations: number;
  successPct: number;
  textConversations: number;
  avgResponseMins: number | null;
};

export async function humanAgentStats(workspaceId?: string): Promise<HumanAgentStats[]> {
  const sb = messagingDb();
  let cq = sb.from("sms_conversations").select("id, outcome, assigned_user_id, state");
  if (workspaceId) cq = cq.eq("workspace_id", workspaceId);
  const { data: convs } = await cq;
  const rows = (convs ?? []).filter((c) => c.assigned_user_id);
  if (!rows.length) return [];

  const { data: msgs } = await sb
    .from("sms_messages")
    .select("conversation_id, direction, created_at, sent_by_user_id")
    .in("conversation_id", rows.map((r) => r.id))
    .order("created_at", { ascending: true });

  // Response time = inbound message -> the next outbound in that thread. The
  // number Hatch reports, and the one that actually predicts conversion.
  const gaps = new Map<string, number[]>();
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs ?? []) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push(m); byConv.set(m.conversation_id, list);
  }
  for (const [convId, list] of byConv) {
    const owner = rows.find((r) => r.id === convId)?.assigned_user_id as string | undefined;
    if (!owner) continue;
    let pending: string | null = null;
    for (const m of list ?? []) {
      if (m.direction === "inbound") pending = m.created_at;
      else if (pending) {
        const mins = (new Date(m.created_at).getTime() - new Date(pending).getTime()) / 60000;
        const g = gaps.get(owner) ?? []; g.push(mins); gaps.set(owner, g);
        pending = null;
      }
    }
  }

  const by = new Map<string, { total: number; success: number }>();
  for (const r of rows) {
    const k = r.assigned_user_id as string;
    const e = by.get(k) ?? { total: 0, success: 0 };
    e.total++;
    if (r.outcome === "success") e.success++;
    by.set(k, e);
  }

  return [...by.entries()].map(([id, e]) => {
    const g = gaps.get(id) ?? [];
    return {
      name: id,
      conversations: e.total,
      successPct: e.total ? Math.round((e.success / e.total) * 1000) / 10 : 0,
      textConversations: e.total,
      avgResponseMins: g.length ? Math.round(g.reduce((a, b) => a + b, 0) / g.length) : null,
    };
  }).sort((a, b) => b.conversations - a.conversations);
}

/* ─────────────────────── conversations report ────────────────────── */

export type ReportRow = {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  agent: string | null;
  workspace_name: string;
  started_at: string | null;
  last_message_at: string | null;
  durationMins: number | null;
  outcome: string | null;
};

export const REPORT_PAGE_SIZE = 25;

/**
 * Hatch's flat conversations report: Contact, Agent, Date, Workspace, Duration,
 * Disposition, paginated 25 at a time.
 *
 * Duration is first message to last, which is what Hatch appears to show — its
 * rows read "22m", "2h 13m", "4d 6h". Note that a long duration is not a bad
 * sign here: a conversation that ran four days is one where the customer kept
 * replying, and Hatch's own human-agent averages sit in days.
 */
export async function loadReport(opts: {
  workspaceId?: string; outcome?: string; page?: number;
}) {
  const sb = messagingDb();
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * REPORT_PAGE_SIZE;

  let q = sb
    .from("sms_conversations")
    .select("id, customer_phone, customer_name, owning_agent, outcome, created_at, last_message_at, sms_sub_accounts(name)", { count: "exact" })
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(from, from + REPORT_PAGE_SIZE - 1);
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  if (opts.outcome) q = q.eq("outcome", opts.outcome);

  const { data, count } = await q;
  const rows: ReportRow[] = (data ?? []).map((r) => {
    const ws = r.sms_sub_accounts as unknown as { name: string } | null;
    const start = r.created_at ? new Date(r.created_at).getTime() : null;
    const end = r.last_message_at ? new Date(r.last_message_at).getTime() : null;
    return {
      id: r.id, customer_phone: r.customer_phone, customer_name: r.customer_name,
      agent: r.owning_agent, workspace_name: ws?.name ?? "—",
      started_at: r.created_at, last_message_at: r.last_message_at,
      durationMins: start && end && end >= start ? Math.round((end - start) / 60000) : null,
      outcome: r.outcome,
    };
  });
  return { rows, total: count ?? 0, page, pages: Math.max(1, Math.ceil((count ?? 0) / REPORT_PAGE_SIZE)) };
}

/** "22m", "2h 13m", "4d 6h" — Hatch's own formatting. */
export function humanDuration(mins: number | null): string {
  if (mins == null) return "—";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
