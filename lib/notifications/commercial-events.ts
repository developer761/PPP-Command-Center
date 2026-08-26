import "server-only";
import { postCommercialSlack, slackEscape } from "@/lib/commercial/slack-notify";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/resend";
import { reportWarn } from "@/lib/observability";
import { getEnabledNotifyEmail } from "@/lib/notifications/email-prefs";

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
 *                                       expiring (or already expired);
 *                                       sent to primary AM; deduped 30
 *                                       days per doc_id.
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
 *   - Bell `link` is stored RELATIVE (matches the existing
 *     customer_form_submitted convention in lib/notifications/insert.ts)
 *     so the in-app <Link> does SPA navigation. Email bodies build the
 *     absolute URL inline via appendBase() so the link works in a mail
 *     client too.
 */

export type CommercialNotificationKind =
  | "commercial_task_assigned"
  | "commercial_task_overdue"
  | "commercial_opp_status_changed"
  | "commercial_opp_note_added"
  | "commercial_note_mention"
  | "commercial_document_expiring"
  | "commercial_hot_deal_cooling"
  // Phase 3 (Karan 2026-07-07): invoicing events fan out to the opp team so
  // Alex + team see cash-flow moments (created / partial payment / paid in
  // full) without opening the app. Overdue detection lives in a separate
  // daily cron; that fires the same "invoice_paid_full" pattern in reverse.
  | "commercial_invoice_created"
  | "commercial_invoice_payment_recorded"
  | "commercial_invoice_paid_full"
  // Phase F.4 (Karan 2026-07-14): sending a proposal is the moment Alex
  // cares about — the team + estimator want to know it went out so they
  // can watch for the customer response.
  | "commercial_proposal_sent"
  // R1d (Karan 2026-08): in-app approval hard gate. A proposal must be
  // approved before it can be sent. Three events drive the loop:
  //   - approval_requested → pinged to every approver (Brendan/Stephanie/admins)
  //   - approved           → back to the requester (green light to send)
  //   - changes_requested  → back to the requester with the approver's note
  | "commercial_proposal_approval_requested"
  | "commercial_proposal_approved"
  | "commercial_proposal_changes_requested"
  // Block 3B (Karan 2026-07-25): user-defined custom alert rules fire this
  // kind; the title/body carry the specifics.
  | "commercial_custom_rule"
  // Karan 2026-07-27 audit: a won/lost opportunity still un-debriefed 7+ days
  // after the decision — nudge the owner to capture the win/loss reason.
  | "commercial_debrief_overdue"
  // Karan 2026-07-27: internal marker + bell when the 15-day past-due client
  // reminder email is sent (or couldn't be, for lack of a contact email).
  | "commercial_invoice_dunning"
  | "commercial_aia_dunning"
  // R6 (Karan 2026-08): a GC submitted a bid through the public online bid form.
  // Fans out to the whole commercial team so nobody misses a fresh lead.
  | "commercial_bid_submitted";

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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Prepend NEXT_PUBLIC_APP_URL (trailing-slash safe) to a relative
 *  path for use in EMAIL bodies. Bell rows store the relative path
 *  directly. */
function appendBase(relativePath: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  return `${base}${relativePath}`;
}

/** Truncate a body string for bell row + email — keeps the dropdown
 *  scannable and the email body bounded even if a future caller passes
 *  a 5000-char note. */
function truncatePreview(s: string, maxLen: number): string {
  if (!s) return s;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen).trimEnd()}…`;
}

/**
 * Shared core: check recipient is active, write the bell row, queue the
 * commercial-channel email. Every event helper below reduces to a single
 * call into this.
 *
 * `link` MUST be a relative path (e.g. "/commercial/opportunities/123").
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
  /** Relative path (e.g. "/commercial/opportunities/<uuid>?tab=tasks"). */
  link: string;
  /** Subject + body for the email. If `emailHtml` is omitted, Resend
   *  sends only the text body. */
  email: {
    subject: string;
    text: string;
    html?: string;
  };
  /** When true, only the bell row is written (no email). Used by custom
   *  rules with an in-app-only channel. Default false = send email if the
   *  recipient opted into email notifications. */
  skipEmail?: boolean;
  /** When true, email the recipient even if they haven't opted into email
   *  notifications — falls back to their profile email. Used for the approval
   *  loop (approvers ARE the gate; a bell they never see stalls proposals). */
  alwaysEmail?: boolean;
  /** Deliver even when the actor IS the recipient.
   *
   *  The self-skip below is right for FYI events ("Someone edited X") — you
   *  don't need telling about your own action. It is WRONG when the event
   *  hands the actor a task or moves work into their court, because then the
   *  skip means the workflow stalls with nobody told at all.
   *
   *  Brendan 2026-08-17: "When I send for approval I don't see any
   *  notification… When I make a change request I didn't get a notification."
   *  He is both the estimator and the approver, which is normal in a shop this
   *  size — so every approval notification was self-addressed and silently
   *  dropped, leaving a proposal sitting in pending_approval with no trace. */
  allowSelfNotify?: boolean;
}): Promise<{ ok: true; written: boolean } | { ok: false; error: string }> {
  // Self-skip — actor already knows. Opt out for task-handoff kinds.
  if (
    !input.allowSelfNotify &&
    input.actingUserId &&
    input.actingUserId === input.recipientUserId
  ) {
    return { ok: true, written: false };
  }
  try {
    const sb = adminClient();
    // Recipient lookup — skip inactive users + grab their email for the
    // outbound notification email.
    const { data: profile } = await sb
      .from("profiles")
      .select("user_id, email, is_active, has_new_platform_access")
      .eq("user_id", input.recipientUserId)
      .maybeSingle();
    const p = profile as {
      user_id?: string;
      email?: string;
      is_active?: boolean | null;
      has_new_platform_access?: boolean | null;
    } | null;
    // Audit fix 2026-06-24: also gate on has_new_platform_access. If an
    // admin revoked Commercial CC access (without soft-deleting their
    // assignments), the user keeps getting bells + emails for an app they
    // can no longer open. Skip those too.
    if (!p || p.is_active === false || p.has_new_platform_access === false) {
      return { ok: true, written: false };
    }
    // CREW never receive Commercial notifications.
    //
    // `has_new_platform_access` isn't enough: a crew-only login can carry it
    // and still be bounced off every Commercial surface by the crew allowlist.
    // So a painter added to a deal's team was getting bell rows — and, for the
    // alwaysEmail kinds, actual emails — pointing at pages that redirect them
    // straight back to their own home. A notification you are structurally
    // forbidden from acting on is noise at best and confusing at worst.
    //
    // Gated at the single dispatch chokepoint so it covers every kind at once
    // rather than each fan-out remembering to check.
    const { isCrewOnlyUser } = await import("@/lib/commercial/crew-access");
    if (await isCrewOnlyUser(input.recipientUserId)) {
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
      // Stage 3.5: page Slack — bell insert failure means the user will
      // NEVER see this notification. Dedup absorbs spam if it's a
      // sustained outage.
      reportWarn({
        key: "bell_insert_failed",
        message: "Notification bell insert failed",
        platform: "commercial_cc",
        context: {
          kind: input.kind,
          source_id_short: input.sourceId ? input.sourceId.slice(0, 8) : "null",
          recipient_id_short: input.recipientUserId.slice(0, 8),
          db_error: insErr.message?.slice(0, 100),
        },
      });
      return { ok: false, error: insErr.message };
    }
    // Email is OPT-IN (Karan + Katie 2026-07-27): the bell/inbox is always the
    // source of truth; email only goes out if the recipient set a notification
    // email + turned it on (commercial_user_email_prefs). No pref → bell only.
    // Fire-and-forget — log on failure but don't propagate.
    // Email target: the recipient's opted-in notify email, or — when the caller
    // marks this alwaysEmail (the approval loop) — their profile email as a
    // fallback so an approver/requester is never left with only a bell.
    const notifyEmail = input.skipEmail
      ? null
      : (await getEnabledNotifyEmail(input.recipientUserId)) ?? (input.alwaysEmail ? p.email ?? null : null);
    if (notifyEmail) {
      // List-Unsubscribe on every notification email. Stephanie 2026-08-17:
      // "half of them end up in spam/junk." Gmail and Outlook read a
      // one-click unsubscribe as a sign of a legitimate recurring sender, and
      // its absence as the opposite — without it the only way to stop the mail
      // is "report spam", which is precisely the reputation hit that puts the
      // NEXT message in junk. The link is real: the notification settings page
      // is where the enabled flag on this address is turned off.
      const unsubscribeUrl = appendBase("/commercial/settings/notifications");
      const result = await sendEmail({
        to: notifyEmail,
        subject: input.email.subject,
        text: input.email.text,
        html: input.email.html,
        channel: "commercial",
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          // Tells the mail client the URL is safe to POST to, which is what
          // makes the native "Unsubscribe" button appear beside the sender.
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [{ name: "kind", value: input.kind }],
      });
      if (!result.ok) {
        // Stage 3.5: page Slack on email send failures. Bell row still
        // landed (we already inserted above), but the email channel is
        // degraded. Dedup absorbs sustained Resend outages.
        reportWarn({
          key: "commercial_email_send_failed",
          message: "Commercial notification email send failed",
          platform: "commercial_cc",
          context: {
            kind: input.kind,
            source_id_short: input.sourceId ? input.sourceId.slice(0, 8) : "null",
            resend_error: result.error?.slice(0, 100),
            http_status:
              "statusCode" in result && typeof result.statusCode === "number"
                ? result.statusCode
                : null,
          },
        });
      }
    }
    return { ok: true, written: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[commercial-events] unexpected error (kind=${input.kind}, source=${input.sourceId ?? "null"}): ${msg}`
    );
    return { ok: false, error: msg };
  }
}

// Cap on opp title shown in bell title — past ~60 chars it overflows the
// dropdown awkwardly. Email subject keeps the full title.
const BELL_TITLE_OPP_CAP = 60;
// Cap on inline note shown in status-changed bell body.
const BELL_NOTE_CAP = 120;

// ════════════════════════════════════════════════════════════════════
// 1. commercial_task_assigned
// ════════════════════════════════════════════════════════════════════

/** Fired by lib/commercial/opportunities/tasks.ts on insert of a task
 *  with assigned_user_id set. (No reassignment write path exists today;
 *  if a future update path mutates assigned_user_id, it must call this
 *  helper too — see the bell verbiage comment in tasks.ts.) */
export async function insertCommercialTaskAssignedNotification(input: {
  taskId: string;
  opportunityId: string;
  taskTitle: string;
  /** ISO date (YYYY-MM-DD) of when the task is due — null if open-ended. */
  dueAt: string | null;
  /** Display name of the parent opp ("Lobby + Halls Repaint Q3"). */
  oppTitle: string;
  recipientUserId: string;
  /** Who created the task. Drives self-skip. */
  actingUserId: string | null;
  /** Display name of the actor ("Alex Chen"). Defaults to "PPP admin". */
  assignerName: string;
}): Promise<void> {
  const dueClause = input.dueAt && input.dueAt.length >= 10
    ? ` — due ${input.dueAt.slice(0, 10)}`
    : "";
  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=tasks`;
  const emailLink = appendBase(relativeLink);
  const title = `Task: ${truncatePreview(input.taskTitle, 80)}${dueClause}`;
  const body = `${input.assignerName} assigned you a task on ${truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP)}.`;

  const subject = `New task: ${input.taskTitle} (${input.oppTitle})`;
  const text = [
    `Hi,`,
    ``,
    `${input.assignerName} assigned you a task on ${input.oppTitle}:`,
    ``,
    `  ${input.taskTitle}${dueClause}`,
    ``,
    `Open the opportunity: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.assignerName)}</strong> assigned you a task on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;font-weight:600;">${escape(input.taskTitle)}${dueClause ? ` <span style="color:#666;font-weight:normal;">${escape(dueClause)}</span>` : ""}</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the task",
    tone: "neutral",
  });

  await dispatchCommercialNotification({
    kind: "commercial_task_assigned",
    recipientUserId: input.recipientUserId,
    actingUserId: input.actingUserId,
    sourceId: input.taskId,
    title,
    body,
    link: relativeLink,
    email: { subject, text, html },
  });
}

// ════════════════════════════════════════════════════════════════════
// 2. commercial_task_overdue
// ════════════════════════════════════════════════════════════════════

/** Fired by the daily commercial cron. Caller MUST check the dedup
 *  window (24h) before calling — see lib/commercial/cron/overdue-tasks.ts.
 *  Caller filters out today's tasks (due_at is a DATE column compared
 *  date-only) so `dueAt` here is guaranteed strictly in the past. */
export async function insertCommercialTaskOverdueNotification(input: {
  taskId: string;
  opportunityId: string;
  taskTitle: string;
  /** ISO date (YYYY-MM-DD). */
  dueAt: string;
  oppTitle: string;
  recipientUserId: string;
}): Promise<void> {
  // Date-only diff so we don't get fractional days from TZ math. dueAt
  // is a DATE (YYYY-MM-DD); today is the cron-day in UTC. Both are
  // start-of-day so the diff is clean integer days.
  const dueDateStr = input.dueAt.slice(0, 10);
  // ET date so the "X days past due" count matches the ET-based overdue detector.
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const overdueDays = Math.max(
    1,
    Math.round(
      (Date.parse(`${todayStr}T00:00:00Z`) - Date.parse(`${dueDateStr}T00:00:00Z`)) /
        (1000 * 60 * 60 * 24)
    )
  );
  const dayNoun = overdueDays === 1 ? "day" : "days";
  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=tasks`;
  const emailLink = appendBase(relativeLink);
  const title = `Overdue: ${truncatePreview(input.taskTitle, 80)}`;
  const body = `${overdueDays} ${dayNoun} past due on ${truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP)}.`;

  const subject = `Overdue task: ${input.taskTitle} (${input.oppTitle})`;
  const text = [
    `Hi,`,
    ``,
    `One of your tasks on ${input.oppTitle} is overdue:`,
    ``,
    `  ${input.taskTitle}`,
    `  Due ${dueDateStr} (${overdueDays} ${dayNoun} late)`,
    ``,
    `Open the opportunity: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p>One of your tasks on <strong>${escape(input.oppTitle)}</strong> is overdue:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#fef2f2;border-left:4px solid #dc2626;border-radius:8px;">
    <strong>${escape(input.taskTitle)}</strong><br/>
    <span style="color:#666;font-size:12px;">Due ${escape(dueDateStr)} · ${overdueDays} ${dayNoun} late</span>
  </p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "It's overdue",
    tone: "needs_action",
  });

  await dispatchCommercialNotification({
    kind: "commercial_task_overdue",
    recipientUserId: input.recipientUserId,
    actingUserId: null, // cron has no actor
    sourceId: input.taskId,
    title,
    body,
    link: relativeLink,
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
      "user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(user_id, email, is_active, has_new_platform_access)"
    )
    .eq("opportunity_id", input.opportunityId)
    .is("removed_at", null);
  type Row = {
    user_id: string;
    user:
      | { user_id: string; email: string; is_active: boolean | null; has_new_platform_access: boolean | null }
      | Array<{ user_id: string; email: string; is_active: boolean | null; has_new_platform_access: boolean | null }>
      | null;
  };
  const recipientIds = new Set<string>();
  for (const raw of (rows ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    if (u.is_active === false) continue;
    // Audit fix 2026-06-24: also skip if Commercial CC access was revoked.
    if (u.has_new_platform_access === false) continue;
    if (input.actingUserId && u.user_id === input.actingUserId) continue;
    recipientIds.add(u.user_id);
  }
  if (recipientIds.size === 0) return { fanout: 0 };

  // Phase B audit fix (2026-07-10): opp detail page has a shim that
  // bounces params-less URLs back to the account list. Add ?tab=info
  // so the recipient lands on the opp itself, not the account view.
  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=info`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const title = `${shortOppTitle} → ${input.toStatusLabel}`;
  // Bell body inline note caps at BELL_NOTE_CAP so a 5000-char note can't
  // blow up the dropdown row. Full note still in the email body.
  const noteForBell = input.note ? ` Note: ${truncatePreview(input.note, BELL_NOTE_CAP)}` : "";
  const body = `${input.actorName} moved status from ${input.fromStatusLabel}.${noteForBell}`;

  const subject = `Status change: ${input.oppTitle} → ${input.toStatusLabel}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} changed the status on ${input.oppTitle}:`,
    `  ${input.fromStatusLabel} → ${input.toStatusLabel}`,
    input.note ? `  Note: ${input.note}` : "",
    ``,
    `Open the opportunity: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> changed the status on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;"><span style="color:#666;">${escape(input.fromStatusLabel)}</span> → <strong>${escape(input.toStatusLabel)}</strong></p>
  ${input.note ? `<p style="margin:8px 0;padding:12px 16px;background:#fffbeb;border-left:4px solid #d97706;border-radius:8px;color:#444;word-break:break-word;"><em>${escape(input.note)}</em></p>` : ""}
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the deal",
    tone: "neutral",
  });

  await Promise.allSettled(
    Array.from(recipientIds).map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_opp_status_changed",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.opportunityId,
        title,
        body,
        link: relativeLink,
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
 *  on addOpportunityNote success. `excludeUserIds` lets the caller
 *  skip users who already got a more-specific notification (e.g.
 *  @mention recipients shouldn't also get the generic team-fanout
 *  one for the same note). */
export async function insertCommercialOppNoteAddedNotifications(input: {
  opportunityId: string;
  noteId: string;
  oppTitle: string;
  /** Pre-truncated by caller; helper applies a defensive secondary
   *  truncate so a future caller can't blow up the bell row. */
  noteBodyPreview: string;
  actingUserId: string | null;
  actorName: string;
  /** User IDs to skip (e.g. recipients who already got the @mention
   *  variant of this same note). Optional. */
  excludeUserIds?: string[];
}): Promise<{ fanout: number }> {
  const sb = adminClient();
  const { data: rows } = await sb
    .from("commercial_opportunity_assignments")
    .select(
      "user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(user_id, email, is_active, has_new_platform_access)"
    )
    .eq("opportunity_id", input.opportunityId)
    .is("removed_at", null);
  type Row = {
    user_id: string;
    user:
      | { user_id: string; email: string; is_active: boolean | null; has_new_platform_access: boolean | null }
      | Array<{ user_id: string; email: string; is_active: boolean | null; has_new_platform_access: boolean | null }>
      | null;
  };
  const exclude = new Set(input.excludeUserIds ?? []);
  const recipientIds = new Set<string>();
  for (const raw of (rows ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    if (u.is_active === false) continue;
    // Audit fix 2026-06-24: also skip if Commercial CC access was revoked.
    if (u.has_new_platform_access === false) continue;
    if (input.actingUserId && u.user_id === input.actingUserId) continue;
    if (exclude.has(u.user_id)) continue;
    recipientIds.add(u.user_id);
  }
  if (recipientIds.size === 0) return { fanout: 0 };

  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=notes`;
  const emailLink = appendBase(relativeLink);
  const safePreview = truncatePreview(input.noteBodyPreview, 240);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const title = `New note on ${shortOppTitle}`;
  const body = `${input.actorName}: ${safePreview}`;

  const subject = `New note on ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} added a note on ${input.oppTitle}:`,
    ``,
    `  ${safePreview}`,
    ``,
    `Open the opportunity: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> added a note on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;color:#333;white-space:pre-wrap;word-break:break-word;">${escape(safePreview)}</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Read the note",
    tone: "neutral",
  });

  await Promise.allSettled(
    Array.from(recipientIds).map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_opp_note_added",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.noteId,
        title,
        body,
        link: relativeLink,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

// ════════════════════════════════════════════════════════════════════
// 4b. commercial_note_mention — fired alongside note_added when the
//      note body @mentions one or more users. Personal-tone copy +
//      higher-prominence visual (yellow tag color in bell, "tagged"
//      verb instead of "added"). Caller is responsible for excluding
//      these recipients from the generic note_added fanout so each
//      user gets exactly one notification per note.
// ════════════════════════════════════════════════════════════════════

/** Per-user "you were tagged" helper. Caller passes the deduped set of
 *  mentioned user_ids. Self-skip is enforced in dispatch. */
export async function insertCommercialNoteMentionNotifications(input: {
  opportunityId: string;
  noteId: string;
  oppTitle: string;
  noteBodyPreview: string;
  actingUserId: string | null;
  actorName: string;
  mentionedUserIds: string[];
}): Promise<{ fanout: number }> {
  if (input.mentionedUserIds.length === 0) return { fanout: 0 };
  const safePreview = truncatePreview(input.noteBodyPreview, 240);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=notes`;
  const emailLink = appendBase(relativeLink);
  const title = `${input.actorName} tagged you on ${shortOppTitle}`;
  const body = safePreview;

  const subject = `${input.actorName} tagged you on ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} tagged you in a note on ${input.oppTitle}:`,
    ``,
    `  ${safePreview}`,
    ``,
    `Open the opportunity: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> tagged you in a note on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#fef9c3;border-left:4px solid #ca8a04;border-radius:8px;color:#333;white-space:pre-wrap;word-break:break-word;">${escape(safePreview)}</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Read it",
    tone: "neutral",
  });

  await Promise.allSettled(
    Array.from(new Set(input.mentionedUserIds)).map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_note_mention",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.noteId,
        title,
        body,
        link: relativeLink,
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

/** Format expiry timing: "today", "tomorrow", "in N days", or
 *  "N days ago" for already-expired. */
function expiryClause(expiresAt: string): {
  shortLabel: string;
  prefix: string;
  expired: boolean;
  daysAbs: number;
} {
  const expMs = new Date(expiresAt).getTime();
  const nowMs = Date.now();
  const diffDays = Math.round((expMs - nowMs) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    const ago = Math.abs(diffDays);
    return {
      shortLabel: ago === 1 ? "1 day ago" : `${ago} days ago`,
      prefix: "Expired",
      expired: true,
      daysAbs: ago,
    };
  }
  if (diffDays === 0) {
    return { shortLabel: "today", prefix: "Expires", expired: false, daysAbs: 0 };
  }
  if (diffDays === 1) {
    return { shortLabel: "tomorrow", prefix: "Expires", expired: false, daysAbs: 1 };
  }
  return {
    shortLabel: `in ${diffDays} days`,
    prefix: "Expires",
    expired: false,
    daysAbs: diffDays,
  };
}

/** Fired by daily cron. Caller MUST check the dedup window (30 days)
 *  before calling — see lib/commercial/cron/expiring-documents.ts. */
export async function insertCommercialDocumentExpiringNotification(input: {
  documentId: string;
  accountId: string;
  accountName: string;
  fileName: string;
  category: string;
  /** ISO TIMESTAMPTZ. */
  expiresAt: string;
  recipientUserId: string;
}): Promise<void> {
  const exp = expiryClause(input.expiresAt);
  const relativeLink = `/commercial/accounts/${input.accountId}?tab=documents`;
  const emailLink = appendBase(relativeLink);
  const shortAccountName = truncatePreview(input.accountName, BELL_TITLE_OPP_CAP);
  const title = exp.expired
    ? `${input.category} EXPIRED: ${shortAccountName}`
    : `${input.category} expiring ${exp.shortLabel}: ${shortAccountName}`;
  const body = exp.expired
    ? `${input.fileName} expired ${exp.shortLabel}.`
    : `${input.fileName} expires ${exp.shortLabel}.`;

  const subject = exp.expired
    ? `${input.category} for ${input.accountName} EXPIRED (${exp.shortLabel})`
    : `${input.category} for ${input.accountName} expires ${exp.shortLabel}`;
  const text = [
    `Hi,`,
    ``,
    exp.expired
      ? `A compliance document on ${input.accountName} has EXPIRED:`
      : `A compliance document on ${input.accountName} is expiring soon:`,
    ``,
    `  ${input.fileName} (${input.category})`,
    `  ${exp.prefix} ${input.expiresAt.slice(0, 10)} (${exp.shortLabel})`,
    ``,
    `Open the account: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p>A compliance document on <strong>${escape(input.accountName)}</strong> ${exp.expired ? "has <strong>EXPIRED</strong>" : "is expiring soon"}:</p>
  <p style="margin:16px 0;padding:12px 16px;background:${exp.expired ? "#fef2f2;border-left:4px solid #dc2626" : "#fffbeb;border-left:4px solid #d97706"};border-radius:8px;">
    <strong>${escape(input.fileName)}</strong> <span style="color:#666;">(${escape(input.category)})</span><br/>
    <span style="color:#666;font-size:12px;">${exp.prefix} ${escape(input.expiresAt.slice(0, 10))} · ${escape(exp.shortLabel)}</span>
  </p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the account →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open documents",
    tone: "needs_action",
  });

  await dispatchCommercialNotification({
    kind: "commercial_document_expiring",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.documentId,
    title,
    body,
    link: relativeLink,
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
  // Phase B audit fix (2026-07-10): opp detail page has a shim that
  // bounces params-less URLs back to the account list. Add ?tab=info
  // so the recipient lands on the opp itself, not the account view.
  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=info`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const dayNoun = input.daysSinceUpdate === 1 ? "day" : "days";
  const title = `Cooling: ${shortOppTitle}`;
  const body = `Hot deal but no update in ${input.daysSinceUpdate} ${dayNoun}.`;

  const subject = `Hot deal cooling: ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.oppTitle} is a Hot deal (high-value bid, decision due soon) but hasn't been touched in ${input.daysSinceUpdate} ${dayNoun}.`,
    ``,
    `Pick up the phone, log a note, or flip the status to Follow Up if you're waiting on the GC.`,
    ``,
    `Open the opportunity: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.oppTitle)}</strong> is a Hot deal (high-value bid, decision due soon) but hasn't been touched in <strong>${input.daysSinceUpdate} ${dayNoun}</strong>.</p>
  <p>Pick up the phone, log a note, or flip the status to <em>Follow Up</em> if you're waiting on the GC.</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the deal",
    tone: "needs_action",
  });

  await dispatchCommercialNotification({
    kind: "commercial_hot_deal_cooling",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.opportunityId,
    title,
    body,
    link: relativeLink,
    email: { subject, text, html },
  });
}

// ════════════════════════════════════════════════════════════════════
// commercial_debrief_overdue — win/lost opp still un-debriefed 7+ days.
// ════════════════════════════════════════════════════════════════════

/** Fired by daily cron when a won/lost opportunity is still un-debriefed 7+
 *  days after the decision. Caller checks the dedup window (7 days). Sent to
 *  the opp owner (primary lead) — the person who should capture the reason. */
export async function insertCommercialDebriefOverdueNotification(input: {
  opportunityId: string;
  accountId: string;
  oppTitle: string;
  /** "won" | "lost" — drives copy. */
  outcome: string;
  daysSinceDecision: number;
  recipientUserId: string;
}): Promise<void> {
  const relativeLink = `/commercial/accounts/${input.accountId}/debrief/${input.opportunityId}`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const title = `Debrief needed: ${shortOppTitle}`;
  const body = `Marked ${input.outcome} ${input.daysSinceDecision} days ago — capture the win/loss reason.`;

  const subject = `Win/Loss debrief still open: ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.oppTitle} was marked ${input.outcome} ${input.daysSinceDecision} days ago but hasn't been debriefed yet.`,
    `A quick debrief (competitor, deciding factor, lessons) is what makes the Win/Loss report useful.`,
    ``,
    `Complete the debrief: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.oppTitle)}</strong> was marked <strong>${escape(input.outcome)}</strong> ${input.daysSinceDecision} days ago but hasn't been debriefed yet.</p>
  <p>A quick debrief (competitor, deciding factor, lessons) is what makes the Win/Loss report useful.</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Complete the debrief →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Fill in the debrief",
    tone: "needs_action",
  });

  await dispatchCommercialNotification({
    kind: "commercial_debrief_overdue",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.opportunityId,
    title,
    body,
    link: relativeLink,
    email: { subject, text, html },
  });
}

/** Client-facing 15-day past-due reminder email (Karan 2026-07-27). Sent to the
 *  GC billing contact directly (NOT the internal bell/opt-in path). Returns ok
 *  so the cron can record last_dunning_at + fire the internal marker. */
export async function sendClientInvoiceDunningEmail(input: {
  to: string;
  invoiceNumber: string;
  balanceCents: number;
  dueDateIso: string | null;
  accountName: string;
  daysPastDue: number;
}): Promise<{ ok: boolean }> {
  // Read the operating company rather than hardcoding a name. This was the one
  // outbound commercial email that named a company in its body, and it named
  // the RESIDENTIAL one — so a Tomco GC chasing a past-due invoice got a
  // reminder signed "Precision Painting Plus".
  const { getOperatingCompany } = await import("@/lib/commercial/operating-company/db");
  const company = await getOperatingCompany();
  const money = formatMoneyCents(input.balanceCents);
  const dueStr = input.dueDateIso
    ? new Date(input.dueDateIso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })
    : null;
  const subject = `Payment reminder — Invoice ${input.invoiceNumber} (${money} past due)`;
  const text = [
    `Hello,`,
    ``,
    `This is a friendly reminder that Invoice ${input.invoiceNumber} has an outstanding balance of ${money}${dueStr ? `, due ${dueStr}` : ""} — now ${input.daysPastDue} days past due.`,
    ``,
    `If payment is already on its way, thank you and please disregard this notice. Otherwise, we'd appreciate settling the balance at your earliest convenience. Reply to this email with any questions.`,
    ``,
    `Thank you,`,
    company.name,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hello,</p>
  <p>This is a friendly reminder that <strong>Invoice ${escape(input.invoiceNumber)}</strong> has an outstanding balance of <strong>${escape(money)}</strong>${dueStr ? `, due ${escape(dueStr)}` : ""} — now <strong>${input.daysPastDue} days past due</strong>.</p>
  <p>If payment is already on its way, thank you and please disregard this notice. Otherwise, we'd appreciate settling the balance at your earliest convenience. Reply to this email with any questions.</p>
  <p style="margin-top:24px;">Thank you,<br/>${company.name}</p>
</div>`;
  const res = await sendEmail({
    to: input.to,
    subject,
    text,
    html,
    channel: "commercial",
    tags: [{ name: "kind", value: "commercial_invoice_dunning" }],
  });
  return { ok: res.ok };
}

/** Internal bell (+ opt-in email) telling the team a client dunning notice was
 *  sent — or couldn't be, for lack of a contact email. Also the visible record
 *  of client outreach. Deduping is handled by the invoice's last_dunning_at. */
export async function insertCommercialInvoiceDunningMarker(input: {
  invoiceId: string;
  invoiceNumber: string;
  recipientUserId: string;
  daysPastDue: number;
  balanceCents: number;
  sentToClient: boolean;
  /** True when a contact email EXISTS but the send failed (vs. no contact). */
  emailFailed?: boolean;
  /** Too far past due to auto-mail a demand about — a person should look. */
  stale?: boolean;
  clientEmailMasked: string | null;
}): Promise<void> {
  const relativeLink = `/commercial/invoices/${input.invoiceId}`;
  const emailLink = appendBase(relativeLink);
  const money = formatMoneyCents(input.balanceCents);
  // Three distinct states so the team isn't told "no contact" on a send failure.
  const title = input.sentToClient
    ? `Past-due reminder sent · ${input.invoiceNumber}`
    : input.stale
    ? `Very old unpaid invoice — needs a look · ${input.invoiceNumber}`
    : input.emailFailed
    ? `Past-due reminder FAILED to send · ${input.invoiceNumber}`
    : `Past-due invoice needs a contact · ${input.invoiceNumber}`;
  const body = input.sentToClient
    ? `Emailed the client${input.clientEmailMasked ? ` (${input.clientEmailMasked})` : ""} — ${money}, ${input.daysPastDue}d past due.`
    : input.stale
    ? `${input.invoiceNumber} shows ${money} outstanding and is ${input.daysPastDue}d past due — too old to send an automatic reminder about. Usually a payment that was never recorded, or a write-off nobody voided. Check before chasing.`
    : input.emailFailed
    ? `Couldn't email the client${input.clientEmailMasked ? ` (${input.clientEmailMasked})` : ""} for ${input.invoiceNumber} (${money}, ${input.daysPastDue}d past due) — the email failed; follow up manually.`
    : `${input.invoiceNumber} is ${input.daysPastDue}d past due but the account has no contact email — follow up manually.`;

  const subject = title;
  const text = [body, ``, `Open the invoice: ${emailLink}`, ``, `— PPP Commercial Command Center`].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>${escape(body)}</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the invoice →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the invoice",
    tone: "needs_action",
  });

  await dispatchCommercialNotification({
    kind: "commercial_invoice_dunning",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.invoiceId,
    title,
    body,
    link: relativeLink,
    email: { subject, text, html },
  });
}

/**
 * The same reminder, for a job billed by AIA payment application.
 *
 * NOT a reuse of the invoice email with a different number substituted. A GC's
 * AP department matches a payment against a certified application — "Invoice
 * AIA #3" is not a document they hold, and quoting an invoice number that does
 * not exist is how a reminder gets ignored or disputed. So this names the
 * application and its project, and says what it is.
 *
 * Retainage is deliberately never in the figure: `dueNowCents` is G702 line 6
 * less what has been certified paid. Chasing a GC for money their contract lets
 * them hold to close-out is the fastest way to lose the relationship this email
 * is meant to protect.
 */
export async function sendClientAiaDunningEmail(input: {
  to: string;
  applicationNumber: number;
  projectName: string;
  balanceCents: number;
  dueDateIso: string | null;
  daysPastDue: number;
}): Promise<{ ok: boolean }> {
  const { getOperatingCompany } = await import("@/lib/commercial/operating-company/db");
  const company = await getOperatingCompany();
  const money = formatMoneyCents(input.balanceCents);
  const dueStr = input.dueDateIso
    ? new Date(input.dueDateIso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })
    : null;
  const appLabel = `Application No. ${input.applicationNumber}`;
  const subject = `Payment reminder — ${appLabel}, ${input.projectName} (${money} past due)`;
  const text = [
    `Hello,`,
    ``,
    `This is a friendly reminder that ${appLabel} for ${input.projectName} has an outstanding balance of ${money}${dueStr ? `, due ${dueStr}` : ""} — now ${input.daysPastDue} days past due.`,
    ``,
    `This is the amount certified as earned less retainage; retainage held under the contract is not included.`,
    ``,
    `If payment is already on its way, thank you and please disregard this notice. Otherwise, we'd appreciate settling the balance at your earliest convenience. Reply to this email with any questions.`,
    ``,
    `Thank you,`,
    company.name,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hello,</p>
  <p>This is a friendly reminder that <strong>${escape(appLabel)}</strong> for <strong>${escape(input.projectName)}</strong> has an outstanding balance of <strong>${escape(money)}</strong>${dueStr ? `, due ${escape(dueStr)}` : ""} — now <strong>${input.daysPastDue} days past due</strong>.</p>
  <p style="color:#555;">This is the amount certified as earned less retainage; retainage held under the contract is not included.</p>
  <p>If payment is already on its way, thank you and please disregard this notice. Otherwise, we&rsquo;d appreciate settling the balance at your earliest convenience. Reply to this email with any questions.</p>
  <p style="margin-top:24px;">Thank you,<br/>${company.name}</p>
</div>`;
  const res = await sendEmail({
    to: input.to,
    subject,
    text,
    html,
    channel: "commercial",
    tags: [{ name: "kind", value: "commercial_aia_dunning" }],
  });
  return { ok: res.ok };
}

/** Internal bell for the AIA reminder — same three states as the invoice one
 *  (sent / failed / no contact on file), linking to the application itself. */
export async function insertCommercialAiaDunningMarker(input: {
  opportunityId: string;
  applicationId: string;
  applicationNumber: number;
  projectName: string;
  recipientUserId: string;
  daysPastDue: number;
  balanceCents: number;
  sentToClient: boolean;
  emailFailed?: boolean;
  /** Too far past due to auto-mail a demand about — a person should look. */
  stale?: boolean;
  clientEmailMasked: string | null;
}): Promise<void> {
  const relativeLink = `/commercial/opportunities/${input.opportunityId}?tab=aia&app=${input.applicationId}`;
  const emailLink = appendBase(relativeLink);
  const money = formatMoneyCents(input.balanceCents);
  const ref = `Application No. ${input.applicationNumber} · ${input.projectName}`;
  const title = input.sentToClient
    ? `Past-due reminder sent · ${ref}`
    : input.stale
    // Named as what it is. At this age the likeliest explanation is our own
    // record, not the GC's cheque.
    ? `Very old unpaid application — needs a look · ${ref}`
    : input.emailFailed
    ? `Past-due reminder FAILED to send · ${ref}`
    : `Past-due application needs a contact · ${ref}`;
  const body = input.sentToClient
    ? `Emailed the GC${input.clientEmailMasked ? ` (${input.clientEmailMasked})` : ""} — ${money}, ${input.daysPastDue}d past due.`
    : input.stale
    ? `${ref} shows ${money} outstanding and is ${input.daysPastDue}d past due — too old to send an automatic reminder about. Usually the application was paid and never marked, or it's already being handled. Check before chasing.`
    : input.emailFailed
    ? `Couldn't email the GC${input.clientEmailMasked ? ` (${input.clientEmailMasked})` : ""} for ${ref} (${money}, ${input.daysPastDue}d past due) — the email failed; follow up manually.`
    : `${ref} is ${input.daysPastDue}d past due but the account has no contact email — follow up manually.`;

  const subject = title;
  const text = [body, ``, `Open the application: ${emailLink}`, ``, `— PPP Commercial Command Center`].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>${escape(body)}</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the application &rarr;</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the application",
    tone: "needs_action",
  });

  await dispatchCommercialNotification({
    kind: "commercial_aia_dunning",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.applicationId,
    title,
    body,
    link: relativeLink,
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
  withinHours: number,
  // Optional: scope the dedup to a specific RECIPIENT. Without it the dedup is
  // per (kind, source) only, so reassigning a document's account manager left
  // the NEW AM with no alert for up to the dedup window (29 days) because the
  // old AM's recent notification still matched (audit N15). Passing the intended
  // recipient means each person is deduped independently.
  recipientUserId?: string
): Promise<boolean> {
  const sb = adminClient();
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
  let query = sb
    .from("notifications")
    .select("id")
    .eq("kind", kind)
    .eq("work_order_id", sourceId)
    .gte("created_at", cutoff)
    .limit(1);
  if (recipientUserId) query = query.eq("recipient_user_id", recipientUserId);
  const { data, error } = await query;
  if (error) {
    console.warn(
      `[commercial-events] dedup query failed (kind=${kind}, source=${sourceId}): ${error.message}`
    );
    // Fail-safe: if the dedup query errors, ASSUME we already sent so a
    // single user doesn't get spammed by a broken cron. The miss surfaces
    // in logs for next-day diagnosis.
    return true;
  }
  return (data ?? []).length > 0;
}

/**
 * Retire the "Approval needed" bells for a proposal once somebody has decided.
 *
 * Brendan 2026-08-26: "once I approve it the notification should go away on its
 * own." It didn't — the request bell stayed unread for every approver until
 * each of them clicked it individually, so a queue of things needing action
 * kept showing work that was already done, and the count stopped meaning
 * anything.
 *
 * Marks the request read for EVERYONE, not just the approver who acted: the
 * proposal is no longer waiting on any of them. The separate "decided"
 * notification that goes to the requester is what carries the outcome forward,
 * so nothing is lost by clearing this one.
 *
 * Best-effort. A proposal that was approved must never fail because a bell
 * could not be tidied.
 */
export async function clearApprovalRequestNotifications(
  proposalId: string
): Promise<void> {
  try {
    const sb = adminClient();
    const { error } = await sb
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("kind", "commercial_proposal_approval_requested")
      .eq("work_order_id", proposalId)
      .is("read_at", null);
    if (error) {
      console.warn(
        `[commercial-events] could not clear approval bells for ${proposalId}: ${error.message}`
      );
    }
  } catch (err) {
    console.warn(
      "[commercial-events] clearApprovalRequestNotifications threw:",
      err instanceof Error ? err.message : err
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// Invoicing (Phase 3, Karan 2026-07-07)
//
// Three fanout helpers for the invoicing lifecycle. Each fans out to the
// full opp team (minus the actor). The bell links directly to the invoice
// detail page — Alex + team can jump from bell → invoice → record
// payment / mark sent in one click.
//
// Recipient resolution mirrors the opp-status fanout: every active team
// member on the parent opp with has_new_platform_access=true, actor
// excluded via dispatchCommercialNotification's self-skip.
//
// Money formatting: cents → $X,XXX.00 via a local helper (avoids adding a
// server-only import cycle into lib/commercial/invoices/format.ts).
// ════════════════════════════════════════════════════════════════════

function formatMoneyCents(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function resolveOppTeamRecipients(
  opportunityId: string,
  actingUserId: string | null
): Promise<string[]> {
  const sb = adminClient();
  const { data: rows } = await sb
    .from("commercial_opportunity_assignments")
    .select(
      "user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(user_id, email, is_active, has_new_platform_access)"
    )
    .eq("opportunity_id", opportunityId)
    .is("removed_at", null);
  type Row = {
    user_id: string;
    user:
      | { user_id: string; email: string; is_active: boolean | null; has_new_platform_access: boolean | null }
      | Array<{ user_id: string; email: string; is_active: boolean | null; has_new_platform_access: boolean | null }>
      | null;
  };
  const recipientIds = new Set<string>();
  for (const raw of (rows ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    if (u.is_active === false) continue;
    if (u.has_new_platform_access === false) continue;
    if (actingUserId && u.user_id === actingUserId) continue;
    recipientIds.add(u.user_id);
  }
  return Array.from(recipientIds);
}

/** Fired by lib/commercial/invoices/db.ts createCommercialInvoice on
 *  successful insert. Fans out to the opp team so anyone tracking the
 *  deal knows billing has started. */
export async function insertCommercialInvoiceCreatedNotifications(input: {
  invoiceId: string;
  invoiceNumber: string;
  opportunityId: string;
  oppTitle: string;
  totalCents: number;
  actingUserId: string | null;
  actorName: string;
}): Promise<{ fanout: number }> {
  const recipients = await resolveOppTeamRecipients(input.opportunityId, input.actingUserId);
  if (recipients.length === 0) return { fanout: 0 };

  const relativeLink = `/commercial/invoices/${input.invoiceId}`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const money = formatMoneyCents(input.totalCents);
  const title = `New invoice: ${input.invoiceNumber} · ${money}`;
  const body = `${input.actorName} drafted ${input.invoiceNumber} on ${shortOppTitle}.`;

  const subject = `New invoice ${input.invoiceNumber} · ${money} · ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} created invoice ${input.invoiceNumber} on ${input.oppTitle}:`,
    `  Total: ${money}`,
    ``,
    `Open the invoice: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> created invoice <strong>${escape(input.invoiceNumber)}</strong> on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;"><span style="color:#666;">Total:</span> <strong>${escape(money)}</strong></p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the invoice →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the invoice",
    tone: "neutral",
  });

  await Promise.allSettled(
    recipients.map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_invoice_created",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.invoiceId,
        title,
        body,
        link: relativeLink,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

/** Fired by lib/commercial/invoices/db.ts addPayment when the payment
 *  landed but did NOT fully close the invoice (partial). Fans out to
 *  the opp team. */
export async function insertCommercialInvoicePaymentRecordedNotifications(input: {
  invoiceId: string;
  invoiceNumber: string;
  opportunityId: string;
  oppTitle: string;
  amountCents: number;
  balanceRemainingCents: number;
  actingUserId: string | null;
  actorName: string;
}): Promise<{ fanout: number }> {
  const recipients = await resolveOppTeamRecipients(input.opportunityId, input.actingUserId);
  if (recipients.length === 0) return { fanout: 0 };

  const relativeLink = `/commercial/invoices/${input.invoiceId}#payments`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const paidMoney = formatMoneyCents(input.amountCents);
  const remainingMoney = formatMoneyCents(input.balanceRemainingCents);
  const title = `Payment ${paidMoney} · ${input.invoiceNumber}`;
  const body = `${input.actorName} recorded a payment on ${shortOppTitle}. ${remainingMoney} remaining.`;

  const subject = `Payment ${paidMoney} recorded · ${input.invoiceNumber} · ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} recorded a payment on ${input.invoiceNumber} (${input.oppTitle}):`,
    `  Amount: ${paidMoney}`,
    `  Balance remaining: ${remainingMoney}`,
    ``,
    `See the invoice: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> recorded a payment on <strong>${escape(input.invoiceNumber)}</strong> (${escape(input.oppTitle)}):</p>
  <p style="margin:16px 0;padding:12px 16px;background:#eff6ff;border-radius:8px;">
    <span style="color:#666;">Amount:</span> <strong>${escape(paidMoney)}</strong><br />
    <span style="color:#666;">Balance remaining:</span> <strong>${escape(remainingMoney)}</strong>
  </p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">See the invoice →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  // ONE post per event — inserted above the per-recipient work below, so a
  // bell that fans out to five people still puts a single line in the channel.
  await postCommercialSlack({
    text: `*${slackEscape(title)}*`,
    context: slackEscape(body),
    url: relativeLink,
    urlLabel: "Open the invoice",
    tone: "good",
  });

  await Promise.allSettled(
    recipients.map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_invoice_payment_recorded",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.invoiceId,
        title,
        body,
        link: relativeLink,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

/** Fired by lib/commercial/invoices/db.ts addPayment (or the daily
 *  status-drift cron) when a payment brings paid_cents >= total_cents.
 *  Emerald tone in the email + celebratory copy — this is the moment
 *  Alex cares about. Fans out to the opp team. */
export async function insertCommercialInvoicePaidNotifications(input: {
  invoiceId: string;
  invoiceNumber: string;
  opportunityId: string;
  oppTitle: string;
  totalCents: number;
  actingUserId: string | null;
  actorName: string;
}): Promise<{ fanout: number }> {

  const relativeLink = `/commercial/invoices/${input.invoiceId}`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const money = formatMoneyCents(input.totalCents);
  // Slack posts BEFORE the recipient check, and outside it.
  //
  // Bells and emails are per-person, so giving up when nobody is assigned is
  // right for them. The channel is not per-person — it is the room the team
  // watches — and this event is exactly as true when the deal has no assignees.
  // Gating it on recipients would make the channel silently incomplete in the
  // one case nobody would think to check.
  await postCommercialSlack({
    text: `*Paid in full* — ${slackEscape(input.invoiceNumber)} · ${money}`,
    context: slackEscape(input.oppTitle),
    url: relativeLink,
    urlLabel: "Open the invoice",
    tone: "good",
  });

  const recipients = await resolveOppTeamRecipients(input.opportunityId, input.actingUserId);
  if (recipients.length === 0) return { fanout: 0 };

  const title = `PAID · ${input.invoiceNumber} · ${money}`;
  const body = `${shortOppTitle} is paid in full.`;

  const subject = `PAID · ${input.invoiceNumber} · ${money} · ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.invoiceNumber} on ${input.oppTitle} is paid in full.`,
    `  Total collected: ${money}`,
    ``,
    `Open the invoice: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.invoiceNumber)}</strong> on <strong>${escape(input.oppTitle)}</strong> is paid in full.</p>
  <p style="margin:16px 0;padding:12px 16px;background:#ecfdf5;border-left:4px solid #059669;border-radius:8px;">
    <span style="color:#666;">Total collected:</span> <strong>${escape(money)}</strong>
  </p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the invoice →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  await Promise.allSettled(
    recipients.map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_invoice_paid_full",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.invoiceId,
        title,
        body,
        link: relativeLink,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

/** Phase F.4 (Karan 2026-07-14): a proposal was Sent by Alex. Fans out
 *  to the opp team so estimator + team see the moment it left the office
 *  and can watch for the customer reply. Deep-links to the proposal
 *  editor so recipients can Preview the PDF that just went out. */
export async function insertCommercialProposalSentNotifications(input: {
  proposalId: string;
  revisionNumber: number;
  totalCents: number;
  opportunityId: string;
  accountId: string;
  dealId: string;
  oppTitle: string;
  gcCompany: string | null;
  actingUserId: string | null;
  actorName: string;
}): Promise<{ fanout: number }> {

  const relativeLink = `/commercial/accounts/${input.accountId}/deals/${input.dealId}/proposal/${input.proposalId}`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const money = formatMoneyCents(input.totalCents);
  const revLabel = `R${input.revisionNumber}`;
  const gcSuffix = input.gcCompany ? ` to ${input.gcCompany}` : "";

  // Slack posts BEFORE the recipient check, and outside it.
  //
  // Bells and emails are per-person, so giving up when nobody is assigned is
  // right for them. The channel is not per-person — it is the room the team
  // watches — and this event is exactly as true when the deal has no assignees.
  // Gating it on recipients would make the channel silently incomplete in the
  // one case nobody would think to check.
  await postCommercialSlack({
    text: `*Proposal sent* — ${slackEscape(revLabel)} · ${money}${input.gcCompany ? ` to *${slackEscape(input.gcCompany)}*` : ""}`,
    context: `${slackEscape(input.oppTitle)} · sent by ${slackEscape(input.actorName)}`,
    url: relativeLink,
    urlLabel: "Open the proposal",
    tone: "good",
  });

  const recipients = await resolveOppTeamRecipients(input.opportunityId, input.actingUserId);
  if (recipients.length === 0) return { fanout: 0 };
  const title = `Proposal sent: ${revLabel} · ${money}`;
  const body = `${input.actorName} sent ${revLabel}${gcSuffix} on ${shortOppTitle}.`;

  const subject = `Proposal ${revLabel} sent · ${money} · ${input.oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${input.actorName} sent proposal ${revLabel}${gcSuffix} on ${input.oppTitle}:`,
    `  Total: ${money}`,
    ``,
    `Open the proposal: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(input.actorName)}</strong> sent proposal <strong>${escape(revLabel)}</strong>${input.gcCompany ? ` to <strong>${escape(input.gcCompany)}</strong>` : ""} on <strong>${escape(input.oppTitle)}</strong>:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;"><span style="color:#666;">Total:</span> <strong>${escape(money)}</strong></p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the proposal →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  await Promise.allSettled(
    recipients.map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_proposal_sent",
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.proposalId,
        title,
        body,
        link: relativeLink,
        email: { subject, text, html },
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  return { fanout };
}

/** Resolve the account_id + title for a proposal's parent opportunity so
 *  the approval notifications can build the editor deep-link. */
async function resolveOppAccountAndTitle(
  opportunityId: string
): Promise<{ accountId: string | null; oppTitle: string }> {
  const sb = adminClient();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("account_id, title")
    .eq("id", opportunityId)
    .maybeSingle();
  const row = data as { account_id: string | null; title: string | null } | null;
  return { accountId: row?.account_id ?? null, oppTitle: row?.title ?? "a deal" };
}

/**
 * R1d — proposal sent FOR APPROVAL. Fans out to every approver (Brendan,
 * Stephanie, admins) so someone can green-light it. The proposal is BLOCKED
 * from sending until one of them approves. Skips the requester themselves.
 */
/**
 * R6 — a GC submitted a bid through the public online form. Fan a bell + email
 * out to the whole active commercial team so a fresh lead never gets missed.
 */
/**
 * Who gets told a proposal is waiting on approval.
 *
 * Exported because this one rule decides whether a person sees their own work,
 * and it has been wrong twice. The default is "everyone but you" — nobody needs
 * telling about their own action. The exception is when YOU are an approver:
 * the request is now sitting in your queue, and skipping you hides it. The
 * previous version only made that exception when the requester was the SOLE
 * approver, so adding a second approver silently stopped the first one seeing
 * his own requests.
 */
export function approvalRequestRecipients(
  allApprovers: string[],
  actingUserId: string | null
): { recipients: string[]; actorIsApprover: boolean } {
  const actorIsApprover = !!actingUserId && allApprovers.includes(actingUserId);
  if (actorIsApprover) return { recipients: allApprovers, actorIsApprover };
  const others = allApprovers.filter((uid) => !(actingUserId && uid === actingUserId));
  // No one else to ask: fall back to the full list rather than telling nobody
  // and leaving the proposal gated in silence.
  return { recipients: others.length > 0 ? others : allApprovers, actorIsApprover };
}

export async function insertCommercialBidSubmittedNotifications(input: {
  opportunityId: string;
  accountId: string;
  accountName: string;
  contactName: string | null;
  contactEmail: string | null;
  oppTitle: string;
}): Promise<{ fanout: number }> {

  const relativeLink = `/commercial/opportunities/${input.opportunityId}`;
  const emailLink = appendBase(relativeLink);
  const who = input.contactName?.trim() || input.accountName;

  // Slack posts BEFORE the recipient check, and outside it.
  //
  // Bells and emails are per-person, so giving up when nobody is assigned is
  // right for them. The channel is not per-person — it is the room the team
  // watches — and this event is exactly as true when the deal has no assignees.
  // Gating it on recipients would make the channel silently incomplete in the
  // one case nobody would think to check.
  await postCommercialSlack({
    text: `*New bid request* — *${slackEscape(input.accountName)}*`,
    context: [
      slackEscape(input.oppTitle),
      `from ${slackEscape(who)}`,
      input.contactEmail ? slackEscape(input.contactEmail) : null,
    ].filter(Boolean).join(" · "),
    url: relativeLink,
    urlLabel: "Open the opportunity",
    tone: "needs_action",
  });

  const { listManagedUsers } = await import("@/lib/auth/user-management");
  const users = (await listManagedUsers()).filter((u) => u.has_new_platform_access && u.is_active);
  if (users.length === 0) return { fanout: 0 };
  const shortTitle = truncatePreview(input.oppTitle, BELL_TITLE_OPP_CAP);
  const title = `New bid request: ${truncatePreview(input.accountName, BELL_TITLE_OPP_CAP)}`;
  const body = `${who} submitted a bid request through the website — ${shortTitle}.`;
  const subject = `New bid request — ${input.accountName}`;
  const contactLine = input.contactEmail ? `Reply to: ${input.contactEmail}` : "";
  const text = [
    `Hi,`,
    ``,
    `${who} just submitted a bid request through the website.`,
    `Project: ${input.oppTitle}`,
    contactLine,
    ``,
    `Open it: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(who)}</strong> just submitted a bid request through the website.</p>
  <p style="margin:8px 0;padding:12px 16px;background:#f0f9ff;border-left:4px solid #2baae1;border-radius:8px;color:#444;">
    <strong>Project:</strong> ${escape(input.oppTitle)}${input.contactEmail ? `<br/><strong>Reply to:</strong> ${escape(input.contactEmail)}` : ""}
  </p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#1e8fbf;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  for (const u of users) {
    const r = await dispatchCommercialNotification({
      kind: "commercial_bid_submitted",
      recipientUserId: u.user_id,
      actingUserId: null,
      sourceId: input.opportunityId,
      title,
      body,
      link: relativeLink,
      email: { subject, text, html },
    });
    if (r.ok) fanout++;
  }
  return { fanout };
}

export async function insertCommercialProposalApprovalRequestedNotifications(input: {
  proposalId: string;
  revisionNumber: number;
  totalCents: number;
  opportunityId: string;
  gcCompany: string | null;
  actingUserId: string | null;
  actorName: string;
}): Promise<{ fanout: number; approverCount: number }> {
  // Lazy import to avoid a server-only cycle (db.ts ↔ this file both import
  // each other's helpers).
  const { listProposalApproverUserIds } = await import(
    "@/lib/commercial/proposals/db"
  );
  const allApprovers = await listProposalApproverUserIds();
  // Normally notify everyone BUT the requester — you don't need telling about
  // your own action.
  //
  // Unless the requester is an APPROVER, in which case the request is now
  // sitting in their queue too and skipping them hides their own work from
  // them. The old rule only made that exception when they were the SOLE
  // approver, so the moment a second approver existed Brendan stopped seeing
  // his own requests — Brendan 2026-08-26: "I don't see the approvals I send
  // in my notifications." Being one of two approvers does not make the item
  // any less his to action.
  const { recipients: approverIds, actorIsApprover } = approvalRequestRecipients(
    allApprovers,
    input.actingUserId ?? null
  );
  if (approverIds.length === 0) return { fanout: 0, approverCount: 0 };

  const { accountId, oppTitle } = await resolveOppAccountAndTitle(input.opportunityId);
  if (!accountId) {
    reportWarn({
      key: "proposal_approval_requested_no_account",
      message: "Approval-requested notification skipped — opp has no account; approvers NOT notified",
      platform: "commercial_cc",
      context: {
        opp_id_short: input.opportunityId.slice(0, 8),
        proposal_id_short: input.proposalId.slice(0, 8),
      },
    });
    return { fanout: 0, approverCount: 0 };
  }

  const relativeLink = `/commercial/accounts/${accountId}/deals/${input.opportunityId}/proposal/${input.proposalId}`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(oppTitle, BELL_TITLE_OPP_CAP);
  const money = formatMoneyCents(input.totalCents);
  const revLabel = `R${input.revisionNumber}`;
  const gcSuffix = input.gcCompany ? ` (${input.gcCompany})` : "";
  const requester = input.actorName || "Someone";
  const title = `Approval needed: ${revLabel} · ${money}`;
  const body = `${requester} is requesting approval on ${revLabel}${gcSuffix} · ${shortOppTitle}.`;

  const subject = `Approval needed — proposal ${revLabel} · ${money} · ${oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    `${requester} sent proposal ${revLabel}${gcSuffix} on ${oppTitle} for your approval:`,
    `  Total: ${money}`,
    ``,
    `It can't be sent to the customer until you approve it.`,
    `Review + approve: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(requester)}</strong> sent proposal <strong>${escape(revLabel)}</strong>${input.gcCompany ? ` (<strong>${escape(input.gcCompany)}</strong>)` : ""} on <strong>${escape(oppTitle)}</strong> for your approval:</p>
  <p style="margin:16px 0;padding:12px 16px;background:#f6f7f8;border-radius:8px;"><span style="color:#666;">Total:</span> <strong>${escape(money)}</strong></p>
  <p style="color:#92400e;">It can't be sent to the customer until you approve it.</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#b45309;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Review + approve →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  let fanout = 0;
  await Promise.allSettled(
    approverIds.map(async (uid) => {
      const r = await dispatchCommercialNotification({
        kind: "commercial_proposal_approval_requested",
        allowSelfNotify: actorIsApprover,
        recipientUserId: uid,
        actingUserId: input.actingUserId,
        sourceId: input.proposalId,
        title,
        body,
        link: relativeLink,
        email: { subject, text, html },
        alwaysEmail: true, // approvers gate the proposal — always email, not opt-in
      });
      if (r.ok && r.written) fanout += 1;
    })
  );
  // ONE message, AFTER the fan-out. The bell + email loop above runs once per
  // approver; Slack is a room they are all already in, so posting inside the
  // loop would put the same line in three times for three approvers.
  await postCommercialSlack({
    text: `*Approval needed* — ${slackEscape(revLabel)} · ${money}${input.gcCompany ? ` for *${slackEscape(input.gcCompany)}*` : ""}`,
    context: `${slackEscape(oppTitle)} · requested by ${slackEscape(requester)} · it can't go to the customer until an approver approves it`,
    url: relativeLink,
    urlLabel: "Review & approve",
    tone: "needs_action",
  });
  return { fanout, approverCount: approverIds.length };
}

/**
 * R1d — approval DECIDED. One recipient: the estimator who requested it.
 * `decision` picks the kind + copy: "approved" (green light to send) or
 * "changes_requested" (kicked back with the approver's note).
 */
export async function insertCommercialProposalApprovalDecidedNotification(input: {
  decision: "approved" | "changes_requested";
  proposalId: string;
  revisionNumber: number;
  opportunityId: string;
  gcCompany: string | null;
  recipientUserId: string;
  actingUserId: string | null;
  actorName: string;
  note: string | null;
  /** RUX-6: this recipient is a "receiver" (CC'd on the decision), not the
   *  estimator who owns the next step — so drop the "you send it / you edit it"
   *  action wording; they just get the heads-up + a View link. */
  forReceiver?: boolean;
}): Promise<{ ok: boolean; written: boolean }> {
  const { accountId, oppTitle } = await resolveOppAccountAndTitle(input.opportunityId);
  if (!accountId) {
    reportWarn({
      key: "proposal_approval_decided_no_account",
      message: "Approval-decided notification skipped — opp has no account; requester NOT notified",
      platform: "commercial_cc",
      context: {
        opp_id_short: input.opportunityId.slice(0, 8),
        proposal_id_short: input.proposalId.slice(0, 8),
        decision: input.decision,
      },
    });
    return { ok: false, written: false };
  }

  const relativeLink = `/commercial/accounts/${accountId}/deals/${input.opportunityId}/proposal/${input.proposalId}`;
  const emailLink = appendBase(relativeLink);
  const shortOppTitle = truncatePreview(oppTitle, BELL_TITLE_OPP_CAP);
  const revLabel = `R${input.revisionNumber}`;
  const approver = input.actorName || "An approver";
  const isApproved = input.decision === "approved";
  const noteForBell = input.note ? ` Note: ${truncatePreview(input.note, BELL_NOTE_CAP)}` : "";

  const title = isApproved
    ? `Approved: ${revLabel} — ready to send`
    : `Changes requested: ${revLabel}`;
  const body = isApproved
    ? `${approver} approved ${revLabel} · ${shortOppTitle}.${input.forReceiver ? "" : " You can send it now."}`
    : `${approver} sent ${revLabel} back on ${shortOppTitle}.${noteForBell}`;

  const subject = isApproved
    ? `Proposal ${revLabel} approved — ready to send · ${oppTitle}`
    : `Changes requested on proposal ${revLabel} · ${oppTitle}`;
  const text = [
    `Hi,`,
    ``,
    isApproved
      ? `${approver} approved proposal ${revLabel} on ${oppTitle}. It's cleared to send to the customer.`
      : `${approver} requested changes on proposal ${revLabel} on ${oppTitle} — it's back in draft.`,
    input.note ? `  Note: ${input.note}` : "",
    ``,
    input.forReceiver ? `View it: ${emailLink}` : isApproved ? `Send it: ${emailLink}` : `Make the edits: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
  ]
    .filter(Boolean)
    .join("\n");
  const accent = isApproved ? "#047857" : "#b45309";
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p><strong>${escape(approver)}</strong> ${isApproved ? "approved" : "requested changes on"} proposal <strong>${escape(revLabel)}</strong> on <strong>${escape(oppTitle)}</strong>${isApproved ? ". It's cleared to send to the customer." : " — it's back in draft."}</p>
  ${input.note ? `<p style="margin:8px 0;padding:12px 16px;background:#fffbeb;border-left:4px solid #d97706;border-radius:8px;color:#444;word-break:break-word;"><em>${escape(input.note)}</em></p>` : ""}
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:${accent};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${input.forReceiver ? "View →" : isApproved ? "Send it →" : "Make the edits →"}</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;

  const r = await dispatchCommercialNotification({
    kind: isApproved
      ? "commercial_proposal_approved"
      : "commercial_proposal_changes_requested",
    recipientUserId: input.recipientUserId,
    actingUserId: input.actingUserId,
    sourceId: input.proposalId,
    title,
    body,
    link: relativeLink,
    email: { subject, text, html },
    alwaysEmail: true, // the requester is waiting on this decision — always email
    // A decision changes the proposal's state (back to draft, or cleared to
    // send). Even when you approved your own request, that transition is the
    // thing you act on next — so it is a handoff, not an FYI.
    allowSelfNotify: true,
  });
  // ONE post per decision, not one per recipient. This function is called once
  // for the requester and again for every "receiver" CC'd on the outcome;
  // `forReceiver` marks those copies (verified at all three call sites in
  // proposals/db.ts), so the primary call is the single one that speaks for the
  // event.
  if (!input.forReceiver) {
    const approvedDecision = input.decision === "approved";
    await postCommercialSlack({
      text: `${approvedDecision ? "*Proposal approved*" : "*Changes requested*"} — ${slackEscape(revLabel)}${input.gcCompany ? ` for *${slackEscape(input.gcCompany)}*` : ""}`,
      context: [
        slackEscape(oppTitle),
        `${approvedDecision ? "approved" : "sent back"} by ${slackEscape(input.actorName)}`,
        approvedDecision ? "ready to send to the customer" : null,
        // The approver's reason IS the point of a rejection — putting it in the
        // channel saves opening the proposal to find out why.
        input.note?.trim() ? `“${slackEscape(truncatePreview(input.note.trim(), 160))}”` : null,
      ].filter(Boolean).join(" · "),
      url: relativeLink,
      urlLabel: approvedDecision ? "Send it" : "Make the edits",
      tone: approvedDecision ? "good" : "needs_action",
    });
  }
  return { ok: r.ok, written: r.ok ? (r as { written: boolean }).written : false };
}

/**
 * Custom-rule notification (Block 3B). Fires the `commercial_custom_rule` kind
 * to the rule OWNER. Respects the rule's channel: "bell" writes only the bell
 * row, "email" + "both" also send an email. Returns whether it was written
 * (inactive/no-access owner is skipped, like every other event).
 */
export async function insertCustomRuleNotification(input: {
  recipientUserId: string;
  /** The matched entity id — stored so callers/fires can reference it. */
  sourceId: string;
  title: string;
  body: string;
  /** Relative path into the app (e.g. "/commercial/invoices/<id>"). */
  link: string;
  channel: "bell" | "email" | "both";
}): Promise<{ ok: boolean; written: boolean }> {
  const emailLink = appendBase(input.link);
  const subject = input.title;
  const text = [
    input.body,
    ``,
    `Open it: ${emailLink}`,
    ``,
    `— PPP Commercial Command Center`,
    `(You created this alert. Manage your alerts in Settings → Notifications.)`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>${escape(input.body)}</p>
  <p style="margin:24px 0;"><a href="${emailLink}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open it →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center<br/>You created this alert. Manage your alerts in Settings → Notifications.</p>
</div>`;

  const r = await dispatchCommercialNotification({
    kind: "commercial_custom_rule",
    recipientUserId: input.recipientUserId,
    actingUserId: null,
    sourceId: input.sourceId,
    title: input.title,
    body: input.body,
    link: input.link,
    email: { subject, text, html },
    skipEmail: input.channel === "bell",
  });
  return { ok: r.ok, written: r.ok ? (r as { written: boolean }).written : false };
}
