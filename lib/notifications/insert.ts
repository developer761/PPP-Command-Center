import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * In-app notification insert (the bell). Fanned-out per-recipient at insert
 * time so the read path is a single WHERE recipient_user_id = ? — no
 * scope/join logic, no chance of leaking another rep's notifications.
 *
 * Recipients for a 'customer_form_submitted' event:
 *   - Every admin (profiles.is_admin = true)
 *   - The WO sender (status.token.created_by_user_id) — the rep on the WO
 *
 * Deduped: if the sender is also an admin they get one row, not two. The
 * row also has the WO's owning rep (the WO sender) which the bell uses to
 * order "your work order" rows above generic admin fanout.
 *
 * Fire-and-forget shape: any DB error logs + swallows. The customer's submit
 * flow must never 500 because the bell row didn't persist — they don't even
 * know the bell exists.
 */

import type { CommercialNotificationKind } from "./commercial-events";

/**
 * Union of every notification kind the platform writes. Bell renderer is
 * kind-agnostic but downstream code that filters or routes on kind should
 * import THIS union, not redeclare it — keeps the source of truth in one
 * place even as new event kinds land in commercial-events.ts.
 */
export type NotificationKind =
  | "customer_form_submitted"
  | "commercial_account_team_added"
  | "commercial_opportunity_team_added"
  | CommercialNotificationKind;

export type CustomerFormSubmittedInput = {
  /** Supabase user id of the rep who originally sent the form. They get a
   *  bell row regardless of admin status. */
  senderUserId: string;
  workOrderId: string;
  workOrderNumber: string | null;
  customerName: string | null;
  /** True when this is the customer's second submission (re-edit). Used in
   *  the bell title so admin can spot "Sarah re-submitted her colors". */
  isReedit: boolean;
  lineItemCount: number;
  /** True when notes were the only meaningful content (exterior WOs etc).
   *  Drives the bell copy so admin knows what to expect when they click. */
  notesOnly: boolean;
  /** True when SF writeback was gated off (test_only + WO not on allowlist,
   *  or mode=off). Adds a clarifier to the body so admin knows the data is
   *  in Command Center only, not in Salesforce yet. */
  writebackSkipped?: boolean;
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Insert a 'customer_form_submitted' notification row for the WO sender +
 * every admin. Deduplicated by recipient_user_id so the sender doesn't get
 * two rows when they're also an admin.
 *
 * Never throws. Logs every failure path so a misconfigured env surfaces in
 * Vercel logs without breaking the customer's submit flow.
 */
export async function insertCustomerFormSubmittedNotification(
  input: CustomerFormSubmittedInput
): Promise<void> {
  try {
    const sb = adminClient();

    // Resolve admin recipients. Empty-set is fine (no admin profiles yet) —
    // the sender still gets their own row.
    // Only ACTIVE admins get bell rows — a deactivated admin shouldn't see
    // notifications for events that landed after they left.
    const { data: admins, error: adminErr } = await sb
      .from("profiles")
      .select("user_id")
      .eq("is_admin", true)
      .eq("is_active", true);
    if (adminErr) {
      console.warn("[notifications] admin lookup failed:", adminErr.message);
    }

    // Dedupe — sender + admins, sender wins if they're both.
    const recipients = new Set<string>();
    recipients.add(input.senderUserId);
    for (const a of admins ?? []) {
      if (a.user_id) recipients.add(a.user_id as string);
    }

    // Build the bell payload. Copy is tuned for the dropdown row — short
    // title, body adds enough context that admin doesn't need to click.
    const woLabel = input.workOrderNumber ?? "a work order";
    const who = input.customerName?.trim() || "Customer";
    const verb = input.isReedit ? "updated their colors on" : "submitted colors for";
    const title = input.notesOnly
      ? `${who} submitted notes on ${woLabel}`
      : `${who} ${verb} ${woLabel}`;
    const baseBody = input.notesOnly
      ? "Project notes were submitted — no per-room color picks."
      : `${input.lineItemCount} room${input.lineItemCount === 1 ? "" : "s"} of color picks ready to review.`;
    // Writeback-skipped clarifier: admin sees the submission landed in
    // Command Center but Salesforce wasn't updated (test_only allowlist
    // gate, or mode=off). Without this, admin would assume SF is current.
    const body = input.writebackSkipped
      ? `${baseBody} (Saved in Command Center — Salesforce writeback gated for this WO.)`
      : baseBody;
    // The materials WO drawer is where admin acts on a submission.
    const link = `/dashboard/materials/${encodeURIComponent(input.workOrderId)}`;

    const rows = Array.from(recipients).map((userId) => ({
      recipient_user_id: userId,
      kind: "customer_form_submitted" as NotificationKind,
      work_order_id: input.workOrderId,
      work_order_number: input.workOrderNumber,
      customer_name: input.customerName,
      title,
      body,
      link,
    }));

    if (rows.length === 0) return;

    const { error: insErr } = await sb.from("notifications").insert(rows);
    if (insErr) {
      console.warn(`[notifications] insert failed for WO ${input.workOrderId.slice(0, 8)}…:`, insErr.message);
    }
  } catch (err) {
    console.warn("[notifications] unexpected insert error:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Bell row for "you've been assigned to an account/opp" — fires on every
 * successful addAssignment write (account-side AND opp-side). Single
 * recipient: the staffer who got assigned. Distinct from the email
 * notification — this is the in-app red dot the next time they open the
 * Command Center, so they know to look at the new account even if they
 * miss the email.
 *
 * Fire-and-forget: any error logs + swallows. Never breaks the assignment
 * write.
 */
export type CommercialTeamAssignedInput = {
  /** Surface — drives the bell copy + link */
  surface: "account" | "opportunity";
  /** UUID of the account or opp the recipient was added to */
  parentId: string;
  /** Display name for the parent (account company_name or opp title) */
  parentName: string;
  /** Optional secondary context — account name for an opp assignment */
  secondaryName?: string | null;
  /** Supabase user_id of the assignee */
  recipientUserId: string;
  /** Role label as the user reads it ("Sales Rep" not "sales_rep") */
  roleLabel: string;
  /** True when the assignment is also flagged primary */
  isPrimary: boolean;
  /** "assigned" | "promoted" | "restored" — matches the email verb */
  action: "assigned" | "promoted" | "restored";
  /** Display name of the user who did the assigning, for the body line */
  assignerName: string;
};

export async function insertCommercialTeamAssignedNotification(
  input: CommercialTeamAssignedInput & { actingUserId?: string | null }
): Promise<void> {
  try {
    // Self-assignment short-circuit — symmetric with the email pipeline
    // (see notifyAssignment self-skip in lib/commercial/*/assignments.ts).
    // Alice already knows she added herself; a red dot the next time she
    // opens the platform tells her nothing new.
    if (input.actingUserId && input.actingUserId === input.recipientUserId) return;
    const sb = adminClient();

    // Skip bell row when the recipient has been deactivated since the
    // page load — there's no value in a notification a deactivated user
    // can never see. Matches the admin-fanout filter in
    // insertCustomerFormSubmittedNotification above.
    const { data: recipient } = await sb
      .from("profiles")
      .select("is_active")
      .eq("user_id", input.recipientUserId)
      .maybeSingle();
    if ((recipient as { is_active?: boolean | null } | null)?.is_active === false) return;

    const kind: NotificationKind =
      input.surface === "account"
        ? "commercial_account_team_added"
        : "commercial_opportunity_team_added";

    const verb =
      input.action === "promoted"
        ? `promoted you to PRIMARY ${input.roleLabel}`
        : input.action === "restored"
          ? `re-added you as ${input.roleLabel}`
          : `assigned you as ${input.roleLabel}`;

    const primarySuffix =
      input.isPrimary && input.action !== "promoted"
        ? " (Primary)"
        : "";

    const title =
      input.surface === "account"
        ? `${input.parentName}${primarySuffix}`
        : `${input.parentName}${primarySuffix}`;
    const body =
      input.surface === "opportunity" && input.secondaryName
        ? `${input.assignerName} ${verb}. Account: ${input.secondaryName}.`
        : `${input.assignerName} ${verb}.`;
    const link =
      input.surface === "account"
        ? `/commercial/accounts/${input.parentId}?tab=team`
        : `/commercial/opportunities/${input.parentId}?tab=team`;

    const row = {
      recipient_user_id: input.recipientUserId,
      kind,
      // WO-specific columns left null; the bell renderer reads title/body/link only
      work_order_id: null as string | null,
      work_order_number: null as string | null,
      customer_name: null as string | null,
      title,
      body,
      link,
    };

    const { error: insErr } = await sb.from("notifications").insert(row);
    if (insErr) {
      console.warn(
        `[notifications] commercial team-add insert failed for ${input.surface} ${input.parentId.slice(0, 8)}…:`,
        insErr.message
      );
    }
  } catch (err) {
    console.warn(
      "[notifications] commercial team-add unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
