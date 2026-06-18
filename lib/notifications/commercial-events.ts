import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/resend";

/**
 * Stage 1 — Commercial CC event notifications (Karan 2026-06-18).
 *
 * Six new "I should know about this" events for the Commercial CC. Each
 * fires a bell row immediately + queues a commercial-channel email. The
 * email channel routes through COMMERCIAL_RESEND_API_KEY +
 * COMMERCIAL_RESEND_FROM_ADDRESS (falls back to RESEND_API_KEY +
 * RESEND_FROM_ADDRESS until Karan finishes the team.* subdomain in
 * Resend/Vercel; see lib/email/resend.ts).
 *
 * Kinds shipped here:
 *
 *   - commercial_task_assigned        — fired on task create with
 *                                       assigned_user_id; one recipient.
 *   - commercial_task_overdue         — fired by daily cron when a task
 *                                       passes due_at without completion;
 *                                       deduped 24h per task_id.
 *   - commercial_opp_status_changed   — fanned out to every active team
 *                                       member on the opp (minus actor).
 *   - commercial_opp_note_added       — fanned out to every active team
 *                                       member on the opp (minus author).
 *   - commercial_document_expiring    — fired by daily cron for docs
 *                                       expiring in ≤30 days; sent to
 *                                       primary account manager; deduped
 *                                       30 days per doc_id.
 *   - commercial_hot_deal_cooling     — fired by daily cron for Hot deals
 *                                       not updated in 7+ days; sent to
 *                                       primary lead; deduped 7 days per
 *                                       opp_id.
 *
 * Shared invariants:
 *   - Self-skip:   actingUserId === recipientUserId → bail.
 *   - Inactive:    recipient.is_active === false → bail.
 *   - Fire-and-forget on email — bell row goes in either way so the
 *     red dot still surfaces if Resend is down.
 *   - Dedup is OUTSIDE the bell insert (per-kind helpers below) — the
 *     callers query the notifications table for an existing row in
 *     the dedup window before calling the helper.
 */

export type CommercialNotificationKind =
  | "commercial_task_assigned"
  | "commercial_task_overdue"
  | "commercial_opp_status_changed"
  | "commercial_opp_note_added"
  | "commercial_document_expiring"
  | "commercial_hot_deal_cooling";

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "";
}

/**
 * Shared core: check recipient is active, write the bell row, queue the
 * commercial-channel email. Every event helper below reduces to a single
 * call into this.
 *
 * Returns { ok: true, written: true | false } — `written=false` means
 * we skipped (self, inactive, or no email). Never throws; logs all
 * failures + returns ok:false on insert errors.
 */
async function dispatchCommercialNotification(input: {
  kind: CommercialNotificationKind;
  recipientUserId: string;
  actingUserId?: string | null;
  /** Stored in notifications.work_order_id — the source-record UUID
   *  (task / opp / note / doc) so callers can dedup later. */
  sourceId: string | null;
  title: string;
  body: string;
  link: string;
  /** Subject + body for the email. If `emailHtml` is omitted, Resend
   *  sends only the text body. */
  email: {
    subject: string;
    text: string;
    html?: string;
  };
}): Promise<{ ok: true; written: boolean } | { ok: false; error: string }> {
  // Self-skip — actor already knows.
  if (input.actingUserId && input.actingUserId === input.recipientUserId) {
    return { ok: true, written: false };
  }
  try {
    const sb = adminClient();
    // Recipient lookup — skip inactive users + grab their email for the
    // outbound notification email.
    const { data: profile } = await sb
      .from("profiles")
      .select("user_id, email, is_active")
      .eq("user_id", input.recipientUserId)
      .maybeSingle();
    const p = profile as { user_id?: string; email?: string; is_active?: boolean | null } | null;
    if (!p || p.is_active === false) {
      return { ok: true, written: false };
    }
    // Bell row first — even if email fails, the assignee sees the dot.
    const { error: insErr } = await sb.from("notifications").insert({
      recipient_user_id: input.recipientUserId,
      kind: input.kind,
      work_order_id: input.sourceId,
      work_order_number: null,
      customer_name: null,
      title: input.title,
      body: input.body,
      link: input.link,
    });
    if (insErr) {
      console.warn(`[commercial-events] bell insert failed (${input.kind}):`, insErr.message);
      return { ok: false, error: insErr.message };
    }
    // Email is fire-and-forget — log on failure but don't propagate.
    if (p.email) {
      const result = await sendEmail({
        to: p.email,
        subject: input.email.subject,
        text: input.email.text,
        html: input.email.html,
        channel: "commercial",
        tags: [{ name: "kind", value: input.kind }],
      });
      if (!result.ok) {
        console.warn(
          `[commercial-events] email queue failed (${input.kind}):`,
          result.error
        );
      }
    }
    return { ok: true, written: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[commercial-events] unexpected error (${input.kind}):`, msg);
    return { ok: false, error: msg };
  }
}

// ════════════════════════════════════════════════════════════════════
// 1. commercial_task_assigned
// ════════════════════════════════════════════════════════════════════

/** Fired by lib/commercial/opportunities/tasks.ts on insert + on
 *  reassignment when the new assigned_user_id !== the actor. */
export async function insertCommercialTaskAssignedNotification(input: {
  taskId: string;
  opportunityId: string;
  taskTitle: string;
  /** ISO timestamp of when the task is due — null if open-ended. */
  dueAt: string | null;
  /** Display name of the parent opp ("Lobby + Halls Repaint Q3"). */
  oppTitle: string;
  recipientUserId: string;
  /** Who created/reassigned the task. Drives self-skip. */
  actingUserId: string | null;
  /** Display name of the actor ("Alex Chen"). Defaults to "PPP admin". */
  assignerName: string;
}): Promise<void> {
  const dueClause = input.dueAt
    ? ` — due ${input.dueAt.slice(0, 10)}`
    : "";
  const link = `${appBaseUrl()}/commercial/opportunities/${input.opportunityId}?tab=tasks`;
  const title = `Task: ${input.taskTitle}${dueClause}`;
  const body = `${input.assignerName} assigned you a task on ${input.oppTitle}.`;

  const subject = `New task: ${input.taskTitle} (${input.oppTitle})`;
  const text = [
    `Hi,`,
    ``,
    `${input.assignerName} assigned you a task on ${input.oppTitle}:`,
    ``,
    `  ${input.taskTitle}${dueClause}`,
    ``,
    `Open the opportunity: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.assignerName)}</strong> assigned you a task on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;font-weight:600;">${escape(input.taskTitle)}${dueClause ? ` <span style="color:#666;font-weight:normal;">${escape(dueClause)}</span>` : ""}</p>
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  await dispatchCommercialNotification({
    kind: "commercial_task_assigned",
    recipientUserId: input.recipientUserId,
    actingUserId: input.actingUserId,
    sourceId: input.taskId,
    title,
    body,
    link,
    email: { subject, text, html },
  });
}

// ════════════════════════════════════════════════════════════════════
// 2. commercial_task_overdue
// ════════════════════════════════════════════════════════════════════

/** Fired by the daily commercial cron. Caller MUST check the dedup
 *  window (24h) before calling — see lib/commercial/cron/overdue-tasks.ts. */
export async function insertCommercialTaskOverdueNotification(input: {
  taskId: string;
  opportunityId: string;
  taskTitle: string;
  dueAt: string;
  oppTitle: string;
  recipientUserId: string;
}): Promise<void> {
  const overdueDays = Math.max(
    1,
    Math.floor((Date.now() - new Date(input.dueAt).getTime()) / (1000 * 60 * 60 * 24))
  );
  const link = `${appBaseUrl()}/commercial/opportunities/${input.opportunityId}?tab=tasks`;
  const title = `Overdue: ${input.taskTitle}`;
  const body = `${overdueDays} day${overdueDays === 1 ? "" : "s"} past due on ${input.oppTitle}.`;

  const subject = `Overdue task: ${input.taskTitle} (${input.oppTitle})`;
  const text = [
    `Hi,`,
    ``,
    `One of your tasks on ${input.oppTitle} is overdue:`,
    ``,
    `  ${input.taskTitle}`,
    `  Due ${input.dueAt.slice(0, 10)} (${overdueDays} day${overdueDays === 1 ? "" : "s"} late)`,
    ``,
    `Open the opportunity: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p>One of your tasks on <strong>${escape(input.oppTitle)}</strong> is overdue:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#fef2f2;border-left:4px solid #dc2626;border-radius:8px;">
    <strong>${escape(input.taskTitle)}</strong><br/>
    <span style="color:#666;font-size:12px;">Due ${escape(input.dueAt.slice(0, 10))} · ${overdueDays} day${overdueDays === 1 ? "" : "s"} late</span>
  </p>
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  await dispatchCommercialNotification({
    kind: "commercial_task_overdue",
    recipientUserId: input.recipientUserId,
    actingUserId: null, // cron has no actor
    sourceId: input.taskId,
    title,
    body,
    link,
    email: { subject, text, html },
  });
}

// ════════════════════════════════════════════════════════════════════
// 3. commercial_opp_status_changed
// ════════════════════════════════════════════════════════════════════

/** Fanout helper — one bell + email per active team member on the opp,
 *  minus the actor. Called from lib/commercial/opportunities/status.ts
 *  after changeOpportunityStatus succeeds. */
export async function insertCommercialOppStatusChangedNotifications(input: {
  opportunityId: string;
  oppTitle: string;
  fromStatusLabel: string;
  toStatusLabel: string;
  actingUserId: string | null;
  actorName: string;
  /** Optional note attached to the status change. */
  note: string | null;
}): Promise<{ fanout: number }> {
  // Resolve team — every is_primary=any, removed_at=null, joined to active profiles.
  const sb = adminClient();
  const { data: rows } = await sb
    .from("commercial_opportunity_assignments")
    .select(
      "user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(user_id, email, is_active)"
    )
    .eq("opportunity_id", input.opportunityId)
    .is("removed_at", null);
  type Row = {
    user_id: string;
    user:
      | { user_id: string; email: string; is_active: boolean | null }
      | Array<{ user_id: string; email: string; is_active: boolean | null }>
      | null;
  };
  const recipientIds = new Set<string>();
  for (const raw of (rows ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    if (u.is_active === false) continue;
    if (input.actingUserId && u.user_id === input.actingUserId) continue;
    recipientIds.add(u.user_id);
  }
  if (recipientIds.size === 0) return { fanout: 0 };

  const link = `${appBaseUrl()}/commercial/opportunities/${input.opportunityId}`;
  const title = `${input.oppTitle} → ${input.toStatusLabel}`;
  const noteFragment = input.note ? ` Note: ${input.note}` : "";
  const body = `${input.actorName} moved status from ${input.fromStatusLabel}.${noteFragment}`;

  const subject = `Status change: ${input.oppTitle} → ${input.toStatusLabel}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} changed the status on ${input.oppTitle}:`,
    `  ${input.fromStatusLabel} → ${input.toStatusLabel}`,
    input.note ? `  Note: ${input.note}` : "",
    ``,
    `Open the opportunity: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> changed the status on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;"><span style="color:#666;">${escape(input.fromStatusLabel)}</span> → <strong>${escape(input.toStatusLabel)}</strong></p>
  ${input.note ? `<p style="margin:8px 0;padding:12px 16px;background:#fffbeb;border-left:4px solid #d97706;border-radius:8px;color:#444;"><em>${escape(input.note)}</em></p>` : ""}
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  await Promise.allSettled(
    Array.from(recipientIds).map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_opp_status_changed",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.opportunityId,
        title,
        body,
        link,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

// ════════════════════════════════════════════════════════════════════
// 4. commercial_opp_note_added
// ════════════════════════════════════════════════════════════════════

/** Fanout helper. Called from lib/commercial/opportunities/notes.ts
 *  on addOpportunityNote success. */
export async function insertCommercialOppNoteAddedNotifications(input: {
  opportunityId: string;
  noteId: string;
  oppTitle: string;
  noteBodyPreview: string;
  actingUserId: string | null;
  actorName: string;
}): Promise<{ fanout: number }> {
  const sb = adminClient();
  const { data: rows } = await sb
    .from("commercial_opportunity_assignments")
    .select(
      "user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(user_id, email, is_active)"
    )
    .eq("opportunity_id", input.opportunityId)
    .is("removed_at", null);
  type Row = {
    user_id: string;
    user:
      | { user_id: string; email: string; is_active: boolean | null }
      | Array<{ user_id: string; email: string; is_active: boolean | null }>
      | null;
  };
  const recipientIds = new Set<string>();
  for (const raw of (rows ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    if (u.is_active === false) continue;
    if (input.actingUserId && u.user_id === input.actingUserId) continue;
    recipientIds.add(u.user_id);
  }
  if (recipientIds.size === 0) return { fanout: 0 };

  const link = `${appBaseUrl()}/commercial/opportunities/${input.opportunityId}?tab=notes`;
  const title = `New note on ${input.oppTitle}`;
  const body = `${input.actorName}: ${input.noteBodyPreview}`;

  const subject = `New note on ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} added a note on ${input.oppTitle}:`,
    ``,
    `  ${input.noteBodyPreview}`,
    ``,
    `Open the opportunity: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> added a note on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;color:#333;white-space:pre-wrap;">${escape(input.noteBodyPreview)}</p>
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  await Promise.allSettled(
    Array.from(recipientIds).map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_opp_note_added",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.noteId,
        title,
        body,
        link,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

// ════════════════════════════════════════════════════════════════════
// 5. commercial_document_expiring
// ════════════════════════════════════════════════════════════════════

/** Fired by daily cron. Caller MUST check the dedup window (30 days)
 *  before calling — see lib/commercial/cron/expiring-documents.ts. */
export async function insertCommercialDocumentExpiringNotification(input: {
  documentId: string;
  accountId: string;
  accountName: string;
  fileName: string;
  category: string;
  expiresAt: string;
  recipientUserId: string;
}): Promise<void> {
  const daysOut = Math.max(
    0,
    Math.ceil(
      (new Date(input.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    )
  );
  const link = `${appBaseUrl()}/commercial/accounts/${input.accountId}?tab=documents`;
  const title = `${input.category} expiring soon: ${input.accountName}`;
  const body = `${input.fileName} expires in ${daysOut} day${daysOut === 1 ? "" : "s"}.`;

  const subject = `${input.category} for ${input.accountName} expires in ${daysOut}d`;
  const text = [
    `Hi,`,
    ``,
    `A document on ${input.accountName} is expiring soon:`,
    ``,
    `  ${input.fileName} (${input.category})`,
    `  Expires ${input.expiresAt.slice(0, 10)} (${daysOut} day${daysOut === 1 ? "" : "s"} away)`,
    ``,
    `Open the account: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p>A compliance document on <strong>${escape(input.accountName)}</strong> is expiring soon:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#fffbeb;border-left:4px solid #d97706;border-radius:8px;">
    <strong>${escape(input.fileName)}</strong> <span style="color:#666;">(${escape(input.category)})</span><br/>
    <span style="color:#666;font-size:12px;">Expires ${escape(input.expiresAt.slice(0, 10))} · ${daysOut} day${daysOut === 1 ? "" : "s"} away</span>
  </p>
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the account →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  await dispatchCommercialNotification({
    kind: "commercial_document_expiring",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.documentId,
    title,
    body,
    link,
    email: { subject, text, html },
  });
}

// ════════════════════════════════════════════════════════════════════
// 6. commercial_hot_deal_cooling
// ════════════════════════════════════════════════════════════════════

/** Fired by daily cron. Caller MUST check the dedup window (7 days)
 *  before calling — see lib/commercial/cron/hot-deals-cooling.ts. */
export async function insertCommercialHotDealCoolingNotification(input: {
  opportunityId: string;
  oppTitle: string;
  /** Days since last update on the opp record. */
  daysSinceUpdate: number;
  recipientUserId: string;
}): Promise<void> {
  const link = `${appBaseUrl()}/commercial/opportunities/${input.opportunityId}`;
  const title = `🔥 Cooling: ${input.oppTitle}`;
  const body = `Hot deal but no update in ${input.daysSinceUpdate} days.`;

  const subject = `Hot deal cooling: ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.oppTitle} is a Hot deal ($50k+ bid, decision due soon) but hasn't been touched in ${input.daysSinceUpdate} days.`,
    ``,
    `Pick up the phone, log a note, or flip the status to on_hold if it's truly stuck.`,
    ``,
    `Open the opportunity: ${link}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.oppTitle)}</strong> is a 🔥 Hot deal ($50k+ bid, decision due soon) but hasn't been touched in <strong>${input.daysSinceUpdate} days</strong>.</p>
  <p>Pick up the phone, log a note, or flip the status to <em>on_hold</em> if it's truly stuck.</p>
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  await dispatchCommercialNotification({
    kind: "commercial_hot_deal_cooling",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.opportunityId,
    title,
    body,
    link,
    email: { subject, text, html },
  });
}

// ════════════════════════════════════════════════════════════════════
// Dedup helper — used by cron jobs to skip already-fired notifications.
// ════════════════════════════════════════════════════════════════════

/**
 * True if a notification of `kind` was already inserted for `sourceId`
 * within the last `withinHours`. Cron callers use this to suppress
 * duplicate reminders.
 *
 * Implementation: simple existence query against the notifications
 * table using the work_order_id column as the source-id pointer.
 */
export async function hasRecentNotification(
  kind: CommercialNotificationKind,
  sourceId: string,
  withinHours: number
): Promise<boolean> {
  const sb = adminClient();
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("notifications")
    .select("id")
    .eq("kind", kind)
    .eq("work_order_id", sourceId)
    .gte("created_at", cutoff)
    .limit(1);
  if (error) {
    console.warn(`[commercial-events] dedup query failed (${kind}):`, error.message);
    // Fail-safe: if the dedup query errors, ASSUME we already sent so a
    // single user doesn't get spammed by a broken cron. The miss surfaces
    // in logs for next-day diagnosis.
    return true;
  }
  return (data ?? []).length > 0;
}
