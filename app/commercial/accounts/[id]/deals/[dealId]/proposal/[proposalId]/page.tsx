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

import { flashMessage } from "@/lib/commercial/flash";
import { makeCarries, FIELDS_INPUT_NAME, fieldsFor } from "@/lib/commercial/proposals/form-fields";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { listAccountContacts } from "@/lib/commercial/accounts/contacts";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { listProposalEmailSends } from "@/lib/commercial/proposals/email";
import { ProposalSendControl } from "@/components/commercial/proposal-send-control";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import {
  getCommercialOpportunity,
  derivedOppName,
  listCommercialOpportunities,
} from "@/lib/commercial/opportunities/db";
import {
  getProposal,
  proposalDisplayId,
  updateProposal,
  softDeleteProposal,
  listLineItemsForProposal,
  createLineItem,
  updateLineItem,
  deleteLineItem,
  getLineItem,
  sendProposal,
  isProposalApprover,
  requestProposalApproval,
  approveProposal,
  requestProposalChanges,
  unlockApprovedProposal,
  withdrawApprovalRequest,
  listProposalsForOpp,
  type CommercialProposalLineItem,
} from "@/lib/commercial/proposals/db";
import { opportunityStatusLabelV2 } from "@/lib/commercial/opportunities/constants";
import {
  tomcoDefaultIntro,
  proposalStatusLabel,
  proposalTotalLabel,
  proposalRevisionLabel,
} from "@/lib/commercial/proposals/constants";
import { listProducts } from "@/lib/commercial/products/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { listChangeOrders } from "@/lib/commercial/change-orders/db";
import { productUnitLabel } from "@/lib/commercial/products/constants";
import { listExclusions } from "@/lib/commercial/exclusions/db";
import ExclusionPicker from "@/components/commercial/exclusion-picker";
import ProductPicker, { type PickableProduct } from "@/components/commercial/product-picker";
import { IconTrophy } from "@/components/commercial/inline-icons";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { EditableProductChip } from "@/components/commercial/editable-product-chip";
import { AutosaveProposalName } from "@/components/commercial/autosave-proposal-name";
import { AutosaveProposalForm } from "@/components/commercial/autosave-proposal-form";
import { FillProjectFromDeal } from "@/components/commercial/fill-project-from-deal";
import ProposalMarkupUpload from "@/components/commercial/proposal-markup-upload";
import { DateField } from "@/components/commercial/date-field";
import { listDocumentsForParent } from "@/lib/commercial/documents/db";
import {
  INPUT_CLS,
  TEXTAREA_CLS,
  LABEL_CLS,
  SELECT_CLS,
  SELECT_BG_STYLE,
} from "@/lib/commercial/form-classnames";
import { UUID_RE } from "@/lib/commercial/uuid";
import { SubmitButton } from "@/components/commercial/submit-button";

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
/** Like dollarsInputToCents but returns null (not 0) on an unparseable value —
 *  used for the Final-price override so a typo falls back to NO override (total =
 *  real subtotal) instead of silently zeroing the contract. */
function dollarsInputToCentsOrNull(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
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
  // NO `overflow-hidden` on the card. Stephanie 2026-08-13: *"Exclusion drop
  // down cuts off and I am unable to scroll lower to see all of my options."*
  // The picker's own list scrolls fine — the CARD was clipping it at the
  // border, so options below the fold were unreachable rather than merely
  // hidden. The clip only ever existed to keep the header band inside the
  // rounded corners, which the header now does itself with `rounded-t-xl`.
  // This governs every picker in the editor, not just exclusions.
  return (
    <section
      id={id}
      className={`bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm scroll-mt-24 ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50/40 rounded-t-xl">
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
  await assertCommercialAccess(user.id);
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

  // ── PATCH-ONLY SAVE ────────────────────────────────────────────────
  //
  // This action used to read EVERY field and write all of them, so a form
  // that carried only some of them silently blanked the rest. That is why a
  // separate rename action had to exist, and it is the thing standing between
  // us and Stephanie's requested section order — her sequence interleaves the
  // autosave block with the line-item forms, which means splitting the big
  // form, which under the old behaviour meant each part erasing the others.
  //
  // A form now DECLARES what it carries via a hidden `__fields` list, and
  // only those fields are touched. `updateProposal` already treats undefined
  // as "leave alone", so the whole fix lives here.
  //
  // A form with no declaration keeps the old whole-form behaviour, which is
  // correct for the single combined editor and means nothing changes until a
  // form opts in.
  //
  // The declaration is required rather than inferred from what FormData
  // contains, because an unchecked checkbox is simply ABSENT from FormData —
  // inferring presence would make "unchecked" indistinguishable from "not on
  // this form", and unticking a box would never save.
  const carries = makeCarries(String(formData.get(FIELDS_INPUT_NAME) ?? ""));
  const text = (name: string) => String(formData.get(name) ?? "").trim();

  const header = { ...existing.header_json };
  if (carries("gc_company")) header.gc_company = text("gc_company") || undefined;
  if (carries("attention")) header.attention = text("attention") || undefined;
  if (carries("phone")) header.phone = text("phone") || undefined;
  if (carries("email")) header.email = text("email") || undefined;
  if (carries("project_name")) header.project_name = text("project_name") || undefined;
  if (carries("project_address")) header.project_address = text("project_address") || undefined;
  if (carries("date_iso")) header.date_iso = text("date_iso") || undefined;
  if (carries("show_cip_notice")) {
    header.show_capital_improvement_notice = formData.get("show_cip_notice") === "on";
  }
  if (carries("gc_address_lines")) {
    const gcAddrRaw = text("gc_address_lines");
    header.gc_address_lines = gcAddrRaw
      ? gcAddrRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : undefined;
  }
  const headerTouched = [
    "gc_company", "attention", "phone", "email", "project_name",
    "project_address", "date_iso", "show_cip_notice", "gc_address_lines",
  ].some(carries);

  const estimator = { ...existing.estimator_snapshot_json };
  if (carries("est_name")) estimator.name = text("est_name") || undefined;
  if (carries("est_title")) estimator.title = text("est_title") || undefined;
  if (carries("est_phone")) estimator.phone = text("est_phone") || undefined;
  if (carries("est_email")) estimator.email = text("est_email") || undefined;
  const estimatorTouched = ["est_name", "est_title", "est_phone", "est_email"].some(carries);

  const introOverride = text("intro_text_override");
  const altNotes = text("alternate_notes");
  const bidNotes = text("bid_notes");
  const pdfShowPrices = formData.get("pdf_show_line_prices") === "on";
  // R1c: Bid Set date (empty → null). R1b: final price override — blank field
  // means "clear back to the line-item sum" (null), NOT $0; a typed value
  // overrides the total (dollarsInputToCents clamps ≥0).
  const bidSetDate = carries("bid_set_date") ? text("bid_set_date") || null : undefined;
  const finalPriceRaw = text("final_price_override");
  // A typo/unparseable entry -> null (clears the override; total falls back to the
  // real subtotal) rather than $0, which would silently zero the contract + AIA.
  const finalPriceOverride = !carries("final_price_override")
    ? undefined
    : finalPriceRaw === ""
    ? null
    : dollarsInputToCentsOrNull(finalPriceRaw);

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
    header_json: headerTouched ? header : undefined,
    estimator_snapshot_json: estimatorTouched ? estimator : undefined,
    intro_text_override: carries("intro_text_override") ? introOverride || null : undefined,
    alternate_notes: carries("alternate_notes") ? altNotes || null : undefined,
    bid_notes: carries("bid_notes") ? bidNotes || null : undefined,
    exclusion_ids: carries("exclusion_ids") ? exclusionIds : undefined,
    custom_exclusions: carries("custom_exclusions") ? customExclusions : undefined,
    pdf_show_line_prices: carries("pdf_show_line_prices") ? pdfShowPrices : undefined,
    final_price_override_cents: finalPriceOverride,
    bid_set_date: bidSetDate,
    updated_by_user_id: userId,
  });
  if (!result.ok) {
    // Karan 2026-07-20 (autosave fix): throw instead of redirect so the
    // AutosaveProposalForm wrapper's try/catch sets status="error" and
    // renders the "Save failed" pill in-place — no jarring navigation
    // that wipes the user's in-flight typing.
    throw new Error(result.error);
  }
  // NO redirect on success. A redirect would trigger a full navigation on
  // every save, blowing away input focus + cursor position mid-typing.
  //
  // And on a BACKGROUND save, no revalidation either. Stephanie 2026-08-13:
  // *"it automatically saves every 3 seconds making it hard to enter data
  // without it being overwritten or erased."* Uncontrolled inputs do keep
  // their in-flight text across a revalidate — but anything React re-keys
  // from server data (the inclusion and alternate rows) remounts, which is
  // exactly the "erased" she is describing. Re-rendering the page someone is
  // typing into buys nothing: the data being revalidated is the data they
  // just typed. The write still lands; only the re-render is skipped.
  //
  // CORRECTION (2026-08-13, Karan: "make sure we're not breaking any flow we
  // had in place"). An earlier version of this comment said "an explicit save
  // still revalidates everything" — that was wrong. Karan removed the manual
  // Save button on 2026-07-20, so autosave is the ONLY caller and the
  // revalidatePath calls below are now unreachable in practice.
  //
  // They are kept rather than deleted because they are correct for any future
  // non-autosave caller, and nothing goes stale meanwhile: the proposal page,
  // the proposals list and the account page are all `force-dynamic`, so each
  // re-reads on navigation regardless. Verified, not assumed.
  // Background saves normally skip revalidation — see above. The exception is
  // a change that alters something rendered OUTSIDE the form being typed into:
  // a Final price override repins proposal.total_cents, and the TOTAL chip in
  // the sticky header and the Inclusions subtotal both read it. Skipping the
  // refresh there left Kim looking at the old contract number while the new
  // one was already saved — worse than a re-render, because she has no reason
  // to doubt the figure on screen.
  const overrideChanged =
    carries("final_price_override") &&
    (existing.final_price_override_cents ?? null) !== (finalPriceOverride ?? null);
  if (String(formData.get("__autosave") ?? "") === "1" && !overrideChanged) return;
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/proposals");
}

/** Karan 2026-07-15: dedicated rename action — patches ONLY the
 *  project_name in header_json without touching any other field.
 *
 *  It existed because saveProposalAction used to wipe fields missing from
 *  formData, which made submitting just the rename input catastrophic. That
 *  is no longer true (saves are patch-only as of 2026-08-13), so this could
 *  now be folded in — but it is kept deliberately: it is the narrowest
 *  possible write, it is already proven, and collapsing two working paths
 *  into one to save a few lines is how a rename starts touching fields it
 *  has no business touching. */
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
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
  // No redirect on success: this is a debounced autosave, and navigating on every
  // keystroke-pause scrolled the editor + stuck a ?saved=1 flag. revalidatePath
  // already refreshes the name in place (matches saveProposalAction).
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
        proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent("That product is a browse header — pick one of its variations (e.g. Seal & Poly).")}`, proposalBack(formData))
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
      // R1a: checkbox defaults checked; unchecked → absent → false (hide price).
      show_price: formData.get("show_price") === "on",
    },
    userId
  );
  if (!result.ok) {
    redirect(
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
    );
  }
  // Karan 2026-08-13: "I'm adding an inclusion and it asked me to leave the
  // site and it's on the adding screen still. It makes me refresh then it comes
  // up to the total."
  //
  // This used to `redirect()` to the URL it was ALREADY on. Navigating to the
  // current path is a no-op in the App Router — the hash never reaches the
  // server, so there is nothing to change — which meant the revalidated total
  // never painted until the user refreshed by hand. It also fired a real
  // navigation, which is what triggered the autosave form's "Leave site?"
  // guard mid-edit.
  //
  // `revalidatePath` alone is the idiomatic answer: the action returns, React
  // re-renders the server component with fresh data, and the user stays put
  // with the new line and the new total on screen.
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent("That line item is not part of this proposal.")}`, proposalBack(formData))
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
      // No #line-items hash on error — it would scroll past the top error
      // banner (audit fix). Stay at the top so the message is seen.
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?error=${encodeURIComponent("This line item was updated in another tab. Refresh to see the latest, then re-apply your change.")}`
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
  // Stephanie 2026-08-13: the product can now be SWAPPED on a saved row, not
  // just cleared. The link has to move with the name — a row showing product B
  // while still pointing at product A is worse than a locked field. Absent →
  // undefined (don't touch); present-but-blank → null (row became free-text).
  const pidInput = formData.get("product_id");
  const pidRaw = pidInput === null ? null : String(pidInput).trim();
  const product_id: string | null | undefined =
    pidInput === null ? undefined : pidRaw && UUID_RE.test(pidRaw) ? pidRaw : null;
  // Sanitize quantity the same way the add path does — a NaN (blank/"abc")
  // otherwise slips past updateLineItem's `< 0`/`=== 0` checks and writes null,
  // dropping the row from the TOTAL (Karan 2026-07-27 audit).
  const rawQty = Number(String(formData.get("quantity") ?? "1"));
  const result = await updateLineItem(
    {
      id,
      description: String(formData.get("description") ?? ""),
      product_name,
      product_id,
      quantity: Number.isFinite(rawQty) && rawQty >= 0 ? rawQty : 1,
      unit: String(formData.get("unit") ?? "each"),
      unit_price_cents: dollarsInputToCents(String(formData.get("unit_price") ?? "0")),
      is_alternate: formData.get("is_alternate") === "on",
      show_price: formData.get("show_price") === "on",
      phase,
    },
    userId
  );
  if (!result.ok) {
    redirect(
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  // Keep the origin on SUCCESS too — round 1 wired only the error paths, so
  // the ordinary case still dropped "Back to Proposals".
  redirect(
    proposalHref(accountId, dealId, proposalId, "#line-items", proposalBack(formData))
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent("That line item is not part of this proposal.")}`, proposalBack(formData))
    );
  }
  const result = await deleteLineItem(id, userId);
  if (!result.ok) {
    redirect(
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  // Keep the origin on SUCCESS too — round 1 wired only the error paths, so
  // the ordinary case still dropped "Back to Proposals".
  redirect(
    proposalHref(accountId, dealId, proposalId, "#line-items", proposalBack(formData))
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
    );
  }
  revalidatePath(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`
  );
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?sent=1`
  );
}

// ── R1d approval workflow actions ──────────────────────────────────────
/** A deal drill-in URL — `/commercial/accounts/<uuid>?tab=projects&project=<uuid>…` */
const DEAL_DRILL_IN_RE = /^\/commercial\/accounts\/[0-9a-f-]{36}\?tab=projects&project=[0-9a-f-]{36}/i;
/** The deal's own page — where its tools live as of restructure step 3
 *  (2026-08-12). Added alongside the drill-in shape, not instead of it: the
 *  old URLs still arrive from bookmarks and sent email. A `?back=` this
 *  guard rejects is silently dropped, so omitting the new shape would kill
 *  every back link from the deal page with nothing to show for it. */
const OPP_PAGE_RE = /^\/commercial\/opportunities\/[0-9a-f-]{36}(\?|#|$)/i;

function proposalHref(accountId: string, dealId: string, proposalId: string, suffix = "", back = "") {
  const base = `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}`;
  // Split the suffix into query and fragment. Appending `?back=` after a
  // `#line-items` suffix would bury the query INSIDE the fragment, so the
  // breadcrumb param would be silently dropped and the anchor broken with it.
  const hashAt = suffix.indexOf("#");
  const query = hashAt === -1 ? suffix : suffix.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : suffix.slice(hashAt);
  let url = `${base}${query}`;
  if (back) {
    url += `${url.includes("?") ? "&" : "?"}back=${encodeURIComponent(back)}`;
  }
  return `${url}${hash}`;
}

/**
 * The origin an action received via its hidden `back` input.
 *
 * The editor never carried this: every one of its actions redirected to a bare
 * proposal URL, so the first line-item edit silently threw away where you came
 * from and the breadcrumb reverted. Open-redirect-guarded — internal paths only.
 */
function proposalBack(fd: FormData): string {
  const b = String(fd.get("back") ?? "");
  return b.startsWith("/commercial/") ? b : "";
}

/** Any editor asks for approval: draft → pending_approval + notify approvers. */
async function requestApprovalAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) redirect("/commercial");
  const result = await requestProposalApproval({ proposal_id: proposalId, actor_user_id: userId });
  if (!result.ok) {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData)));
  }
  revalidatePath(proposalHref(accountId, dealId, proposalId));
  redirect(proposalHref(accountId, dealId, proposalId, "?approval=requested", proposalBack(formData)));
}

/** Approver approves: pending_approval → approved. Rejects non-approvers. */
async function approveAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) redirect("/commercial");
  const result = await approveProposal({ proposal_id: proposalId, actor_user_id: userId });
  if (!result.ok) {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData)));
  }
  revalidatePath(proposalHref(accountId, dealId, proposalId));
  redirect(proposalHref(accountId, dealId, proposalId, "?approval=approved", proposalBack(formData)));
}

/** Approver kicks it back with a note: pending_approval | approved → draft. */
async function requestChangesAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  const note = String(formData.get("changes_note") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) redirect("/commercial");
  const result = await requestProposalChanges({ proposal_id: proposalId, actor_user_id: userId, note });
  if (!result.ok) {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData)));
  }
  revalidatePath(proposalHref(accountId, dealId, proposalId));
  redirect(proposalHref(accountId, dealId, proposalId, "?approval=changes", proposalBack(formData)));
}

/** Any editor unlocks an approved proposal to edit: approved → draft (approval invalidated). */
async function unlockAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) redirect("/commercial");
  const result = await unlockApprovedProposal({ proposal_id: proposalId, actor_user_id: userId });
  if (!result.ok) {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData)));
  }
  revalidatePath(proposalHref(accountId, dealId, proposalId));
  redirect(proposalHref(accountId, dealId, proposalId, "?approval=unlocked", proposalBack(formData)));
}

/** Reopen an EXPIRED proposal back to draft so it can be tweaked, re-approved,
 *  and re-sent (send requires approval, so expired can't go straight to sent). */
async function reopenExpiredAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) redirect("/commercial");
  const { updateProposalStatus } = await import("@/lib/commercial/proposals/db");
  const current = await getProposal(proposalId);
  if (!current || current.status !== "expired") {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent("Only an expired proposal can be reopened here.")}`, proposalBack(formData)));
  }
  const result = await updateProposalStatus({ id: proposalId, to_status: "draft", acting_user_id: userId });
  if (!result.ok) {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData)));
  }
  revalidatePath(proposalHref(accountId, dealId, proposalId));
  revalidatePath(`/commercial/accounts/${accountId}`);
  redirect(proposalHref(accountId, dealId, proposalId, "?approval=reopened_expired", proposalBack(formData)));
}

/** Sender withdraws their own pending request back to draft (any editor). */
async function withdrawAction(formData: FormData) {
  "use server";
  const userId = await requireAuthed();
  const accountId = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("deal_id") ?? "");
  const proposalId = String(formData.get("proposal_id") ?? "");
  if (![accountId, dealId, proposalId].every((v) => UUID_RE.test(v))) redirect("/commercial");
  const result = await withdrawApprovalRequest({ proposal_id: proposalId, actor_user_id: userId });
  if (!result.ok) {
    redirect(proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData)));
  }
  revalidatePath(proposalHref(accountId, dealId, proposalId));
  redirect(proposalHref(accountId, dealId, proposalId, "?approval=withdrawn", proposalBack(formData)));
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
    );
  }
  // Land straight on the deal's Proposals view (the deleted revision is simply
  // gone from the list = the feedback). Going via .../proposal?deleted=1 dropped
  // the flag on its 302 to the account page, so the old flow gave no context (#20).
  redirect(
    `/commercial/opportunities/${dealId}?tab=proposals#deal-proposals`
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent("Invalid outcome.")}`, proposalBack(formData))
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
      proposalHref(accountId, dealId, proposalId, `?error=${encodeURIComponent(result.error)}`, proposalBack(formData))
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
  // When the deal was already in delivery we deliberately left it there (see
  // markProposalOutcome). Say so — the deal not moving was the confusing part.
  const kept = result.deal_left_in_delivery
    ? `&deal_kept=${encodeURIComponent(result.deal_left_in_delivery)}`
    : "";
  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${proposalId}?outcome=${outcome}${kept}`
  );
}

// ─────────────── page render ───────────────

export default async function ProposalEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string; proposalId: string }>;
  searchParams: Promise<{ saved?: string; error?: string; created?: string; sent?: string; back?: string; outcome?: "won" | "lost" | "reopened" | "reopened_solo" | string; deal_kept?: string; kept?: string; approval?: "requested" | "approved" | "changes" | "unlocked" | "withdrawn" | string }>;
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
  const viewerId = await requireAuthed();
  // R1d: only a flagged approver (Settings → Access) sees the Approve +
  // Request-changes controls. Everyone else builds, edits, and sends-for-approval.
  const viewerIsApprover = await isProposalApprover(viewerId);

  const [account, opp, proposal] = await Promise.all([
    getCommercialAccount(accountId),
    getCommercialOpportunity(dealId),
    getProposal(proposalId),
  ]);
  if (!account) notFound();
  if (!opp || opp.account_id !== accountId) notFound();
  if (!proposal || proposal.opportunity_id !== dealId) notFound();
  // The deal's own answer. Won/lost, or anywhere past the sale — all of them
  // mean the outcome is recorded and this proposal is history.
  // Has this proposal actually gone to the GC? Won/lost count — they can only
  // follow a send. `superseded`/`expired` do too: both are end states of a
  // proposal that was live.
  // Bounced here from the revision route because this proposal has not gone to
  // the GC yet — so it IS the working copy. Explained rather than silently
  // redirected, which would just look broken.
  const keptOriginal = (Array.isArray(sp.kept) ? sp.kept[0] : sp.kept) === "1";
  const hasBeenSent =
    !!proposal.sent_at ||
    ["sent", "won", "lost", "superseded", "expired"].includes(proposal.status);
  const dealDecided =
    opp.status === "pre_sale_closed" ||
    ["pre_construction", "in_progress", "billing", "post_sale_closed"].includes(opp.status);

  const [lineItems, products, allExclusions, accountDeals] = await Promise.all([
    listLineItemsForProposal(proposalId),
    listProducts({ includeInactive: false }),
    listExclusions({ activeOnly: true }),
    // Karan 2026-07-20: fill-PROJECT-from-deal picker needs every deal
    // under this account so Alex can hot-swap the PROJECT block from
    // any sibling deal's structured data. Filter to non-deleted only.
    listCommercialOpportunities({ accountId }),
  ]);
  // Billing progress (Karan A2 2026-07-30): once this proposal is the accepted
  // contract, show how much of it has been billed. Contract = proposal total +
  // net APPROVED change orders tied to THIS proposal; billed = issued invoices
  // linked to it. Deducts can't push the contract below $0.
  const [proposalInvoices, dealChangeOrders, dealDocuments, siblingProposals] = await Promise.all([
    listCommercialInvoices({ opportunityId: dealId }),
    listChangeOrders(dealId),
    listDocumentsForParent("opportunity", dealId),
    listProposalsForOpp(dealId),
  ]);
  // Revision numbering starts only once the CLIENT has been sent something on
  // this deal — see proposalRevisionLabel. Computed from the siblings, not
  // just this row, so R2 doesn't appear on a bump of a never-sent draft.
  const anySentOnDeal = siblingProposals.some((sp) => sp.sent_at != null);
  const revLabel = proposalRevisionLabel(proposal, anySentOnDeal);
  // Kim: recipient list + operating-company identity + prior email-sends for the
  // "Send proposal" review sheet / "emailed to …" line.
  const [accountContacts, operatingCompany, proposalEmailSends] = await Promise.all([
    listAccountContacts(accountId),
    getOperatingCompany(),
    listProposalEmailSends(proposalId),
  ]);
  const contactsWithEmail = accountContacts
    .map(({ contact, attachments }) => ({
      name: contact.full_name,
      email: (contact.email ?? "").trim(),
      isPrimary: attachments.some((a) => a.is_primary),
    }))
    .filter((c) => c.email);
  const primaryContact =
    contactsWithEmail.find((c) => c.isPrimary) ?? contactsWithEmail[0] ?? null;
  const sendContacts = contactsWithEmail.map((c) => ({ name: c.name, email: c.email }));
  const lastEmailSend = proposalEmailSends[0] ?? null;

  // R1c: marked-up plan sets / bid docs the estimator attached to this deal.
  const bidSetDocs = dealDocuments.filter((d) => d.category === "bid_set");
  const issuedForProposal = proposalInvoices.filter(
    (inv) => inv.proposal_id === proposalId && inv.status !== "draft" && inv.status !== "void",
  );
  // Contract math is PRE-TAX (proposal total + CO amounts carry no tax), so
  // "billed of contract" sums invoice SUBTOTALS — tax-inclusive totals would
  // inflate billedPct and falsely trip overBilled on any taxed invoice.
  const billedCents = issuedForProposal.reduce((s, inv) => s + inv.subtotal_cents, 0);
  const netCoForProposal = dealChangeOrders
    .filter((c) => c.status === "approved" && c.proposal_id === proposalId)
    .reduce((s, c) => s + c.amount_cents, 0);
  const effectiveContractCents = Math.max(0, proposal.total_cents + netCoForProposal);
  const remainingCents = Math.max(0, effectiveContractCents - billedCents);
  const billedPct = effectiveContractCents > 0 ? Math.min(100, Math.round((billedCents / effectiveContractCents) * 100)) : 0;
  const overBilled = billedCents > effectiveContractCents;
  const showBilling = proposal.status === "won" || billedCents > 0 || netCoForProposal !== 0;

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
  // Line-item mutations are server-guarded draft-only; the editor renders them
  // read-only past draft so a locked proposal isn't an edit→error dead-end (#2).
  const canEditLines = proposal.status === "draft";
  // R1b: raw non-alternate line-item sum — what the total is when there's no
  // final-price override (shown as the "leave blank to use" hint).
  const lineItemSumCents = lineItems
    .filter((i) => !i.is_alternate)
    .reduce((a, i) => a + Math.round(Number(i.quantity) * i.unit_price_cents), 0);
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

  // 2026-08 restructure: proposals live on the DEAL now — back goes to the
  // deal view's proposals section, not the (removed) account Proposals tab.
  const listHref = `/commercial/opportunities/${dealId}?tab=proposals#deal-proposals`;
  // RUX-1: when opened from the Proposals index (sidebar), offer "Back to
  // Proposals" so the editor reads as part of that queue — not a dead-end into
  // the account. Whitelisted (only the exact index path) so ?back can't be an
  // open-redirect; the deal breadcrumb stays as the secondary link.
  const fromProposalsIndex = sp.back === "/commercial/proposals";
  // Guarded origin, re-emitted into every action's form. The deal drill-in
  // counts: a proposal reached from the deal should return to the deal.
  const backRaw = typeof sp.back === "string" ? sp.back : "";
  const backParam =
    backRaw === "/commercial/proposals" || DEAL_DRILL_IN_RE.test(backRaw) || OPP_PAGE_RE.test(backRaw) ? backRaw : "";

  // Hidden fields shared by every server action on this page.
  const hiddenIds = (
    <>
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="proposal_id" value={proposalId} />
      {/* Carries where the user came from through every action, so the
          breadcrumb survives a save instead of reverting on the first edit. */}
      <input type="hidden" name="back" value={backParam} />
    </>
  );

  const gcAddrText = (proposal.header_json.gc_address_lines ?? []).join("\n");
  // What the intro will actually read if left blank — bid-set clause included,
  // matching the PDF exactly (Stephanie 2026-08-13).
  const defaultIntroPreview = tomcoDefaultIntro(
    proposal.bid_set_date ? fmtEtDate(proposal.bid_set_date) : null
  );


  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      {keptOriginal && (
        <div role="status" className="rounded-lg border border-cc-brand-200 bg-cc-brand-50 px-4 py-3 text-[13px] text-cc-brand-900">
          <strong className="font-semibold">Still working the original.</strong> A new revision is for
          after the GC has seen it and asked for changes — until then this one is the live proposal, so
          edit it here.
        </div>
      )}
      {/* Breadcrumb + status pill */}
      <nav className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        {fromProposalsIndex ? (
          <>
            <Link href="/commercial/proposals" className="inline-flex items-center gap-1.5 font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[32px]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 12H5" />
                <path d="m12 19-7-7 7-7" />
              </svg>
              Back to Proposals
            </Link>
            <span aria-hidden className="text-ppp-charcoal-300">·</span>
            <Link href={listHref} className="truncate hover:text-cc-brand-700 min-h-[44px] sm:min-h-[32px] inline-flex items-center">
              {account.company_name} · {oppName}
            </Link>
          </>
        ) : (
          <>
            <Link href={listHref} className="hover:text-cc-brand-700 inline-flex items-center gap-1 min-h-[44px] sm:min-h-[32px]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 12H5" />
                <path d="m12 19-7-7 7-7" />
              </svg>
              <span>Back to {account.company_name} proposals</span>
            </Link>
            <span aria-hidden className="text-ppp-charcoal-300">·</span>
            <span className="text-ppp-charcoal-900 font-medium">{oppName}</span>
          </>
        )}
      </nav>

      {/* 2026-07-21: sticky toolbar (desktop only) so the identity, TOTAL,
          and Send/PDF actions stay reachable while scrolling the long form.
          NOT sticky on mobile — the buttons wrap into a tall block that
          would eat a 375px viewport if pinned. */}
      <header className="sm:sticky sm:top-2 z-20 bg-surface/95 backdrop-blur-sm border border-ppp-charcoal-200 rounded-xl p-4 flex flex-col gap-3 shadow-md shadow-ppp-charcoal-900/5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {/* No R# until the client has actually seen something — an
                estimator bumping drafts internally shouldn't produce an "R3"
                on a proposal nobody outside the building has received
                (Karan 2026-08). */}
            {revLabel && (
              <span className="text-[11px] font-bold text-ppp-charcoal-500 uppercase tracking-widest tabular-nums">
                {revLabel}
              </span>
            )}
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
                {proposalDisplayId(proposal)}
              </span>
            )}
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-surface text-ppp-charcoal-700 border-ppp-charcoal-200">
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
          {/* No `action=` on the form — AutosaveProposalName calls the action
              directly with this form's FormData, so React 19 can't reset the
              uncontrolled input mid-type. The form element stays purely as the
              FormData container (it carries hiddenIds); it has no submit
              button, and the input preventDefault()s Enter, so nothing
              triggers a native submit. */}
          <form className="flex items-center gap-2">
            {hiddenIds}
            <AutosaveProposalName
              action={renameProposalAction}
              initialValue={proposal.header_json.project_name ?? ""}
              placeholder={`Name this revision (e.g. "Warehouse Repaint")`}
              inputClassName="text-lg font-bold text-ppp-charcoal bg-transparent border-b border-dashed border-ppp-charcoal-200 focus:border-cc-brand-400 focus:outline-none py-0.5 min-w-0 flex-1 placeholder:text-ppp-charcoal-500 placeholder:italic placeholder:font-normal"
              disabled={proposal.status !== "draft"}
            />
          </form>
        </div>
        {/* Action bar — its own full-width row below the identity (RUX-5) so the
            buttons breathe instead of cramming beside the R#/PROP/TOTAL block. */}
        <div className="flex items-center gap-2 flex-wrap border-t border-ppp-charcoal-100 pt-3">
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
                href={
                  // 2026-07-28 re-audit: for a SENT/closed proposal, link the
                  // frozen snapshot PDF saved to Files at send time — the live
                  // render re-resolves exclusion_ids to CURRENT library text, so
                  // editing/deleting a library exclusion afterward would rewrite
                  // the apparent "sent" record. Drafts (no snapshot yet) keep the
                  // live render.
                  proposal.status !== "draft" && proposal.snapshot_document_id
                    ? `/api/commercial/documents/${proposal.snapshot_document_id}/download`
                    : `/api/commercial/proposals/${proposalId}/pdf`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[36px]"
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
              {(proposal.status === "draft" ||
                proposal.status === "pending_approval" ||
                proposal.status === "approved") && (
                <a
                  href={`/api/commercial/proposals/${proposalId}/pdf?mode=internal`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-navy-200 bg-ppp-navy-50 text-ppp-navy-700 text-[12px] font-semibold hover:bg-ppp-navy-100 min-h-[44px] sm:min-h-[36px]"
                  title="Internal Plan Report — the same proposal PLUS the internal bid notes + per-line prices, for estimator + approver review. Never shown to the GC."
                >
                  Plan report
                </a>
              )}
            </>
          )}
          {/* Karan 2026-07-15: "Bump revision" was dev jargon nobody
              understood. It clones this proposal's data into a fresh
              R{n+1} draft — for when the customer wants a revised
              quote after seeing R{n}. Now labeled with what it does.
              
              Karan 2026-08-13: "the revision should only be made after we send
              it to the GC and they want something changed. Kate can work on
              the original one until approved by GC."
              
              So this is gated on the proposal having actually GONE OUT. While
              it is a draft, pending approval, or approved-but-unsent, the
              thing in front of you IS the working copy — editing it is the
              correct move, and offering a revision invites a second row that
              splits the work in two and makes "which one is live" a question
              nobody should have to ask. */}
          {hasBeenSent && (
          <Link
            href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/new?bump=${proposalId}`}
            className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[36px]"
            title={`Start R${proposal.revision_number + 1} as a fresh draft, copying all this revision's fields as a starting point. Use when the customer wants a revised quote.`}
          >
            + New revision (R{proposal.revision_number + 1})
          </Link>
          )}
          {/* R1d HARD GATE: draft → request approval (not direct send). */}
          {proposal.status === "draft" && hasPdfBody && (
            <form action={requestApprovalAction} className="inline-flex">
              {hiddenIds}
              <ConfirmSubmitButton
                message={`Send R${proposal.revision_number} for approval? A designated approver must approve it before it can go to ${proposal.header_json.gc_company ?? "the GC"}. They'll be notified now.`}
                pendingLabel="Requesting…"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-[13px] font-semibold hover:bg-amber-700 shadow-sm min-h-[44px] sm:min-h-[40px] disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 12l2 2 4-4" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
                Send for approval
              </ConfirmSubmitButton>
            </form>
          )}
          {/* Pending approval — anyone can withdraw their request back to draft. */}
          {proposal.status === "pending_approval" && (
            <form action={withdrawAction} className="inline-flex">
              {hiddenIds}
              <ConfirmSubmitButton
                message={`Withdraw R${proposal.revision_number} from approval? It goes back to draft so you can edit it. You'll need to send it for approval again afterward.`}
                pendingLabel="Withdrawing…"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-300 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[36px]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 2v6h6 M3.5 8a9 9 0 1 0 2.3-3.3L3 8" />
                </svg>
                Withdraw
              </ConfirmSubmitButton>
            </form>
          )}
          {/* Pending approval — approver-only Approve + Request changes. */}
          {proposal.status === "pending_approval" && viewerIsApprover && (
            <>
              <form action={approveAction} className="inline-flex">
                {hiddenIds}
                <ConfirmSubmitButton
                  message={`Approve R${proposal.revision_number}? This clears it to send to ${proposal.header_json.gc_company ?? "the GC"}. Whoever requested approval will be notified.`}
                  pendingLabel="Approving…"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 shadow-sm min-h-[44px] sm:min-h-[40px] disabled:opacity-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Approve
                </ConfirmSubmitButton>
              </form>
              <details className="inline-flex relative group">
                <summary className="list-none inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-300 bg-surface text-amber-800 text-[13px] font-semibold hover:bg-amber-50 min-h-[44px] sm:min-h-[40px] cursor-pointer select-none">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
                  </svg>
                  Request changes
                </summary>
                <form
                  action={requestChangesAction}
                  className="absolute right-0 top-full mt-2 z-30 w-72 bg-surface border border-ppp-charcoal-200 rounded-xl shadow-xl p-3 space-y-2"
                >
                  {hiddenIds}
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
                    What needs to change?
                  </label>
                  <textarea
                    name="changes_note"
                    required
                    rows={3}
                    maxLength={2000}
                    placeholder="e.g. Bump the markup on the labor lines, and add the parking exclusion."
                    className={TEXTAREA_CLS}
                  />
                  <SubmitButton
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 text-white text-[13px] font-semibold hover:bg-amber-700 min-h-[44px] sm:min-h-[40px]"
                  >
                    Send back for changes
                  </SubmitButton>
                  <p className="text-[10.5px] text-ppp-charcoal-400 leading-snug">
                    Returns R{proposal.revision_number} to draft and notifies whoever requested approval.
                  </p>
                </form>
              </details>
            </>
          )}
          {/* Approved — the real Send + Unlock-to-edit. */}
          {proposal.status === "approved" && hasPdfBody && (
            <>
              <ProposalSendControl
                proposalId={proposalId}
                accountId={accountId}
                dealId={dealId}
                revisionNumber={proposal.revision_number}
                projectName={proposal.header_json.project_name ?? null}
                gcCompany={proposal.header_json.gc_company ?? null}
                contacts={sendContacts}
                defaultEmail={primaryContact?.email ?? null}
                defaultName={primaryContact?.name ?? null}
                ocName={operatingCompany.name}
                pdfHref={`/api/commercial/proposals/${proposalId}/pdf`}
                markSentAction={sendProposalAction}
              />
              <form action={unlockAction} className="inline-flex">
                {hiddenIds}
                <ConfirmSubmitButton
                  message={`Unlock R${proposal.revision_number} to edit? This invalidates the approval — it'll go back to draft and need a fresh approval before it can be sent.`}
                  pendingLabel="Unlocking…"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-300 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[36px]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                  </svg>
                  Unlock to edit
                </ConfirmSubmitButton>
              </form>
            </>
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cc-brand-300 bg-surface text-cc-brand-700 text-[13px] font-semibold hover:bg-cc-brand-50 min-h-[44px] touch-manipulation"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 2v6h6 M3.5 8a9 9 0 1 0 2.3-3.3L3 8" />
                </svg>
                Reopen
              </ConfirmSubmitButton>
            </form>
          )}
          {/* Expired: reopen to draft so it can be re-priced, re-approved, and
              re-sent (send requires approval — expired can't go straight out). */}
          {proposal.status === "expired" && (
            <form action={reopenExpiredAction} className="inline-flex">
              {hiddenIds}
              <ConfirmSubmitButton
                message={`Reopen R${proposal.revision_number} to edit? It goes back to draft so you can tweak it, get it approved again, and re-send. (Or use "+ New revision" to start fresh.)`}
                pendingLabel="Reopening…"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cc-brand-300 bg-surface text-cc-brand-700 text-[13px] font-semibold hover:bg-cc-brand-50 min-h-[44px] touch-manipulation"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 2v6h6 M3.5 8a9 9 0 1 0 2.3-3.3L3 8" />
                </svg>
                Reopen to edit
              </ConfirmSubmitButton>
            </form>
          )}
          {/* Karan 2026-07-15: Won / Lost outcome buttons on Sent
              proposals. Flips both the proposal AND the parent deal so
              Alex doesn't have to touch two surfaces to close out a
              bid. Lost routes into the account debrief flow to capture
              the reason. */}
          {/* AUDIT 2026-08-13 (Karan: "I marked it as won using the button but
              the proposal still says mark as won"). The deal-side cascade does
              flip a sent proposal to Won — but the proposal page offered the
              button purely off its OWN status, so any moment the two drifted,
              this screen invited you to decide something already decided.
              Same class as the stage bar contradicting the next-step button:
              two surfaces describing one deal must not disagree. */}
          {proposal.status === "sent" && !dealDecided && (
            <>
              <form action={markProposalOutcomeAction} className="inline-flex">
                {hiddenIds}
                <input type="hidden" name="outcome" value="won" />
                <ConfirmSubmitButton
                  message={`Mark R${proposal.revision_number} WON? This also flips the opportunity to Pre-Sale Closed · Won. You'll be able to start the project next.`}
                  pendingLabel="Marking won…"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 transition-colors shadow-sm min-h-[44px] disabled:opacity-50 touch-manipulation"
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
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 bg-surface text-rose-700 text-[13px] font-semibold hover:bg-rose-50 min-h-[44px] sm:min-h-[40px] disabled:opacity-50"
                >
                  Mark lost
                </ConfirmSubmitButton>
              </form>
            </>
          )}
        </div>
      </header>

      {/* ── Billing progress (A2) — how much of this accepted contract has been
          billed. Contract = proposal total + approved COs tied to it. ── */}
      {showBilling && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-3">
            <span aria-hidden className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-emerald-600 text-white shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-ppp-charcoal leading-tight">Billing progress</h2>
              <p className="text-[11px] text-ppp-charcoal-500 leading-snug">How much of this contract has been billed across its invoices.</p>
            </div>
            {overBilled && (
              <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[10px] font-bold uppercase tracking-wide text-amber-800 shrink-0">Over-billed</span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Contract</div>
              <div className="font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 text-ppp-charcoal">{formatDollars(effectiveContractCents)}</div>
              {netCoForProposal !== 0 && <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">incl {netCoForProposal < 0 ? "−" : "+"}{formatDollars(Math.abs(netCoForProposal))} COs</div>}
            </div>
            <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Billed</div>
              <div className="font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 text-emerald-700">{formatDollars(billedCents)}</div>
              <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">{issuedForProposal.length} invoice{issuedForProposal.length === 1 ? "" : "s"}</div>
            </div>
            <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Remaining</div>
              <div className="font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 text-ppp-charcoal">{formatDollars(remainingCents)}</div>
            </div>
            <div className="rounded-lg border border-cc-brand-300 bg-surface px-2.5 py-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">% billed</div>
              <div className="font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 text-cc-brand-800">{billedPct}%</div>
            </div>
          </div>
          <div className="mt-3 h-2 rounded-full bg-ppp-charcoal-200/70 overflow-hidden">
            <div className={`h-full rounded-full transition-all ${overBilled ? "bg-amber-500" : "bg-ppp-blue-500"}`} style={{ width: `${billedPct}%` }} aria-label={`${billedPct}% billed`} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-ppp-charcoal-500">{proposal.status === "won" ? "Accepted contract" : "Not yet accepted"}</span>
            <Link href={`/commercial/invoices?account_id=${accountId}#opp-${dealId}`} className="text-[11.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 inline-flex items-center gap-0.5 min-h-[44px] sm:min-h-[36px]">
              View invoices <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
            </Link>
          </div>
        </section>
      )}

      {sp.saved === "1" && (
        <div role="status" className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-sm text-emerald-800">Saved.</div>
      )}
      {sp.created === "1" && (
        <div role="status" className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-2.5 text-sm text-cc-brand-800">
          Proposal created. Header prefilled from the opportunity — start with inclusions below.
        </div>
      )}
      {sp.sent === "1" && (
        <div role="status" className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900">
          <strong>Proposal sent.</strong> PDF snapshot saved to Files, opportunity flipped to <em>Proposal · Sent</em>, and the team was notified.
        </div>
      )}
      {sp.outcome === "won" && (
        <div role="status" className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900 flex items-start gap-2">
          <IconTrophy size={16} className="text-emerald-700 shrink-0 mt-0.5" />
          <span>
            <strong>Marked won.</strong>{" "}
            {sp.deal_kept
              ? <>The opportunity was left in <em>{opportunityStatusLabelV2(sp.deal_kept)}</em>. The proposal is marked won, but the deal was NOT moved — it is either already decided or past the bid stage, and pulling it back would erase real state. Move it by hand if that is what you meant.</>
              : <>Opportunity flipped to <em>Pre-Sale Closed · Won</em>. Start the project when the client&rsquo;s ready.</>}
          </span>
        </div>
      )}
      {sp.outcome === "lost" && (
        <div role="status" className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-900 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <strong>Marked lost.</strong>{" "}
            {sp.deal_kept
              ? <>The opportunity was left in <em>{opportunityStatusLabelV2(sp.deal_kept)}</em> — reversing a deal that has already been decided, or that has work under way, erases real state. Fix the proposal, or move the deal by hand if it really was lost.</>
              : <>Opportunity flipped to <em>Pre-Sale Closed · Lost</em>. Please add the loss reason so the Win/Loss report is accurate.</>}
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
        <div role="status" className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-3 text-sm text-cc-brand-900">
          <strong>Reopened.</strong> Proposal is back to Sent and the parent opportunity is back to <em>Proposal · Sent</em>.
        </div>
      )}
      {sp.outcome === "reopened_solo" && (
        <div role="status" className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          <strong>Reopened proposal only.</strong> The parent opportunity already moved forward (past Pre-Sale Closed) so it was left as-is. Move it back manually on the pipeline kanban if you meant to reopen the whole opportunity.
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5 text-sm text-rose-800" role="alert">
          {flashMessage(sp.error)}
        </div>
      )}
      {/* R1d approval flash banners */}
      {sp.approval === "requested" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900" role="status">
          <strong>Sent for approval.</strong> The designated approvers were notified. This proposal can&rsquo;t be sent to the GC until it&rsquo;s approved.
        </div>
      )}
      {/* Katie 2026-08-13, on the spacing between "Send proposal" and "above":
          the real problem was that TWO approved banners stacked. This transient
          toast fired on `?approval=approved` while the persistent
          `status === "approved"` banner below said strictly more — locked from
          editing, and what Unlock does. One state, one banner; the persistent
          one wins because it is still true tomorrow. */}
      {sp.approval === "changes" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900" role="status">
          <strong>Changes requested.</strong> This proposal is back to draft and whoever requested approval was notified. Make the edits, then send for approval again.
        </div>
      )}
      {sp.approval === "unlocked" && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-3 text-sm text-cc-brand-900" role="status">
          <strong>Unlocked for editing.</strong> The prior approval was cleared — you&rsquo;ll need a fresh approval before this can be sent.
        </div>
      )}
      {sp.approval === "reopened_expired" && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-3 text-sm text-cc-brand-900" role="status">
          <strong>Reopened.</strong> This proposal had expired and is back to draft. Update the
          pricing and dates before you send it again — an expired quote usually needs both.
        </div>
      )}

      {sp.approval === "withdrawn" && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-3 text-sm text-cc-brand-900" role="status">
          <strong>Withdrawn.</strong> This proposal is back to draft. Make your changes, then send it for approval again.
        </div>
      )}

      {/* R1d: a draft that was kicked back carries the approver's note so the
          estimator knows exactly what to fix. Only while still in draft. */}
      {proposal.status === "draft" && proposal.changes_requested_note && (
        <div className="bg-amber-50 border-l-4 border-amber-500 border-t border-r border-b border-amber-200 rounded-lg px-4 py-3 text-[13px] text-amber-900" role="status">
          <div className="font-semibold mb-0.5">Changes requested by the approver:</div>
          <p className="text-[12.5px] text-amber-800 whitespace-pre-wrap break-words">{proposal.changes_requested_note}</p>
        </div>
      )}

      {/* Locked states. pending_approval + approved are internal locks (NOT yet
          sent to the GC); sent/won/lost/expired/superseded are the frozen
          "GC already has it" states. Copy differs so we never tell someone the
          GC has a copy that hasn't gone out. */}
      {proposal.status === "pending_approval" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[13px] text-amber-900" role="status">
          <div className="font-semibold mb-0.5">Awaiting approval — locked for editing.</div>
          <div className="text-[12.5px] text-amber-800">
            {viewerIsApprover
              ? "You can Approve or Request changes above. Nothing on the proposal can be edited while it's under review."
              : "A designated approver must approve it — or send it back with changes — before it can be sent. It's locked from editing until then. Need to tweak it yourself? Use Withdraw above to pull it back to draft."}
          </div>
        </div>
      )}
      {proposal.status === "approved" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-[13px] text-emerald-900" role="status">
          <div className="font-semibold mb-0.5">Approved — ready to send.</div>
          <div className="text-[12.5px] text-emerald-800">
            Locked from editing so the approved version is what goes out. Use <em>Send proposal</em> above, or <em>Unlock to edit</em> (which clears the approval and needs a fresh one).
          </div>
        </div>
      )}
      {(proposal.status === "sent" ||
        proposal.status === "won" ||
        proposal.status === "lost" ||
        proposal.status === "expired" ||
        proposal.status === "superseded") && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[13px] text-amber-900" role="status">
          <div className="font-semibold mb-0.5">
            This proposal is {proposalStatusLabel(proposal.status).toLowerCase()} — read-only.
          </div>
          <div className="text-[12.5px] text-amber-800">
            The GC already has this copy on file. To make changes, use the &ldquo;+ New revision&rdquo; button at the top to start a fresh draft.
          </div>
          {lastEmailSend && (
            <div className="mt-2 pt-2 border-t border-amber-200/70 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-amber-800">
              <span>
                Emailed to <strong>{lastEmailSend.to_email}</strong> · {fmtEtDate(lastEmailSend.created_at)}
                {proposalEmailSends.length > 1 ? ` · sent ${proposalEmailSends.length}×` : ""}
              </span>
              {proposal.status === "sent" && (
                <ProposalSendControl
                  proposalId={proposalId}
                  accountId={accountId}
                  dealId={dealId}
                  revisionNumber={proposal.revision_number}
                  projectName={proposal.header_json.project_name ?? null}
                  gcCompany={proposal.header_json.gc_company ?? null}
                  contacts={sendContacts}
                  defaultEmail={lastEmailSend.to_email}
                  defaultName={primaryContact?.name ?? null}
                  ocName={operatingCompany.name}
                  pdfHref={`/api/commercial/proposals/${proposalId}/pdf`}
                  markSentAction={sendProposalAction}
                  resend
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* R1d "warn, don't block": a Won proposal that never went through
          approval (never approved AND never sent) — its un-vetted price is now
          the billed contract. Persistent heads-up so it's caught no matter how
          it was closed (kanban drag, deal drag, etc.). */}
      {proposal.status === "won" &&
        !proposal.approved_by_user_id &&
        !proposal.snapshot_document_id && (
          <div className="bg-amber-50 border-l-4 border-amber-500 border-t border-r border-b border-amber-200 rounded-lg px-4 py-3 text-[13px] text-amber-900" role="alert">
            <div className="font-semibold mb-0.5">Won without approval.</div>
            <div className="text-[12.5px] text-amber-800">
              This proposal became the accepted contract without going through the approval step, so its price was never signed off. If that&rsquo;s intentional (a verbal yes), you&rsquo;re all set — otherwise double-check the total, since AIA billing and invoices pull from it.
            </div>
          </div>
        )}

      {/* MAIN AUTOSAVE FORM — wraps every editable section EXCEPT line
          items. Karan 2026-07-20: no manual Save button, every field
          change debounces (800ms) → server action fires. Only wired on
          draft proposals — sent/won/lost render read-only above. */}
      {/* Header + Intro */}
      <AutosaveProposalForm action={saveProposalAction} disabled={proposal.status !== "draft"}>
        {hiddenIds}
        <input type="hidden" name={FIELDS_INPUT_NAME} value={fieldsFor("header", "intro")} />

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
                <div>
                  <span className={LABEL_CLS}>Proposal date</span>
                  <DateField ariaLabel="Proposal date" name="date_iso" defaultValue={proposal.header_json.date_iso ?? ""} placeholder="Pick a date" className="mt-1" />
                </div>
                <div>
                  <span className={LABEL_CLS}>Bid Set date <span className="font-normal text-ppp-charcoal-400">(optional)</span></span>
                  <DateField ariaLabel="Bid set date" name="bid_set_date" defaultValue={proposal.bid_set_date ?? ""} placeholder="Pick a date" className="mt-1" />
                </div>
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
                    Opportunity — the job site
                  </div>
                  <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                    The specific customer + site this covers. Prints as &ldquo;PROJECT: {"{"}Name{"}"}, {"{"}Address{"}"}&rdquo;.
                  </p>
                </div>
                {fillableDeals.length > 0 && (
                  <FillProjectFromDeal
                    // Name is owned by the sticky AutosaveProposalName above — a
                    // second project_name input here reverted it on any body-field
                    // autosave (R4 #3). Fill only the address.
                    deals={fillableDeals}
                    projectAddressInputId="header-project-address"
                  />
                )}
              </div>
              <div className="grid grid-cols-1 gap-3">
                <label className="block">
                  <span className={LABEL_CLS}>Project address</span>
                  <input id="header-project-address" type="text" name="project_address" defaultValue={proposal.header_json.project_address ?? ""} className={INPUT_CLS} placeholder="e.g. 37-38 Junction Blvd, Queens" />
                </label>
              </div>
            </div>

            {/* Capital-improvement banner toggle */}
            <label className="flex items-center gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 px-3.5 py-2.5 cursor-pointer min-h-[44px] sm:min-h-0">
              <input type="checkbox" name="show_cip_notice" defaultChecked={proposal.header_json.show_capital_improvement_notice ?? false} className="w-4 h-4 accent-amber-600" />
              <span className="text-[12.5px] text-ppp-charcoal-700">Show yellow &ldquo;Capital Improvement / NY Sales Tax&rdquo; banner on the PDF</span>
            </label>
          </div>
        </EditorSection>

        {/* Intro override. The preview shows the intro that will ACTUALLY
            print, bid-set clause and all — showing the date-less boilerplate
            while the PDF says something else is how someone concludes the date
            "didn't carry over" and retypes the paragraph by hand. */}
        <EditorSection
          title="Intro paragraph"
          subtitle={<>Blank = the Tomco default: <em>&ldquo;{defaultIntroPreview}&rdquo;</em> Anything you type here replaces it.</>}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2 M9 20h6 M12 4v16" />
            </svg>
          }
        >
          <textarea name="intro_text_override" defaultValue={proposal.intro_text_override ?? ""} rows={3} className={TEXTAREA_CLS} placeholder="Leave blank to use the Tomco default." />
        </EditorSection>
      </AutosaveProposalForm>

      {/* Line items — separate forms outside the main save form so each
          row is its own action. 2026-07-21: unified under EditorSection.
          Only a DRAFT can be edited: every line-item mutation is server-guarded
          draft-only, so on a sent/won/etc. proposal the editable table + Add form
          are a guaranteed-error dead-end — render read-only instead (R4 #2). */}
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
            <p className="text-[13px] text-ppp-charcoal-500 italic">{canEditLines ? "No inclusions yet — add the first one below." : "No inclusions."}</p>
          ) : canEditLines ? (
            <LineItemsTable
              rows={inclusions}
              accountId={accountId}
              dealId={dealId}
              proposalId={proposalId}
              updateAction={updateLineItemAction}
              deleteAction={deleteLineItemAction}
              products={products.map((p) => ({
                ...p,
                is_parent_only: parentIdsWithChildren.has(p.id),
              }))}
              backHref={backParam}
            />
          ) : (
            <ReadOnlyLineItems rows={inclusions} />
          )}
          {canEditLines && (
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
          )}
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
          ) : canEditLines ? (
            <LineItemsTable
              rows={alternates}
              accountId={accountId}
              dealId={dealId}
              proposalId={proposalId}
              updateAction={updateLineItemAction}
              deleteAction={deleteLineItemAction}
              products={products.map((p) => ({
                ...p,
                is_parent_only: parentIdsWithChildren.has(p.id),
              }))}
              backHref={backParam}
            />
          ) : (
            <ReadOnlyLineItems rows={alternates} />
          )}
          {canEditLines && (
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
          )}
        </div>
      </EditorSection>

      {/* Qualifications */}
      <AutosaveProposalForm action={saveProposalAction} disabled={proposal.status !== "draft"}>
        {hiddenIds}
        <input type="hidden" name={FIELDS_INPUT_NAME} value={fieldsFor("qualifications")} />

        {/* Qualifications (fka "Alternate description") — Karan meeting 2026-08 */}
        <EditorSection
          title="Qualifications"
          subtitle="Optional qualifications paragraph shown above the alternate line items on the proposal."
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7 7h10 M7 12h10 M7 17h6" /><path d="M3 7h.01 M3 12h.01 M3 17h.01" />
            </svg>
          }
        >
          <textarea name="alternate_notes" defaultValue={proposal.alternate_notes ?? ""} rows={2} className={TEXTAREA_CLS} placeholder="e.g. Exterior: Power wash exterior of building." />
        </EditorSection>
      </AutosaveProposalForm>

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
            <p className="text-[13px] text-ppp-charcoal-500 italic">{canEditLines ? "No labor rows — add hours + rate below if you're billing labor separately." : "No labor rows."}</p>
          ) : canEditLines ? (
            <LineItemsTable
              rows={laborRows}
              accountId={accountId}
              dealId={dealId}
              proposalId={proposalId}
              updateAction={updateLineItemAction}
              deleteAction={deleteLineItemAction}
              products={products.map((p) => ({
                ...p,
                is_parent_only: parentIdsWithChildren.has(p.id),
              }))}
              backHref={backParam}
            />
          ) : (
            <ReadOnlyLineItems rows={laborRows} />
          )}
          {canEditLines && (
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
          )}
        </div>
      </EditorSection>

      {/* Exclusions + Bid notes + PDF options + Estimator sign-off */}
      <AutosaveProposalForm action={saveProposalAction} disabled={proposal.status !== "draft"}>
        {hiddenIds}
        <input type="hidden" name={FIELDS_INPUT_NAME} value={fieldsFor("exclusions", "bidNotes", "pdfOptions", "estimator")} />

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

          {/* R1c: marked-up plan set / bid-doc attach. Files to the DEAL's
              documents (bid_set), so it survives revision bumps and shows in
              the deal's Documents. Internal only — never on the customer PDF. */}
          <div className="mt-4 pt-4 border-t border-ppp-charcoal-100">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div className="min-w-0">
                <div className="text-[12px] font-bold text-ppp-charcoal">Marked-up plans / bid set</div>
                <div className="text-[11px] text-ppp-charcoal-500 leading-snug">Attach a marked-up plan set or the GC&rsquo;s bid document. Filed to this opportunity — internal only.</div>
              </div>
              <ProposalMarkupUpload opportunityId={dealId} />
            </div>
            {bidSetDocs.length > 0 ? (
              <ul className="space-y-1">
                {bidSetDocs.map((d) => (
                  <li key={d.id}>
                    <a
                      href={`/api/commercial/documents/${d.id}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[12.5px] text-cc-brand-700 hover:text-cc-brand-800 hover:underline min-h-[36px]"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="truncate max-w-[240px]">{d.file_name}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11.5px] text-ppp-charcoal-400 italic">No marked-up docs attached yet.</p>
            )}
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
          <label className="flex items-center gap-2.5 cursor-pointer min-h-[44px] sm:min-h-0">
            <input type="checkbox" name="pdf_show_line_prices" defaultChecked={proposal.pdf_show_line_prices} className="w-4 h-4 accent-cc-brand-600" />
            <span className="text-[12.5px] text-ppp-charcoal-700">
              Show per-line prices on the customer PDF (Tomco default hides them — customer sees only the TOTAL)
            </span>
          </label>
          {/* R1b: adjustable final price. Blank = the line-item sum; a value here
              becomes the proposal TOTAL AND the contract number (AIA + invoicing). */}
          <div className="mt-3 pt-3 border-t border-ppp-charcoal-100">
            <span className="text-[12.5px] font-semibold text-ppp-charcoal-700">Final price override <span className="font-normal text-ppp-charcoal-400">(optional)</span></span>
            <div className="flex items-center gap-1.5 mt-1 max-w-[240px]">
              <span className="text-ppp-charcoal-500 text-[13px]">$</span>
              <input
                type="text"
                aria-label="Final price override"
                inputMode="decimal"
                name="final_price_override"
                defaultValue={proposal.final_price_override_cents != null ? centsToDollarInput(proposal.final_price_override_cents) : ""}
                placeholder="Auto (from line items)"
                className={`${INPUT_CLS} tabular-nums`}
              />
            </div>
            <p className="text-[11px] text-ppp-charcoal-500 mt-1">
              Leave blank to use the line-item total ({formatDollars(lineItemSumCents)}). A value here becomes the TOTAL the customer sees — and the contract number used for AIA billing + invoicing.
            </p>
          </div>
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
      </AutosaveProposalForm>

      {/* Karan 2026-07-20: no manual "Save proposal" button — every field
          autosaves. Stephanie 2026-08-13 asked for this order, which
          interleaves these panels with the line-item tables, so the single
          save form is now three declared forms (see form-fields.ts): each
          writes only the fields it carries, and they cannot blank each
          other. */}
      <p className="text-[12px] text-ppp-charcoal-500 text-center">
        Changes save automatically. Line items save independently below.
      </p>

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
  products,
  backHref,
}: {
  rows: CommercialProposalLineItem[];
  accountId: string;
  dealId: string;
  proposalId: string;
  updateAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
  /** The same catalogue the add row uses, so "Change" behaves identically
   *  to picking the product the first time (Stephanie 2026-08-13). */
  products: PickableProduct[];
  /** Where the user came from, so row actions keep the breadcrumb. */
  backHref: string;
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
            className="rounded-xl border border-ppp-charcoal-200 bg-surface p-4 space-y-3 shadow-sm"
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
            {/* The catalogue link travels with the name, so swapping the
                product can't leave the row pointing at the old one. */}
            <input type="hidden" id={`pid-${r.id}`} name="product_id" defaultValue={r.product_id ?? ""} />
            {/* Round-3 audit fix: optimistic-lock stamp so a stale two-tab
                save is rejected before it overwrites a concurrent edit. */}
            <input type="hidden" name="original_updated_at" value={r.updated_at} />
            {/* Carries the origin so Save row / Remove keep the breadcrumb the
                rest of the page preserves. Without it proposalBack() always
                returned "" and editing a line item silently dropped "Back to
                Proposals" (2026-08-13 audit). */}
            <input type="hidden" name="back" value={backHref} />

            {/* Product chip + Clear (only when this row came from the catalog). */}
            {/* Rendered even with NO product: the chip holds the only
                ProductPicker an existing row has, so gating it on
                product_name made "Clear" a one-way door — a free-text line
                could never be linked back to the catalogue without deleting
                and rebuilding it. (2026-08-13 audit.) */}
            {(
              <EditableProductChip
                name={r.product_name ?? ""}
                inputId={`pn-${r.id}`}
                productIdInputId={`pid-${r.id}`}
                descriptionInputId={`desc-${r.id}`}
                unitInputId={`unit-${r.id}`}
                unitPriceInputId={`price-${r.id}`}
                products={products}
                accountId={accountId}
              />
            )}

            <label className="block">
              <span className={LABEL_CLS}>Description</span>
              <textarea
                id={`desc-${r.id}`}
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
                <input type="text" id={`unit-${r.id}`} name="unit" defaultValue={productUnitLabel(r.unit)} className={INPUT_CLS} />
              </label>
              <label className="block">
                <span className={LABEL_CLS}>Unit price</span>
                <input type="text" id={`price-${r.id}`} inputMode="decimal" name="unit_price" defaultValue={centsToDollarInput(r.unit_price_cents)} className={`${INPUT_CLS} tabular-nums`} />
              </label>
            </div>

            {/* R1a: per-line price visibility. Alternates always print their price
                (a priceless alternate is meaningless to a GC) — preserve their
                value via a hidden field so a save doesn't flip them off. Only
                affects the client PDF when "Show per-line prices" is on. */}
            {r.is_alternate ? (
              <input type="hidden" name="show_price" value={r.show_price === false ? "" : "on"} />
            ) : (
              <label className="inline-flex items-center gap-2 text-[12.5px] text-ppp-charcoal-600 cursor-pointer min-h-[44px] select-none">
                <input type="checkbox" name="show_price" defaultChecked={r.show_price !== false} className="w-4 h-4 accent-cc-brand-600" />
                Show this line&rsquo;s price on the client PDF
              </label>
            )}

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
                <SubmitButton
                  className="inline-flex items-center px-4 min-h-[44px] rounded-lg bg-ppp-charcoal-800 text-surface text-[13px] font-semibold hover:bg-ppp-navy-900 touch-manipulation"
                >
                  Save row
                </SubmitButton>
              </div>
            </div>
          </form>
        </li>
      ))}
    </ul>
  );
}

/** Read-only line-item list for a locked (non-draft) proposal — shows the scope
 *  without any editable inputs or Save/Remove/Add controls (R4 #2). */
function ReadOnlyLineItems({ rows }: { rows: CommercialProposalLineItem[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const lineCents = Math.round(Number(r.quantity) * r.unit_price_cents);
        return (
          <li key={r.id} className="rounded-xl border border-ppp-charcoal-200 bg-surface p-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              {r.product_name && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold bg-ppp-charcoal-100 text-ppp-navy mb-1">{r.product_name}</span>
              )}
              {r.description && <p className="text-[13px] text-ppp-charcoal-700 whitespace-pre-wrap">{r.description}</p>}
              <p className="text-[11.5px] text-ppp-charcoal-500 mt-1 tabular-nums">
                {Number(r.quantity)}{r.unit ? ` ${r.unit}` : ""} × {formatDollars(r.unit_price_cents)}
              </p>
            </div>
            <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ppp-charcoal">{r.show_price === false ? "—" : formatDollars(lineCents)}</span>
          </li>
        );
      })}
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

      {/* R1a: alternates always print their price; inclusions/labor can hide it. */}
      {isAlternate ? (
        <input type="hidden" name="show_price" value="on" />
      ) : (
        <label className="inline-flex items-center gap-2 text-[12.5px] text-ppp-charcoal-600 cursor-pointer min-h-[44px] select-none">
          <input type="checkbox" name="show_price" defaultChecked className="w-4 h-4 accent-cc-brand-600" />
          Show this line&rsquo;s price on the client PDF
        </label>
      )}

      <div className="flex justify-end">
        <PendingSubmitButton pendingLabel="Adding…" className="inline-flex items-center gap-1.5 px-4 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 touch-manipulation disabled:opacity-60">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          Add {addLabel}
        </PendingSubmitButton>
      </div>
    </form>
  );
}
