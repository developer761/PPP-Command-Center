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
  const result = await updateLineItem(
    {
      id,
      description: String(formData.get("description") ?? ""),
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

      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
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
            <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
              {totalLabel}: <strong className="text-ppp-charcoal-800">{formatDollars(proposal.total_cents)}</strong>
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
          {inclusions.length === 0 ? (
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-400 text-[13px] font-semibold min-h-[36px]"
              title="Add at least one line item below to generate the proposal PDF."
              aria-disabled
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              PDF — add a line item first
            </span>
          ) : (
            <>
              <a
                href={`/api/commercial/proposals/${proposalId}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[36px]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                Preview PDF
              </a>
              {proposal.status === "draft" && (
                <a
                  href={`/api/commercial/proposals/${proposalId}/pdf?mode=internal`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[36px]"
                  title="Internal view — shows line-item prices so you can sanity-check the estimator math"
                >
                  Internal view
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
          {proposal.status === "draft" && inclusions.length > 0 && (
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

        {/* Header block. Karan 2026-07-20: relabeled to reflect the
            real model — the GC is the Account holder (the company we
            send the proposal TO), the Project is the specific deal /
            job at THEIR customer's site. Two separate blocks visually
            so Alex knows exactly which fields go where. */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-5">
          <h2 className="text-sm font-bold text-ppp-charcoal">Header</h2>

          <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-cc-brand-800">
              Send To — GC (Account holder)
            </div>
            <p className="text-[11.5px] text-ppp-charcoal-500 -mt-1">
              The company Tomco has a relationship with. This block prints under &ldquo;PROPOSAL SUBMITTED TO:&rdquo; on the PDF.
            </p>
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

          <div className="space-y-3 pt-3 border-t border-ppp-charcoal-100">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-widest text-cc-brand-800">
                  Project — the opportunity / job site
                </div>
                <p className="text-[11.5px] text-ppp-charcoal-500 mt-1">
                  The specific customer + site this proposal covers. Prints as &ldquo;PROJECT: {"{"}Name{"}"}, {"{"}Address{"}"}&rdquo; on the PDF.
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

          <label className="inline-flex items-center gap-2 pt-2 border-t border-ppp-charcoal-100 w-full">
            <input type="checkbox" name="show_cip_notice" defaultChecked={proposal.header_json.show_capital_improvement_notice ?? false} className="w-4 h-4 accent-cc-brand-600" />
            <span className="text-[13px] text-ppp-charcoal-700">Show yellow &ldquo;Capital Improvement / NY Sales Tax&rdquo; banner on PDF</span>
          </label>
        </section>

        {/* Intro override */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-2">
          <h2 className="text-sm font-bold text-ppp-charcoal">Intro paragraph</h2>
          <p className="text-[12px] text-ppp-charcoal-500">Blank = use the Tomco default: <em>"{TOMCO_DEFAULT_INTRO}"</em></p>
          <textarea name="intro_text_override" defaultValue={proposal.intro_text_override ?? ""} rows={3} className={TEXTAREA_CLS} placeholder="Leave blank to use the Tomco default." />
        </section>

        {/* Exclusions */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <ExclusionPicker
            label="Exclusions"
            initialSelected={selectedExclusions.map((e) => ({
              id: e.id,
              text: e.text,
              category: e.category,
              use_count: e.use_count,
            }))}
            initialCustom={proposal.custom_exclusions ?? []}
          />
        </section>

        {/* Alternate notes */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-2">
          <h2 className="text-sm font-bold text-ppp-charcoal">Alternate description</h2>
          <p className="text-[12px] text-ppp-charcoal-500">Optional summary paragraph above the alternate line items.</p>
          <textarea name="alternate_notes" defaultValue={proposal.alternate_notes ?? ""} rows={2} className={TEXTAREA_CLS} placeholder="e.g. Exterior: Power wash exterior of building." />
        </section>

        {/* Bid notes — INTERNAL ONLY. Rendered on the ?mode=internal
            PDF for Alex/Katie's estimator review; never on the customer
            PDF. Karan 2026-07-15: prior label said "hidden on PDF
            unless populated" which was misleading — the customer PDF
            renderer never rendered this field at all. Now honest. */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-2">
          <h2 className="text-sm font-bold text-ppp-charcoal">Bid notes <span className="ml-1 text-[11px] font-semibold uppercase tracking-widest text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">Internal only</span></h2>
          <p className="text-[12px] text-ppp-charcoal-500">Estimator scratch-pad. Visible only on the internal-mode PDF review — never on the customer copy.</p>
          <textarea name="bid_notes" defaultValue={proposal.bid_notes ?? ""} rows={3} className={TEXTAREA_CLS} placeholder="e.g. Called Michael on Tuesday to confirm scope. Assumes existing HM doors are still on-site." />
        </section>

        {/* Estimator sign-off */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-bold text-ppp-charcoal">Estimator sign-off</h2>
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
        </section>

        {/* PDF options */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" name="pdf_show_line_prices" defaultChecked={proposal.pdf_show_line_prices} className="w-4 h-4 accent-cc-brand-600" />
            <span className="text-[13px] text-ppp-charcoal-700">
              Show per-line prices on customer PDF (Tomco default hides them — customer sees only the TOTAL)
            </span>
          </label>
        </section>

        {/* Karan 2026-07-20: killed the manual "Save proposal" button.
            AutosaveProposalForm debounces every field change (800ms) →
            fires saveProposalAction and shows a "Saving… / Saved" pill
            top-right. Line items still save independently below. */}
        <p className="text-[12px] text-ppp-charcoal-500 text-center">
          Changes save automatically. Line items save independently below.
        </p>
      </AutosaveProposalForm>

      {/* Line items — separate form outside the main save form so
          each row is its own action. */}
      <section id="line-items" className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-bold text-ppp-charcoal">Inclusions</h2>
          <span className="text-[12px] text-ppp-charcoal-500">
            {inclusions.length} line{inclusions.length === 1 ? "" : "s"} · {totalLabel} {formatDollars(proposal.total_cents)}
          </span>
        </div>

        {inclusions.length === 0 ? (
          <p className="text-[13px] text-ppp-charcoal-500 italic py-2">No inclusions yet — add the first one below.</p>
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
      </section>

      {/* Labor — migration 063 (2026-07-19, Katie). Included in TOTAL
          (same as inclusions) but renders under its own "Labor:" PDF
          section. Row shape: qty=hours, unit="hour", price=hourly rate. */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-bold text-ppp-charcoal">
            Labor <span className="font-normal text-ppp-charcoal-500 text-[12px]">(rolls into TOTAL · renders as its own PDF section)</span>
          </h2>
          {laborRows.length > 0 && (
            <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
              {laborRows.reduce((a, r) => a + Number(r.quantity), 0)} hrs · {formatDollars(laborRows.reduce((a, r) => a + Math.round(Number(r.quantity) * r.unit_price_cents), 0))}
            </span>
          )}
        </div>
        {laborRows.length === 0 ? (
          <p className="text-[13px] text-ppp-charcoal-500 italic py-2">No labor rows — add hours + rate below if you're billing labor separately.</p>
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
      </section>

      {/* Alternates */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-4">
        <h2 className="text-sm font-bold text-ppp-charcoal">Alternates <span className="font-normal text-ppp-charcoal-500 text-[12px]">(excluded from TOTAL)</span></h2>
        {alternates.length === 0 ? (
          <p className="text-[13px] text-ppp-charcoal-500 italic py-2">No alternates.</p>
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
      </section>

      {/* Danger zone */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <form action={deleteProposalAction}>
          {hiddenIds}
          <ConfirmSubmitButton
            message={`Delete this proposal draft (R${proposal.revision_number})? Line items and overrides will be lost.`}
            className="text-[12px] text-rose-700 hover:text-rose-800 underline disabled:opacity-50"
          >
            Delete this proposal draft
          </ConfirmSubmitButton>
        </form>
      </section>
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
  return (
    <ul className="divide-y divide-ppp-charcoal-100 border border-ppp-charcoal-100 rounded-lg overflow-hidden">
      {rows.map((r) => (
        <li key={r.id} className="p-3 space-y-2">
          <form action={updateAction} className="space-y-2">
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="deal_id" value={dealId} />
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="is_alternate" value={r.is_alternate ? "on" : ""} />
            {/* Round-3 audit fix: optimistic-lock stamp so a stale
                two-tab save is rejected before it overwrites a
                concurrent edit. Server compares against DB's
                current updated_at. */}
            <input type="hidden" name="original_updated_at" value={r.updated_at} />
            <div className="grid grid-cols-12 gap-2 items-end">
              <label className="col-span-12 sm:col-span-3 block">
                <span className={LABEL_CLS}>Description</span>
                {/* Katie 2026-07-20: line item description = "description
                    area" — multi-line so Alex can add scope detail
                    beyond a single line. PDF renderer (BulletLine in
                    pdf.tsx) already parses \n as sub-item markers, so
                    each newline becomes an indented bullet on the
                    customer PDF. */}
                <textarea
                  name="description"
                  defaultValue={r.description}
                  className={`${INPUT_CLS} min-h-[80px] py-2`}
                  required
                  rows={3}
                  placeholder="e.g. Prep, prime, and paint 2 coats. New lines carry to the PDF as sub-points."
                />
              </label>
              {/* F.6: phase label. Free-text so Alex can use "Phase 1",
                  "Base contract", etc. NULL = ungrouped. */}
              <label
                className="col-span-6 sm:col-span-2 block"
                title="Groups this item under a section header on the PDF. Leave blank for ungrouped."
              >
                <span className={LABEL_CLS}>Phase</span>
                <input
                  type="text"
                  name="phase"
                  defaultValue={r.phase ?? ""}
                  maxLength={60}
                  placeholder="—"
                  className={INPUT_CLS}
                />
              </label>
              <label className="col-span-3 sm:col-span-2 block">
                <span className={LABEL_CLS}>Qty</span>
                <input type="text" inputMode="decimal" name="quantity" defaultValue={String(r.quantity)} className={`${INPUT_CLS} tabular-nums`} />
              </label>
              <label className="col-span-3 sm:col-span-2 block">
                <span className={LABEL_CLS}>Unit</span>
                <input type="text" name="unit" defaultValue={productUnitLabel(r.unit)} className={INPUT_CLS} />
              </label>
              <label className="col-span-6 sm:col-span-3 block">
                <span className={LABEL_CLS}>Unit price</span>
                <input type="text" inputMode="decimal" name="unit_price" defaultValue={centsToDollarInput(r.unit_price_cents)} className={`${INPUT_CLS} tabular-nums`} />
              </label>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
                Row total: {formatDollars(Math.round(Number(r.quantity) * r.unit_price_cents))}
              </span>
              <div className="flex items-center gap-2">
                <button type="submit" className="inline-flex items-center px-3 py-2 rounded-md bg-ppp-charcoal-800 text-white text-[12px] font-semibold hover:bg-ppp-charcoal-900 min-h-[40px]">
                  Save row
                </button>
              </div>
            </div>
          </form>
          <form action={deleteAction} className="text-right">
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="deal_id" value={dealId} />
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="id" value={r.id} />
            <ConfirmSubmitButton
              message="Remove this line item? This can't be undone."
              className="text-[11px] text-rose-700 hover:text-rose-800 underline disabled:opacity-50"
            >
              Remove row
            </ConfirmSubmitButton>
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
  return (
    <form action={submitAction} className="border-t border-ppp-charcoal-100 pt-3 space-y-2">
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="proposal_id" value={proposalId} />
      {isAlternate && <input type="hidden" name="is_alternate" value="on" />}
      {isLabor && <input type="hidden" name="is_labor" value="on" />}
      {!isLabor && products.length > 0 ? (
        <div className="max-w-sm">
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
          />
        </div>
      ) : null}
      <input type="hidden" id={`${prefix}-pid`} name="product_id" defaultValue="" />
      <div className="grid grid-cols-12 gap-2 items-end">
        <label className="col-span-12 sm:col-span-3 block">
          <span className={LABEL_CLS}>Description</span>
          {/* Katie 2026-07-20: multi-line description; newline → PDF
              sub-item bullet via BulletLine's \n parser. */}
          <textarea
            id={`${prefix}-desc`}
            name="description"
            required
            rows={3}
            placeholder={isLabor ? "e.g. Skilled painters — prep + prime + 2 coats" : "e.g. GWB Ceiling & Soffit: Standard prep, prime + 2 coats matte.\n(New lines carry to the PDF as sub-points)"}
            className={`${INPUT_CLS} min-h-[80px] py-2`}
          />
        </label>
        {/* F.6: phase label. Optional — leave blank for ungrouped.
            When ANY line item on this proposal has a phase, the PDF
            groups items under section headers ("Phase 1:", etc.). */}
        <label className="col-span-6 sm:col-span-2 block" title="Groups this item under a section header on the PDF, e.g. 'Phase 1'. Leave blank for ungrouped. If any items have a phase, ungrouped items appear under 'General'.">
          <span className={LABEL_CLS}>Phase (optional)</span>
          <input
            type="text"
            name="phase"
            maxLength={60}
            placeholder="e.g. Phase 1"
            className={INPUT_CLS}
          />
        </label>
        <label className="col-span-3 sm:col-span-2 block">
          <span className={LABEL_CLS}>{isLabor ? "Hours" : "Qty"}</span>
          <input type="text" inputMode="decimal" name="quantity" defaultValue={isLabor ? "8" : "1"} className={`${INPUT_CLS} tabular-nums`} />
        </label>
        <label className="col-span-3 sm:col-span-2 block">
          <span className={LABEL_CLS}>Unit</span>
          <input type="text" id={`${prefix}-unit`} name="unit" defaultValue={isLabor ? "hour" : "each"} className={INPUT_CLS} />
        </label>
        <label className="col-span-6 sm:col-span-3 block">
          <span className={LABEL_CLS}>{isLabor ? "$ / hour" : "Unit price"}</span>
          <input type="text" id={`${prefix}-price`} inputMode="decimal" name="unit_price" defaultValue="0.00" className={`${INPUT_CLS} tabular-nums`} />
        </label>
      </div>
      <div className="flex justify-end">
        <button type="submit" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[40px]">
          Add {isLabor ? "labor row" : isAlternate ? "alternate" : "inclusion"}
        </button>
      </div>
    </form>
  );
}
