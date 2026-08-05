/**
 * Change Orders — shared tool body (Karan 2026-08).
 *
 * The Change Orders UI now lives inline under the deal's **Project** sub-tab
 * (deal view → Project → Change Orders). This module holds the data fetching +
 * the five server actions + the render, so BOTH the standalone route
 * (`change-orders/[dealId]/page.tsx`) and the deal view render the exact same
 * body — one source of truth.
 *
 * Canonical URL for every redirect/link is the deal's Project sub-tab, so an
 * action taken on the standalone route hands you back to the inline view.
 */
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
} from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { getInvoiceContext, listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { listProposalsForOpp, formatProposalNumber, type CommercialProposal } from "@/lib/commercial/proposals/db";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import {
  createChangeOrder,
  updateChangeOrder,
  decideChangeOrder,
  setChangeOrderInvoiced,
  deleteChangeOrder,
} from "@/lib/commercial/change-orders/db";
import { ChangeOrdersPanel } from "@/components/commercial/change-orders-panel";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";

export type ChangeOrdersSP = {
  co_ok?: string;
  error?: string;
  heads_up?: string;
  edit_co?: string;
  co_title?: string;
  co_amt?: string;
  co_desc?: string;
  back?: string;
};

async function requireCommercialUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}

/** Revalidate every surface a change order feeds. */
function revalidateChangeOrderSurfaces(accountId: string, oppId: string) {
  revalidatePath(`/commercial/accounts/${accountId}/change-orders/${oppId}`);
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
}

/** Canonical home for Change Orders = the deal's Project sub-tab. */
export function coBase(accountId: string, oppId: string, origin?: string): string {
  // Return you to WHERE you are — standalone tool when opened directly, the
  // account's deal (Project sub-tab) view when embedded there. Never jump.
  return origin === "route"
    ? `/commercial/accounts/${accountId}/change-orders/${oppId}?v=1`
    : `/commercial/accounts/${accountId}?tab=projects&project=${oppId}&dt=change-orders`;
}
function coRedirect(accountId: string, oppId: string, params: Record<string, string>, back = "", origin = ""): never {
  const p = { ...params };
  // Preserve the sidebar-tool origin (?back=/commercial/post-job/...) so the
  // "← Back to Change Orders" header survives every action.
  if (back && back.startsWith("/commercial/post-job/")) p.back = back;
  const qs = new URLSearchParams(p).toString();
  const b = coBase(accountId, oppId, origin);
  redirect(qs ? `${b}${b.includes("?") ? "&" : "?"}${qs}` : b);
}

/**
 * Resolve the signed CO amount from a positive dollar field + an explicit
 * Add/Deduct direction. The amount field is always entered positive now; the
 * radio decides the sign. Back-compat: a stray minus in the amount still forces
 * a deduct. Returns null on unparseable input, 0 when the magnitude is zero.
 */
function signedAmountCents(rawAmount: string, direction: string): number | null {
  const cents = parseDollarsToCents(rawAmount);
  if (cents === null) return null;
  const magnitude = Math.abs(cents);
  if (magnitude === 0) return 0;
  const isDeduct = direction === "deduct" || cents < 0;
  return isDeduct ? -magnitude : magnitude;
}

/** Human label for a proposal in the CO "which proposal" dropdown. */
function proposalPickerLabel(p: CommercialProposal): string {
  const num = formatProposalNumber(p.proposal_seq) || `R${p.revision_number}`;
  const status = p.status.charAt(0).toUpperCase() + p.status.slice(1);
  return `${num} · ${formatCentsFull(p.total_cents)} · ${status}`;
}

async function addChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const rawTitle = String(formData.get("title") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDesc = String(formData.get("description") ?? "");
  const rawDirection = String(formData.get("direction") ?? "add");
  const rawProposal = String(formData.get("proposal_id") ?? "");
  const preserve = { co_title: rawTitle.slice(0, 200), co_amt: rawAmount.slice(0, 40), co_desc: rawDesc.slice(0, 1000) };
  const signed = signedAmountCents(rawAmount, rawDirection);
  if (signed === null || signed === 0) {
    coRedirect(account_id, opp_id, { error: "Enter an amount greater than zero, then pick Add or Deduct.", ...preserve }, back, origin);
  }
  const result = await createChangeOrder({
    opportunity_id: opp_id,
    title: rawTitle.trim(),
    description: rawDesc.trim() || null,
    amount_cents: signed!,
    proposal_id: UUID_RE.test(rawProposal) ? rawProposal : null,
    created_by_user_id: userId,
  });
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error, ...preserve }, back, origin);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "added" }, back, origin);
}

async function editChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const rawTitle = String(formData.get("title") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDesc = String(formData.get("description") ?? "");
  const rawDirection = String(formData.get("direction") ?? "add");
  const rawProposal = String(formData.get("proposal_id") ?? "");
  const preserve = { edit_co: co_id, co_title: rawTitle.slice(0, 200), co_amt: rawAmount.slice(0, 40), co_desc: rawDesc.slice(0, 1000) };
  const signed = signedAmountCents(rawAmount, rawDirection);
  if (signed === null || signed === 0) {
    coRedirect(account_id, opp_id, { error: "Enter an amount greater than zero, then pick Add or Deduct.", ...preserve }, back, origin);
  }
  const result = await updateChangeOrder(
    co_id,
    {
      title: rawTitle.trim(),
      description: rawDesc.trim() || null,
      amount_cents: signed!,
      proposal_id: UUID_RE.test(rawProposal) ? rawProposal : null,
    },
    userId,
  );
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error, ...preserve }, back, origin);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "saved" }, back, origin);
}

async function decideChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  if (decision !== "approved" && decision !== "declined") coRedirect(account_id, opp_id, { error: "Unknown decision." }, back, origin);
  const result = await decideChangeOrder(co_id, decision as "approved" | "declined", userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error }, back, origin);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: decision === "approved" ? "approved" : "declined" }, back, origin);
}

async function billChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  const on = String(formData.get("on") ?? "1") === "1";
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const result = await setChangeOrderInvoiced(co_id, on, userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error }, back, origin);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  revalidatePath("/commercial/invoices");
  if (result.invoice) {
    revalidatePath(`/commercial/invoices/${result.invoice.id}`);
    const ctx = await getInvoiceContext(result.invoice.id);
    if (ctx.account_id) revalidatePath(`/commercial/accounts/${ctx.account_id}`);
  }
  // A brand-new draft was minted for this CO (the deal had no invoice yet). Land
  // ON it so the team reviews the terms + SENDS it — otherwise the CO sits on an
  // unsent draft and never actually bills. `co_billed=1` lights the invoice
  // page's purpose-built "review & send" nudge, which was previously unreachable
  // (audit F5).
  if (on && result.createdDraft && result.invoice) {
    redirect(`/commercial/invoices/${result.invoice.id}?co_billed=1`);
  }
  // Otherwise stay on the Change Orders tool (so you can tick more than one),
  // showing the updated chip. A never-reject heads-up (over-credit,
  // credit-on-untick, repriced-sent-bill) rides along as a small note.
  coRedirect(
    account_id,
    opp_id,
    { co_ok: on ? "billed" : "unbilled", ...(result.warning ? { heads_up: result.warning } : {}) },
    back,
    origin
  );
}

async function deleteChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const result = await deleteChangeOrder(co_id, userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error }, back, origin);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "deleted" }, back, origin);
}

/**
 * The Change Orders tool body. `variant="route"` adds the standalone-page
 * chrome (back header + heading + max-width). `variant="inline"` is bare for
 * embedding inside the deal Project sub-tab (which supplies its own chrome).
 */
export async function ChangeOrdersTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: ChangeOrdersSP;
  variant: "route" | "inline";
}) {
  await requireCommercialUser();
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([
    getCommercialAccount(id),
    getCommercialOpportunity(dealId),
  ]);
  if (!account || !opp) notFound();
  // Ownership: the deal must belong to this account (enumeration-safe).
  if (opp.account_id !== id) notFound();
  // No Won-gate: Change Orders are available on every deal (Karan 2026-08 —
  // nothing locked). A bid simply has none yet.

  const dealName = derivedOppName(opp, account.company_name);
  // Same contract-base ladder the AIA G702 + Projects + Account 360 use, so all
  // four surfaces show the same "contract to date" (was the bare bid midpoint).
  const base = await getEffectiveContractBaseCents(dealId);
  const baseContractCents = base > 0 ? base : null;
  const [proposalRows, dealInvoices] = await Promise.all([
    listProposalsForOpp(dealId),
    listCommercialInvoices({ opportunityId: dealId }),
  ]);
  const proposalsWithIssuedInvoice = new Set(
    dealInvoices
      .filter((inv) => inv.proposal_id && inv.status !== "draft" && inv.status !== "void")
      .map((inv) => inv.proposal_id as string),
  );
  const proposals = proposalRows.map((p) => ({
    id: p.id,
    label: proposalPickerLabel(p),
    totalCents: p.total_cents,
    hasInvoice: proposalsWithIssuedInvoice.has(p.id),
  }));

  const panel = (
    <ChangeOrdersPanel
      oppId={opp.id}
      accountId={id}
      back={sp.back ?? ""}
      origin={variant}
      basePath={coBase(id, dealId, variant)}
      baseContractCents={baseContractCents}
      proposals={proposals}
      addAction={addChangeOrderAction}
      editAction={editChangeOrderAction}
      decideAction={decideChangeOrderAction}
      billAction={billChangeOrderAction}
      deleteAction={deleteChangeOrderAction}
      okFlag={sp.co_ok ?? null}
      errorMessage={sp.error ?? null}
      headsUp={sp.heads_up ?? null}
      editCoId={sp.edit_co ?? null}
      preserveTitle={sp.co_title ?? null}
      preserveAmount={sp.co_amt ?? null}
      preserveDesc={sp.co_desc ?? null}
    />
  );

  if (variant === "inline") {
    // Bare — the deal's Project sub-tab supplies the heading + chrome.
    return <div className="space-y-4">{panel}</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Change Orders</h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span>
          </p>
        </div>
      </div>
      {panel}
    </div>
  );
}
