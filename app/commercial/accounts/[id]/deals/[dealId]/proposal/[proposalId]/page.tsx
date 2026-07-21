/**
 * Proposal Builder — Phase F.2 editor page.
 *
 * Sections mirror Tomco PDF order top-to-bottom so what Alex/Katie sees
 * on-screen is what the customer sees on the PDF:
 *   1. Header block (GC / Attention / Phone / Email / PROJECT — snapshot,
 *      editable inline)
 *   2. Standard intro paragraph (Tomco default, editable override)
 *   3. Inclusions — line items table with ProductPicker add-row form
 *   4. TOTAL (live-computed on server)
 *   5. Alternates — same shape, isolated from TOTAL
 *   6. Exclusions — ExclusionPicker multi-select
 *   7. Bid notes textarea (hidden on PDF unless populated)
 *   8. Estimator sign-off snapshot (editable inline)
 *   9. PDF options (show line prices toggle)
 *   Bottom: Save all + New revision (R{n+1}) + Delete draft
 *
 * URL: /commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
  listCommercialOpportunities,
} from "@/lib/commercial/opportunities/db";
import {
  getProposal,
  updateProposal,
  softDeleteProposal,
  listLineItemsForProposal,
  createLineItem,
  updateLineItem,
  deleteLineItem,
  getLineItem,
  sendProposal,
  type CommercialProposalLineItem,
} from "@/lib/commercial/proposals/db";
import {
  TOMCO_DEFAULT_INTRO,
  proposalStatusLabel,
  proposalTotalLabel,
} from "@/lib/commercial/proposals/constants";
import { listProducts } from "@/lib/commercial/products/db";
import { productUnitLabel } from "@/lib/commercial/products/constants";
import { listExclusions } from "@/lib/commercial/exclusions/db";
import ExclusionPicker from "@/components/commercial/exclusion-picker";
import ProductPicker from "@/components/commercial/product-picker";
import { IconTrophy } from "@/components/commercial/inline-icons";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { EditableProductChip } from "@/components/commercial/editable-product-chip";
import { AutosaveProposalName } from "@/components/commercial/autosave-proposal-name";
import { AutosaveProposalForm } from "@/components/commercial/autosave-proposal-form";
import { FillProjectFromDeal } from "@/components/commercial/fill-project-from-deal";
import {
  INPUT_CLS,
  TEXTAREA_CLS,
  LABEL_CLS,
  SELECT_CLS,
  SELECT_BG_STYLE,
} from "@/lib/commercial/form-classnames";
import { UUID_RE } from "@/lib/commercial/uuid";

export const dynamic = "force-dynamic";

function centsToDollarInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
function dollarsInputToCents(s: string): number {
  const cleaned = s.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}
function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 2026-07-21 chrome rebuild (Karan): one consistent section shell —
 *  tinted header strip with an optional navy icon + title + subtitle and a
 *  right-aligned action slot, then a padded body. Replaces the ad-hoc
 *  `<section><h2>` cards so every block on the editor reads as one system. */
function EditorSection({
  title,
  subtitle,
  icon,
  right,
  children,
  className = "",
  id,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`bg-white border border-ppp-charcoal-200 rounded-xl overflow-hidden shadow-sm scroll-mt-24 ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/40">
        <div className="flex items-start gap-2.5 min-w-0">
          {icon && (
            <span
              aria-hidden
              className="mt-0.5 inline-flex items-center justify-center h-7 w-7 rounded-lg bg-ppp-navy-50 text-ppp-navy-600 shrink-0"
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[13px] font-bold text-ppp-charcoal leading-tight">{title}</h2>
            {subtitle && (
              <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5 leading-snug">{subtitle}</p>
            )}
          </div>
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

// ─────────────── server actions ───────────────

async function requireAuthed(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) redirect("/commercial");
  return user.id;
}

async function saveProposalAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }

  // Header — pull the editable subset. Merge with existing.
  const existing = await getProposal(proposalId);
  if (!existing || existing.opportunity_id !== dealId) notFound();

  const header = {
    ...existing.header_json,
    gc_company: String(formData.get("gc_company") ?? "").trim() || undefined,
    attention: String(formData.get("attention") ?? "").trim() || undefined,
    phone: String(formData.get("phone") ?? "").trim() || undefined,
    email: String(formData.get("email") ?? "").trim() || undefined,
    project_name: String(formData.get("project_name") ?? "").trim() || undefined,
    project_address:
      String(formData.get("project_address") ?? "").trim() || undefined,
    date_iso: String(formData.get("date_iso") ?? "").trim() || undefined,
    show_capital_improvement_notice:
      formData.get("show_cip_notice") === "on",
  };
  const gcAddrRaw = String(formData.get("gc_address_lines") ?? "").trim();
  header.gc_address_lines = gcAddrRaw
    ? gcAddrRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : undefined;

  const estimator = {
    ...existing.estimator_snapshot_json,
    name: String(formData.get("est_name") ?? "").trim() || undefined,
    title: String(formData.get("est_title") ?? "").trim() || undefined,
    phone: String(formData.get("est_phone") ?? "").trim() || undefined,
    email: String(formData.get("est_email") ?? "").trim() || undefined,
  };

  const introOverride = String(formData.get("intro_text_override") ?? "").trim();
  const altNotes = String(formData.get("alternate_notes") ?? "").trim();
  const bidNotes = String(formData.get("bid_notes") ?? "").trim();
  const pdfShowPrices = formData.get("pdf_show_line_prices") === "on";

  let exclusionIds: string[] = existing.exclusion_ids;
  const rawIds = String(formData.get("exclusion_ids") ?? "").trim();
  if (rawIds) {
    try {
      const parsed = JSON.parse(rawIds);
      if (Array.isArray(parsed)) {
        exclusionIds = parsed.filter(
          (s): s is string => typeof s === "string" && UUID_RE.test(s)
        );
      }
    } catch {
      // ignore malformed JSON; keep existing
    }
  }
  // Round-3 audit fix: drop any picked exclusion IDs that no longer
  // resolve to a live (non-soft-deleted) library row. If Katie
  // archived an exclusion between Alex loading the editor and Alex
  // saving, we don't want to persist the dead ID — it'd render as a
  // blank chip on refresh and silently vanish from the PDF.
  if (exclusionIds.length > 0) {
    const { listExclusions } = await import("@/lib/commercial/exclusions/db");
    const alive = await listExclusions({ activeOnly: false });
    const aliveIds = new Set(alive.map((r) => r.id));
    const dropped = exclusionIds.filter((id) => !aliveIds.has(id));
    exclusionIds = exclusionIds.filter((id) => aliveIds.has(id));
    if (dropped.length > 0) {
      console.warn(
        `[saveProposal] dropped ${dropped.length} dead exclusion id(s) from proposal ${proposalId}`
      );
    }
  }

  // F.5: per-proposal one-off exclusion text lines (NOT saved to
  // library). Parse alongside the UUID list.
  let customExclusions: string[] = existing.custom_exclusions ?? [];
  const rawCustom = String(formData.get("custom_exclusions") ?? "").trim();
  if (rawCustom) {
    try {
      const parsed = JSON.parse(rawCustom);
      if (Array.isArray(parsed)) {
        customExclusions = parsed
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= 500);
      }
    } catch {
      // keep existing on malformed JSON
    }
  }

  const result = await updateProposal({
    id: proposalId,
    header_json: header,
    estimator_snapshot_json: estimator,
    intro_text_override: introOverride || null,
    alternate_notes: altNotes || null,
    bid_notes: bidNotes || null,
    exclusion_ids: exclusionIds,
    custom_exclusions: customExclusions,
    pdf_show_line_prices: pdfShowPrices,
    updated_by_user_id: userId,
  });
  if (!result.ok) {
    // Karan 2026-07-20 (autosave fix): throw instead of redirect so the
    // AutosaveProposalForm wrapper's try/catch sets status="error" and
    // renders the "Save failed" pill in-place — no jarring navigation
    // that wipes the user's in-flight typing.
    throw new Error(result.error);
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/proposals");
  // NO redirect on success. Autosave fires this action every ~800ms;
  // a redirect would trigger a full navigation on every save, blowing
  // away input focus + cursor position mid-typing. revalidatePath is
  // enough — React reconciles the server-rendered snapshot without a
  // page load, and uncontrolled inputs (defaultValue) keep the user's
  // in-flight text.
}

/** Karan 2026-07-15: dedicated rename action — patches ONLY the
 *  project_name in header_json without touching any other field. The
 *  main saveProposalAction wipes fields missing from formData (fine
 *  when it's the full editor form, catastrophic when someone submits
 *  just the rename input at the top of the page). */
async function renameProposalAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  const existing = await getProposal(proposalId);
  if (!existing || existing.opportunity_id !== dealId) notFound();
  const nextName = String(formData.get("project_name") ?? "").trim() || undefined;
  const header = { ...existing.header_json, project_name: nextName };
  const result = await updateProposal({
    id: proposalId,
    header_json: header,
    estimator_snapshot_json: existing.estimator_snapshot_json,
    intro_text_override: existing.intro_text_override,
    exclusion_ids: existing.exclusion_ids,
    custom_exclusions: existing.custom_exclusions,
    alternate_notes: existing.alternate_notes,
    bid_notes: existing.bid_notes,
    pdf_show_line_prices: existing.pdf_show_line_prices,
    updated_by_user_id: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  // Karan 2026-07-16: name changes surface on THREE pages (editor +
  // account page Proposals tab + global proposals kanban). Revalidate
  // all three so the rename shows up wherever the user checks next.
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/proposals");
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?saved=1`
  );
}

async function addLineItemAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  const productIdRaw = String(formData.get("product_id") ?? "").trim();
  const product_id = productIdRaw && UUID_RE.test(productIdRaw) ? productIdRaw : null;
  // F.6: server-side reject if the picked product is a parent-header
  // (has children). Client picker blocks this but we guard here too so
  // a forged POST can't insert a $0 parent-only row.
  // 2026-07-21 audit (dead-end fix): use includeInactive:false to match
  // the client picker (which builds is_parent_only from ACTIVE products
  // only). A parent whose variations are ALL archived has nothing to pick,
  // so it's a normal sellable product — treating it as a browse header
  // here rejected a row the picker let the user select, an unrecoverable
  // dead-end ("pick a variation" with no active variation to pick).
  if (product_id) {
    const catalog = await listProducts({ includeInactive: false });
    const isParent = catalog.some((c) => c.parent_product_id === product_id);
    if (isParent) {
      redirect(
        `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent("That product is a browse header — pick one of its variations (e.g. Seal & Poly).")}`
      );
    }
  }
  const description = String(formData.get("description") ?? "").trim();
  // Migration 071: snapshotted product display name (from the picker),
  // distinct from the free-text description. Capped defensively.
  const productNameRaw = String(formData.get("product_name") ?? "").trim();
  const product_name = productNameRaw ? productNameRaw.slice(0, 200) : null;
  const quantity = Number(String(formData.get("quantity") ?? "1"));
  const unit = String(formData.get("unit") ?? "each").trim() || "each";
  const unit_price_cents = dollarsInputToCents(String(formData.get("unit_price") ?? "0"));
  const is_alternate = formData.get("is_alternate") === "on";
  const is_labor = formData.get("is_labor") === "on";
  const phaseRaw = String(formData.get("phase") ?? "").trim();
  const phase = phaseRaw || null;
  const result = await createLineItem(
    {
      proposal_id: proposalId,
      product_id,
      product_name,
      description,
      quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
      unit,
      unit_price_cents,
      is_alternate,
      phase,
      is_labor: is_labor && !is_alternate,
    },
    userId
  );
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}#line-items`
  );
}

async function updateLineItemAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (![accountId, dealId, proposalId, id].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  // IDOR guard: a forged `id` field must belong to *this* proposal.
  const owning = await getLineItem(id);
  if (!owning || owning.proposal_id !== proposalId) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent("That line item is not part of this proposal.")}`
    );
  }
  // Round-3 audit fix: optimistic lock. If Alex has this row open in
  // two tabs, edits + saves tab A, then saves tab B with stale form
  // state, tab B would silently overwrite A's change. The row form
  // now carries the original updated_at as a hidden input; if it
  // doesn't match the DB row's current updated_at, someone else
  // edited it between load and save → reject with a friendly
  // "refresh to see the latest" so no data is lost silently.
  const originalUpdatedAt = String(formData.get("original_updated_at") ?? "").trim();
  if (originalUpdatedAt && originalUpdatedAt !== owning.updated_at) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent("This line item was updated in another tab. Refresh to see the latest, then re-apply your change.")}#line-items`
    );
  }
  // F.6: phase is optional. Empty string → null → clears the phase.
  const phaseInput = formData.get("phase");
  const phase: string | null | undefined =
    phaseInput === null
      ? undefined
      : String(phaseInput).trim() || null;
  // Migration 071: product_name is a hidden field carrying the row's
  // current snapshot (preserved on save). Absent → undefined (don't touch).
  const pnInput = formData.get("product_name");
  const product_name: string | null | undefined =
    pnInput === null ? undefined : String(pnInput).trim().slice(0, 200) || null;
  const result = await updateLineItem(
    {
      id,
      description: String(formData.get("description") ?? ""),
      product_name,
      quantity: Number(String(formData.get("quantity") ?? "1")),
      unit: String(formData.get("unit") ?? "each"),
      unit_price_cents: dollarsInputToCents(String(formData.get("unit_price") ?? "0")),
      is_alternate: formData.get("is_alternate") === "on",
      phase,
    },
    userId
  );
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}#line-items`
  );
}

async function deleteLineItemAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (![accountId, dealId, proposalId, id].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  // Same IDOR guard as update.
  const owning = await getLineItem(id);
  if (!owning || owning.proposal_id !== proposalId) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent("That line item is not part of this proposal.")}`
    );
  }
  const result = await deleteLineItem(id, userId);
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}#line-items`
  );
}

async function sendProposalAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  const result = await sendProposal({
    proposal_id: proposalId,
    actor_user_id: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?sent=1`
  );
}

async function deleteProposalAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  const result = await softDeleteProposal(proposalId, userId);
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal?deleted=1`
  );
}

/** Karan 2026-07-15: Reopen a Won/Lost proposal (undo path). Same
 *  underlying helper the kanban Won→Sent drag uses; see
 *  lib/commercial/proposals/db.ts `reopenProposal` for the parent-
 *  deal cascade + guardrails. */
async function reopenProposalActionForm(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  const { reopenProposal } = await import("@/lib/commercial/proposals/db");
  const result = await reopenProposal({
    proposal_id: proposalId,
    actor_user_id: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  revalidatePath(`/commercial/accounts/${accountId}`);
  const flag = result.deal_reopened ? "reopened" : "reopened_solo";
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?outcome=${flag}`
  );
}

/** Karan 2026-07-15: Mark a Sent proposal Won or Lost. Delegates all
 *  side-effects (proposal.status flip + parent-deal flip) to the shared
 *  markProposalOutcome() helper so this button, the /commercial/
 *  proposals kanban drop, and any future outcome surfaces are always
 *  in sync. */
async function markProposalOutcomeAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  const outcome = String(formData.get("outcome") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) {
    redirect("/commercial");
  }
  if (outcome !== "won" && outcome !== "lost") {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent("Invalid outcome.")}`
    );
  }
  const { markProposalOutcome } = await import("@/lib/commercial/proposals/db");
  const result = await markProposalOutcome({
    proposal_id: proposalId,
    outcome: outcome as "won" | "lost",
    actor_user_id: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  revalidatePath(`/commercial/accounts/${accountId}`);
  // Karan 2026-07-15: stay on the proposal page for BOTH outcomes.
  // Prior version auto-redirected Lost drops to the account debrief,
  // which was jarring ("why am I on the account page now?"). Now the
  // banner on the proposal page carries a link to the debrief so the
  // user can go if they want to — no forced navigation.
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?outcome=${outcome}`
  );
}

// ─────────────── page render ───────────────

export default async function ProposalEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string; proposalId: string }>;
  searchParams: Promise<{ saved?: string; error?: string; created?: string; sent?: string; outcome?: "won" | "lost" | "reopened" | "reopened_solo" | string }>;
}) {
  const { id: accountId, dealId, proposalId } = await params;
  const sp = await searchParams;
  if (
    !UUID_RE.test(accountId) ||
    !UUID_RE.test(dealId) ||
    !UUID_RE.test(proposalId)
  ) {
    notFound();
  }
  await requireAuthed();

  const [account, opp, proposal] = await Promise.all([
    getCommercialAccount(accountId),
    getCommercialOpportunity(dealId),
    getProposal(proposalId),
  ]);
  if (!account) notFound();
  if (!opp || opp.account_id !== accountId) notFound();
  if (!proposal || proposal.opportunity_id !== dealId) notFound();

  const [lineItems, products, allExclusions, accountDeals] = await Promise.all([
    listLineItemsForProposal(proposalId),
    listProducts({ includeInactive: false }),
    listExclusions({ activeOnly: true }),
    // Karan 2026-07-20: fill-PROJECT-from-deal picker needs every deal
    // under this account so Alex can hot-swap the PROJECT block from
    // any sibling deal's structured data. Filter to non-deleted only.
    listCommercialOpportunities({ accountId }),
  ]);
  // Deals list for the fill-project-from-deal client picker. Skip the
  // current deal (nothing to fill from itself) + skip deals with no
  // usable name (label would be blank).
  const fillableDeals = accountDeals
    .filter((d) => d.id !== dealId)
    .map((d) => {
      const projectName = d.client_name?.trim() || d.title?.trim() || "";
      const addrParts = [
        d.property_street?.trim(),
        [d.property_city?.trim(), d.property_state?.trim()]
          .filter(Boolean)
          .join(", "),
      ].filter(Boolean);
      const projectAddress = addrParts.length > 0 ? addrParts.join(", ") : "";
      return {
        id: d.id,
        label: [projectName, projectAddress].filter(Boolean).join(" · "),
        projectName,
        projectAddress,
      };
    })
    .filter((d) => d.label.length > 0);
  // F.6: mark parent-only products (rows that have children) so the
  // picker can render them as browse-only headers + block picks.
  const parentIdsWithChildren = new Set(
    products
      .filter((p) => p.parent_product_id)
      .map((p) => p.parent_product_id!)
  );
  const selectedExclusions = allExclusions.filter((e) =>
    proposal.exclusion_ids.includes(e.id)
  );
  // Three buckets: inclusions (default), alternates (excluded from TOTAL),
  // labor (included in TOTAL, own PDF section). Migration 063 (2026-07-19,
  // Katie's ask): labor rows are inclusion-like (roll into TOTAL) but
  // render separately on the customer PDF so Alex can call out hourly work.
  const inclusions = lineItems.filter((i) => !i.is_alternate && !i.is_labor);
  const laborRows = lineItems.filter((i) => !i.is_alternate && i.is_labor);
  const alternates = lineItems.filter((i) => i.is_alternate);
  // 2026-07-21 audit: the PDF has a real body (and a non-zero TOTAL) when
  // there are inclusions OR labor rows — a labor-only bid is valid. Gate
  // Preview/Send on this, not on inclusions alone.
  const hasPdfBody = inclusions.length > 0 || laborRows.length > 0;
  const oppName = derivedOppName(opp, account.company_name);
  // F.5: TOTAL label ("Labor Only TOTAL" flip) considers BOTH library
  // exclusions and one-off custom lines so a "Materials" exclusion
  // typed as a one-off still flips the label.
  const totalLabel = proposalTotalLabel([
    ...selectedExclusions.map((e) => e.text),
    ...(proposal.custom_exclusions ?? []),
  ]);

  // Karan 2026-07-15: the per-deal proposal-list page is dead (killed
  // as a redirect stub); the Proposals tab on the account page is the
  // single home for every revision. Link back there directly.
  const listHref = `/commercial/accounts/${accountId}?tab=proposals`;

  // Hidden fields shared by every server action on this page.
  const hiddenIds = (
    <>
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="proposal_id" value={proposalId} />
    </>
  );

  const gcAddrText = (proposal.header_json.gc_address_lines ?? []).join("\n");

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      {/* Breadcrumb + status pill */}
      <nav className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        <Link href={listHref} className="hover:text-cc-brand-700 inline-flex items-center gap-1 min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
          <span>Back to {account.company_name} proposals</span>
        </Link>
        <span aria-hidden className="text-ppp-charcoal-300">·</span>
        <span className="text-ppp-charcoal-900 font-medium">{oppName}</span>
      </nav>

      {/* 2026-07-21: sticky toolbar (desktop only) so the identity, TOTAL,
          and Send/PDF actions stay reachable while scrolling the long form.
          NOT sticky on mobile — the buttons wrap into a tall block that
          would eat a 375px viewport if pinned. */}
      <header className="sm:sticky sm:top-2 z-20 bg-white/95 backdrop-blur-sm border border-ppp-charcoal-200 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap shadow-md shadow-ppp-charcoal-900/5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-[11px] font-bold text-ppp-charcoal-500 uppercase tracking-widest tabular-nums">
              R{proposal.revision_number}
            </span>
            {/* Katie 2026-07-20 (migration 069): PROP-#### chip = the
                global unique identifier for this proposal. Distinct
                from R# (per-deal revision) and from the parent deal's
                ALT-#### id. Renders as a subtle mono chip alongside
                the status pill. */}
            {proposal.proposal_seq != null && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold border border-cc-brand-200 bg-cc-brand-50 text-cc-brand-800"
                title="Unique proposal ID (copy for emails or reference)"
              >
                PROP-{String(proposal.proposal_seq).padStart(4, "0")}
              </span>
            )}
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-white text-ppp-charcoal-700 border-ppp-charcoal-200">
              {proposalStatusLabel(proposal.status)}
            </span>
            <span className="inline-flex items-baseline gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5">
              <span className="text-[9.5px] font-bold uppercase tracking-widest text-emerald-700">{totalLabel}</span>
              <span className="font-condensed text-[15px] font-black text-emerald-800 tabular-nums leading-none">{formatDollars(proposal.total_cents)}</span>
            </span>
          </div>
          {/* Karan 2026-07-16: autosaves as you type — no Save button.
              Fires ~600ms after the user stops typing OR immediately on
              blur/Enter. Falls through to the same renameProposalAction
              server flow. Karan's own words: "make it autosave if i
              want to change the name of the proposals". */}
          <form
            action={renameProposalAction}
            className="flex items-center gap-2"
          >
            {hiddenIds}
            <AutosaveProposalName
              initialValue={proposal.header_json.project_name ?? ""}
              placeholder={`Name this revision (e.g. "Warehouse Repaint")`}
              inputClassName="text-lg font-bold text-ppp-charcoal bg-transparent border-b border-dashed border-ppp-charcoal-200 focus:border-cc-brand-400 focus:outline-none py-0.5 min-w-0 flex-1 placeholder:text-ppp-charcoal-300 placeholder:italic placeholder:font-normal"
              disabled={proposal.status !== "draft"}
            />
          </form>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!hasPdfBody ? (
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-400 text-[13px] font-semibold min-h-[36px]"
              title="Add an inclusion or a labor row below to generate the proposal PDF."
              aria-disabled
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              PDF — add an inclusion or labor row first
            </span>
          ) : (
            <>
              <a
                href={`/api/commercial/proposals/${proposalId}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[36px]"
                title="Customer proposal — what the GC sees. No internal bid notes or per-line prices."
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                Customer PDF
              </a>
              {proposal.status === "draft" && (
                <a
                  href={`/api/commercial/proposals/${proposalId}/pdf?mode=internal`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-navy-200 bg-ppp-navy-50 text-ppp-navy-700 text-[12px] font-semibold hover:bg-ppp-navy-100 min-h-[36px]"
                  title="Internal Plan Report — the same proposal PLUS the internal bid notes + per-line prices, for estimator review (Kim's plan read). Never shown to the GC."
                >
                  Plan report
                </a>
              )}
            </>
          )}
          {/* Karan 2026-07-15: "Bump revision" was dev jargon nobody
              understood. It clones this proposal's data into a fresh
              R{n+1} draft — for when the customer wants a revised
              quote after seeing R{n}. Now labeled with what it does. */}
          <Link
            href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/new?bump=${proposalId}`}
            className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[36px]"
            title={`Start R${proposal.revision_number + 1} as a fresh draft, copying all this revision's fields as a starting point. Use when the customer wants a revised quote.`}
          >
            + New revision (R{proposal.revision_number + 1})
          </Link>
          {proposal.status === "draft" && hasPdfBody && (
            <form action={sendProposalAction} className="inline-flex">
              {hiddenIds}
              <ConfirmSubmitButton
                message={`Send R${proposal.revision_number} to ${proposal.header_json.gc_company ?? "the GC"}? This saves the sent PDF into Files as an official copy (prior drafts remain), flips the opportunity to Proposal · Sent, and notifies the team. You can still start R${proposal.revision_number + 1} after.`}
                pendingLabel="Sending…"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 shadow-sm min-h-[40px] disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                Send proposal
              </ConfirmSubmitButton>
            </form>
          )}
          {/* Karan 2026-07-15: Reopen button on Won/Lost proposals.
              Undo path for accidental closes. Reverses both the
              proposal AND the parent deal (if the deal hasn't moved
              beyond pre_sale_closed — see reopenProposal guardrail). */}
          {(proposal.status === "won" || proposal.status === "lost") && (
            <form action={reopenProposalActionForm} className="inline-flex">
              {hiddenIds}
              <ConfirmSubmitButton
                message={`Reopen R${proposal.revision_number}? Flips this proposal back to Sent AND (if the parent opportunity is still at Pre-Sale Closed) flips the opportunity back to Proposal · Sent. Use this if you marked ${proposal.status.toUpperCase()} by mistake.`}
                pendingLabel="Reopening…"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cc-brand-300 bg-white text-cc-brand-700 text-[13px] font-semibold hover:bg-cc-brand-50 min-h-[36px]"
              >
                ↺ Reopen
              </ConfirmSubmitButton>
            </form>
          )}
          {/* Karan 2026-07-15: Won / Lost outcome buttons on Sent
              proposals. Flips both the proposal AND the parent deal so
              Alex doesn't have to touch two surfaces to close out a
              bid. Lost routes into the account debrief flow to capture
              the reason. */}
          {proposal.status === "sent" && (
            <>
              <form action={markProposalOutcomeAction} className="inline-flex">
                {hiddenIds}
                <input type="hidden" name="outcome" value="won" />
                <ConfirmSubmitButton
                  message={`Mark R${proposal.revision_number} WON? This also flips the opportunity to Pre-Sale Closed · Won. You'll be able to start the project next.`}
                  pendingLabel="Marking won…"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 shadow-sm min-h-[40px] disabled:opacity-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Mark won
                </ConfirmSubmitButton>
              </form>
              <form action={markProposalOutcomeAction} className="inline-flex">
                {hiddenIds}
                <input type="hidden" name="outcome" value="lost" />
                <ConfirmSubmitButton
                  message={`Mark R${proposal.revision_number} LOST? You'll be routed to the debrief page to capture the reason (competitor won / price / no response / etc.). This also flips the opportunity to Pre-Sale Closed · Lost.`}
                  pendingLabel="Marking lost…"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 bg-white text-rose-700 text-[13px] font-semibold hover:bg-rose-50 min-h-[40px] disabled:opacity-50"
                >
                  Mark lost
                </ConfirmSubmitButton>
              </form>
            </>
          )}
        </div>
      </header>

      {sp.saved === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-sm text-emerald-800">Saved.</div>
      )}
      {sp.created === "1" && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-2.5 text-sm text-cc-brand-800">
          Proposal created. Header prefilled from the opportunity — start with inclusions below.
        </div>
      )}
      {sp.sent === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900">
          <strong>Proposal sent.</strong> PDF snapshot saved to Files, opportunity flipped to <em>Proposal · Sent</em>, and the team was notified.
        </div>
      )}
      {sp.outcome === "won" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900 flex items-start gap-2">
          <IconTrophy size={16} className="text-ppp-green-600 shrink-0 mt-0.5" />
          <span><strong>Marked won.</strong> Opportunity flipped to <em>Pre-Sale Closed · Won</em>. Start the project when the client&rsquo;s ready.</span>
        </div>
      )}
      {sp.outcome === "lost" && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-900 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <strong>Marked lost.</strong> Opportunity flipped to <em>Pre-Sale Closed · Lost</em>. Please add the loss reason so the Win/Loss report is accurate.
          </div>
          <Link
            href={`/commercial/accounts/${accountId}/debrief/${dealId}?just_closed=1`}
            className="shrink-0 inline-flex items-center px-3 py-1.5 rounded-lg bg-rose-600 text-white text-[12px] font-semibold hover:bg-rose-700"
          >
            Add loss reason →
          </Link>
        </div>
      )}
      {sp.outcome === "reopened" && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-3 text-sm text-cc-brand-900">
          <strong>Reopened.</strong> Proposal is back to Sent and the parent opportunity is back to <em>Proposal · Sent</em>.
        </div>
      )}
      {sp.outcome === "reopened_solo" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          <strong>Reopened proposal only.</strong> The parent opportunity already moved forward (past Pre-Sale Closed) so it was left as-is. Move it back manually on the pipeline kanban if you meant to reopen the whole opportunity.
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5 text-sm text-rose-800" role="alert">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {/* Sent/Won/Lost proposals are frozen — the GC already has a
          PDF copy, editing would break the audit trail + updateProposal
          rejects the write anyway. Show a clear amber banner instead
          of an autosaving form that would flash "Save failed" every
          800ms. Alex needs to bump a new revision to make changes. */}
      {proposal.status !== "draft" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[13px] text-amber-900" role="status">
          <div className="font-semibold mb-0.5">
            This proposal is {proposalStatusLabel(proposal.status).toLowerCase()} — read-only.
          </div>
          <div className="text-[12.5px] text-amber-800">
            The GC already has this copy on file. To make changes, use the &ldquo;+ New revision&rdquo; button at the top to start a fresh draft.
          </div>
        </div>
      )}

      {/* MAIN AUTOSAVE FORM — wraps every editable section EXCEPT line
          items. Karan 2026-07-20: no manual Save button, every field
          change debounces (800ms) → server action fires. Only wired on
          draft proposals — sent/won/lost render read-only above. */}
      <AutosaveProposalForm action={saveProposalAction} disabled={proposal.status !== "draft"}>
        {hiddenIds}

        {/* Header block. Karan 2026-07-20: the GC is the Account holder
            (who we send TO), the Project is the specific job at their
            customer's site. Two tinted sub-panels so Alex knows exactly
            which fields go where. 2026-07-21: unified under EditorSection. */}
        <EditorSection
          title="Header"
          subtitle="Prints at the top of the proposal PDF — who it's addressed to + the job."
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
            </svg>
          }
        >
          <div className="space-y-3">
            {/* GC sub-panel */}
            <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 p-3.5 space-y-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700">
                  Send to — GC (account holder)
                </div>
                <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                  The company Tomco has a relationship with. Prints under &ldquo;PROPOSAL SUBMITTED TO:&rdquo;.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className={LABEL_CLS}>GC name</span>
                  <input type="text" name="gc_company" defaultValue={proposal.header_json.gc_company ?? ""} className={INPUT_CLS} placeholder="e.g. Alta Construction East Inc." />
                </label>
                <label className="block">
                  <span className={LABEL_CLS}>Proposal date</span>
                  <input type="date" name="date_iso" defaultValue={proposal.header_json.date_iso ?? ""} className={INPUT_CLS} />
                </label>
                <label className="block sm:col-span-2">
                  <span className={LABEL_CLS}>GC address (one line per row)</span>
                  <textarea name="gc_address_lines" defaultValue={gcAddrText} rows={2} className={TEXTAREA_CLS} placeholder="143 West 29th Street, Fl 12&#10;New York, NY 10001" />
                </label>
                <label className="block">
                  <span className={LABEL_CLS}>Attention</span>
                  <input type="text" name="attention" defaultValue={proposal.header_json.attention ?? ""} className={INPUT_CLS} placeholder="e.g. Bryon" />
                </label>
                <label className="block">
                  <span className={LABEL_CLS}>Phone</span>
                  <input type="text" name="phone" defaultValue={proposal.header_json.phone ?? ""} className={INPUT_CLS} placeholder="e.g. 212-912-0011" />
                </label>
                <label className="block sm:col-span-2">
                  <span className={LABEL_CLS}>Email</span>
                  <input type="email" name="email" defaultValue={proposal.header_json.email ?? ""} className={INPUT_CLS} placeholder="e.g. bryon@altaconstruction-inc.net" />
                </label>
              </div>
            </div>

            {/* Project sub-panel */}
            <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 p-3.5 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700">
                    Project — the opportunity / job site
                  </div>
                  <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                    The specific customer + site this covers. Prints as &ldquo;PROJECT: {"{"}Name{"}"}, {"{"}Address{"}"}&rdquo;.
                  </p>
                </div>
                {fillableDeals.length > 0 && (
                  <FillProjectFromDeal
                    deals={fillableDeals}
                    projectNameInputId="header-project-name"
                    projectAddressInputId="header-project-address"
                  />
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className={LABEL_CLS}>Project name</span>
                  <input id="header-project-name" type="text" name="project_name" defaultValue={proposal.header_json.project_name ?? ""} className={INPUT_CLS} placeholder="e.g. JD Sports" />
                </label>
                <label className="block">
                  <span className={LABEL_CLS}>Project address</span>
                  <input id="header-project-address" type="text" name="project_address" defaultValue={proposal.header_json.project_address ?? ""} className={INPUT_CLS} placeholder="e.g. 37-38 Junction Blvd, Queens" />
                </label>
              </div>
            </div>

            {/* Capital-improvement banner toggle */}
            <label className="flex items-center gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 px-3.5 py-2.5 cursor-pointer">
              <input type="checkbox" name="show_cip_notice" defaultChecked={proposal.header_json.show_capital_improvement_notice ?? false} className="w-4 h-4 accent-amber-600" />
              <span className="text-[12.5px] text-ppp-charcoal-700">Show yellow &ldquo;Capital Improvement / NY Sales Tax&rdquo; banner on the PDF</span>
            </label>
          </div>
        </EditorSection>

        {/* Intro override */}
        <EditorSection
          title="Intro paragraph"
          subtitle={<>Blank = the Tomco default: <em>&ldquo;{TOMCO_DEFAULT_INTRO}&rdquo;</em></>}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2 M9 20h6 M12 4v16" />
            </svg>
          }
        >
          <textarea name="intro_text_override" defaultValue={proposal.intro_text_override ?? ""} rows={3} className={TEXTAREA_CLS} placeholder="Leave blank to use the Tomco default." />
        </EditorSection>

        {/* Exclusions */}
        <EditorSection
          title="Exclusions"
          subtitle="What the proposal explicitly does NOT cover — bulleted on the PDF."
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          }
        >
          <ExclusionPicker
            label="Add"
            initialSelected={selectedExclusions.map((e) => ({
              id: e.id,
              text: e.text,
              category: e.category,
              use_count: e.use_count,
            }))}
            initialCustom={proposal.custom_exclusions ?? []}
          />
        </EditorSection>

        {/* Alternate notes */}
        <EditorSection
          title="Alternate description"
          subtitle="Optional summary paragraph above the alternate line items."
        >
          <textarea name="alternate_notes" defaultValue={proposal.alternate_notes ?? ""} rows={2} className={TEXTAREA_CLS} placeholder="e.g. Exterior: Power wash exterior of building." />
        </EditorSection>

        {/* Bid notes — INTERNAL ONLY. Rendered on the ?mode=internal
            PDF for Alex/Katie's estimator review; never on the customer
            PDF. Karan 2026-07-15: prior label said "hidden on PDF
            unless populated" which was misleading — the customer PDF
            renderer never rendered this field at all. Now honest. */}
        <EditorSection
          title={<>Bid notes <span className="ml-1 text-[10px] font-semibold uppercase tracking-widest text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">Internal only</span></>}
          subtitle="Estimator scratch-pad — only on the internal-mode PDF, never on the customer copy."
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
            </svg>
          }
        >
          <textarea name="bid_notes" defaultValue={proposal.bid_notes ?? ""} rows={3} className={TEXTAREA_CLS} placeholder="e.g. Called Michael on Tuesday to confirm scope. Assumes existing HM doors are still on-site." />
        </EditorSection>

        {/* Estimator sign-off */}
        <EditorSection
          title="Estimator sign-off"
          subtitle="Prints in the sign-off block at the bottom of the PDF."
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          }
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL_CLS}>Name</span>
              <input type="text" name="est_name" defaultValue={proposal.estimator_snapshot_json.name ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Title</span>
              <input type="text" name="est_title" defaultValue={proposal.estimator_snapshot_json.title ?? ""} className={INPUT_CLS} placeholder="e.g. Lead Estimator, Tomco Painting" />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Phone</span>
              <input type="text" name="est_phone" defaultValue={proposal.estimator_snapshot_json.phone ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Email</span>
              <input type="email" name="est_email" defaultValue={proposal.estimator_snapshot_json.email ?? ""} className={INPUT_CLS} />
            </label>
          </div>
        </EditorSection>

        {/* PDF options */}
        <EditorSection
          title="PDF options"
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          }
        >
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" name="pdf_show_line_prices" defaultChecked={proposal.pdf_show_line_prices} className="w-4 h-4 accent-cc-brand-600" />
            <span className="text-[12.5px] text-ppp-charcoal-700">
              Show per-line prices on the customer PDF (Tomco default hides them — customer sees only the TOTAL)
            </span>
          </label>
        </EditorSection>

        {/* Karan 2026-07-20: killed the manual "Save proposal" button.
            AutosaveProposalForm debounces every field change (800ms) →
            fires saveProposalAction and shows a "Saving… / Saved" pill
            top-right. Line items still save independently below. */}
        <p className="text-[12px] text-ppp-charcoal-500 text-center">
          Changes save automatically. Line items save independently below.
        </p>
      </AutosaveProposalForm>

      {/* Line items — separate forms outside the main save form so each
          row is its own action. 2026-07-21: unified under EditorSection. */}
      <EditorSection
        id="line-items"
        title="Inclusions"
        subtitle="The scope of work. Prints as the proposal's main body."
        icon={
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        }
        right={
          <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
            {inclusions.length} line{inclusions.length === 1 ? "" : "s"} · <strong className="text-ppp-charcoal-800">{formatDollars(proposal.total_cents)}</strong>
          </span>
        }
      >
        <div className="space-y-4">
          {inclusions.length === 0 ? (
            <p className="text-[13px] text-ppp-charcoal-500 italic">No inclusions yet — add the first one below.</p>
          ) : (
            <LineItemsTable
              rows={inclusions}
              accountId={accountId}
              dealId={dealId}
              proposalId={proposalId}
              updateAction={updateLineItemAction}
              deleteAction={deleteLineItemAction}
            />
          )}
          <AddLineItemForm
            accountId={accountId}
            dealId={dealId}
            proposalId={proposalId}
            products={products.map((p) => ({
              ...p,
              is_parent_only: parentIdsWithChildren.has(p.id),
            }))}
            submitAction={addLineItemAction}
            isAlternate={false}
          />
        </div>
      </EditorSection>

      {/* Labor — migration 063 (2026-07-19, Katie). Included in TOTAL
          (same as inclusions) but renders under its own "Labor:" PDF
          section. Row shape: qty=hours, unit="hour", price=hourly rate. */}
      <EditorSection
        title="Labor"
        subtitle="Rolls into the TOTAL · renders as its own “Labor:” PDF section."
        icon={
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        }
        right={
          laborRows.length > 0 ? (
            <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
              {laborRows.reduce((a, r) => a + Number(r.quantity), 0)} hrs · <strong className="text-ppp-charcoal-800">{formatDollars(laborRows.reduce((a, r) => a + Math.round(Number(r.quantity) * r.unit_price_cents), 0))}</strong>
            </span>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {laborRows.length === 0 ? (
            <p className="text-[13px] text-ppp-charcoal-500 italic">No labor rows — add hours + rate below if you're billing labor separately.</p>
          ) : (
            <LineItemsTable
              rows={laborRows}
              accountId={accountId}
              dealId={dealId}
              proposalId={proposalId}
              updateAction={updateLineItemAction}
              deleteAction={deleteLineItemAction}
            />
          )}
          <AddLineItemForm
            accountId={accountId}
            dealId={dealId}
            proposalId={proposalId}
            products={products.map((p) => ({
              ...p,
              is_parent_only: parentIdsWithChildren.has(p.id),
            }))}
            submitAction={addLineItemAction}
            isAlternate={false}
            isLabor={true}
          />
        </div>
      </EditorSection>

      {/* Alternates */}
      <EditorSection
        title="Alternates"
        subtitle="Optional add-ons — shown separately and NOT counted in the TOTAL."
        icon={
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        }
      >
        <div className="space-y-4">
          {alternates.length === 0 ? (
            <p className="text-[13px] text-ppp-charcoal-500 italic">No alternates.</p>
          ) : (
            <LineItemsTable
              rows={alternates}
              accountId={accountId}
              dealId={dealId}
              proposalId={proposalId}
              updateAction={updateLineItemAction}
              deleteAction={deleteLineItemAction}
            />
          )}
          <AddLineItemForm
            accountId={accountId}
            dealId={dealId}
            proposalId={proposalId}
            products={products.map((p) => ({
              ...p,
              is_parent_only: parentIdsWithChildren.has(p.id),
            }))}
            submitAction={addLineItemAction}
            isAlternate={true}
          />
        </div>
      </EditorSection>

      {/* Danger zone */}
      <form action={deleteProposalAction} className="flex justify-center pt-2">
        {hiddenIds}
        <ConfirmSubmitButton
          message={`Delete this proposal draft (R${proposal.revision_number})? Line items and overrides will be lost.`}
          className="text-[12px] text-ppp-charcoal-400 hover:text-rose-700 inline-flex items-center gap-1.5 min-h-[44px] touch-manipulation disabled:opacity-50"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
          Delete this proposal draft
        </ConfirmSubmitButton>
      </form>
    </div>
  );
}

// ─────────────── sub-components ───────────────

function LineItemsTable({
  rows,
  accountId,
  dealId,
  proposalId,
  updateAction,
  deleteAction,
}: {
  rows: CommercialProposalLineItem[];
  accountId: string;
  dealId: string;
  proposalId: string;
  updateAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  // 2026-07-21 rebuild (Karan): rows are cards, not a cramped 12-col grid.
  // Product name shown as a distinct navy chip (snapshotted, preserved on
  // save via a hidden field); Description is its own labelled area; the
  // Phase/Qty/Unit/Price sit in a tidy row (2-up on mobile, 4-up on sm+).
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.id}>
          <form
            action={updateAction}
            className="rounded-xl border border-ppp-charcoal-200 bg-white p-4 space-y-3 shadow-sm"
          >
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="deal_id" value={dealId} />
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="is_alternate" value={r.is_alternate ? "on" : ""} />
            {/* Migration 071: preserve the snapshotted product name on save;
                the EditableProductChip below can blank this to convert the
                row to free-text (fixes the mis-picked-variation dead-end). */}
            <input type="hidden" id={`pn-${r.id}`} name="product_name" defaultValue={r.product_name ?? ""} />
            {/* Round-3 audit fix: optimistic-lock stamp so a stale two-tab
                save is rejected before it overwrites a concurrent edit. */}
            <input type="hidden" name="original_updated_at" value={r.updated_at} />

            {/* Product chip + Clear (only when this row came from the catalog). */}
            {r.product_name && (
              <EditableProductChip name={r.product_name} inputId={`pn-${r.id}`} />
            )}

            <label className="block">
              <span className={LABEL_CLS}>Description</span>
              <textarea
                name="description"
                defaultValue={r.description}
                className={`${TEXTAREA_CLS} min-h-[72px]`}
                rows={3}
                placeholder={r.product_name ? "Optional scope detail — prints under the product name." : "e.g. Prep, prime, and paint 2 coats. New lines carry to the PDF as sub-points."}
              />
            </label>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block" title="Groups this item under a section header on the PDF. Leave blank for ungrouped.">
                <span className={LABEL_CLS}>Phase</span>
                <input type="text" name="phase" defaultValue={r.phase ?? ""} maxLength={60} placeholder="—" className={INPUT_CLS} />
              </label>
              <label className="block">
                <span className={LABEL_CLS}>Qty</span>
                <input type="text" inputMode="decimal" name="quantity" defaultValue={String(r.quantity)} className={`${INPUT_CLS} tabular-nums`} />
              </label>
              <label className="block">
                <span className={LABEL_CLS}>Unit</span>
                <input type="text" name="unit" defaultValue={productUnitLabel(r.unit)} className={INPUT_CLS} />
              </label>
              <label className="block">
                <span className={LABEL_CLS}>Unit price</span>
                <input type="text" inputMode="decimal" name="unit_price" defaultValue={centsToDollarInput(r.unit_price_cents)} className={`${INPUT_CLS} tabular-nums`} />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-ppp-charcoal-100">
              <span className="text-[12.5px] text-ppp-charcoal-600 tabular-nums pt-2">
                Row total{" "}
                <span className="font-bold text-ppp-charcoal">
                  {formatDollars(Math.round(Number(r.quantity) * r.unit_price_cents))}
                </span>
              </span>
              <div className="flex items-center gap-3 pt-2">
                <ConfirmSubmitButton
                  formAction={deleteAction}
                  message="Remove this line item? This can't be undone."
                  className="text-[12px] text-rose-700 hover:text-rose-800 min-h-[44px] inline-flex items-center touch-manipulation disabled:opacity-50"
                >
                  Remove
                </ConfirmSubmitButton>
                <button type="submit" className="inline-flex items-center px-4 min-h-[44px] rounded-lg bg-ppp-charcoal-800 text-white text-[13px] font-semibold hover:bg-ppp-charcoal-900 touch-manipulation">
                  Save row
                </button>
              </div>
            </div>
          </form>
        </li>
      ))}
    </ul>
  );
}

function AddLineItemForm({
  accountId,
  dealId,
  proposalId,
  products,
  submitAction,
  isAlternate,
  isLabor = false,
}: {
  accountId: string;
  dealId: string;
  proposalId: string;
  products: Array<{
    id: string;
    sku: string;
    name: string;
    category: string;
    unit: string;
    default_unit_price_cents: number;
    // F.6
    variation_label?: string | null;
    description?: string | null;
    is_parent_only?: boolean;
    parent_product_id?: string | null;
  }>;
  submitAction: (formData: FormData) => Promise<void>;
  isAlternate: boolean;
  isLabor?: boolean;
}) {
  const prefix = isLabor ? "labor" : isAlternate ? "alt" : "inc";
  const addLabel = isLabor ? "labor row" : isAlternate ? "alternate" : "inclusion";
  // 2026-07-21 rebuild (Karan): the add-row is a clean bordered card with
  // the product picker up top (prominent, full width), then a distinct
  // Description area, then a tidy numeric row.
  return (
    <form
      action={submitAction}
      className="rounded-xl border border-dashed border-cc-brand-300 bg-cc-brand-50/30 p-4 space-y-3"
    >
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="proposal_id" value={proposalId} />
      {isAlternate && <input type="hidden" name="is_alternate" value="on" />}
      {isLabor && <input type="hidden" name="is_labor" value="on" />}
      <input type="hidden" id={`${prefix}-pid`} name="product_id" defaultValue="" />
      <input type="hidden" id={`${prefix}-pname`} name="product_name" defaultValue="" />

      <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700">
        Add {addLabel}
      </div>

      {/* Product picker (catalog) — fills product name + description +
          unit + price. Not shown for labor (hourly free-text). */}
      {!isLabor && products.length > 0 && (
        <ProductPicker
          products={products.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            category: p.category,
            unit: p.unit,
            default_unit_price_cents: p.default_unit_price_cents,
            variation_label: p.variation_label ?? null,
            description: p.description ?? null,
            is_parent_only: p.is_parent_only ?? false,
            parent_product_id: p.parent_product_id ?? null,
          }))}
          accountId={accountId}
          descriptionInputId={`${prefix}-desc`}
          unitInputId={`${prefix}-unit`}
          unitPriceInputId={`${prefix}-price`}
          productIdInputId={`${prefix}-pid`}
          productNameInputId={`${prefix}-pname`}
        />
      )}

      <label className="block">
        <span className={LABEL_CLS}>Description</span>
        <textarea
          id={`${prefix}-desc`}
          name="description"
          rows={3}
          placeholder={isLabor ? "e.g. Skilled painters — prep + prime + 2 coats" : "Optional if a product is picked. New lines carry to the PDF as sub-points."}
          className={`${TEXTAREA_CLS} min-h-[72px]`}
        />
      </label>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* F.6: phase groups items under section headers on the PDF. */}
        <label className="block" title="Groups this item under a section header on the PDF, e.g. 'Phase 1'. Leave blank for ungrouped.">
          <span className={LABEL_CLS}>Phase</span>
          <input type="text" name="phase" maxLength={60} placeholder="e.g. Phase 1" className={INPUT_CLS} />
        </label>
        <label className="block">
          <span className={LABEL_CLS}>{isLabor ? "Hours" : "Qty"}</span>
          <input type="text" inputMode="decimal" name="quantity" defaultValue={isLabor ? "8" : "1"} className={`${INPUT_CLS} tabular-nums`} />
        </label>
        <label className="block">
          <span className={LABEL_CLS}>Unit</span>
          <input type="text" id={`${prefix}-unit`} name="unit" defaultValue={isLabor ? "hour" : "each"} className={INPUT_CLS} />
        </label>
        <label className="block">
          <span className={LABEL_CLS}>{isLabor ? "$ / hour" : "Unit price"}</span>
          <input type="text" id={`${prefix}-price`} inputMode="decimal" name="unit_price" defaultValue="0.00" className={`${INPUT_CLS} tabular-nums`} />
        </label>
      </div>

      <div className="flex justify-end">
        <button type="submit" className="inline-flex items-center gap-1.5 px-4 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 touch-manipulation">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          Add {addLabel}
        </button>
      </div>
    </form>
  );
}
