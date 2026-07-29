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
import { ProjectToolbar } from "@/components/commercial/project-toolbar";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { getInvoiceContext } from "@/lib/commercial/invoices/db";
import {
  createChangeOrder,
  updateChangeOrder,
  decideChangeOrder,
  billChangeOrder,
  deleteChangeOrder,
} from "@/lib/commercial/change-orders/db";
import { ChangeOrdersPanel } from "@/components/commercial/change-orders-panel";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{
  co_ok?: string;
  error?: string;
  edit_co?: string;
  co_title?: string;
  co_amt?: string;
  co_desc?: string;
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

async function addChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const rawTitle = String(formData.get("title") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDesc = String(formData.get("description") ?? "");
  const preserve = { co_title: rawTitle.slice(0, 200), co_amt: rawAmount.slice(0, 40), co_desc: rawDesc.slice(0, 1000) };
  const amount_cents = parseDollarsToCents(rawAmount);
  if (amount_cents === null || amount_cents === 0) {
    coRedirect(account_id, opp_id, { error: "Enter a non-zero amount (use a minus sign for a deduct, e.g. -500.00).", ...preserve });
  }
  const result = await createChangeOrder({
    opportunity_id: opp_id,
    title: rawTitle.trim(),
    description: rawDesc.trim() || null,
    amount_cents: amount_cents!,
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
  const preserve = { edit_co: co_id, co_title: rawTitle.slice(0, 200), co_amt: rawAmount.slice(0, 40), co_desc: rawDesc.slice(0, 1000) };
  const amount_cents = parseDollarsToCents(rawAmount);
  if (amount_cents === null || amount_cents === 0) {
    coRedirect(account_id, opp_id, { error: "Enter a non-zero amount (use a minus sign for a deduct).", ...preserve });
  }
  const result = await updateChangeOrder(co_id, { title: rawTitle.trim(), description: rawDesc.trim() || null, amount_cents: amount_cents! }, userId);
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

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      {/* Back to the account (opportunities tab, scrolled to this deal). */}
      <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        {/* Back to the deal DRAWER (where the operator clicked in from), not a
            #deal-row anchor — the anchor scroll was unreliable and dumped the
            user at the top of the account (Karan 2026-07-28). */}
        <Link href={`/commercial/accounts/${id}?tab=projects`} className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
          {account.company_name} · Projects
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/commercial/accounts/${id}?tab=projects&project=${dealId}`} className="text-ppp-charcoal-700 font-medium truncate hover:text-cc-brand-700 min-h-[32px] inline-flex items-center">{dealName}</Link>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Change Orders</h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span>
          </p>
        </div>
      </div>

      <ProjectToolbar accountId={id} dealId={dealId} active="change-orders" />

      <ChangeOrdersPanel
        oppId={opp.id}
        accountId={id}
        baseContractCents={baseContractCents}
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
