import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import {
  INPUT_CLS,
  SELECT_CLS,
  SELECT_BG_STYLE,
  TEXTAREA_CLS,
  LABEL_CLS,
} from "@/lib/commercial/form-classnames";

import {
  getOpportunitySubmittal,
  editOpportunitySubmittal,
  deleteOpportunitySubmittal,
  changeSubmittalStatus,
  createOpportunitySubmittal,
  type ChangeSubmittalStatusInput,
} from "@/lib/commercial/opportunities/submittals";
import {
  addSubmittalItem,
  editSubmittalItem,
  deleteSubmittalItem,
} from "@/lib/commercial/opportunities/submittal-items";
import { listOpportunityFinishes } from "@/lib/commercial/opportunities/finishes";
import {
  listAttachmentsBySubmittal,
  listUnlinkedOpportunityAttachments,
  linkAttachmentToSubmittal,
  unlinkAttachmentFromSubmittal,
  categorizeFilename,
  formatBytes,
} from "@/lib/commercial/opportunities/attachments";
import {
  ALLOWED_SUBMITTAL_TRANSITIONS,
  INCLUDED_KINDS,
  SUBMITTAL_RESPONSES,
  TRANSMITTED_AS_OPTIONS,
  includedKindLabel,
  isTerminalSubmittalStatus,
  submittalResponseLabel,
  submittalStatusLabel,
  submittalStatusTone,
  transmittedAsLabel,
  type IncludedKind,
  type SubmittalResponse,
  type SubmittalStatus,
  type TransmittedAs,
} from "@/lib/commercial/opportunities/submittal-constants";

/**
 * Submittal detail page — `/commercial/opportunities/[id]/submittals/[sid]`.
 *
 * Cover-form editing + items editor. Status transitions (Send / Approve /
 * Revise & resubmit / Void) ship in Batch 4. PDF download + spec-sheet
 * attachment linkage ship in Batch 5/6.
 *
 * Scoping: every server action takes BOTH opportunity_id AND submittal_id,
 * and the lib double-scopes (eq id + eq opportunity_id) on every mutation.
 * Mirror of yesterday's cross-account security fix shape.
 */

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string; sid: string }>;
type SP = Promise<{ error?: string; saved?: string; picker?: string; preselect?: string }>;

// ─────────────────────────────────────────────────────────────────────
//  Cover form edit action — draft-only (lib enforces)
// ─────────────────────────────────────────────────────────────────────

async function editCoverAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }

  // Collect the 9 "WE ARE SENDING YOU" checkbox values into the included_kinds array.
  const included_kinds: IncludedKind[] = [];
  for (const kind of INCLUDED_KINDS) {
    if (formData.get(`included_${kind}`) === "on") included_kinds.push(kind);
  }

  // transmitted_as = empty string means "no selection" → null
  const transmittedRaw = (formData.get("transmitted_as") as string | null)?.trim() || "";
  const transmitted_as = (transmittedRaw || null) as TransmittedAs | null;

  // Address — textarea with 1 line per entry; split + trim.
  const addressRaw = String(formData.get("to_address") ?? "");
  const to_address_lines = addressRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const result = await editOpportunitySubmittal({
    opportunity_id,
    submittal_id,
    to_company: (formData.get("to_company") as string)?.trim() || null,
    to_attention: (formData.get("to_attention") as string)?.trim() || null,
    to_address_lines: to_address_lines.length > 0 ? to_address_lines : null,
    re_subject: (formData.get("re_subject") as string)?.trim() || "Submittals",
    included_kinds,
    transmitted_as,
    remarks: (formData.get("remarks") as string)?.trim() || null,
    updated_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?saved=1`);
}

// ─────────────────────────────────────────────────────────────────────
//  Item actions — draft-only (lib enforces via loadSubmittalForItemMutation)
// ─────────────────────────────────────────────────────────────────────

async function addItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }

  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent("Description is required.")
    );
  }
  const copiesRaw = String(formData.get("copies") ?? "1").trim();
  const copies = parseInt(copiesRaw, 10);
  if (!Number.isFinite(copies) || copies < 1) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent("Copies must be a positive whole number.")
    );
  }

  const result = await addSubmittalItem({
    opportunity_id,
    submittal_id,
    description,
    copies,
    item_date: (formData.get("item_date") as string)?.trim() || null,
    item_number: (formData.get("item_number") as string)?.trim() || null,
    finish_code: (formData.get("finish_code") as string)?.trim() || null,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

async function editItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  const item_id = String(formData.get("item_id") ?? "");
  if (![opportunity_id, submittal_id, item_id].every((s) => UUID_RE.test(s))) {
    redirect("/commercial/opportunities");
  }

  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent("Description is required.")
    );
  }
  const copies = parseInt(String(formData.get("copies") ?? "1").trim(), 10);

  const result = await editSubmittalItem({
    opportunity_id,
    submittal_id,
    item_id,
    description,
    copies: Number.isFinite(copies) && copies >= 1 ? copies : 1,
    item_date: (formData.get("item_date") as string)?.trim() || null,
    item_number: (formData.get("item_number") as string)?.trim() || null,
    finish_code: (formData.get("finish_code") as string)?.trim() || null,
    updated_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

async function deleteItemAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  const item_id = String(formData.get("item_id") ?? "");
  if (![opportunity_id, submittal_id, item_id].every((s) => UUID_RE.test(s))) {
    redirect("/commercial/opportunities");
  }
  const result = await deleteSubmittalItem(opportunity_id, submittal_id, item_id, user.id);
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

// ─────────────────────────────────────────────────────────────────────
//  Delete submittal (draft only)
// ─────────────────────────────────────────────────────────────────────

async function deleteSubmittalAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }
  const result = await deleteOpportunitySubmittal(opportunity_id, submittal_id, user.id);
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  // Drop the badge count on the opp list page.
  revalidatePath("/commercial/opportunities");
  redirect(`/commercial/opportunities/${opportunity_id}?tab=submittals`);
}

// ─────────────────────────────────────────────────────────────────────
//  Attachment linkage — link existing Plans & Specs PDFs to this submittal
// ─────────────────────────────────────────────────────────────────────

async function linkAttachmentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  const attachment_id = String(formData.get("attachment_id") ?? "");
  if (![opportunity_id, submittal_id, attachment_id].every((s) => UUID_RE.test(s))) {
    redirect("/commercial/opportunities");
  }
  const result = await linkAttachmentToSubmittal(
    opportunity_id,
    submittal_id,
    attachment_id,
    user.id
  );
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

async function bulkLinkAttachmentsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }
  // FormData.getAll returns FormDataEntryValue[]; coerce each to string
  // + filter to valid UUIDs so a hand-crafted POST can't pass garbage.
  const attachment_ids = formData.getAll("attachment_ids")
    .map((v) => String(v))
    .filter((s) => UUID_RE.test(s));
  // Preserve the picker state on error so Alex doesn't have to re-tick
  // 25 checkboxes after a rejection (audit Round 3, 2026-07-01).
  // preselect is a comma-list of UUIDs that render as defaultChecked +
  // force the <details> picker open when present.
  const preselect = attachment_ids.join(",");
  const errBase = `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}` +
    `?picker=open&preselect=${preselect}&error=`;
  if (attachment_ids.length === 0) {
    redirect(errBase + encodeURIComponent("Pick at least one attachment to link."));
  }
  // Hard-cap batch size — each id triggers 3 SELECTs + 1 UPDATE in the
  // lib, so an unbounded batch can blow past the 30s function budget
  // AND hold the user request hostage. Recheck audit 2026-06-30.
  // 25 is well above any real submittal package (Tomco ref had 3-12).
  if (attachment_ids.length > 25) {
    redirect(errBase + encodeURIComponent("Can only attach up to 25 files at once. Pick a smaller batch."));
  }
  // Loop linkAttachmentToSubmittal — the lib is already idempotent +
  // race-guarded per row. Track ALL failures (not just first) so the
  // surfaced copy is honest about partial success.
  const failures: string[] = [];
  for (const aid of attachment_ids) {
    const res = await linkAttachmentToSubmittal(opportunity_id, submittal_id, aid, user.id);
    if (!res.ok) failures.push(res.error);
  }
  if (failures.length > 0) {
    const summary = failures.length === attachment_ids.length
      ? `All ${failures.length} failed: ${failures[0]}`
      : `${failures.length} of ${attachment_ids.length} failed: ${failures[0]}`;
    redirect(errBase + encodeURIComponent(summary));
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?saved=1`);
}

async function unlinkAttachmentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  const attachment_id = String(formData.get("attachment_id") ?? "");
  if (![opportunity_id, submittal_id, attachment_id].every((s) => UUID_RE.test(s))) {
    redirect("/commercial/opportunities");
  }
  const result = await unlinkAttachmentFromSubmittal(
    opportunity_id,
    submittal_id,
    attachment_id,
    user.id
  );
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(`/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}`);
}

// ─────────────────────────────────────────────────────────────────────
//  Status DAG transitions — single server action behind the lib's
//  changeSubmittalStatus enforcement. Mirror of the opportunity status
//  pattern at lib/commercial/opportunities/status.ts.
// ─────────────────────────────────────────────────────────────────────
//
// Flow:
//   draft        → Send                    → submitted
//   submitted    → Mark received           → under_review
//   under_review → Approved                → approved   (response stamped)
//   under_review → Approved as Noted       → approved_as_noted
//   under_review → Revise & Resubmit       → revise_and_resubmit
//   under_review → Reject                  → rejected
//   approved/_as_noted/revise/rejected → Close → closed
//   any non-closed → Void (with reason) → voided

async function changeStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    redirect("/commercial/opportunities");
  }

  const to_status = String(formData.get("to_status") ?? "") as SubmittalStatus;

  // Build the input — only include side-effect fields the target status needs.
  const input: ChangeSubmittalStatusInput = {
    opportunity_id,
    submittal_id,
    to_status,
    changed_by_user_id: user.id,
    note: (formData.get("note") as string)?.trim() || null,
  };

  // Response branches require a response enum + optionally copies count.
  if (
    to_status === "approved" ||
    to_status === "approved_as_noted" ||
    to_status === "revise_and_resubmit" ||
    to_status === "rejected"
  ) {
    const responseRaw = (formData.get("response") as string)?.trim() || "";
    if (responseRaw) input.response = responseRaw as SubmittalResponse;
    const copiesRaw = (formData.get("response_copies") as string)?.trim();
    if (copiesRaw) {
      const n = parseInt(copiesRaw, 10);
      if (Number.isFinite(n) && n >= 0) input.response_copies = n;
    }
    const recv = (formData.get("response_received_at") as string)?.trim();
    // HTML date input gives YYYY-MM-DD; convert to ISO timestamp at
    // midday-ET so the date doesn't shift across timezones. Previous
    // hardcoded T17:00:00Z was noon EST but 1pm EDT — recheck audit
    // 2026-06-30 caught it. T16:00:00Z = noon EDT (DST, ~Mar–Nov);
    // T17:00:00Z = noon EST (~Nov–Mar). Detect DST for the date the
    // user picked rather than the date of the request.
    if (recv) {
      const recvDate = new Date(`${recv}T12:00:00Z`);
      // Round-trip through ET to discover the actual offset on that day.
      const etHour = Number(recvDate.toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }));
      // etHour is what 12:00 UTC maps to in NY (7 in EST, 8 in EDT).
      // Offset (UTC -> ET) = etHour - 12. So to land noon-ET, ISO = (12 - offset).
      const utcHourForNoonEt = 12 - (etHour - 12);
      const hh = String(utcHourForNoonEt).padStart(2, "0");
      input.response_received_at = `${recv}T${hh}:00:00.000Z`;
    }
  }

  // Void branch requires void_reason.
  if (to_status === "voided") {
    const reason = (formData.get("void_reason") as string)?.trim();
    if (!reason) {
      redirect(
        `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
          encodeURIComponent("Void reason is required.")
      );
    }
    input.void_reason = reason;
  }

  const result = await changeSubmittalStatus(input);
  if (!result.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  // Status-change ripples to the opp list badge ("awaiting GC" count).
  revalidatePath("/commercial/opportunities");
  redirect(
    `/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}?saved=1`
  );
}

/**
 * Create a revision of this submittal in one click. Spawns a new draft
 * row with revises_submittal_id pointing back at the parent + the parent's
 * cover snapshotted in (lib does the defaulting), then closes the parent
 * (revise_and_resubmit → closed), then redirects to the new revision so
 * Alex can edit the cover + items.
 *
 * Only valid when parent status is revise_and_resubmit or rejected.
 */
async function createRevisionAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const parent_submittal_id = String(formData.get("submittal_id") ?? "");
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(parent_submittal_id)) {
    redirect("/commercial/opportunities");
  }

  // Create the revision row (lib pulls parent cover snapshot + bumps
  // revision_number).
  const createRes = await createOpportunitySubmittal({
    opportunity_id,
    revises_submittal_id: parent_submittal_id,
    created_by_user_id: user.id,
  });
  if (!createRes.ok) {
    redirect(
      `/commercial/opportunities/${opportunity_id}/submittals/${parent_submittal_id}?error=` +
        encodeURIComponent(createRes.error)
    );
  }

  // Best-effort close the parent. If it's not in a state that allows
  // close (e.g. user already closed manually), we don't block — the new
  // revision is the source of truth from here.
  await changeSubmittalStatus({
    opportunity_id,
    submittal_id: parent_submittal_id,
    to_status: "closed",
    changed_by_user_id: user.id,
    note: `Superseded by revision ${createRes.submittal.id.slice(0, 8)}.`,
  });

  revalidatePath("/commercial/opportunities");
  redirect(
    `/commercial/opportunities/${opportunity_id}/submittals/${createRes.submittal.id}?saved=1`
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────────────────────────────

export default async function SubmittalDetailPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id: opportunity_id, sid: submittal_id } = await params;
  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) notFound();

  const sp = await searchParams;
  const errorMessage = pickFirst(sp.error);
  const saved = pickFirst(sp.saved) === "1";
  // Bulk-link picker state preservation on error (audit Round 3).
  // `?picker=open` re-opens the <details>; `?preselect=<comma-list>`
  // seeds defaultChecked so Alex doesn't re-tick 25 boxes after a
  // rejected submit.
  const pickerOpen = pickFirst(sp.picker) === "open";
  const preselectedIds = (pickFirst(sp.preselect) ?? "")
    .split(",")
    .filter((s) => UUID_RE.test(s));

  const loaded = await getOpportunitySubmittal(opportunity_id, submittal_id);
  if (!loaded) notFound();
  const { submittal, items, statusLog } = loaded;

  // Finish-code suggestions for the items editor (autocomplete-friendly).
  // Attachments — linked + unlinked, fetched in parallel for the
  // "Attached spec sheets" section.
  const [finishes, linkedAttachments, unlinkedAttachments] = await Promise.all([
    listOpportunityFinishes(opportunity_id),
    listAttachmentsBySubmittal(opportunity_id, submittal_id),
    listUnlinkedOpportunityAttachments(opportunity_id),
  ]);
  // Can't link new things to a voided submittal; show different copy.
  const canLinkAttachments = submittal.status !== "voided";

  const isDraft = submittal.status === "draft";
  const isTerminal = isTerminalSubmittalStatus(submittal.status);
  const tone = submittalStatusTone(submittal.status);
  const tonePillCls =
    tone === "emerald" ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : tone === "amber" ? "bg-amber-50 text-amber-900 border-amber-200"
    : tone === "rose" ? "bg-rose-50 text-rose-800 border-rose-200"
    : tone === "sky" ? "bg-sky-50 text-sky-800 border-sky-200"
    : tone === "charcoal" ? "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200"
    : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200";

  // Mirrors the PDF's safeDateLabel — bare "YYYY-MM-DD" (Postgres DATE
  // column) parses as UTC midnight, which renders as the PREVIOUS day in
  // America/New_York. Append T12:00:00Z (noon UTC = 7-8am ET, still same
  // day) before parsing. Round 2 audit caught the items-list rendering
  // one day early for item_date values stored as DATE.
  const fmtDate = (iso: string | null): string => {
    if (!iso) return "—";
    if (iso.startsWith("0000")) return "—";
    const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    const d = new Date(isoDateOnly ? `${iso}T12:00:00Z` : iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };
  const fmtDateTime = (iso: string | null): string => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const includedSet = new Set<IncludedKind>(submittal.included_kinds);
  const addressDefault = (submittal.to_address_lines ?? []).join("\n");

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Back link */}
      <Link
        href={`/commercial/opportunities/${opportunity_id}?tab=submittals`}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ppp-charcoal-600 hover:text-ppp-charcoal min-h-[44px] touch-manipulation"
      >
        <span aria-hidden>←</span> Back to submittals
      </Link>

      {/* Banners */}
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {saved && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>Cover saved.</span>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-ppp-charcoal font-mono">
                SUB-{String(submittal.submittal_number).padStart(3, "0")}
                {submittal.revision_number > 0 && (
                  <span className="text-ppp-charcoal-500 ml-2 text-lg">Rev {submittal.revision_number}</span>
                )}
              </h1>
              <span
                className={`inline-flex items-center text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${tonePillCls}`}
              >
                {submittalStatusLabel(submittal.status)}
              </span>
            </div>
            <div className="text-[12px] text-ppp-charcoal-500 mt-1">
              Created {fmtDateTime(submittal.created_at)}
              {submittal.sent_at && <span> · Sent {fmtDate(submittal.sent_at)}</span>}
              {submittal.response_received_at && (
                <span> · Response received {fmtDate(submittal.response_received_at)}</span>
              )}
            </div>
          </div>

          {/* Right-side action cluster */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Download Letter of Transmittal PDF — always available, opens in
                new tab. Inline content-disposition means browser PDF viewer
                handles save/print. */}
            <a
              href={`/api/commercial/opportunities/${opportunity_id}/submittals/${submittal_id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors min-h-[44px] touch-manipulation"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
              </svg>
              Download PDF
            </a>

            {/* Draft-only actions: delete */}
            {isDraft && (
              <form action={deleteSubmittalAction}>
                <input type="hidden" name="opportunity_id" value={opportunity_id} />
                <input type="hidden" name="submittal_id" value={submittal_id} />
                <button
                  type="submit"
                  className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-sm font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px] touch-manipulation"
                >
                  Delete draft
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Voided banner — show on status alone (Round 2 audit). The
            reason field is required by the void action, but legacy/admin
            rows may have null reasons; the banner must still surface so
            the user sees the voided status up top. */}
        {submittal.status === "voided" && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900">
            <strong className="font-semibold">Voided.</strong>{" "}
            {submittal.void_reason ?? <em className="text-rose-700/80">No reason recorded.</em>}
            {submittal.voided_at && (
              <span className="text-rose-700/80 text-[12px] ml-2">
                · {fmtDateTime(submittal.voided_at)}
              </span>
            )}
          </div>
        )}

        {/* Revision banner — when viewing a revision, surface the
            relationship to the parent so Alex can jump back at a glance.
            The package number (SUB-XXX) is shared across revisions so
            we link by parent's revision_number (current - 1, since
            createOpportunitySubmittal does `parent.revision_number + 1`)
            — this disambiguates from the header which already shows the
            current Rev N. Audit recheck 2026-06-30. */}
        {submittal.revises_submittal_id && (
          <div className="mt-4 px-3 py-2.5 rounded-lg bg-sky-50 border border-sky-100 text-[12px] text-sky-900 flex items-start gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden>
              <path d="M3 7v6a2 2 0 0 0 2 2h13l-4-4M21 17v-6a2 2 0 0 0-2-2H6l4-4" />
            </svg>
            <div className="flex-1 min-w-0">
              <strong className="font-semibold">
                Revision {submittal.revision_number} of SUB-{String(submittal.submittal_number).padStart(3, "0")}
              </strong>
              {" — cover + items copied forward from "}
              <Link
                href={`/commercial/opportunities/${opportunity_id}/submittals/${submittal.revises_submittal_id}`}
                className="text-sky-700 hover:text-sky-900 underline underline-offset-2 font-semibold"
              >
                {submittal.revision_number > 1
                  ? `Rev ${submittal.revision_number - 1}`
                  : "the original draft"}
                {" →"}
              </Link>
              {", which was auto-closed."}
            </div>
          </div>
        )}
      </header>

      {/* ──────────── Status Actions Panel ────────────
          Contextual buttons + inline forms that surface the next-step
          transitions allowed by the DAG for the current status. */}
      <StatusActionsPanel
        opportunityId={opportunity_id}
        submittalId={submittal_id}
        status={submittal.status}
        itemCount={items.length}
        hasResponse={!!submittal.response}
      />

      {/* Cover form */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">
          Letter of Transmittal — cover
        </h2>
        {/* Locked banner — sent + non-terminal. Skipped for voided
            (the rose Voided banner up top already covers it; suggesting
            Revise/Void here would mislead since voided is terminal).
            Audit recheck 2026-06-30. */}
        {!isDraft && submittal.status !== "voided" && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[12px] text-amber-900 flex items-start gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <div className="flex-1">
              <strong className="font-semibold">Locked — already sent.</strong>{" "}
              Editing the cover or items would invalidate the GC&apos;s copy. If something needs to change,{" "}
              <strong>create a revision</strong> (the original auto-closes, items copy forward) — use the{" "}
              <em>Revise &amp; Resubmit</em> response branch, or the Void path for a sent-in-error.
            </div>
          </div>
        )}
        <form action={editCoverAction} className="space-y-4">
          <input type="hidden" name="opportunity_id" value={opportunity_id} />
          <input type="hidden" name="submittal_id" value={submittal_id} />

          {/* To / Attention — 2-col on sm+ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="to_company" className={LABEL_CLS}>To (company)</label>
              <input
                id="to_company"
                name="to_company"
                type="text"
                maxLength={120}
                defaultValue={submittal.to_company ?? ""}
                disabled={!isDraft}
                placeholder="e.g. Alta Construction"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label htmlFor="to_attention" className={LABEL_CLS}>Attention</label>
              <input
                id="to_attention"
                name="to_attention"
                type="text"
                maxLength={120}
                defaultValue={submittal.to_attention ?? ""}
                disabled={!isDraft}
                placeholder="e.g. Meyer Beyda"
                className={INPUT_CLS}
              />
            </div>
          </div>

          {/* Address — textarea, one line per address line */}
          <div>
            <label htmlFor="to_address" className={LABEL_CLS}>Bill-to address</label>
            <textarea
              id="to_address"
              name="to_address"
              rows={3}
              maxLength={400}
              defaultValue={addressDefault}
              disabled={!isDraft}
              placeholder="One line per address line — e.g. 143 W 29th Street Fl 12&#10;New York NY 10001"
              className={TEXTAREA_CLS}
            />
          </div>

          {/* RE */}
          <div>
            <label htmlFor="re_subject" className={LABEL_CLS}>RE</label>
            <input
              id="re_subject"
              name="re_subject"
              type="text"
              maxLength={120}
              defaultValue={submittal.re_subject ?? "Submittals"}
              disabled={!isDraft}
              className={INPUT_CLS}
            />
          </div>

          {/* WE ARE SENDING YOU — 9 checkboxes in a wrap grid.
              Single-col on the smallest screens (≤375px) so each label
              has a full 44px+ tap target with breathing room, 2-col on
              ≥400px, 3-col on tablet+ (audit UI H3, 2026-06-30). */}
          <div>
            <label className={LABEL_CLS}>We are sending you</label>
            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
              {INCLUDED_KINDS.map((kind) => (
                <label
                  key={kind}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded border min-h-[44px] touch-manipulation ${
                    isDraft
                      ? "border-ppp-charcoal-200 hover:bg-ppp-charcoal-50 cursor-pointer"
                      : "border-ppp-charcoal-100 bg-ppp-charcoal-50/50 cursor-not-allowed"
                  }`}
                >
                  <input
                    type="checkbox"
                    name={`included_${kind}`}
                    defaultChecked={includedSet.has(kind)}
                    disabled={!isDraft}
                    className="w-4 h-4 rounded border-ppp-charcoal-300 text-emerald-600 focus:ring-emerald-600/40 shrink-0"
                  />
                  <span className="text-[13px] text-ppp-charcoal-700 leading-tight">
                    {includedKindLabel(kind)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* THESE ARE TRANSMITTED — radio-as-select for compactness */}
          <div>
            <label htmlFor="transmitted_as" className={LABEL_CLS}>These are transmitted</label>
            <select
              id="transmitted_as"
              name="transmitted_as"
              defaultValue={submittal.transmitted_as ?? ""}
              disabled={!isDraft}
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              <option value="">— Select —</option>
              {TRANSMITTED_AS_OPTIONS.map((t) => (
                <option key={t} value={t}>{transmittedAsLabel(t)}</option>
              ))}
            </select>
          </div>

          {/* Remarks */}
          <div>
            <label htmlFor="remarks" className={LABEL_CLS}>Remarks</label>
            <textarea
              id="remarks"
              name="remarks"
              rows={2}
              maxLength={1000}
              defaultValue={submittal.remarks ?? ""}
              disabled={!isDraft}
              placeholder="Optional — handwritten notes from the cover (e.g. &ldquo;Doors will now be pre-finished.&rdquo;)"
              className={TEXTAREA_CLS}
            />
          </div>

          {isDraft && (
            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
              >
                Save cover
              </button>
            </div>
          )}
        </form>
      </section>

      {/* Items table */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">
          Items · {items.length}
        </h2>

        {/* Add item — draft only */}
        {isDraft && (
          <form
            action={addItemAction}
            className="bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded-lg p-3 mb-4 space-y-3"
          >
            <input type="hidden" name="opportunity_id" value={opportunity_id} />
            <input type="hidden" name="submittal_id" value={submittal_id} />

            {/* Description — full width, required */}
            <div>
              <label className={LABEL_CLS}>
                Description <span className="text-rose-700">*</span>
              </label>
              <input
                name="description"
                type="text"
                required
                maxLength={300}
                placeholder="e.g. Material Spec Sheets"
                className={INPUT_CLS}
              />
            </div>

            {/* Copies / Date / # / Finish — single-col on small mobile so
                the native date picker has full width (it overflows in a
                2-col layout on iOS at 375px). 2-col on ≥400px, 4-col on
                tablet+ (audit UI H5, 2026-06-30). Children get min-w-0
                so the date picker can shrink inside its grid track. */}
            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 sm:grid-cols-4 gap-3 [&>div]:min-w-0">
              <div>
                <label className={LABEL_CLS}>Copies</label>
                <input
                  name="copies"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  defaultValue={1}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS}>Date</label>
                {/* Default to today (ET) — matches the response-date input
                    pattern + saves Alex blank-fielding every row. Round 2
                    audit caught the inconsistency. ET-correct via
                    Intl format → re-pack as YYYY-MM-DD. */}
                <input
                  name="item_date"
                  type="date"
                  defaultValue={(() => {
                    const parts = new Intl.DateTimeFormat("en-CA", {
                      timeZone: "America/New_York",
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    }).format(new Date());
                    return parts; // en-CA already gives YYYY-MM-DD
                  })()}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS}>Ref #</label>
                <input
                  name="item_number"
                  type="text"
                  maxLength={32}
                  placeholder="optional"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS}>
                  Finish code
                  {finishes.length === 0 && (
                    <Link
                      href={`/commercial/opportunities/${opportunity_id}?tab=finishes`}
                      className="ml-2 text-[10px] font-normal text-sky-700 hover:text-sky-900 underline underline-offset-2"
                    >
                      Add finishes first →
                    </Link>
                  )}
                </label>
                <input
                  name="finish_code"
                  type="text"
                  maxLength={32}
                  list="finish-codes-list"
                  placeholder={finishes.length === 0 ? "no finishes yet" : "e.g. WD-1"}
                  className={INPUT_CLS}
                />
              </div>
            </div>

            {/* Datalist powers the finish-code typeahead from the opp's Finish Schedule.
                Empty state is fine — Alex can still type free-form codes; the cold-start
                link above nudges them to populate the Finish Schedule for typeahead. */}
            <datalist id="finish-codes-list">
              {finishes.map((f) => (
                <option key={f.id} value={f.code}>
                  {f.product_name ? `${f.code} · ${f.product_name}` : f.code}
                </option>
              ))}
            </datalist>

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px] touch-manipulation"
              >
                Add item
              </button>
            </div>
          </form>
        )}

        {/* Items list */}
        {items.length === 0 ? (
          <div className="bg-ppp-charcoal-50/50 border border-dashed border-ppp-charcoal-200 rounded-lg p-6 text-center text-[12px] text-ppp-charcoal-500">
            No items yet. {isDraft ? "Add rows for spec sheets, drawdowns, samples, etc." : "Empty submittal — void and recreate."}
          </div>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100 -mx-5">
            {items.map((item) => (
              <li key={item.id} className="px-5 py-3">
                {isDraft ? (
                  <details className="group">
                    <summary className="cursor-pointer list-none flex items-start gap-3 -mx-2 px-2 py-1 rounded hover:bg-ppp-charcoal-50">
                      <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-100 text-ppp-charcoal-700 text-[11px] font-bold font-mono min-w-[2rem] justify-center">
                        ×{item.copies}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-ppp-charcoal break-words">
                          {item.description}
                        </div>
                        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                          {item.item_date && <span>{fmtDate(item.item_date)}</span>}
                          {item.item_date && (item.item_number || item.finish_code) && <span> · </span>}
                          {item.item_number && <span>#{item.item_number}</span>}
                          {item.item_number && item.finish_code && <span> · </span>}
                          {item.finish_code && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 font-mono">
                              {item.finish_code}
                            </span>
                          )}
                        </div>
                      </div>
                      <span aria-hidden className="shrink-0 text-ppp-charcoal-400 text-[12px] mt-1 transition-transform group-open:rotate-90">
                        ▶
                      </span>
                    </summary>

                    <form action={editItemAction} className="mt-3 space-y-3 pl-1">
                      <input type="hidden" name="opportunity_id" value={opportunity_id} />
                      <input type="hidden" name="submittal_id" value={submittal_id} />
                      <input type="hidden" name="item_id" value={item.id} />

                      <div>
                        <label className={LABEL_CLS}>
                          Description <span className="text-rose-700">*</span>
                        </label>
                        <input
                          name="description"
                          type="text"
                          required
                          maxLength={300}
                          defaultValue={item.description}
                          className={INPUT_CLS}
                        />
                      </div>
                      <div className="grid grid-cols-1 min-[400px]:grid-cols-2 sm:grid-cols-4 gap-3 [&>div]:min-w-0">
                        <div>
                          <label className={LABEL_CLS}>Copies</label>
                          <input
                            name="copies"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            defaultValue={item.copies}
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className={LABEL_CLS}>Date</label>
                          <input
                            name="item_date"
                            type="date"
                            defaultValue={item.item_date ?? ""}
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className={LABEL_CLS}>Ref #</label>
                          <input
                            name="item_number"
                            type="text"
                            maxLength={32}
                            defaultValue={item.item_number ?? ""}
                            className={INPUT_CLS}
                          />
                        </div>
                        <div>
                          <label className={LABEL_CLS}>Finish code</label>
                          <input
                            name="finish_code"
                            type="text"
                            maxLength={32}
                            list="finish-codes-list"
                            defaultValue={item.finish_code ?? ""}
                            className={INPUT_CLS}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="submit"
                          className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px] touch-manipulation"
                        >
                          Save item
                        </button>
                      </div>
                    </form>

                    {/* Delete is its own form so it doesn't conflict with the edit form */}
                    <form action={deleteItemAction} className="mt-2 pl-1">
                      <input type="hidden" name="opportunity_id" value={opportunity_id} />
                      <input type="hidden" name="submittal_id" value={submittal_id} />
                      <input type="hidden" name="item_id" value={item.id} />
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[36px]"
                      >
                        Delete item
                      </button>
                    </form>
                  </details>
                ) : (
                  // Locked view (non-draft)
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-100 text-ppp-charcoal-700 text-[11px] font-bold font-mono min-w-[2rem] justify-center">
                      ×{item.copies}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-ppp-charcoal break-words">{item.description}</div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                        {item.item_date && <span>{fmtDate(item.item_date)}</span>}
                        {item.item_date && item.item_number && <span> · </span>}
                        {item.item_number && <span>#{item.item_number}</span>}
                        {item.finish_code && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 font-mono">
                            {item.finish_code}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ──────────── Attached spec sheets & samples ──────────── */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal">
              Attached spec sheets &amp; samples
            </h2>
            <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
              The PDFs that ship with this submittal — product data, color charts,
              drawdowns, etc. Source files live in{" "}
              <Link
                href={`/commercial/opportunities/${opportunity_id}?tab=plans`}
                className="text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
              >
                Plans &amp; Specs
              </Link>
              ; link the ones that belong to this transmittal here.
            </p>
          </div>
        </div>

        {/* Linked attachments list */}
        {linkedAttachments.length === 0 ? (
          <div className="bg-ppp-charcoal-50/50 border border-dashed border-ppp-charcoal-200 rounded-lg p-6 text-center text-[12px] text-ppp-charcoal-500">
            No PDFs linked yet.{" "}
            {canLinkAttachments && unlinkedAttachments.length > 0 && (
              <span>Pick from {unlinkedAttachments.length} unlinked file{unlinkedAttachments.length === 1 ? "" : "s"} below.</span>
            )}
            {canLinkAttachments && unlinkedAttachments.length === 0 && (
              <span>
                Upload spec sheets on{" "}
                <Link
                  href={`/commercial/opportunities/${opportunity_id}?tab=plans`}
                  className="text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
                >
                  Plans &amp; Specs
                </Link>
                {" "}first, then come back to link them here.
              </span>
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {linkedAttachments.map((att) => {
              const category = categorizeFilename(att.file_name);
              return (
                <li
                  key={att.id}
                  className="flex items-start justify-between gap-3 p-3 rounded-lg border border-ppp-charcoal-100 bg-white hover:border-emerald-200 hover:bg-emerald-50/30 transition-colors"
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span
                      aria-hidden
                      className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded bg-emerald-50 text-emerald-700 border border-emerald-100"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" />
                      </svg>
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ppp-charcoal break-words">
                        {att.file_name}
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                        {category && (
                          <span className="inline-block px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 text-[10px] uppercase tracking-wider font-bold mr-1.5">
                            {category}
                          </span>
                        )}
                        v{att.version} · {formatBytes(att.size_bytes)} · uploaded {fmtDate(att.uploaded_at)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={`/api/commercial/opportunities/${opportunity_id}/attachments/${att.id}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-100 min-h-[36px] touch-manipulation"
                    >
                      Open
                    </a>
                    {canLinkAttachments && (
                      <form action={unlinkAttachmentAction} className="inline">
                        <input type="hidden" name="opportunity_id" value={opportunity_id} />
                        <input type="hidden" name="submittal_id" value={submittal_id} />
                        <input type="hidden" name="attachment_id" value={att.id} />
                        <button
                          type="submit"
                          title="Unlink — file stays on Plans & Specs"
                          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[36px] sm:min-h-[36px] touch-manipulation"
                        >
                          Unlink
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Link existing PDF picker — collapsed by default to avoid clutter.
            One form with checkboxes + a single "Attach selected" button
            (audit workflow #8 — bulk-link). Previously one form per
            attachment meant 6 separate round-trips when Alex needed to
            attach all the architect spec PDFs to a fresh draft. */}
        {canLinkAttachments && unlinkedAttachments.length > 0 && (
          <details className="mt-4 group" open={pickerOpen}>
            <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 hover:text-emerald-800 min-h-[36px] touch-manipulation select-none">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90" aria-hidden>
                <path d="M9 18l6-6-6-6" />
              </svg>
              + Link existing PDF ({unlinkedAttachments.length} available)
            </summary>
            <form action={bulkLinkAttachmentsAction} className="mt-3 p-3 rounded-lg border border-emerald-100 bg-emerald-50/30 space-y-3">
              <input type="hidden" name="opportunity_id" value={opportunity_id} />
              <input type="hidden" name="submittal_id" value={submittal_id} />
              <p className="text-[11px] text-ppp-charcoal-600">
                Tick the PDFs that belong to this submittal package. Multi-select supported (up to 25 per batch).
              </p>
              <ul className="space-y-1">
                {unlinkedAttachments.map((att) => {
                  const category = categorizeFilename(att.file_name);
                  return (
                    <li key={att.id}>
                      <label className="flex items-center gap-3 p-2 rounded hover:bg-white transition-colors cursor-pointer min-h-[44px] touch-manipulation">
                        <input
                          type="checkbox"
                          name="attachment_ids"
                          value={att.id}
                          defaultChecked={preselectedIds.includes(att.id)}
                          className="w-4 h-4 rounded border-ppp-charcoal-300 text-emerald-600 focus:ring-emerald-600/40 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-ppp-charcoal break-words">{att.file_name}</div>
                          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                            {category && (
                              <span className="inline-block px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 text-[10px] uppercase tracking-wider font-bold mr-1.5">
                                {category}
                              </span>
                            )}
                            v{att.version} · {formatBytes(att.size_bytes)}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-end pt-1 border-t border-emerald-100">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
                >
                  Attach selected
                </button>
              </div>
            </form>
          </details>
        )}

        {!canLinkAttachments && linkedAttachments.length === 0 && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[12px] text-amber-900">
            Voided submittals can&apos;t gain new attachments. The package shipped with no
            spec sheets attached.
          </div>
        )}
      </section>

      {/* Status timeline — proper rail+dot pattern (mirrors how the opp
          detail timeline renders activity rows; submittal audit M1 pulled
          us off the flat-bullet list into something Alex can scan as a
          journey). Dot color picks up the tone of the to_status so the
          eye can spot approved-vs-revise-vs-voided without reading. */}
      {statusLog.length > 0 && (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Status history</h2>
          <ol className="relative space-y-3">
            {/* Vertical rail */}
            <span aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-ppp-charcoal-100" />
            {statusLog.map((log) => {
              const tone = submittalStatusTone(log.to_status);
              // Single solid dot in the tone's primary color, sitting on
              // a `ring-white` halo so it punches over the vertical rail
              // cleanly. Audit recheck 2026-06-30 caught the prior
              // outer-ring-overridden + same-color-inner-dot = invisible
              // nested-span structure. One dot, one color, done.
              // Charcoal-500 is the fallback for draft/closed (charcoal +
              // neutral tones). Charcoal-400 isn't in @theme — caught by
              // Round 2 audit, dot would render colorless.
              const dotCls =
                tone === "emerald" ? "bg-emerald-500"
                : tone === "rose" ? "bg-rose-500"
                : tone === "amber" ? "bg-amber-500"
                : tone === "sky" ? "bg-sky-500"
                : tone === "charcoal" ? "bg-ppp-charcoal-500"
                : "bg-ppp-charcoal-500";
              return (
                <li key={log.id} className="relative flex items-start gap-3 pl-1">
                  <span
                    aria-hidden
                    className={`relative z-10 w-[15px] h-[15px] rounded-full ring-4 ring-white shrink-0 mt-0.5 ${dotCls}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline flex-wrap gap-x-2">
                      <span className="text-[13px] font-semibold text-ppp-charcoal">
                        {log.from_status ? (
                          <>
                            <span className="text-ppp-charcoal-500 font-normal">{submittalStatusLabel(log.from_status)}</span>
                            <span className="text-ppp-charcoal-400 mx-1">→</span>
                            <span>{submittalStatusLabel(log.to_status)}</span>
                          </>
                        ) : (
                          <span>{submittalStatusLabel(log.to_status)}</span>
                        )}
                      </span>
                      <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">{fmtDateTime(log.changed_at)}</span>
                    </div>
                    {log.note && (
                      <div className="text-[12px] text-ppp-charcoal-600 mt-1 italic">&ldquo;{log.note}&rdquo;</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Status Actions Panel
// ─────────────────────────────────────────────────────────────────────
//
// Contextual action surface — what Alex can do next from the current
// status, surfaced as a card immediately under the header. Each transition
// uses a server-action form so we get URL-stable state + no client JS.
//
// Design principles:
//   1. ONE primary action per state (emerald) — the obvious "next step"
//   2. Secondary actions (charcoal) — viable alternatives
//   3. Destructive (Void) — always shown for non-terminal states, but
//      tucked at the bottom in rose so it's intentional
//   4. Inline response form when transitioning into a response branch —
//      no second screen, no modal
//   5. Disabled-with-reason banners when an action is technically valid
//      but contextually wrong (e.g. "Send" with 0 items)
//   6. After-revision affordance — when in revise/rejected, the primary
//      action is "Create revision" (one-click spawns the new draft)
//
// All buttons hit 44px min-h, touch-manipulation. Forms stack on mobile.

function StatusActionsPanel({
  opportunityId,
  submittalId,
  status,
  itemCount,
  hasResponse,
}: {
  opportunityId: string;
  submittalId: string;
  status: SubmittalStatus;
  itemCount: number;
  hasResponse: boolean;
}) {
  const allowed = ALLOWED_SUBMITTAL_TRANSITIONS[status] ?? [];
  // Terminal states (closed/voided): no transitions left, but the user
  // still benefits from a card that tells them WHY this is the end of
  // the line + what to do next (audit UI H2, 2026-06-30). Previously
  // we returned null here, leaving Alex on a page with no "next" cue.
  if (allowed.length === 0) {
    const isVoid = status === "voided";
    return (
      <section className={`border rounded-xl p-5 ${
        isVoid
          ? "bg-rose-50/50 border-rose-100"
          : "bg-ppp-charcoal-50/50 border-ppp-charcoal-100"
      }`}>
        <h2 className={`text-sm font-bold ${isVoid ? "text-rose-900" : "text-ppp-charcoal"}`}>
          {isVoid ? "Voided — sent in error" : "Closed — package complete"}
        </h2>
        <p className={`text-[12px] mt-1 ${isVoid ? "text-rose-800" : "text-ppp-charcoal-600"}`}>
          {isVoid
            ? "This submittal won't appear in the opp's badge count. The PDF is preserved with a VOIDED watermark for the audit trail. Start a new submittal from the opportunity if you need to send a replacement."
            : "Status log + items are locked. To send another package on this opp, start a new submittal from the Submittals tab."}
        </p>
        {/* No back-link button — the page already has a "← Back to
            submittals" link at the top of every state (line ~597),
            avoid duplicating it. Round 2 audit. */}
      </section>
    );
  }

  // Hidden inputs every form needs.
  const hiddenIds = (
    <>
      <input type="hidden" name="opportunity_id" value={opportunityId} />
      <input type="hidden" name="submittal_id" value={submittalId} />
    </>
  );

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">What&apos;s next?</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            {actionHelperLine(status)}
          </p>
        </div>
      </div>

      {/* DRAFT → SUBMITTED */}
      {status === "draft" && (
        <div className="space-y-3">
          {itemCount === 0 && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[12px] text-amber-900">
              <strong className="font-semibold">Heads up:</strong>{" "}
              Add at least one item before sending — GCs expect a populated transmittal.
            </div>
          )}
          <form action={changeStatusAction} className="flex flex-wrap items-center gap-2">
            {hiddenIds}
            <input type="hidden" name="to_status" value="submitted" />
            <button
              type="submit"
              disabled={itemCount === 0}
              title={itemCount === 0 ? "Add at least one item before sending" : undefined}
              className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
              Send to GC
            </button>
          </form>
        </div>
      )}

      {/* SUBMITTED → UNDER_REVIEW (GC acknowledged receipt) */}
      {status === "submitted" && (
        <div className="space-y-3">
          <form action={changeStatusAction} className="flex flex-wrap items-center gap-2">
            {hiddenIds}
            <input type="hidden" name="to_status" value="under_review" />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
            >
              Mark received by GC
            </button>
            <span className="text-[12px] text-ppp-charcoal-500">
              Use when the GC acknowledges they got the package — &ldquo;under review&rdquo; period starts.
            </span>
          </form>
        </div>
      )}

      {/* UNDER_REVIEW → response branches */}
      {status === "under_review" && (
        <div className="space-y-4">
          <p className="text-[12px] text-ppp-charcoal-700">
            Record the GC&apos;s response — pick the outcome below + (optional) details.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ResponseRecorder
              opportunityId={opportunityId}
              submittalId={submittalId}
              to_status="approved"
              tone="emerald"
              label="Approved as Submitted"
              defaultResponse="approved"
            />
            <ResponseRecorder
              opportunityId={opportunityId}
              submittalId={submittalId}
              to_status="approved_as_noted"
              tone="emerald"
              label="Approved as Noted"
              defaultResponse="approved_as_noted"
            />
            <ResponseRecorder
              opportunityId={opportunityId}
              submittalId={submittalId}
              to_status="revise_and_resubmit"
              tone="amber"
              label="Revise & Resubmit"
              defaultResponse="returned_for_corrections"
              copiesPlaceholder="copies requested"
            />
            <ResponseRecorder
              opportunityId={opportunityId}
              submittalId={submittalId}
              to_status="rejected"
              tone="rose"
              label="Rejected"
              defaultResponse="returned_for_corrections"
            />
          </div>
        </div>
      )}

      {/* APPROVED / APPROVED_AS_NOTED → close */}
      {(status === "approved" || status === "approved_as_noted") && (
        <div className="space-y-3">
          {/* Inverted condition was the bug — shown when hasResponse=false
              (Round 2 audit). The banner makes sense AFTER a response was
              captured (sky-info nudging the user to close), and we should
              warn when no response is stamped (the unusual bypass path). */}
          {hasResponse ? (
            <div className="px-3 py-2 rounded-lg bg-sky-50 border border-sky-100 text-[12px] text-sky-800">
              Response captured. Close to lock the package + move it into history.
            </div>
          ) : (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[12px] text-amber-900">
              <strong className="font-semibold">No GC response on file.</strong>{" "}
              This submittal is marked approved but the response wasn&apos;t recorded on the
              cover. Closing will lock it as-is; the status log will show the transition
              without a captured response. If that matters, add a note to the status log
              via the close form below.
            </div>
          )}
          <form action={changeStatusAction} className="space-y-2">
            {hiddenIds}
            <input type="hidden" name="to_status" value="closed" />
            {/* Optional note captured onto the status log entry for this
                transition — makes the audit trail useful when there was
                no formal GC response but Alex has context worth
                preserving (audit Round 3, 2026-07-01). */}
            <div>
              <label htmlFor="close-note" className={LABEL_CLS}>
                Close note <span className="text-ppp-charcoal-500">(optional)</span>
              </label>
              <textarea
                id="close-note"
                name="note"
                rows={2}
                maxLength={500}
                placeholder="Optional — captured on the status log (e.g. &ldquo;Verbal OK from PM 6/28.&rdquo;)"
                className={TEXTAREA_CLS}
              />
            </div>
            <div>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
              >
                Close submittal
              </button>
            </div>
          </form>
        </div>
      )}

      {/* REVISE_AND_RESUBMIT / REJECTED → create revision is the primary path */}
      {(status === "revise_and_resubmit" || status === "rejected") && (
        <div className="space-y-3">
          <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[12px] text-amber-900">
            <strong className="font-semibold">Revision path:</strong>{" "}
            Create a new revision — cover + items copy forward; original closes automatically.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form action={createRevisionAction}>
              {hiddenIds}
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
              >
                + Create revision
              </button>
            </form>
            {/* Manual close fallback — for the rare case where Alex doesn't actually need a revision */}
            <form action={changeStatusAction}>
              {hiddenIds}
              <input type="hidden" name="to_status" value="closed" />
              <button
                type="submit"
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
              >
                Close without revision
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Void — bottom-of-card, rose. The summary used to be a thin
          text link which made it easy to miss when Alex actually needed
          it (audit UI M4). Now styled as a visible secondary button so
          it's findable, but still tucked at the bottom + outlined (not
          filled) so it doesn't compete with the primary action above. */}
      {allowed.includes("voided") && (
        <details className="mt-5 group">
          <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 bg-white text-[13px] font-semibold text-rose-800 hover:bg-rose-50 active:bg-rose-100 min-h-[40px] touch-manipulation select-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90" aria-hidden>
              <path d="M9 18l6-6-6-6" />
            </svg>
            Void this submittal
          </summary>
          <form action={changeStatusAction} className="mt-3 space-y-3 p-4 rounded-lg border-2 border-rose-300 bg-rose-50">
            {hiddenIds}
            <input type="hidden" name="to_status" value="voided" />
            <p className="text-[12px] text-rose-900 leading-relaxed">
              <strong className="font-semibold">Heads up — voiding is irreversible.</strong>{" "}
              Voiding marks the submittal as &ldquo;sent in error&rdquo;. The PDF gets a VOIDED
              watermark, the row stays in history with the reason below, and the badge count
              on the opportunity drops. Use this when the wrong package went out, not for
              revisions (use Revise &amp; Resubmit → Create revision for that).
            </p>
            <div>
              <label htmlFor="void_reason" className={LABEL_CLS}>
                Void reason <span className="text-rose-700">*</span>
              </label>
              <textarea
                id="void_reason"
                name="void_reason"
                required
                rows={2}
                maxLength={500}
                placeholder="e.g. Sent to wrong GC contact — replaced by SUB-006"
                className={TEXTAREA_CLS}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-rose-700 text-white text-sm font-semibold hover:bg-rose-800 active:bg-rose-900 min-h-[44px] touch-manipulation"
              >
                Void submittal
              </button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}

/** Helper text under the "What's next?" panel header — explains the
 *  workflow stage in one line. */
function actionHelperLine(status: SubmittalStatus): string {
  switch (status) {
    case "draft": return "Fill the cover + items, then send to the GC.";
    case "submitted": return "Sent. Mark received when the GC acknowledges the package.";
    case "under_review": return "GC is reviewing. Record their response when it comes back.";
    case "approved": return "Approved as submitted. Close to lock + archive.";
    case "approved_as_noted": return "Approved with comments. Close to lock + archive.";
    case "revise_and_resubmit": return "GC wants changes. Create a revision to copy forward + start fresh.";
    case "rejected": return "GC rejected. Create a revision or close to abandon.";
    default: return "";
  }
}

/**
 * One response-recorder card — collapsible details element that expands
 * to a small form (response enum + optional copies count + optional date +
 * optional note). Used for the 4 under_review → branches.
 *
 * Tone drives the border + button color (emerald/amber/rose).
 */
function ResponseRecorder({
  opportunityId,
  submittalId,
  to_status,
  tone,
  label,
  defaultResponse,
  copiesPlaceholder,
}: {
  opportunityId: string;
  submittalId: string;
  to_status: SubmittalStatus;
  tone: "emerald" | "amber" | "rose";
  label: string;
  defaultResponse: SubmittalResponse;
  copiesPlaceholder?: string;
}) {
  // Tone differentiation in the COLLAPSED state too — without the dot
  // the 4 cards look identical when closed, defeating the at-a-glance
  // outcome cue (audit UI M3, 2026-06-30).
  const toneStyles =
    tone === "emerald"
      ? { card: "border-emerald-200 bg-emerald-50/40", btn: "bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 shadow-emerald-600/30", dot: "bg-emerald-500" }
      : tone === "amber"
      ? { card: "border-amber-200 bg-amber-50/40", btn: "bg-amber-700 hover:bg-amber-800 active:bg-amber-900 shadow-amber-700/30", dot: "bg-amber-500" }
      : { card: "border-rose-200 bg-rose-50/40", btn: "bg-rose-700 hover:bg-rose-800 active:bg-rose-900 shadow-rose-700/30", dot: "bg-rose-500" };

  return (
    <details className={`group rounded-lg border ${toneStyles.card} overflow-hidden`}>
      <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center justify-between gap-2 hover:bg-white/50 min-h-[44px] touch-manipulation select-none">
        <span className="flex items-center gap-2 min-w-0">
          <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${toneStyles.dot}`} />
          <span className="text-sm font-semibold text-ppp-charcoal truncate">{label}</span>
        </span>
        <span aria-hidden className="text-ppp-charcoal-400 text-[12px] transition-transform group-open:rotate-90 shrink-0">
          ▶
        </span>
      </summary>
      <form action={changeStatusAction} className="px-3 pb-3 pt-1 space-y-3 border-t border-white/60">
        <input type="hidden" name="opportunity_id" value={opportunityId} />
        <input type="hidden" name="submittal_id" value={submittalId} />
        <input type="hidden" name="to_status" value={to_status} />

        <div>
          <label className={LABEL_CLS}>GC response (exact wording)</label>
          <select
            name="response"
            defaultValue={defaultResponse}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            {SUBMITTAL_RESPONSES.map((r) => (
              <option key={r} value={r}>{submittalResponseLabel(r)}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLS}>
              {copiesPlaceholder ? "Copies" : "Copies (if specified)"}
            </label>
            <input
              name="response_copies"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={copiesPlaceholder ?? "optional"}
              className={INPUT_CLS}
            />
          </div>
          <div>
            <label className={LABEL_CLS}>Response date</label>
            <input
              name="response_received_at"
              type="date"
              // ET-correct today via en-CA formatter (returns YYYY-MM-DD).
              // Was toISOString().slice(0,10) which is UTC — between
              // 8pm and midnight ET, the picker defaulted to tomorrow's
              // date and Alex would stamp the wrong response date on GC
              // approvals. Audit Round 4, 2026-07-01.
              defaultValue={new Intl.DateTimeFormat("en-CA", {
                timeZone: "America/New_York",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(new Date())}
              className={INPUT_CLS}
            />
          </div>
        </div>

        <div>
          <label className={LABEL_CLS}>Note (optional)</label>
          <input
            name="note"
            type="text"
            maxLength={300}
            placeholder="e.g. Spec changes requested — see attached redline."
            className={INPUT_CLS}
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className={`inline-flex items-center justify-center px-4 py-2 rounded-lg ${toneStyles.btn} text-white text-sm font-semibold transition-colors shadow-sm min-h-[44px] touch-manipulation`}
          >
            Record {label.toLowerCase()}
          </button>
        </div>
      </form>
    </details>
  );
}
