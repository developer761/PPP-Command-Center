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
 *   Bottom: Save all + Bump revision + Delete draft
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
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
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

  const result = await updateProposal({
    id: proposalId,
    header_json: header,
    estimator_snapshot_json: estimator,
    intro_text_override: introOverride || null,
    alternate_notes: altNotes || null,
    bid_notes: bidNotes || null,
    exclusion_ids: exclusionIds,
    pdf_show_line_prices: pdfShowPrices,
    updated_by_user_id: userId,
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
  const description = String(formData.get("description") ?? "").trim();
  const quantity = Number(String(formData.get("quantity") ?? "1"));
  const unit = String(formData.get("unit") ?? "each").trim() || "each";
  const unit_price_cents = dollarsInputToCents(String(formData.get("unit_price") ?? "0"));
  const is_alternate = formData.get("is_alternate") === "on";
  const result = await createLineItem(
    {
      proposal_id: proposalId,
      product_id,
      description,
      quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
      unit,
      unit_price_cents,
      is_alternate,
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
  const result = await updateLineItem(
    {
      id,
      description: String(formData.get("description") ?? ""),
      quantity: Number(String(formData.get("quantity") ?? "1")),
      unit: String(formData.get("unit") ?? "each"),
      unit_price_cents: dollarsInputToCents(String(formData.get("unit_price") ?? "0")),
      is_alternate: formData.get("is_alternate") === "on",
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

// ─────────────── page render ───────────────

export default async function ProposalEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string; proposalId: string }>;
  searchParams: Promise<{ saved?: string; error?: string; created?: string; sent?: string }>;
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

  const [lineItems, products, allExclusions] = await Promise.all([
    listLineItemsForProposal(proposalId),
    listProducts({ includeInactive: false }),
    listExclusions({ activeOnly: true }),
  ]);
  const selectedExclusions = allExclusions.filter((e) =>
    proposal.exclusion_ids.includes(e.id)
  );
  const inclusions = lineItems.filter((i) => !i.is_alternate);
  const alternates = lineItems.filter((i) => i.is_alternate);
  const oppName = derivedOppName(opp, account.company_name);
  const totalLabel = proposalTotalLabel(selectedExclusions.map((e) => e.text));

  const listHref = `/commercial/accounts/${accountId}/deals/${dealId}/proposal`;

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
          <span>All revisions</span>
        </Link>
        <span aria-hidden className="text-ppp-charcoal-300">·</span>
        <span className="text-ppp-charcoal-900 font-medium">{oppName}</span>
      </nav>

      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-bold text-ppp-charcoal">Proposal R{proposal.revision_number}</h1>
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-white text-ppp-charcoal-700 border-ppp-charcoal-200">
            {proposalStatusLabel(proposal.status)}
          </span>
          <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">
            {totalLabel}: <strong className="text-ppp-charcoal-800">{formatDollars(proposal.total_cents)}</strong>
          </span>
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
          <Link
            href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/new?bump=${proposalId}`}
            className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[36px]"
          >
            Bump revision →
          </Link>
          {proposal.status === "draft" && inclusions.length > 0 && (
            <form action={sendProposalAction} className="inline-flex">
              {hiddenIds}
              <ConfirmSubmitButton
                message={`Send R${proposal.revision_number} to ${proposal.header_json.gc_company ?? "the customer"}? This snapshots the PDF into Files, flips the deal to Proposal · Sent, and notifies the team. You can still bump a new revision after.`}
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
        </div>
      </header>

      {sp.saved === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-sm text-emerald-800">Saved.</div>
      )}
      {sp.created === "1" && (
        <div className="bg-cc-brand-50 border border-cc-brand-200 rounded-lg px-4 py-2.5 text-sm text-cc-brand-800">
          Proposal created. Header prefilled from the deal — start with inclusions below.
        </div>
      )}
      {sp.sent === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900">
          <strong>Proposal sent.</strong> PDF snapshot saved to Files, deal flipped to <em>Proposal · Sent</em>, and the team was notified.
        </div>
      )}
      {sp.error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5 text-sm text-rose-800" role="alert">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {/* MAIN SAVE FORM — wraps every editable section EXCEPT line items. */}
      <form action={saveProposalAction} className="space-y-4">
        {hiddenIds}

        {/* Header block */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-bold text-ppp-charcoal">Header</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL_CLS}>GC / Customer name</span>
              <input type="text" name="gc_company" defaultValue={proposal.header_json.gc_company ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Proposal date</span>
              <input type="date" name="date_iso" defaultValue={proposal.header_json.date_iso ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block sm:col-span-2">
              <span className={LABEL_CLS}>GC address (one line per row)</span>
              <textarea name="gc_address_lines" defaultValue={gcAddrText} rows={2} className={TEXTAREA_CLS} placeholder="Line 1&#10;City, State ZIP" />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Attention</span>
              <input type="text" name="attention" defaultValue={proposal.header_json.attention ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Phone</span>
              <input type="text" name="phone" defaultValue={proposal.header_json.phone ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block sm:col-span-2">
              <span className={LABEL_CLS}>Email</span>
              <input type="email" name="email" defaultValue={proposal.header_json.email ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>PROJECT name</span>
              <input type="text" name="project_name" defaultValue={proposal.header_json.project_name ?? ""} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>PROJECT address</span>
              <input type="text" name="project_address" defaultValue={proposal.header_json.project_address ?? ""} className={INPUT_CLS} />
            </label>
          </div>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" name="show_cip_notice" defaultChecked={proposal.header_json.show_capital_improvement_notice ?? false} className="w-4 h-4 accent-cc-brand-600" />
            <span className="text-[13px] text-ppp-charcoal-700">Show yellow "Capital Improvement / NY Sales Tax" banner on PDF</span>
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
          />
        </section>

        {/* Alternate notes */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-2">
          <h2 className="text-sm font-bold text-ppp-charcoal">Alternate description</h2>
          <p className="text-[12px] text-ppp-charcoal-500">Optional summary paragraph above the alternate line items.</p>
          <textarea name="alternate_notes" defaultValue={proposal.alternate_notes ?? ""} rows={2} className={TEXTAREA_CLS} placeholder="e.g. Exterior: Power wash exterior of building." />
        </section>

        {/* Bid notes */}
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-2">
          <h2 className="text-sm font-bold text-ppp-charcoal">Bid notes (hidden on PDF unless populated)</h2>
          <textarea name="bid_notes" defaultValue={proposal.bid_notes ?? ""} rows={3} className={TEXTAREA_CLS} placeholder="Internal notes for the estimator. Leave blank to keep off the customer PDF." />
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

        {/* Footer save row */}
        <div className="flex items-center justify-between gap-3 flex-wrap sticky bottom-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="submit" className="inline-flex items-center px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 shadow-sm min-h-[44px]">
              Save proposal
            </button>
            <span className="text-[12px] text-ppp-charcoal-500">Line items save independently below.</span>
          </div>
        </div>
      </form>

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
          products={products}
          submitAction={addLineItemAction}
          isAlternate={false}
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
          products={products}
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
            <div className="grid grid-cols-12 gap-2 items-end">
              <label className="col-span-12 sm:col-span-6 block">
                <span className={LABEL_CLS}>Description</span>
                <input type="text" name="description" defaultValue={r.description} className={INPUT_CLS} required />
              </label>
              <label className="col-span-4 sm:col-span-2 block">
                <span className={LABEL_CLS}>Qty</span>
                <input type="text" inputMode="decimal" name="quantity" defaultValue={String(r.quantity)} className={`${INPUT_CLS} tabular-nums`} />
              </label>
              <label className="col-span-4 sm:col-span-2 block">
                <span className={LABEL_CLS}>Unit</span>
                <input type="text" name="unit" defaultValue={r.unit} className={INPUT_CLS} />
              </label>
              <label className="col-span-4 sm:col-span-2 block">
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
  }>;
  submitAction: (formData: FormData) => Promise<void>;
  isAlternate: boolean;
}) {
  const prefix = isAlternate ? "alt" : "inc";
  return (
    <form action={submitAction} className="border-t border-ppp-charcoal-100 pt-3 space-y-2">
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="proposal_id" value={proposalId} />
      {isAlternate && <input type="hidden" name="is_alternate" value="on" />}
      {products.length > 0 ? (
        <div className="max-w-sm">
          <ProductPicker
            products={products.map((p) => ({
              id: p.id,
              sku: p.sku,
              name: p.name,
              category: p.category,
              unit: p.unit,
              default_unit_price_cents: p.default_unit_price_cents,
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
        <label className="col-span-12 sm:col-span-6 block">
          <span className={LABEL_CLS}>Description</span>
          <input type="text" id={`${prefix}-desc`} name="description" required placeholder="e.g. GWB Ceiling & Soffit: Standard prep, prime + 2 coats matte." className={INPUT_CLS} />
        </label>
        <label className="col-span-4 sm:col-span-2 block">
          <span className={LABEL_CLS}>Qty</span>
          <input type="text" inputMode="decimal" name="quantity" defaultValue="1" className={`${INPUT_CLS} tabular-nums`} />
        </label>
        <label className="col-span-4 sm:col-span-2 block">
          <span className={LABEL_CLS}>Unit</span>
          <input type="text" id={`${prefix}-unit`} name="unit" defaultValue="each" className={INPUT_CLS} />
        </label>
        <label className="col-span-4 sm:col-span-2 block">
          <span className={LABEL_CLS}>Unit price</span>
          <input type="text" id={`${prefix}-price`} inputMode="decimal" name="unit_price" defaultValue="0.00" className={`${INPUT_CLS} tabular-nums`} />
        </label>
      </div>
      <div className="flex justify-end">
        <button type="submit" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[40px]">
          Add {isAlternate ? "alternate" : "inclusion"}
        </button>
      </div>
    </form>
  );
}
