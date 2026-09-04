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
import { proposalLabel } from "@/lib/commercial/proposals/constants";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
} from "@/lib/commercial/opportunities/db";
import { getEffectiveContractBaseCents, aiaBillingRollupBulk } from "@/lib/commercial/aia/db";
import { listAccountContacts } from "@/lib/commercial/accounts/contacts";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { getInvoiceContext, listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { listProposalsForOpp, proposalDisplayId, type CommercialProposal } from "@/lib/commercial/proposals/db";
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
import { normalizeToolOrigin, toolOriginQs } from "@/lib/commercial/tool-origin";

export type ChangeOrdersSP = {
  co_ok?: string;
  /** Change-order send result (Stephanie 2026-08-18). */
  co_sent?: string;
  co_send_error?: string;
  error?: string;
  heads_up?: string;
  edit_co?: string;
  co_title?: string;
  co_amt?: string;
  co_desc?: string;
  back?: string;
  from?: string;
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
  revalidatePath(`/commercial/opportunities/${oppId}`);
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
}

/** Canonical home for Change Orders = the deal's Project sub-tab. */
export function coBase(accountId: string, oppId: string, origin?: string): string {
  // Return you to WHERE you are — standalone tool when opened directly, the
  // account's deal (Project sub-tab) view when embedded there. Never jump.
  return `/commercial/opportunities/${oppId}?tab=project&sub=change-orders`;
}
function coRedirect(accountId: string, oppId: string, params: Record<string, string>, back = "", origin = "", from = ""): never {
  const p = { ...params };
  // Preserve the sidebar-tool origin (?back=/commercial/post-job/...) so the
  // "← Back to Change Orders" header survives every action.
  if (back && back.startsWith("/commercial/post-job/")) p.back = back;
  // Preserve the deal-tab origin (?from=overview) so the inline back arrow
  // returns to where the tool was opened even after a save.
  const fromTab = normalizeToolOrigin(from);
  if (fromTab) p.from = fromTab;
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
  const num = proposalDisplayId(p) || proposalLabel(p);
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
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const rawTitle = String(formData.get("title") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDesc = String(formData.get("description") ?? "");
  const rawDirection = String(formData.get("direction") ?? "add");
  const rawProposal = String(formData.get("proposal_id") ?? "");
  const preserve = { co_title: rawTitle.slice(0, 200), co_amt: rawAmount.slice(0, 40), co_desc: rawDesc.slice(0, 1000) };
  const signed = signedAmountCents(rawAmount, rawDirection);
  if (signed === null || signed === 0) {
    coRedirect(account_id, opp_id, { error: "Enter an amount greater than zero, then pick Add or Deduct.", ...preserve }, back, origin, from);
  }
  const result = await createChangeOrder({
    opportunity_id: opp_id,
    title: rawTitle.trim(),
    description: rawDesc.trim() || null,
    amount_cents: signed!,
    proposal_id: UUID_RE.test(rawProposal) ? rawProposal : null,
    created_by_user_id: userId,
  });
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error, ...preserve }, back, origin, from);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "added" }, back, origin, from);
}

async function editChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
    coRedirect(account_id, opp_id, { error: "Enter an amount greater than zero, then pick Add or Deduct.", ...preserve }, back, origin, from);
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
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error, ...preserve }, back, origin, from);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "saved" }, back, origin, from);
}

async function decideChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  if (decision !== "approved" && decision !== "declined") coRedirect(account_id, opp_id, { error: "Unknown decision." }, back, origin, from);
  const result = await decideChangeOrder(co_id, decision as "approved" | "declined", userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error }, back, origin, from);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: decision === "approved" ? "approved" : "declined" }, back, origin, from);
}

async function billChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  const on = String(formData.get("on") ?? "1") === "1";
  // Which invoice under this deal to bill on: a draft's uuid, the sentinel "new"
  // for a CO-only invoice, or "" to keep the default (current draft, else new).
  const rawTarget = String(formData.get("target_invoice_id") ?? "");
  const target = rawTarget === "new" || UUID_RE.test(rawTarget) ? rawTarget : null;
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const result = await setChangeOrderInvoiced(co_id, on, userId, on ? target : null);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error }, back, origin, from);
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
    // Carry the heads-up through. The AIA double-bill caution is set ONLY in
    // the branch that mints a fresh draft — which is exactly this branch — so
    // dropping it here made that warning unreachable on every path it was
    // written for: approve a CO on a deal already billing through AIA, land on
    // the new draft, and nothing tells you the same money is on the G702.
    const headsUp = result.warning ? `&heads_up=${encodeURIComponent(result.warning)}` : "";
    redirect(`/commercial/invoices/${result.invoice.id}?co_billed=1${headsUp}`);
  }
  // Otherwise stay on the Change Orders tool (so you can tick more than one),
  // showing the updated chip. A never-reject heads-up (over-credit,
  // credit-on-untick, repriced-sent-bill) rides along as a small note.
  // A CREDIT has nothing to reduce on an empty invoice, so it can come back
  // applied-for-$0 with no invoice attached. Reporting the usual green "added
  // to the invoice" there was a lie: the credit landed nowhere, the CO stayed
  // un-billed, and (until the report fix) it showed up in no unbilled tally
  // either. Say so instead.
  const nothingApplied = on && !result.invoice;
  coRedirect(
    account_id,
    opp_id,
    {
      co_ok: nothingApplied ? "nothing_to_credit" : on ? "billed" : "unbilled",
      ...(result.warning ? { heads_up: result.warning } : {}),
    },
    back,
    origin,
    from
  );
}

/**
 * Email a change order to the GC for written approval.
 *
 * Stephanie: a CO "requires us to first submit it in writing in proposal format
 * and then an approval from the customer." The document and the approval
 * statuses both existed; sending was the gap, so it happened outside the
 * platform and left no trace on the job.
 *
 * Human-reviewed like every other outbound here — recipient, subject and body
 * all come from the form. Sending does NOT approve: status still moves only
 * when someone records the customer's answer.
 */
async function sendChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const change_order_id = String(formData.get("change_order_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(change_order_id)) {
    redirect("/commercial/accounts");
  }

  const { emailChangeOrderToGc } = await import("@/lib/commercial/change-orders/email");
  const res = await emailChangeOrderToGc({
    change_order_id,
    actor_user_id: userId,
    to_email: String(formData.get("to_email") ?? ""),
    cc_email: String(formData.get("cc_email") ?? "") || null,
    subject: String(formData.get("subject") ?? ""),
    message: String(formData.get("message") ?? ""),
  });
  if (!res.ok) coRedirect(account_id, opp_id, { co_send_error: res.error }, back, origin, from);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_sent: res.to_email }, back, origin, from);
}

async function deleteChangeOrderAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const co_id = String(formData.get("co_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(co_id)) redirect("/commercial/accounts");
  const result = await deleteChangeOrder(co_id, userId);
  if (!result.ok) coRedirect(account_id, opp_id, { error: result.error }, back, origin, from);
  revalidateChangeOrderSurfaces(account_id, opp_id);
  coRedirect(account_id, opp_id, { co_ok: "deleted" }, back, origin, from);
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
  const [proposalRows, dealInvoices, coContacts, coAiaRoll] = await Promise.all([
    listProposalsForOpp(dealId),
    listCommercialInvoices({ opportunityId: dealId }),
    listAccountContacts(id).catch(() => []),
    // Does this job bill through AIA? Drives the "COs flow onto the next
    // application" note, so nobody is invited to invoice one separately.
    aiaBillingRollupBulk([dealId]).then((m) => m.get(dealId) ?? null).catch(() => null),
  ]);
  // Best guess at who signs a change order: a PM or project contact first, then
  // anyone with an email. Stephanie shouldn't retype the address every time.
  const sendToDefault =
    coContacts.find((c) =>
      /project\s*manager|\bpm\b|superintend|construction/i.test(c.contact.title ?? "")
    )?.contact.email ||
    coContacts.find((c) => c.contact.email)?.contact.email ||
    "";
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

  // Draft invoices are the only ones a change-order line can still join (an
  // issued/paid invoice is frozen). The panel offers these + "New invoice" so
  // the team picks where the CO lands. Newest first, matching the invoices tab.
  const draftInvoices = dealInvoices
    .filter((inv) => inv.status === "draft")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((inv) => ({
      id: inv.id,
      number: inv.invoice_number,
      subtotalCents: inv.subtotal_cents,
    }));

  const panel = (
    <ChangeOrdersPanel
      oppId={opp.id}
      accountId={id}
      back={sp.back ?? ""}
      from={sp.from ?? ""}
      origin={variant}
      basePath={`${coBase(id, dealId, variant)}${toolOriginQs(sp.from)}`}
      baseContractCents={baseContractCents}
      proposals={proposals}
      draftInvoices={draftInvoices}
      addAction={addChangeOrderAction}
      editAction={editChangeOrderAction}
      decideAction={decideChangeOrderAction}
      billAction={billChangeOrderAction}
      deleteAction={deleteChangeOrderAction}
      sendAction={sendChangeOrderAction}
      sendToDefault={sendToDefault}
      hasAiaBilling={!!coAiaRoll?.hasAia}
      sendOk={sp.co_sent ?? null}
      sendError={sp.co_send_error ?? null}
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
