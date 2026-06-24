import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getCommercialOpportunity,
  opportunityStatusLabel,
  opportunitySourceLabel,
  opportunityLossReasonLabel,
  formatBidRange,
  weightedPipelineCents,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_LOSS_REASONS,
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunityLossReason,
} from "@/lib/commercial/opportunities/db";
import { getCommercialAccount, type CommercialAccount } from "@/lib/commercial/accounts/db";
import {
  softDeleteCommercialOpportunity,
  createCommercialOpportunity,
} from "@/lib/commercial/opportunities/mutations";
import { commercialDb } from "@/lib/commercial/db";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { isTerminalOpportunityStatus } from "@/lib/commercial/opportunities/constants";
import {
  allowedNextStatuses,
  changeOpportunityStatus,
  shouldWarnTransition,
  listOpportunityStatusLog,
} from "@/lib/commercial/opportunities/status";
import {
  listOpportunityTeam,
  addOpportunityAssignment,
  removeOpportunityAssignment,
  OPPORTUNITY_ASSIGNMENT_ROLES,
  opportunityAssignmentRoleLabel,
  type OpportunityAssignmentRole,
} from "@/lib/commercial/opportunities/assignments";
import {
  listOpportunityTasks,
  createOpportunityTask,
  completeOpportunityTask,
  uncompleteOpportunityTask,
  deleteOpportunityTask,
  type OpportunityTask,
} from "@/lib/commercial/opportunities/tasks";
import {
  listOpportunityNotes,
  addOpportunityNote,
  editOpportunityNote,
  deleteOpportunityNote,
  togglePinOpportunityNote,
  type OpportunityNoteWithAuthor,
} from "@/lib/commercial/opportunities/notes";
import {
  postPlaceholderAutoNote,
  writeDebrief,
  clearDebriefFlagOnReopen,
} from "@/lib/commercial/win-loss/debrief";
import DebriefFields from "@/components/commercial/debrief-fields";
import {
  listOpportunityAttachments,
  archiveOpportunityAttachment,
  categorizeFilename,
  formatBytes,
  type OpportunityAttachment,
} from "@/lib/commercial/opportunities/attachments";
import { revalidatePath } from "next/cache";
import { listAssignableStaff } from "@/lib/commercial/accounts/assignments";
import CommercialOpportunityUploadForm from "@/components/commercial-opportunity-upload-form";
import InfoDot from "@/components/info-dot";
import EmailArchiveTab from "@/components/commercial/email-archive-tab";
import MentionTextarea from "@/components/commercial/mention-textarea";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{
  tab?: string;
  error?: string;
  action?: string;
  to?: string;
  status_ok?: string;
  confirm_delete?: string;
  edited?: string;
  cloned?: string;
  just_closed?: string;
  debrief_saved?: string;
}>;

async function submitDebriefOnlyAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");
  // Load opp so we know its terminal outcome (debrief panel only renders
  // for terminal opps; this is the server-side echo of that gate).
  const opp = await getCommercialOpportunity(opp_id);
  if (!opp) redirect("/commercial/opportunities");
  const isTerminal = isTerminalOpportunityStatus(opp.status);
  if (!isTerminal) {
    redirect(`/commercial/opportunities/${opp_id}?tab=info`);
  }
  const competitor = String(formData.get("debrief_competitor") ?? "").trim();
  const decidingFactor = String(formData.get("debrief_deciding_factor") ?? "").trim();
  const lessons = String(formData.get("debrief_lessons") ?? "").trim();
  const internalNotes = String(formData.get("debrief_internal_notes") ?? "").trim();
  // Resolve the most recent terminal status_log row as the FK target so
  // we link the debrief to the actual close event (not a prior reopen).
  const sb = commercialDb();
  const { data: lastLog } = await sb
    .from("commercial_opportunity_status_log")
    .select("id")
    .eq("opportunity_id", opp_id)
    .eq("to_status", opp.status)
    .order("changed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const statusLogId = (lastLog as { id: string } | null)?.id ?? null;
  const result = await writeDebrief({
    opportunityId: opp_id,
    outcome: opp.status as "won" | "lost" | "no_bid",
    competitorName: competitor || null,
    decidingFactor: (decidingFactor && (OPPORTUNITY_LOSS_REASONS as readonly string[]).includes(decidingFactor)) ? decidingFactor : null,
    lessonsLearned: lessons || null,
    internalNotes: internalNotes || null,
    statusLogId,
    actorUserId: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp_id}?tab=debrief&error=` + encodeURIComponent(result.error));
  }
  redirect(`/commercial/opportunities/${opp_id}?tab=debrief&debrief_saved=1`);
}

async function changeStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  const to_status = String(formData.get("to_status") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    redirect(`/commercial/opportunities/${opp_id}?error=` + encodeURIComponent("Invalid status."));
  }
  // Legacy loss_reason + note form fields were removed 2026-06-24
  // (Karan: "why are these here if its not in lost section LOSS REASON
  // IF LOST"). DebriefFields covers terminal transitions structurally:
  // its debrief_deciding_factor maps 1:1 to OPPORTUNITY_LOSS_REASONS,
  // and lessons/internal_notes cover the freeform note slot. Non-
  // terminal transitions just don't need either field.
  const decidingFactorRaw = String(formData.get("debrief_deciding_factor") ?? "").trim();
  const lessonsRaw = String(formData.get("debrief_lessons") ?? "").trim();
  const internalNotesRaw = String(formData.get("debrief_internal_notes") ?? "").trim();
  // Only set loss_reason for lost/no_bid (won doesn't carry one).
  const loss_reason =
    (to_status === "lost" || to_status === "no_bid") &&
    decidingFactorRaw &&
    (OPPORTUNITY_LOSS_REASONS as readonly string[]).includes(decidingFactorRaw)
      ? (decidingFactorRaw as OpportunityLossReason)
      : null;
  // status_log "note" gets the freeform debrief text (lessons preferred,
  // falls back to internal_notes). Empty otherwise.
  const noteForStatusLog = lessonsRaw || internalNotesRaw || null;
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    acting_user_id: user.id,
    note: noteForStatusLog,
    loss_reason,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp_id}?error=` + encodeURIComponent(result.error));
  }

  // Win/Loss Debrief enrichment — fires when status flipped INTO a terminal
  // state. Three paths:
  //   1. User filled debrief fields → writeDebrief (creates row + enriches auto-note + sets flag)
  //   2. User checked "skip" → postPlaceholderAutoNote (puts placeholder, leaves amber banner)
  //   3. User didn't see the form (legacy path / API call) → same placeholder
  // Re-opening (from terminal → non-terminal) clears the debriefed_at flag
  // so a future re-close requires a new debrief.
  const isTerminal = isTerminalOpportunityStatus(to_status);
  if (isTerminal) {
    const skip = String(formData.get("debrief_skip") ?? "") === "1";
    const competitor = String(formData.get("debrief_competitor") ?? "").trim();
    const decidingFactor = String(formData.get("debrief_deciding_factor") ?? "").trim();
    const lessons = String(formData.get("debrief_lessons") ?? "").trim();
    const internalNotes = String(formData.get("debrief_internal_notes") ?? "").trim();
    const hasAnyDebriefField = !skip && (competitor || decidingFactor || lessons || internalNotes);

    if (hasAnyDebriefField) {
      // Resolve the most recent status_log row for this transition (FK target).
      const sb2 = commercialDb();
      const { data: lastLog } = await sb2
        .from("commercial_opportunity_status_log")
        .select("id")
        .eq("opportunity_id", opp_id)
        .eq("to_status", to_status)
        .order("changed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const statusLogId = (lastLog as { id: string } | null)?.id ?? null;
      const debriefResult = await writeDebrief({
        opportunityId: opp_id,
        outcome: to_status as "won" | "lost" | "no_bid",
        competitorName: competitor || null,
        decidingFactor: decidingFactor || null,
        lessonsLearned: lessons || null,
        internalNotes: internalNotes || null,
        statusLogId,
        actorUserId: user.id,
      });
      if (!debriefResult.ok) {
        // Status flipped but debrief failed. Don't post a SECOND placeholder
        // here — writeDebrief's enrichment path already handles missing
        // placeholders by creating a fresh enriched note. Posting again
        // here would create a duplicate "[AUTO] Debrief pending" on the
        // account timeline. Just warn the user; banner will catch the
        // missing debrief on next visit.
        redirect(`/commercial/opportunities/${opp_id}?tab=debrief&status_ok=1&debrief_warn=` + encodeURIComponent(debriefResult.error));
      }
      // Debrief saved INLINE with the status flip — land them on the
      // Debrief tab with the read-only view + success banner.
      redirect(`/commercial/opportunities/${opp_id}?tab=debrief&debrief_saved=1`);
    } else {
      // User skipped or didn't fill — drop the minimal placeholder so the
      // account timeline reflects the closure immediately. Amber banner
      // will nudge them to come back and fill out the structured debrief.
      await postPlaceholderAutoNote({
        opportunityId: opp_id,
        outcome: to_status as "won" | "lost" | "no_bid",
        actorUserId: user.id,
      });
    }
    // Skipped the inline debrief — route to Debrief tab so the user
    // sees the form and can decide to fill it now or skip again.
    // Audit fix 2026-06-24 (logic-flow #1): clear the stale debriefed_at
    // flag BEFORE redirect when transitioning terminal→terminal (e.g.
    // Won → Reopened → Lost). Without this, the new terminal state
    // inherits the prior outcome's debriefed flag, suppressing the
    // amber "Debrief needed" prompt on the second close.
    await clearDebriefFlagOnReopen(opp_id, user.id);
    redirect(`/commercial/opportunities/${opp_id}?tab=debrief&status_ok=1`);
  } else {
    // Non-terminal transition. If the opp WAS terminal (reopen case),
    // clear the debriefed_at flag so a future re-close requires a fresh
    // debrief. Idempotent — no-op if flag was already null.
    await clearDebriefFlagOnReopen(opp_id, user.id);
  }

  redirect(`/commercial/opportunities/${opp_id}?tab=info&status_ok=1`);
}

/**
 * Soft-delete an opportunity. Always lands on the global pipeline with
 * a `deleted=<title>` banner — that's a known-good page regardless of
 * the parent account's state. (The earlier "redirect to parent account
 * tab" path was hitting a 404 in some flows.) revalidatePath on the
 * destination so the deleted row is gone from the list immediately.
 */
async function reopenOpportunityAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: "reopened" as OpportunityStatus,
    acting_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp_id}?error=` + encodeURIComponent(result.error));
  }
  await clearDebriefFlagOnReopen(opp_id, user.id);
  redirect(`/commercial/opportunities/${opp_id}?tab=info&status_ok=1`);
}

async function softDeleteOpportunityAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");
  // Resolve the title BEFORE deleting so we can pass it to the banner.
  const sb = commercialDb();
  const { data: pre } = await sb
    .from("commercial_opportunities")
    .select("title, account_id")
    .eq("id", opp_id)
    .maybeSingle();
  const title = ((pre as { title?: string } | null)?.title || "Opportunity");
  const result = await softDeleteCommercialOpportunity(opp_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp_id}?error=${encodeURIComponent(result.error)}`);
  }
  // Refresh both surfaces so the row disappears immediately.
  revalidatePath("/commercial/opportunities");
  if (pre && (pre as { account_id?: string }).account_id) {
    revalidatePath(`/commercial/accounts/${(pre as { account_id: string }).account_id}`);
  }
  redirect(`/commercial/opportunities?deleted=${encodeURIComponent(title)}`);
}

/**
 * Clone an existing opportunity into a new one. Re-bidding the same site
 * is a common workflow (Alex: "we lost the bid in Q1, they're shopping
 * again in Q3"); typing the full scope + bid range + property address
 * from scratch each time is friction.
 *
 * Copies: title (prefixed "Copy of "), description, source, bid range,
 *         property address, proposed start/end (NOT proposal_due_at —
 *         that's a fresh ask).
 * Resets: status → inquiry, probability → status default, decided_at →
 *         null, loss_reason/notes → null, primary_contact_id → re-auto-
 *         picked from the account.
 * Skips:  team, tasks, notes, attachments — these are bid-specific.
 *
 * Redirects to the new opp's detail page so the user can immediately
 * tweak the title / bid range / etc.
 */
async function cloneOpportunityAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");

  const sb = commercialDb();
  const { data: source } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", opp_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!source) {
    redirect(`/commercial/opportunities/${opp_id}?error=${encodeURIComponent("Source opportunity not found.")}`);
  }
  const src = source as CommercialOpportunity;

  const result = await createCommercialOpportunity({
    account_id: src.account_id,
    title: `Copy of ${src.title}`.slice(0, 200),
    description: src.description,
    source: src.source ?? null,
    bid_value_low_cents: src.bid_value_low_cents,
    bid_value_high_cents: src.bid_value_high_cents,
    // proposal_due_at intentionally NOT cloned — re-bidding gets a fresh deadline.
    proposed_start_at: src.proposed_start_at,
    proposed_end_at: src.proposed_end_at,
    property_street: src.property_street,
    property_city: src.property_city,
    property_state: src.property_state,
    property_zip: src.property_zip,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp_id}?error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath("/commercial/opportunities");
  revalidatePath(`/commercial/accounts/${src.account_id}`);
  redirect(`/commercial/opportunities/${result.opportunity.id}?cloned=1`);
}

// ────────────── Team tab actions ──────────────

async function addTeamAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const user_id = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "") as OpportunityAssignmentRole;
  const is_primary = formData.get("is_primary") === "on";
  const notes = (formData.get("notes") as string)?.trim() || null;
  if (!UUID_RE.test(opportunity_id)) redirect("/commercial/opportunities");
  if (!UUID_RE.test(user_id)) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=team&error=${encodeURIComponent("Pick a staff member.")}`);
  }
  if (!(OPPORTUNITY_ASSIGNMENT_ROLES as readonly string[]).includes(role)) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=team&error=${encodeURIComponent("Pick a role.")}`);
  }
  const result = await addOpportunityAssignment({
    opportunity_id,
    user_id,
    role,
    is_primary,
    notes,
    assigned_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=team&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/opportunities/${opportunity_id}?tab=team`);
}

async function removeTeamAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const assignment_id = String(formData.get("assignment_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(assignment_id)) {
    redirect("/commercial/opportunities");
  }
  await removeOpportunityAssignment(opportunity_id, assignment_id, user.id);
  redirect(`/commercial/opportunities/${opportunity_id}?tab=team`);
}

// ────────────── Tasks tab actions ──────────────

async function addTaskAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  if (!UUID_RE.test(opportunity_id)) redirect("/commercial/opportunities");
  const title = String(formData.get("title") ?? "");
  const due_at = (formData.get("due_at") as string) || null;
  const assigned_user_id_raw = String(formData.get("assigned_user_id") ?? "");
  const assigned_user_id =
    assigned_user_id_raw && UUID_RE.test(assigned_user_id_raw) ? assigned_user_id_raw : null;
  const result = await createOpportunityTask({
    opportunity_id,
    title,
    due_at,
    assigned_user_id,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=tasks&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/opportunities/${opportunity_id}?tab=tasks`);
}

async function toggleTaskAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const task_id = String(formData.get("task_id") ?? "");
  const make_complete = String(formData.get("make_complete") ?? "true") === "true";
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(task_id)) {
    redirect("/commercial/opportunities");
  }
  if (make_complete) {
    await completeOpportunityTask(opportunity_id, task_id, user.id);
  } else {
    await uncompleteOpportunityTask(opportunity_id, task_id, user.id);
  }
  redirect(`/commercial/opportunities/${opportunity_id}?tab=tasks`);
}

async function deleteTaskAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const task_id = String(formData.get("task_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(task_id)) {
    redirect("/commercial/opportunities");
  }
  await deleteOpportunityTask(opportunity_id, task_id, user.id);
  redirect(`/commercial/opportunities/${opportunity_id}?tab=tasks`);
}

// ────────────── Notes tab actions ──────────────

async function addNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  if (!UUID_RE.test(opportunity_id)) redirect("/commercial/opportunities");
  const body = String(formData.get("body") ?? "");
  const result = await addOpportunityNote({
    opportunity_id,
    body,
    author_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=notes&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/opportunities/${opportunity_id}?tab=notes`);
}

async function togglePinNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const note_id = String(formData.get("note_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(note_id)) {
    redirect("/commercial/opportunities");
  }
  const result = await togglePinOpportunityNote(opportunity_id, note_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=notes&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/opportunities/${opportunity_id}?tab=notes`);
}

async function editNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const note_id = String(formData.get("note_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(note_id)) {
    redirect("/commercial/opportunities");
  }
  const body = String(formData.get("body") ?? "");
  const result = await editOpportunityNote(opportunity_id, note_id, body, user.id);
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=notes&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/opportunities/${opportunity_id}?tab=notes`);
}

// ────────────── Plans & Specs tab actions ──────────────

async function archiveAttachmentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const attachment_id = String(formData.get("attachment_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(attachment_id)) {
    redirect("/commercial/opportunities");
  }
  const result = await archiveOpportunityAttachment(opportunity_id, attachment_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opportunity_id}?tab=plans&error=${encodeURIComponent(result.error)}`);
  }
  // Keep the list-page 📎 N files badge in sync — the detail page is
  // force-dynamic, but the list page can be cached for navigation.
  revalidatePath("/commercial/opportunities");
  redirect(`/commercial/opportunities/${opportunity_id}?tab=plans`);
}

async function deleteNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const note_id = String(formData.get("note_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(note_id)) {
    redirect("/commercial/opportunities");
  }
  await deleteOpportunityNote(opportunity_id, note_id, user.id);
  redirect(`/commercial/opportunities/${opportunity_id}?tab=notes`);
}

const TABS = [
  { key: "info", label: "Info" },
  // Email promoted to position 2 (audit fix 2026-06-18): on a 375px
  // iPhone with 7 tabs in an overflow-x-auto bar, the rightmost tabs
  // were below the visible fold and Alex never discovered them.
  // Email is the top-3 daily-use surface once the BCC archive is
  // adopted; positioning it right after Info makes it visible in the
  // first 130px of the scroll.
  { key: "email", label: "Email" },
  { key: "team", label: "Team" },
  { key: "plans", label: "Plans & Specs" },
  { key: "notes", label: "Notes" },
  { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" },
] as const;

export default async function OpportunityDetailPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const opp = await getCommercialOpportunity(id);
  if (!opp) notFound();
  const account = await getCommercialAccount(opp.account_id);

  // The Debrief tab only exists for terminal opps (won/lost/no_bid).
  // Building the tab list AFTER fetching opp lets us conditionally
  // expose it so non-terminal opps don't see a "Debrief" tab with
  // nothing to fill out.
  const isOppTerminal = isTerminalOpportunityStatus(opp.status);
  const visibleTabs = isOppTerminal
    ? [
        TABS[0],
        // Slot Debrief right after Info — most important tab on a
        // closed deal (until filled in).
        { key: "debrief", label: "Debrief" } as const,
        ...TABS.slice(1),
      ]
    : TABS;
  const tab = (sp.tab && visibleTabs.some((t) => t.key === sp.tab) ? sp.tab : "info") as
    (typeof visibleTabs)[number]["key"];

  const editedOk = pickFirst(sp.edited) === "1";
  const clonedOk = pickFirst(sp.cloned) === "1";

  return (
    <div className="space-y-5">
      {editedOk && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
          <span aria-hidden>✓</span>
          <span>Changes saved.</span>
        </div>
      )}
      {clonedOk && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
          <span aria-hidden>✓</span>
          <span>
            Cloned from another opportunity. Edit the title + bid range now, then
            update the rest as the bid progresses.
          </span>
        </div>
      )}
      {/* Amber "Debrief needed" banner — surfaces when an opp is in a
          terminal state (won/lost/no_bid) but win_loss_debriefed_at is
          NULL. Quarterly report quality + Alex follow-through depend on
          this; banner only goes away when the structured debrief lands. */}
      {(isTerminalOpportunityStatus(opp.status)) &&
        !opp.win_loss_debriefed_at && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-700 shrink-0 mt-0.5" aria-hidden>
              <path d="M12 9v3.5 M12 16h.01 M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            <div className="text-sm text-amber-900">
              <strong>Debrief needed.</strong>{" "}
              This opportunity closed without a Win/Loss Debrief.
              Capturing competitor + deciding factor feeds the quarterly review and helps Alex pattern-match what&apos;s working.
            </div>
          </div>
          <Link
            href={`/commercial/opportunities/${opp.id}?tab=debrief`}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-700 text-white text-[12px] font-semibold hover:bg-amber-800 active:bg-amber-900 min-h-[44px] touch-manipulation shrink-0"
          >
            Add debrief
          </Link>
        </div>
      )}
      <header>
        <Link
          href="/commercial/opportunities"
          className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800 min-h-[44px] touch-manipulation -ml-1 px-1"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          All opportunities
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal truncate">
              {opp.title}
            </h1>
            <div className="text-sm text-ppp-charcoal-500 mt-1 flex items-center gap-2 flex-wrap">
              {account && (
                <Link
                  href={`/commercial/accounts/${account.id}`}
                  className="text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
                >
                  {account.company_name}
                </Link>
              )}
              <span aria-hidden>·</span>
              <StatusPill status={opp.status} />
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <Link
              href={`/commercial/opportunities/${opp.id}/edit`}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal text-[12px] font-semibold hover:bg-ppp-charcoal-50 hover:border-ppp-charcoal-300 min-h-[44px] touch-manipulation"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 20h9 M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              Edit
            </Link>
            <form action={cloneOpportunityAction} className="contents">
              <input type="hidden" name="opp_id" value={opp.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal text-[12px] font-semibold hover:bg-ppp-charcoal-50 hover:border-ppp-charcoal-300 min-h-[44px] touch-manipulation"
                title="Re-bidding the same site? Clone the opp so you don't retype the scope + bid range."
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Duplicate
              </button>
            </form>
            {/* Reopen — only surfaces for closed deals (won/lost/no_bid).
                Replaces the ChangeStatusCard on terminal opps since the
                only allowed next is reopened anyway; one focused action
                in the header beats a whole "Move this deal forward" card
                with a dropdown of one option. */}
            {(isTerminalOpportunityStatus(opp.status)) && (
              <form action={reopenOpportunityAction} className="contents">
                <input type="hidden" name="opp_id" value={opp.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-emerald-200 bg-white text-emerald-700 text-[12px] font-semibold hover:bg-emerald-50 hover:border-emerald-300 min-h-[44px] touch-manipulation"
                  title="Customer's back in play? Reopen puts this deal back into the active pipeline."
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.8 2.8L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  Reopen
                </button>
              </form>
            )}
          </div>
        </div>
      </header>

      {/* Compact KPI strip — bid range, probability, weighted, decision
          countdown if a due date is set. */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiTile
          label="Bid"
          value={formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
          tooltip="Low–high range for this opportunity. Pulled from the bid_value_low_cents / bid_value_high_cents fields you set on the new-opp or edit form."
        />
        <KpiTile
          label="Probability"
          value={`${opp.probability_pct}%`}
          tooltip="Likelihood we win this bid. Defaults from the status (Inquiry 10% → Estimating 50% → Proposal Sent 60% → Negotiating 75% → Won 100%). Override per-opp if you have a stronger read."
        />
        <KpiTile
          label="Weighted"
          value={formatCentsCompact(weightedPipelineCents(opp))}
          tooltip={`Probability × midpoint bid. ${weightedTooltip(opp)} Use this for forecast roll-ups — it's the dollar value adjusted for the chance of closing.`}
        />
        <KpiTile
          label="Decision in"
          value={daysUntilDisplay(opp.proposal_due_at)}
          tooltip="Days until the proposal is due (or how overdue it is). Pulled from proposal_due_at on the new-opp or edit form."
        />
      </section>

      {/* Tab bar — Debrief tab only surfaces on terminal opps. Right-
          edge fade hints there's more tabs to scroll on mobile. */}
      <nav className="relative border-b border-ppp-charcoal-100">
        <ul className="flex gap-1 sm:gap-2 -mb-px overflow-x-auto scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {visibleTabs.map((t) => {
            const active = t.key === tab;
            const needsAttention = t.key === "debrief" && !opp.win_loss_debriefed_at;
            return (
              <li key={t.key}>
                <Link
                  href={`/commercial/opportunities/${opp.id}?tab=${t.key}`}
                  className={`inline-flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors touch-manipulation whitespace-nowrap min-h-[44px] ${
                    active
                      ? "border-emerald-600 text-ppp-charcoal"
                      : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-100"
                  }`}
                >
                  {t.label}
                  {needsAttention && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="Debrief pending" />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-white to-transparent sm:hidden" aria-hidden />
      </nav>

      {tab === "info" && (
        <InfoTab
          opp={opp}
          account={account}
          errorMessage={pickFirst(sp.error)}
          statusOk={pickFirst(sp.status_ok) === "1"}
          preselectTo={pickFirst(sp.to) as OpportunityStatus | undefined}
          confirmDelete={pickFirst(sp.confirm_delete) === "1"}
        />
      )}
      {tab === "debrief" && isOppTerminal && (
        <DebriefTab
          opp={opp}
          justClosed={pickFirst(sp.just_closed) === "1"}
          debriefSaved={pickFirst(sp.debrief_saved) === "1"}
          statusOk={pickFirst(sp.status_ok) === "1"}
          errorMessage={pickFirst(sp.error)}
        />
      )}
      {tab === "team" && <TeamTab oppId={opp.id} errorMessage={pickFirst(sp.error)} />}
      {tab === "tasks" && <TasksTab oppId={opp.id} errorMessage={pickFirst(sp.error)} />}
      {tab === "notes" && <NotesTab oppId={opp.id} errorMessage={pickFirst(sp.error)} />}
      {tab === "plans" && <PlansTab oppId={opp.id} errorMessage={pickFirst(sp.error)} />}
      {tab === "email" && <EmailArchiveTab kind="opp" sourceId={opp.id} />}
      {tab === "timeline" && <TimelineTab oppId={opp.id} />}
    </div>
  );
}

async function InfoTab({
  opp,
  account,
  errorMessage,
  statusOk,
  preselectTo,
  confirmDelete,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
  errorMessage?: string;
  statusOk?: boolean;
  preselectTo?: OpportunityStatus;
  confirmDelete?: boolean;
}) {
  // Terminal opps now show debrief content in a dedicated Debrief tab,
  // not on Info. Info stays focused on deal facts: bid, dates, address,
  // account. The amber banner above the page header still nudges the
  // user to the Debrief tab until win_loss_debriefed_at is set.
  const isTerminal = isTerminalOpportunityStatus(opp.status);
  // Filter the DAG-allowed next statuses by what we actually want to
  // expose in this surface. Detail page allows ALL valid transitions,
  // including terminal ones (won/lost/no_bid) because we have room for
  // the loss-reason picker. List-page quick-flip hides terminals.
  const nextStatuses = allowedNextStatuses(opp.status);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {errorMessage && (
        <div className="lg:col-span-2 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {statusOk && (
        <div className="lg:col-span-2 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700 flex items-start justify-between gap-3">
          <span>Status updated to <strong>{opportunityStatusLabel(opp.status)}</strong>.</span>
          <Link
            href={`/commercial/opportunities/${opp.id}`}
            className="text-[12px] text-emerald-700 hover:text-emerald-900 underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {/* ChangeStatusCard is for moving a deal forward — irrelevant on
          terminal opps (the only allowed next is reopened, which lives
          as its own dedicated button in the page header). The Debrief
          tab carries everything terminal-specific. */}
      {!isTerminal && (
        <ChangeStatusCard
          opp={opp}
          nextStatuses={nextStatuses}
          preselectTo={preselectTo}
          className="lg:col-span-2"
        />
      )}
      <Card title="Deal">
        <Field label="Title" value={opp.title} />
        <Field label="Status" value={opportunityStatusLabel(opp.status)} />
        <Field
          label="Source"
          value={opp.source ? opportunitySourceLabel(opp.source) : "—"}
          tooltip="How this opportunity came in — phone, email, web form, plans room, repeat customer, referral, or other. Set once at create time."
        />
        <Field
          label="Probability"
          value={`${opp.probability_pct}%`}
          tooltip="Likelihood we win this bid. Defaults from status; override if you have a stronger read."
        />
      </Card>
      <Card title="Bid + dates">
        <Field
          label="Bid range"
          value={formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
          tooltip="Low–high estimate for the project's contract value. If you've quoted a firm number, set low=high."
        />
        <Field
          label="Weighted"
          value={formatCentsCompact(weightedPipelineCents(opp))}
          tooltip="Probability × midpoint bid. Use this for forecast roll-ups — it's the dollar value adjusted for the chance of closing."
        />
        <Field
          label="Proposal due"
          value={opp.proposal_due_at?.slice(0, 10) ?? "—"}
          tooltip="When the customer is expecting our proposal. Drives the Decision in countdown on the KPI strip + the Hot deals filter when the bid is also $50k+."
        />
        <Field
          label="Decided"
          value={opp.decided_at?.slice(0, 10) ?? "—"}
          tooltip="Date the opportunity closed — set automatically when status flips to Won, Lost, or No-bid. Used to compute average days-to-close on the Account 360."
        />
        <Field
          label="Proposed start"
          value={opp.proposed_start_at?.slice(0, 10) ?? "—"}
          tooltip="Target kickoff date we're quoting to the customer. Internal estimate — feeds the project setup phase later."
        />
        <Field
          label="Proposed end"
          value={opp.proposed_end_at?.slice(0, 10) ?? "—"}
          tooltip="Target completion date we're quoting. Internal estimate — informs scheduling once the bid is won."
        />
      </Card>
      <Card title="Property / project address">
        <OppPropertyAddress opp={opp} account={account} />
      </Card>
      <Card title="Account">
        {account ? (
          <>
            <Field label="Company" value={account.company_name} />
            <Field label="Industry" value={account.industry ?? "—"} />
            <Field label="Rating" value={account.rating ?? "—"} />
            <p className="text-[12px] mt-2">
              <Link
                href={`/commercial/accounts/${account.id}`}
                className="text-emerald-700 hover:text-emerald-800 underline"
              >
                Open account →
              </Link>
            </p>
          </>
        ) : (
          <p className="text-sm text-ppp-charcoal-500">
            Account isn&apos;t available — it may have been deleted or you may not have access.
          </p>
        )}
      </Card>
      {opp.description && (
        <Card title="Description" className="lg:col-span-2">
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
            {opp.description}
          </p>
        </Card>
      )}

      {/* Danger zone — soft-delete the opportunity. The confirm panel
          uses an HTML anchor (#danger-zone) so clicking "Delete" jumps
          to this section instead of bouncing the user to the top of
          the page on URL change. Record stays in the DB via deleted_at
          so admins can restore. */}
      <div id="danger-zone" className="lg:col-span-2 mt-4 pt-4 border-t border-ppp-charcoal-100 scroll-mt-24">
        {!confirmDelete ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[12px] text-ppp-charcoal-500">
              Wrong account? Duplicate? Delete this opportunity.
            </div>
            <Link
              href={`/commercial/opportunities/${opp.id}?tab=info&confirm_delete=1#danger-zone`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 text-rose-700 text-[12px] font-semibold hover:bg-rose-50 min-h-[44px] touch-manipulation"
            >
              Delete opportunity
            </Link>
          </div>
        ) : (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
            <div className="text-sm font-semibold text-rose-800 mb-1">
              Delete {opp.title || "this opportunity"}?
            </div>
            <p className="text-[13px] text-rose-700 mb-3 leading-relaxed">
              All notes, tasks, attachments, and team assignments tied to this opportunity will hide from list pages. The record stays in the database — an admin can restore it later from the audit log if needed.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <form action={softDeleteOpportunityAction}>
                <input type="hidden" name="opp_id" value={opp.id} />
                <input type="hidden" name="account_id" value={opp.account_id} />
                <button
                  type="submit"
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 min-h-[44px] touch-manipulation"
                >
                  Yes, delete it
                </button>
              </form>
              <Link
                href={`/commercial/opportunities/${opp.id}?tab=info`}
                className="inline-flex items-center px-4 py-2 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-700 text-sm font-medium hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
              >
                Cancel
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeStatusCard({
  opp,
  nextStatuses,
  preselectTo,
  className,
}: {
  opp: CommercialOpportunity;
  nextStatuses: ReadonlyArray<OpportunityStatus>;
  preselectTo?: OpportunityStatus;
  className?: string;
}) {
  // Render the pre-selected status (from list-page quick-flip's
  // "open detail to reopen" handoff, e.g. ?to=lost) as the default
  // so the user lands on the right form without re-picking. Only
  // honor preselectTo if it's actually a valid next status.
  const defaultTo =
    preselectTo && nextStatuses.includes(preselectTo) ? preselectTo : "";
  // The picker tracks state in URL, but the actual form is server-
  // action driven. We render the loss-reason picker ALWAYS so a user
  // who picks 'lost' from the dropdown sees the required fields
  // without an extra page nav. Native HTML required attr enforces it
  // for the lost case (we mirror server-side validation in the lib).
  // Pre-compute the warn-transition list for the current status so we
  // can surface them up-front in a "Heads-up" block (the per-option
  // "(unusual)" suffix already labels them in the dropdown, but the
  // up-front block makes the warning visible BEFORE the user picks).
  const warnNext = nextStatuses.filter((s) => shouldWarnTransition(opp.status, s));
  return (
    <section className={`bg-white border border-emerald-200 rounded-xl p-5 ring-1 ring-emerald-50 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-ppp-charcoal flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-[14px]" aria-hidden>→</span>
            Move this deal forward
          </h2>
          <p className="text-[12px] text-ppp-charcoal-600 mt-1">
            Currently <strong className="text-ppp-charcoal">{opportunityStatusLabel(opp.status)}</strong>. Pick the next state — closed states (Won / Lost / No-bid) need a short note.
          </p>
        </div>
      </div>
      {warnNext.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-[12px] text-amber-800">
          <strong>Heads up</strong> — these transitions are valid but unusual:
          {" "}
          {warnNext.map((s, i) => (
            <span key={s}>
              <em>{opportunityStatusLabel(opp.status)} → {opportunityStatusLabel(s)}</em>
              {i < warnNext.length - 1 ? ", " : ""}
            </span>
          ))}
          . Double-check before submitting.
        </div>
      )}
      {nextStatuses.length === 0 ? (
        <p className="text-[12px] text-ppp-charcoal-500 italic">
          This status has no outbound transitions. Move to <em>reopened</em> first to re-engage.
        </p>
      ) : (
        <form action={changeStatusAction} className="space-y-3">
          <input type="hidden" name="opp_id" value={opp.id} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label htmlFor="to_status" className={LABEL_CLS}>
                Next status <span className="text-rose-700">*</span>
              </label>
              <select
                id="to_status"
                name="to_status"
                required
                defaultValue={defaultTo}
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
              >
                <option value="" disabled>
                  Pick a status
                </option>
                {nextStatuses.map((s) => (
                  <option key={s} value={s}>
                    {opportunityStatusLabel(s)}
                    {shouldWarnTransition(opp.status, s) ? " — unusual" : ""}
                  </option>
                ))}
              </select>
              {defaultTo && shouldWarnTransition(opp.status, defaultTo) && (
                <p className="text-[11px] text-amber-700 mt-1.5">
                  Unusual transition — double-check this is intentional.
                </p>
              )}
            </div>
            {/* Legacy loss_reason + note fields removed 2026-06-24 —
                Karan flagged them as confusing on non-terminal transitions
                ("Loss reason (if lost)" showed when picking Estimating
                → Proposal Sent, which made no sense). DebriefFields
                below covers terminal cases structurally + non-terminal
                doesn't need either. changeStatusAction reads from the
                debrief_deciding_factor + debrief_lessons fields. */}
          </div>
          {/* Win/Loss Debrief fields — only render when status is terminal.
              Hooks the sibling <select name="to_status"> on the client side
              and fades in. Hides the loss_reason + note siblings above (the
              structured debrief replaces them). */}
          <DebriefFields initialStatus={defaultTo ?? undefined} />
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2">
            {/* Secondary action — submits status flip without filling
                out debrief. Sets a hidden field so changeStatusAction
                knows to drop the placeholder auto-note + leave the
                amber "Debrief needed" banner visible. Only relevant
                for terminal transitions; harmless otherwise. */}
            <button
              type="submit"
              name="debrief_skip"
              value="1"
              className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-medium hover:bg-ppp-charcoal-50 hover:border-ppp-charcoal-300 transition-colors min-h-[44px] touch-manipulation"
            >
              Save status, debrief later
            </button>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
            >
              Move forward →
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

async function DebriefTab({
  opp,
  justClosed,
  debriefSaved,
  statusOk,
  errorMessage,
}: {
  opp: CommercialOpportunity;
  justClosed: boolean;
  debriefSaved: boolean;
  statusOk: boolean;
  errorMessage?: string;
}) {
  // Pull existing debriefs so we can render the read-only completed
  // view if win_loss_debriefed_at is set. listDebriefsForOpp returns
  // newest-first; we surface the most recent.
  const debriefs = await (await import("@/lib/commercial/win-loss/debrief")).listDebriefsForOpp(opp.id);
  const latestDebrief = debriefs[0] ?? null;
  const isDebriefed = Boolean(opp.win_loss_debriefed_at) && latestDebrief !== null;
  const outcomeLabel =
    opp.status === "won" ? "Win" : opp.status === "lost" ? "Loss" : "No-bid";

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {(statusOk || justClosed) && !isDebriefed && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700">
          Deal saved as <strong>{opportunityStatusLabel(opp.status)}</strong>. Capture the {outcomeLabel.toLowerCase()} debrief below to feed the quarterly Win/Loss report — or skip and come back later.
        </div>
      )}
      {debriefSaved && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700">
          Debrief saved. Thanks — this feeds the quarterly Win/Loss report.
        </div>
      )}

      {isDebriefed && latestDebrief ? (
        <DebriefReadOnlyView opp={opp} debrief={latestDebrief} debriefCount={debriefs.length} />
      ) : (
        <DebriefFormCard opp={opp} />
      )}

      {/* Legacy loss reason — only if it exists AND a structured debrief
          doesn't supersede it. Keeps continuity for opps closed before
          the debrief feature shipped. */}
      {!isDebriefed && opp.loss_reason && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <div className={LABEL_CLS}>Legacy loss reason (pre-debrief)</div>
          <p className="text-sm text-ppp-charcoal-700 mt-1">
            {opportunityLossReasonLabel(opp.loss_reason)}
          </p>
          {opp.loss_notes && (
            <p className="mt-2 text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
              {opp.loss_notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DebriefFormCard({ opp }: { opp: CommercialOpportunity }) {
  const outcomeLabel =
    opp.status === "won" ? "Win" : opp.status === "lost" ? "Loss" : "No-bid";
  const subhead = opp.status === "won"
    ? "Capture what sealed it — competitor, deciding factor, and what worked. Feeds the quarterly Win/Loss report."
    : opp.status === "lost"
    ? "Capture who we lost to and why. Two minutes now pays back across the quarterly review."
    : "Capture why we passed. Helps Alex pattern-match the bids worth declining versus chasing.";
  return (
    <section className="bg-white border-2 border-amber-300 rounded-xl p-5 shadow-sm">
      <div className="flex items-start gap-3 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-700">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ppp-charcoal">Add the {outcomeLabel} debrief</h2>
          <p className="text-[13px] text-ppp-charcoal-600 mt-1 leading-relaxed">{subhead}</p>
        </div>
      </div>
      <form action={submitDebriefOnlyAction} className="space-y-3">
        <input type="hidden" name="opp_id" value={opp.id} />
        {/* DebriefFields normally watches a sibling <select name="to_status">.
            Here the status is already terminal — passing initialStatus
            renders the form fully open without a sibling select. */}
        <DebriefFields initialStatus={opp.status} />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
          <Link
            href="/commercial/opportunities"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-medium hover:bg-ppp-charcoal-50 hover:border-ppp-charcoal-300 transition-colors min-h-[44px] touch-manipulation"
          >
            Skip — debrief later
          </Link>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
          >
            Save debrief
          </button>
        </div>
      </form>
    </section>
  );
}

function DebriefReadOnlyView({
  opp,
  debrief,
  debriefCount,
}: {
  opp: CommercialOpportunity;
  debrief: { competitor_name: string | null; deciding_factor: string | null; lessons_learned: string | null; internal_notes: string | null; debriefed_at: string };
  debriefCount: number;
}) {
  return (
    <section className="bg-white border border-emerald-200 rounded-xl p-5 ring-1 ring-emerald-50">
      <div className="flex items-start gap-3 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-700">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ppp-charcoal">{opp.status === "won" ? "Win" : opp.status === "lost" ? "Loss" : "No-bid"} Debrief</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1">
            Recorded {new Date(debrief.debriefed_at).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/New_York" })}
            {debriefCount > 1 && ` · ${debriefCount} debriefs on file (this is the most recent)`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          label={opp.status === "won" ? "Beat" : opp.status === "lost" ? "Lost to" : "Competitor"}
          value={debrief.competitor_name ?? "—"}
        />
        <Field
          label={opp.status === "won" ? "What sealed it" : "Deciding factor"}
          value={debrief.deciding_factor
            ? opportunityLossReasonLabel(debrief.deciding_factor as OpportunityLossReason)
            : "—"}
        />
      </div>
      {debrief.lessons_learned && (
        <div className="mt-4">
          <div className={LABEL_CLS}>
            {opp.status === "won" ? "What worked" : "What we'd do differently"}
          </div>
          <p className="mt-1 text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
            {debrief.lessons_learned}
          </p>
        </div>
      )}
      {debrief.internal_notes && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal select-none">
            Internal notes
          </summary>
          <p className="mt-2 text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
            {debrief.internal_notes}
          </p>
        </details>
      )}
    </section>
  );
}

// ─────────────── Team tab ───────────────

async function TeamTab({ oppId, errorMessage }: { oppId: string; errorMessage?: string }) {
  const [team, staff] = await Promise.all([
    listOpportunityTeam(oppId),
    listAssignableStaff(),
  ]);
  // Detect "filled role with no primary holder" so we can amber-banner
  // the user — same pattern as the accounts Team tab.
  const rolesPresent = new Set<OpportunityAssignmentRole>();
  const rolesWithPrimary = new Set<OpportunityAssignmentRole>();
  for (const person of team) {
    for (const a of person.assignments) {
      rolesPresent.add(a.role);
      if (a.is_primary) rolesWithPrimary.add(a.role);
    }
  }
  const missingPrimaryRoles = Array.from(rolesPresent).filter((r) => !rolesWithPrimary.has(r));
  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {missingPrimaryRoles.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <strong>Heads up</strong> — no primary set for:{" "}
          {missingPrimaryRoles.map((r) => opportunityAssignmentRoleLabel(r)).join(", ")}.
        </div>
      )}
      {staff.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          No PPP staff have Commercial CC access yet. Grant access on the admin Users page first.
        </div>
      )}

      {/* Add assignment form */}
      {staff.length > 0 && (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Add to team</h2>
          <form action={addTeamAction} className="space-y-3">
            <input type="hidden" name="opportunity_id" value={oppId} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="team_user" className={LABEL_CLS}>
                  Staff member <span className="text-rose-700">*</span>
                </label>
                <select
                  id="team_user"
                  name="user_id"
                  required
                  defaultValue=""
                  className={SELECT_CLS}
                  style={SELECT_BG_STYLE}
                >
                  <option value="">Pick someone</option>
                  {staff.map((s) => (
                    <option key={s.user_id} value={s.user_id}>
                      {s.full_name ?? s.email}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="team_role" className={LABEL_CLS}>
                  Role <span className="text-rose-700">*</span>
                </label>
                <select
                  id="team_role"
                  name="role"
                  required
                  defaultValue=""
                  className={SELECT_CLS}
                  style={SELECT_BG_STYLE}
                >
                  <option value="">Pick a role</option>
                  {OPPORTUNITY_ASSIGNMENT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {opportunityAssignmentRoleLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input id="team_primary" name="is_primary" type="checkbox" className="w-4 h-4 rounded border-ppp-charcoal-300 text-emerald-600 focus:ring-emerald-600/40" />
              <label htmlFor="team_primary" className="text-[12px] text-ppp-charcoal-700">
                Mark as primary in this role
              </label>
            </div>
            <div>
              <label htmlFor="team_notes" className={LABEL_CLS}>
                Notes
              </label>
              <input
                id="team_notes"
                name="notes"
                type="text"
                placeholder="Optional — e.g. covering for Sarah"
                className={INPUT_CLS}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px] touch-manipulation"
              >
                Add to team
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Current team */}
      {team.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          No team assigned yet. Add the sales rep, estimator, PM, and anyone else from PPP working this deal.
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {team.length} team member{team.length === 1 ? "" : "s"}
            </h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {team.map((person) => (
              <li key={person.user_id} className="px-4 py-4">
                <div className="font-semibold text-ppp-charcoal text-sm">
                  {person.user_full_name ?? person.user_email}
                </div>
                {person.user_full_name && (
                  <a href={`mailto:${person.user_email}`} className="text-[12px] text-emerald-700 hover:text-emerald-800 underline">
                    {person.user_email}
                  </a>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {person.assignments.map((a) => (
                    <span
                      key={a.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${
                        a.is_primary
                          ? "bg-emerald-600 text-white border-emerald-700"
                          : "bg-emerald-50 text-emerald-700 border-emerald-200"
                      }`}
                      title={a.notes ?? undefined}
                    >
                      {a.is_primary && <span aria-hidden>★</span>}
                      {opportunityAssignmentRoleLabel(a.role)}
                      <form action={removeTeamAction} className="inline">
                        <input type="hidden" name="opportunity_id" value={oppId} />
                        <input type="hidden" name="assignment_id" value={a.id} />
                        <button
                          type="submit"
                          aria-label={`Remove ${opportunityAssignmentRoleLabel(a.role)} role`}
                          className={`-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[32px] inline-flex items-center justify-center touch-manipulation ${a.is_primary ? "text-white/80 hover:text-white" : "text-emerald-700/80 hover:text-emerald-900"}`}
                        >
                          ✕
                        </button>
                      </form>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─────────────── Tasks tab ───────────────

async function TasksTab({ oppId, errorMessage }: { oppId: string; errorMessage?: string }) {
  const [tasks, staff] = await Promise.all([
    listOpportunityTasks(oppId),
    listAssignableStaff(),
  ]);
  const open = tasks.filter((t) => !t.completed_at);
  const closed = tasks.filter((t) => !!t.completed_at);
  const staffById = new Map(staff.map((s) => [s.user_id, s]));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Add task</h2>
        <form action={addTaskAction} className="space-y-3">
          <input type="hidden" name="opportunity_id" value={oppId} />
          <div>
            <label htmlFor="task_title" className={LABEL_CLS}>
              Title <span className="text-rose-700">*</span>
            </label>
            <input
              id="task_title"
              name="title"
              type="text"
              required
              maxLength={200}
              placeholder="e.g. Site walk Tuesday + send sub bids"
              className={INPUT_CLS}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="task_due" className={LABEL_CLS}>
                Due date
              </label>
              <input
                id="task_due"
                name="due_at"
                type="date"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label htmlFor="task_assignee" className={LABEL_CLS}>
                Assignee
              </label>
              <select
                id="task_assignee"
                name="assigned_user_id"
                defaultValue=""
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
              >
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.user_id} value={s.user_id}>
                    {s.full_name ?? s.email}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px] touch-manipulation"
            >
              Add task
            </button>
          </div>
        </form>
      </section>

      <TaskList
        label={`Open · ${open.length}`}
        tasks={open}
        oppId={oppId}
        staffById={staffById}
        today={today}
        emptyCopy="No open tasks. Add the next step above."
      />
      {closed.length > 0 && (
        <TaskList
          label={`Completed · ${closed.length}`}
          tasks={closed}
          oppId={oppId}
          staffById={staffById}
          today={today}
          emptyCopy=""
          dim
        />
      )}
    </div>
  );
}

function TaskList({
  label,
  tasks,
  oppId,
  staffById,
  today,
  emptyCopy,
  dim,
}: {
  label: string;
  tasks: OpportunityTask[];
  oppId: string;
  staffById: Map<string, { user_id: string; email: string; full_name: string | null }>;
  today: string;
  emptyCopy: string;
  dim?: boolean;
}) {
  return (
    <div className={`bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden ${dim ? "opacity-80" : ""}`}>
      <div className="px-4 py-3 border-b border-ppp-charcoal-100">
        <h2 className="text-sm font-semibold text-ppp-charcoal">{label}</h2>
      </div>
      {tasks.length === 0 ? (
        <div className="p-6 text-center text-sm text-ppp-charcoal-500">{emptyCopy}</div>
      ) : (
        <ul className="divide-y divide-ppp-charcoal-100">
          {tasks.map((t) => {
            const assignee = t.assigned_user_id ? staffById.get(t.assigned_user_id) : null;
            const overdue =
              !t.completed_at && t.due_at && t.due_at.slice(0, 10) < today;
            const dueChip = !t.completed_at && t.due_at ? dueLabel(t.due_at) : null;
            return (
              <li key={t.id} className="px-4 py-3 flex items-start gap-3">
                <form action={toggleTaskAction} className="pt-1">
                  <input type="hidden" name="opportunity_id" value={oppId} />
                  <input type="hidden" name="task_id" value={t.id} />
                  <input type="hidden" name="make_complete" value={t.completed_at ? "false" : "true"} />
                  <button
                    type="submit"
                    aria-label={t.completed_at ? `Reopen ${t.title}` : `Complete ${t.title}`}
                    className={`rounded border-2 inline-flex items-center justify-center touch-manipulation min-h-[36px] min-w-[36px] text-base ${
                      t.completed_at
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "border-ppp-charcoal-300 hover:border-emerald-500"
                    }`}
                  >
                    {t.completed_at ? "✓" : ""}
                  </button>
                </form>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${t.completed_at ? "line-through text-ppp-charcoal-500" : "text-ppp-charcoal"}`}>
                    {t.title}
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    {dueChip && (
                      <span className={overdue ? "text-rose-700 font-semibold" : t.due_at && t.due_at.slice(0, 10) <= addDaysISO(today, 7) ? "text-amber-700" : "text-ppp-charcoal-500"}>
                        {dueChip}
                      </span>
                    )}
                    {assignee && (
                      <span>
                        Assigned: <strong>{assignee.full_name ?? assignee.email}</strong>
                      </span>
                    )}
                  </div>
                </div>
                <form action={deleteTaskAction} className="shrink-0">
                  <input type="hidden" name="opportunity_id" value={oppId} />
                  <input type="hidden" name="task_id" value={t.id} />
                  <button
                    type="submit"
                    aria-label={`Delete ${t.title}`}
                    title="Delete task"
                    className="px-2 py-1 text-[11px] text-ppp-charcoal-500 hover:text-rose-700 min-h-[44px] inline-flex items-center touch-manipulation"
                  >
                    Delete
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function dueLabel(iso: string): string {
  const target = new Date(iso.slice(0, 10) + "T00:00:00").getTime();
  if (!Number.isFinite(target)) return "—";
  const days = Math.ceil((target - Date.now()) / 86_400_000);
  if (days < 0) return `Overdue ${Math.abs(days)}d`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days}d`;
}

function addDaysISO(base: string, days: number): string {
  const d = new Date(base.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─────────────── Notes tab ───────────────

async function NotesTab({ oppId, errorMessage }: { oppId: string; errorMessage?: string }) {
  // Stage 3: parallel-fetch notes + mentionable team members so the
  // @ autocomplete has live candidates without an extra round-trip.
  // Candidate set is everyone with platform access — broader than just
  // the opp team so Alex can tag Katie even if she isn't formally
  // assigned to this opp yet. Server-side mention resolution still
  // requires the target to be active + have platform access.
  const [notes, allStaff] = await Promise.all([
    listOpportunityNotes(oppId),
    listAssignableStaff(),
  ]);
  const mentionCandidates = allStaff.map((s) => ({
    user_id: s.user_id,
    email: s.email,
    full_name: s.full_name,
  }));
  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Add note</h2>
        <form action={addNoteAction} className="space-y-3">
          <input type="hidden" name="opportunity_id" value={oppId} />
          <MentionTextarea
            name="body"
            required
            maxLength={5000}
            rows={3}
            placeholder="Called Sarah, asking $5k off. Type @ to tag a teammate."
            candidates={mentionCandidates}
            helperText="Tip: type @ to tag a teammate — they'll get a personal notification."
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px] touch-manipulation"
            >
              Add note
            </button>
          </div>
        </form>
      </section>

      {notes.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          No notes yet. The timeline starts with whatever you log first.
        </div>
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} oppId={oppId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteCard({ note, oppId }: { note: OpportunityNoteWithAuthor; oppId: string }) {
  const author = note.author_full_name ?? note.author_email ?? "Unknown";
  const edited = note.updated_at && note.updated_at !== note.created_at;
  const isPinned = note.pinned_at !== null;
  return (
    <li
      className={`border rounded-xl p-4 ${
        isPinned
          ? "bg-amber-50 border-amber-200"
          : "bg-white border-ppp-charcoal-100"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {isPinned && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-200 text-amber-900 border border-amber-300"
              title="Pinned to top of the notes list"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M16 4l-4 4-4-4-2 2 4 4-6 6v2h2l6-6 4 4 2-2-4-4 4-4z" />
              </svg>
              Pinned
            </span>
          )}
          <span className="text-sm font-semibold text-ppp-charcoal">{author}</span>
        </div>
        <span className="text-[11px] text-ppp-charcoal-500">
          {new Date(note.created_at).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/New_York",
          })}
          {" ET"}
          {edited && " · edited"}
        </span>
      </div>
      <details className="group">
        <summary className="list-none cursor-pointer">
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">{note.body}</p>
          <span className="text-[11px] text-emerald-700 underline mt-2 inline-flex items-center gap-1 min-h-[44px] touch-manipulation">
            Edit / Delete
          </span>
        </summary>
        <div className="mt-3 space-y-3">
          <form action={editNoteAction} className="space-y-2">
            <input type="hidden" name="opportunity_id" value={oppId} />
            <input type="hidden" name="note_id" value={note.id} />
            <textarea
              name="body"
              required
              rows={3}
              maxLength={5000}
              defaultValue={note.body}
              className={TEXTAREA_CLS + " min-h-[88px]"}
            />
            <div className="flex justify-end gap-2">
              <button
                type="submit"
                className="inline-flex items-center px-3 py-1.5 rounded-lg bg-ppp-charcoal text-white text-[12px] font-semibold hover:bg-ppp-charcoal-700 min-h-[36px] touch-manipulation"
              >
                Save edit
              </button>
            </div>
          </form>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <form action={togglePinNoteAction}>
              <input type="hidden" name="opportunity_id" value={oppId} />
              <input type="hidden" name="note_id" value={note.id} />
              <button
                type="submit"
                className={`inline-flex items-center gap-1.5 text-[11px] underline min-h-[44px] touch-manipulation rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ppp-blue px-1 ${
                  isPinned
                    ? "text-ppp-charcoal-700 hover:text-ppp-charcoal-900"
                    : "text-amber-700 hover:text-amber-900"
                }`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M16 4l-4 4-4-4-2 2 4 4-6 6v2h2l6-6 4 4 2-2-4-4 4-4z" />
                </svg>
                {isPinned ? "Unpin" : "Pin to top"}
              </button>
            </form>
            <form action={deleteNoteAction}>
              <input type="hidden" name="opportunity_id" value={oppId} />
              <input type="hidden" name="note_id" value={note.id} />
              <button
                type="submit"
                className="text-[11px] text-rose-700 hover:text-rose-900 underline min-h-[44px] inline-flex items-center touch-manipulation rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 px-1"
              >
                Delete note
              </button>
            </form>
          </div>
        </div>
      </details>
    </li>
  );
}

// ─────────────── Plans & Specs tab ───────────────

async function PlansTab({ oppId, errorMessage }: { oppId: string; errorMessage?: string }) {
  const { active, history } = await listOpportunityAttachments(oppId);
  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <CommercialOpportunityUploadForm oppId={oppId} />

      <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ppp-charcoal">
            Current files · {active.length}
          </h2>
          {history.length > 0 && (
            <span className="text-[11px] text-ppp-charcoal-500">
              {history.length} archived in history below
            </span>
          )}
        </div>
        {active.length === 0 ? (
          <div className="p-8 text-center text-sm text-ppp-charcoal-500">
            No files yet. Upload the RFP, plan set, spec book, and any proposal versions here.
          </div>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {active.map((a) => (
              <AttachmentRow key={a.id} attachment={a} oppId={oppId} active />
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 && (
        <details className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden group">
          <summary className="px-4 py-3 cursor-pointer text-[12px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between min-h-[44px] touch-manipulation">
            <span>History · {history.length}</span>
            <span className="text-ppp-charcoal-300 group-open:rotate-180 transition-transform">▾</span>
          </summary>
          <ul className="divide-y divide-ppp-charcoal-100 border-t border-ppp-charcoal-100">
            {history.map((a) => (
              <AttachmentRow key={a.id} attachment={a} oppId={oppId} active={false} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  oppId,
  active,
}: {
  attachment: OpportunityAttachment;
  oppId: string;
  active: boolean;
}) {
  const uploaded = new Date(attachment.uploaded_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
  const category = categorizeFilename(attachment.file_name);
  return (
    <li className="px-4 py-3 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`/api/commercial/opportunities/${oppId}/attachments/${attachment.id}/download`}
            className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 underline break-words py-1 inline-block"
            target="_blank"
            rel="noopener noreferrer"
          >
            {attachment.file_name}
          </a>
          {category && (
            <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border bg-blue-50 text-blue-700 border-blue-200">
              {category}
            </span>
          )}
          {attachment.version > 1 && (
            <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100">
              v{attachment.version}
            </span>
          )}
          {!active && (
            <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border bg-amber-50 text-amber-800 border-amber-200">
              Archived
            </span>
          )}
        </div>
        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span>{formatBytes(attachment.size_bytes)}</span>
          {attachment.mime_type && (
            <>
              <span aria-hidden>·</span>
              <span>{attachment.mime_type.split("/").pop()}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span>Uploaded {uploaded}</span>
        </div>
        {attachment.notes && (
          <p className="text-[12px] text-ppp-charcoal-700 mt-1 leading-relaxed">
            {attachment.notes}
          </p>
        )}
      </div>
      {active && (
        <form action={archiveAttachmentAction} className="shrink-0">
          <input type="hidden" name="opportunity_id" value={oppId} />
          <input type="hidden" name="attachment_id" value={attachment.id} />
          <button
            type="submit"
            title="Archive without replacement. File stays downloadable in History."
            className="px-3 py-1.5 text-[12px] font-medium text-ppp-charcoal-700 border border-ppp-charcoal-100 rounded-lg hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Archive
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * Timeline tab — chronological history of every status change on the
 * opp, sourced from `commercial_opportunity_status_log` (migration 029).
 * Renders an inverted-time vertical timeline: most recent at top.
 * Each row shows the from→to transition, the actor's user_id (raw for
 * now; profile join lands when Recent Activity ships), the timestamp,
 * the optional explanation note, and loss_reason on lost/no_bid exits.
 *
 * Empty state covers freshly-created opps that haven't moved yet.
 */
async function TimelineTab({ oppId }: { oppId: string }) {
  const log = await listOpportunityStatusLog(oppId);
  if (log.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
        <div className="text-sm font-semibold text-ppp-charcoal mb-1">
          No status changes yet
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          As this deal moves through the pipeline, every status change shows up here with the date, the person who changed it, and any note they added.
        </p>
      </div>
    );
  }
  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ppp-charcoal">
          Status history · {log.length}
        </h2>
        <span className="text-[11px] text-ppp-charcoal-500">Most recent first</span>
      </div>
      <ol className="divide-y divide-ppp-charcoal-100">
        {log.map((entry) => {
          const when = new Date(entry.changed_at);
          const isTerminal = isTerminalOpportunityStatus(entry.to_status);
          const isWin = entry.to_status === "won";
          const cls = isWin
            ? "border-l-emerald-500"
            : isTerminal
            ? "border-l-rose-400"
            : "border-l-ppp-charcoal-200";
          return (
            <li key={entry.id} className={`px-4 py-3 border-l-4 ${cls}`}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
                <div className="text-sm font-semibold text-ppp-charcoal">
                  {entry.from_status ? (
                    <>
                      {opportunityStatusLabel(entry.from_status)}
                      <span aria-hidden className="text-ppp-charcoal-400 mx-1.5">→</span>
                      {opportunityStatusLabel(entry.to_status)}
                    </>
                  ) : (
                    <>Created as {opportunityStatusLabel(entry.to_status)}</>
                  )}
                </div>
                <span
                  className="text-[12px] text-ppp-charcoal-500"
                  title={when.toISOString()}
                >
                  {/* America/New_York timezone — the platform is rendered
                      server-side on Vercel (UTC), so leaving timeZone out
                      shows UTC timestamps to NYC users. PPP is in NYC, all
                      end-users are NYC. */}
                  {when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}
                  {" · "}
                  {when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
                  {" ET"}
                </span>
              </div>
              {/* Only surface loss_reason on terminal lost/no_bid rows —
                  if stale data ever set it on a won row, we don't want
                  the timeline to look like the deal was lost. */}
              {entry.loss_reason && (entry.to_status === "lost" || entry.to_status === "no_bid") && (
                <div className="text-[12px] text-rose-700 mb-1">
                  Reason: {opportunityLossReasonLabel(entry.loss_reason)}
                </div>
              )}
              {entry.note && (
                <p className="text-[13px] text-ppp-charcoal-700 leading-relaxed whitespace-pre-wrap">
                  {entry.note}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-bold text-ppp-charcoal mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function OppPropertyAddress({
  opp,
  account,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
}) {
  // Prefer opp-level property address (migration 035). Fall back to the
  // account's site address (or billing as a last resort) when blank —
  // most opps will share the account's existing address until Alex
  // explicitly sets a per-opp value.
  const hasOpp =
    Boolean(opp.property_street) ||
    Boolean(opp.property_city) ||
    Boolean(opp.property_state) ||
    Boolean(opp.property_zip);

  if (hasOpp) {
    const line2 = [opp.property_city, opp.property_state].filter(Boolean).join(", ");
    const line2Full = [line2, opp.property_zip].filter(Boolean).join(" ");
    return (
      <>
        <Field label="Street" value={opp.property_street ?? "—"} />
        <Field label="City / State / ZIP" value={line2Full || "—"} />
        <p className="text-[11px] text-ppp-charcoal-500 mt-1">
          Per-opp address — overrides the account&apos;s site address for this bid.
        </p>
      </>
    );
  }

  const acctStreet = account?.site_street || account?.billing_street || null;
  const acctCity = account?.site_city || account?.billing_city || null;
  const acctState = account?.site_state || account?.billing_state || null;
  const acctZip = account?.site_zip || account?.billing_zip || null;
  const hasFallback = Boolean(acctStreet || acctCity || acctState || acctZip);

  if (!hasFallback) {
    return (
      <p className="text-[12px] text-ppp-charcoal-500 italic">
        No project address set. Add one when editing the opportunity, or set the
        account&apos;s site address.
      </p>
    );
  }
  const fallbackLine2 = [acctCity, acctState].filter(Boolean).join(", ");
  const fallbackLine2Full = [fallbackLine2, acctZip].filter(Boolean).join(" ");
  return (
    <>
      <Field label="Street" value={acctStreet ?? "—"} />
      <Field label="City / State / ZIP" value={fallbackLine2Full || "—"} />
      <p className="text-[11px] text-ppp-charcoal-500 mt-1">
        Pulled from the account&apos;s {account?.site_street ? "site" : "billing"} address.
        Edit the opp to set a per-bid project address.
      </p>
    </>
  );
}

function Field({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string | null | undefined;
  tooltip?: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 shrink-0 w-32 inline-flex items-center gap-1">
        {label}
        {tooltip && <InfoDot text={tooltip} />}
      </span>
      <span className="text-sm text-ppp-charcoal-700 min-w-0 break-words">
        {value || "—"}
      </span>
    </div>
  );
}

function KpiTile({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  // Karan 2026-06-24: tinted top-bar + gradient bg so the KPI strip
  // pops instead of looking like four white squares. Sky/cyan accent
  // matches PPP CC's signature blue. Built-in Tailwind palette only —
  // the earlier ppp-blue-50/40 attempt broke the CSS build silently.
  return (
    <div className="relative border border-ppp-charcoal-100 rounded-lg px-3 pt-3.5 pb-3 bg-gradient-to-br from-white to-sky-50 min-h-[64px] flex flex-col justify-center shadow-sm overflow-hidden">
      <span className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 to-cyan-400" aria-hidden />
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 flex items-center gap-1">
        <span>{label}</span>
        {tooltip && <InfoDot text={tooltip} />}
      </div>
      <div className="text-base sm:text-lg font-bold text-ppp-charcoal mt-1 truncate">
        {value}
      </div>
    </div>
  );
}

/** Weighted tooltip — turns the bare $ value into a one-line data
 *  story Alex can quote. "$12.5k = 25% × $50k midpoint" tells him at
 *  a glance whether the weighted number is "confident" or "we're
 *  hedging." */
function weightedTooltip(opp: CommercialOpportunity): string {
  const low = opp.bid_value_low_cents ?? 0;
  const high = opp.bid_value_high_cents ?? 0;
  if (low === 0 && high === 0) return "No bid value set yet.";
  const mid = (low + (high || low)) / 2;
  const midDollars = (mid / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return `${opp.probability_pct}% probability × $${midDollars} midpoint bid.`;
}

function StatusPill({ status }: { status: OpportunityStatus }) {
  // Karan 2026-06-24: boosted saturation from -50/-700/-200 to
  // -100/-800/-300 across the board so pills pop like the PPP CC.
  // Same color, more contrast. Negotiating uses orange instead of
  // amber to stand out from earlier amber states.
  const map: Record<OpportunityStatus, string> = {
    inquiry: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    site_visit_scheduled: "bg-sky-100 text-sky-800 border-sky-300",
    site_visit_done: "bg-cyan-100 text-cyan-800 border-cyan-300",
    estimating: "bg-amber-100 text-amber-900 border-amber-300",
    proposal_sent: "bg-orange-100 text-orange-900 border-orange-300",
    negotiating: "bg-orange-100 text-orange-900 border-orange-300",
    on_hold: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    won: "bg-emerald-100 text-emerald-800 border-emerald-300",
    lost: "bg-rose-100 text-rose-800 border-rose-300",
    no_bid: "bg-rose-100 text-rose-800 border-rose-300",
    reopened: "bg-blue-100 text-blue-800 border-blue-300",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${map[status]}`}>
      {opportunityStatusLabel(status)}
    </span>
  );
}

function formatCentsCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

function daysUntilDisplay(iso: string | null): string {
  if (!iso) return "—";
  const target = new Date(iso.slice(0, 10) + "T00:00:00").getTime();
  if (!Number.isFinite(target)) return "—";
  const days = Math.ceil((target - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days}d`;
}
