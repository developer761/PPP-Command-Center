/**
 * Change Orders — account-scoped page (Phase G v2, Karan 2026-07-28).
 *
 * Karan: "it should be under the account, not under opportunities... make it
 * visible so people don't have to go searching." Change Orders live on the
 * post-sale Project (the deal), but the home is here under the account — the
 * same pattern as the Debrief page — so it's reachable in one click from the
 * account deal view and never stranded on the bounce-prone opp detail page.
 *
 * All five actions redirect back to THIS page and revalidate every surface a
 * change order touches (account 360, dashboard, invoices) so KPIs + financials
 * stay in sync.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
} from "@/lib/commercial/opportunities/db";
import { isPostSaleProject, oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { getInvoiceContext } from "@/lib/commercial/invoices/db";
import { listProposalsForOpp, formatProposalNumber, type CommercialProposal } from "@/lib/commercial/proposals/db";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import {
  createChangeOrder,
  updateChangeOrder,
  decideChangeOrder,
  billChangeOrder,
  deleteChangeOrder,
} from "@/lib/commercial/change-orders/db";
import { ChangeOrdersPanel } from "@/components/commercial/change-orders-panel";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{
  co_ok?: string;
  error?: string;
  edit_co?: string;
  co_title?: string;
  co_amt?: string;
  co_desc?: string;
  back?: string;
}>;

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

function coBase(accountId: string, oppId: string): string {
  return `/commercial/accounts/${accountId}/change-orders/${oppId}`;
}
function coRedirect(accountId: string, oppId: string, params: Record<string, string>): never {
  const qs = new URLSearchParams(params);
  const q = qs.toString();
  redirect(q ? `${coBase(accountId, oppId)}?${q}` : coBase(accountId, oppId));
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
  const num = formatProposalNumber(p.proposal_seq) || `Rev ${p.revision_number}`;
  const status = p.status.charAt(0).toUpperCase() + p.status.slice(1);
  return `${num} · ${formatCentsFull(p.total_cents)} · ${status}`;
}

async function addChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const rawTitle = String(formData.get("title") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDesc = String(formData.get("description") ?? "");
  const rawDirection = String(formData.get("direction") ?? "add");
  const rawProposal = String(formData.get("proposal_id") ?? "");
  const preserve = { co_title: rawTitle.slice(0, 200), co_amt: rawAmount.slice(0, 40), co_desc: rawDesc.slice(0, 1000) };
  const signed = signedAmountCents(rawAmount, rawDirection);
  if (signed === null || signed === 0) {
    coRedirect(account_id, opp_id, { error: "Enter an amount greater than zero, then pick Add or Deduct.", ...preserve });
  }
  const result = await createChangeOrder({
    opportunity_id: opp_id,
    title: rawTitle.trim(),
    description: rawDesc.trim() || null,
    amount_cents: signed!,
    proposal_id: UUID_RE.test(rawProposal) ? rawProposal : null,
    created_by_user_id: userId,
  });
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error, ...preserve });
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "added" });
}

async function editChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
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
    coRedirect(account_id, opp_id, { error: "Enter an amount greater than zero, then pick Add or Deduct.", ...preserve });
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
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error, ...preserve });
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "saved" });
}

async function decideChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  if (decision !== "approved" && decision !== "declined") coRedirect(account_id, opp_id, { error: "Unknown decision." });
  const result = await decideChangeOrder(co_id, decision as "approved" | "declined", userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error });
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: decision === "approved" ? "approved" : "declined" });
}

async function billChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const result = await billChangeOrder(co_id, userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error });
  revalidateChangeOrderSurfaces(account_id, opp_id);
  revalidatePath("/commercial/invoices");
  const ctx = await getInvoiceContext(result.value.id);
  if (ctx.account_id) revalidatePath(`/commercial/accounts/${ctx.account_id}`);
  redirect(`/commercial/invoices/${result.value.id}?co_billed=1`);
}

async function deleteChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const result = await deleteChangeOrder(co_id, userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error });
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "deleted" });
}

export default async function AccountChangeOrdersPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  await requireCommercialUser();
  const { id, dealId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([
    getCommercialAccount(id),
    getCommercialOpportunity(dealId),
  ]);
  if (!account || !opp) notFound();
  // Ownership: the deal must belong to this account (enumeration-safe).
  if (opp.account_id !== id) notFound();
  // Change Orders only exist on post-sale Projects. A pre-sale deal has none —
  // send the user back to the account rather than showing an empty CO page.
  if (!isPostSaleProject(opp)) {
    redirect(`/commercial/accounts/${id}?tab=opportunities&edit=${dealId}&status_error=${encodeURIComponent("This opens once the deal is Won and in delivery — mark it Won first.")}`);
  }

  const dealName = derivedOppName(opp, account.company_name);
  // Same contract-base ladder the AIA G702 + Projects + Account 360 use, so all
  // four surfaces show the same "contract to date" (was the bare bid midpoint).
  const base = await getEffectiveContractBaseCents(dealId);
  const baseContractCents = base > 0 ? base : null;
  // Proposals on this project — so a CO can name WHICH proposal's scope it
  // amends (Karan 2026-07-29). Reduced to the fields the panel dropdown needs.
  const proposals = (await listProposalsForOpp(dealId)).map((p) => ({
    id: p.id,
    label: proposalPickerLabel(p),
  }));

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

      <ChangeOrdersPanel
        oppId={opp.id}
        accountId={id}
        baseContractCents={baseContractCents}
        proposals={proposals}
        addAction={addChangeOrderAction}
        editAction={editChangeOrderAction}
        decideAction={decideChangeOrderAction}
        billAction={billChangeOrderAction}
        deleteAction={deleteChangeOrderAction}
        okFlag={sp.co_ok ?? null}
        errorMessage={sp.error ?? null}
        editCoId={sp.edit_co ?? null}
        preserveTitle={sp.co_title ?? null}
        preserveAmount={sp.co_amt ?? null}
        preserveDesc={sp.co_desc ?? null}
      />
    </div>
  );
}
