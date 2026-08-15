/**
 * Change Orders panel (Phase G v2, 2026-07-28). Reusable server component so
 * the canonical account-scoped page AND any post-contract embed render one
 * implementation. The host passes the 5 server actions + account/deal ids;
 * this component fetches its own data and owns the layout.
 *
 * Redesign vs v1: a contract-sum summary strip (Original → Net approved →
 * Contract sum to date, + Billed) replaces the flat header, so the panel reads
 * like a running financial picture instead of an empty box. Warmer empty
 * state, clearer hierarchy.
 */
import Link from "next/link";
import {
  listChangeOrders,
  liveInvoiceIds,
  billedChangeOrderChips,
} from "@/lib/commercial/change-orders/db";
import { changeOrderAttachmentsByOrder } from "@/lib/commercial/change-orders/attachments";
import { ChangeOrderAttachments } from "@/components/commercial/change-order-attachments";
import { DonutChart } from "@/components/commercial/charts";
import {
  CHANGE_ORDER_STATUS_META,
  formatChangeOrderNumber,
  changeOrderKind,
} from "@/lib/commercial/change-orders/constants";
import { formatCentsFull, formatCentsCompact, fmtEtDate } from "@/lib/commercial/invoices/format";
import { INPUT_CLS, TEXTAREA_CLS, LABEL_CLS, SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";

type CoAction = (formData: FormData) => void | Promise<void>;

function ChangeOrderPill({ status }: { status: "pending" | "approved" | "declined" }) {
  const meta = CHANGE_ORDER_STATUS_META[status];
  const cls =
    meta.tone === "emerald"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : meta.tone === "rose"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : "bg-amber-50 text-amber-800 border-amber-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${cls}`}>
      {meta.label}
    </span>
  );
}

/** Signed CO amount, e.g. "+$1,200.00" (add) or "−$500.00" (deduct). */
function signedCents(amountCents: number): string {
  const abs = formatCentsFull(Math.abs(amountCents));
  return amountCents < 0 ? `−${abs}` : `+${abs}`;
}

const CO_OK_MESSAGES: Record<string, string> = {
  added: "Change order added.",
  saved: "Change order updated.",
  approved: "Change order approved — it now counts toward the contract sum.",
  declined: "Change order declined — it won't affect the contract sum.",
  deleted: "Change order deleted.",
  billed: "Change order added to the invoice.",
  unbilled: "Change order removed from the invoice.",
};

type ProposalOption = { id: string; label: string; totalCents?: number; hasInvoice?: boolean };

export async function ChangeOrdersPanel({
  oppId,
  accountId,
  back = "",
  from = "",
  baseContractCents,
  proposals = [],
  draftInvoices = [],
  addAction,
  editAction,
  decideAction,
  billAction,
  deleteAction,
  okFlag,
  errorMessage,
  headsUp,
  editCoId,
  preserveTitle,
  preserveAmount,
  preserveDesc,
  basePath,
  origin = "",
}: {
  oppId: string;
  accountId: string;
  /** The ?back= sidebar-tool origin to carry through every form action. */
  back?: string;
  /** The ?from= deal-tab origin (overview/docs/activity) so the inline back
   *  arrow returns to where the tool was opened, even after a save. */
  from?: string;
  /** "route" | "inline" — where the tool is rendered, so actions return you here. */
  origin?: string;
  /** Canonical base URL for this panel's own links (Dismiss/Cancel/Edit). The
   *  caller decides whether that's the standalone tool route or the deal's
   *  Project sub-tab, so the panel works identically inline or on its own page. */
  basePath: string;
  /** The deal's base bid (midpoint) — the "original contract" the COs adjust.
   *  Null when the deal has no bid range; the summary adapts. */
  baseContractCents: number | null;
  /** Proposals on this project, for the "which proposal does this CO amend?"
   *  picker. Empty when the deal has no proposals — the picker hides. */
  proposals?: ProposalOption[];
  /** The deal's DRAFT invoices — the only ones a CO line can still join. The
   *  "bill" control offers these + "New invoice" so the team picks the target.
   *  Empty → the CO goes straight onto a fresh CO-only draft. */
  draftInvoices?: { id: string; number: string; subtotalCents: number }[];
  addAction: CoAction;
  editAction: CoAction;
  decideAction: CoAction;
  billAction: CoAction;
  deleteAction: CoAction;
  okFlag?: string | null;
  errorMessage?: string | null;
  headsUp?: string | null;
  editCoId?: string | null;
  preserveTitle?: string | null;
  preserveAmount?: string | null;
  preserveDesc?: string | null;
}) {
  const items = await listChangeOrders(oppId);
  const [liveInvoices, coChips, coAttachments] = await Promise.all([
    liveInvoiceIds(items.map((c) => c.invoiced_invoice_id).filter((x): x is string => !!x)),
    billedChangeOrderChips(items),
    // Signed CO PDFs / backup, per change order — one batched query.
    changeOrderAttachmentsByOrder(items.map((c) => c.id)),
  ]);
  const proposalById = new Map(proposals.map((p) => [p.id, p]));
  // Net APPROVED change-order $ per proposal — a CO tied to a proposal moves
  // THAT proposal's effective contract (add for +, deduct for −).
  const netApprovedByProposal = new Map<string, number>();
  for (const c of items) {
    if (c.status === "approved" && c.proposal_id) {
      netApprovedByProposal.set(c.proposal_id, (netApprovedByProposal.get(c.proposal_id) ?? 0) + c.amount_cents);
    }
  }

  const approved = items.filter((c) => c.status === "approved");
  const netApprovedCents = approved.reduce((acc, c) => acc + c.amount_cents, 0);
  const pendingCount = items.filter((c) => c.status === "pending").length;
  // Billed = approved COs on a live, ISSUED invoice. A CO sitting on an unsent
  // DRAFT isn't billed to the GC yet (matches the issued-only account/deal
  // "Invoiced" figures), so it's excluded here + counted as "on a draft" below
  // (audit F4).
  const billedCents = approved.reduce((acc, c) => {
    const chip = coChips.get(c.id);
    return chip && !chip.isDraft ? acc + c.amount_cents : acc;
  }, 0);
  const onDraftCount = approved.filter((c) => coChips.get(c.id)?.isDraft).length;
  const contractToDateCents =
    baseContractCents != null ? baseContractCents + netApprovedCents : null;

  // basePath is provided by the caller (route vs inline). Append query params
  // with the right separator since the inline base already carries a query.
  const joinUrl = (extra: string) => (basePath.includes("?") ? `${basePath}&${extra}` : `${basePath}?${extra}`);
  const hasPreserved = preserveTitle != null || preserveAmount != null || preserveDesc != null;
  const addAttemptFailed = hasPreserved && !editCoId;

  return (
    <div className="space-y-3">
      {okFlag && CO_OK_MESSAGES[okFlag] ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800">
          <span className="inline-flex items-start gap-2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg>
            {CO_OK_MESSAGES[okFlag]}
          </span>
          <Link href={basePath} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      ) : null}
      {errorMessage ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3 bg-rose-50 border border-rose-200 text-rose-700">
          <span>{errorMessage}</span>
          <Link href={basePath} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      ) : null}
      {headsUp ? (
        <div className="rounded-lg px-4 py-2.5 text-[12.5px] flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>{headsUp}</span>
        </div>
      ) : null}

      {/* ── Summary strip — the running contract picture ── */}
      <section className="bg-gradient-to-br from-cc-brand-50/60 to-surface border border-cc-brand-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3">
          <span aria-hidden className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-cc-brand-600 text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </span>
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal leading-tight">Change Orders</h2>
            <p className="text-[11px] text-ppp-charcoal-500 leading-snug">
              Scope added or deducted mid-job. Approved change orders adjust the contract sum; additions bill on their own invoice.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryTile
            label="Original contract"
            value={baseContractCents != null ? formatCentsFull(baseContractCents) : "—"}
            hint={baseContractCents == null ? "No bid set" : undefined}
          />
          <SummaryTile
            label="Net approved COs"
            value={netApprovedCents === 0 ? formatCentsFull(0) : signedCents(netApprovedCents)}
            tone={netApprovedCents < 0 ? "rose" : netApprovedCents > 0 ? "emerald" : "neutral"}
          />
          <SummaryTile
            label="Contract to date"
            value={contractToDateCents != null ? formatCentsFull(contractToDateCents) : "—"}
            emphasize
          />
          <SummaryTile
            label="Billed"
            value={formatCentsFull(billedCents)}
            tone={billedCents > 0 ? "emerald" : "neutral"}
            hint={
              onDraftCount > 0
                ? `${onDraftCount} on a draft — send to bill`
                : pendingCount > 0
                ? `${pendingCount} pending`
                : undefined
            }
          />
        </div>
        {/* CO status mix — approved / pending / declined $ (absolute). */}
        {(() => {
          const abs = (s: string) => items.filter((c) => c.status === s).reduce((a, c) => a + Math.abs(c.amount_cents), 0);
          const ap = abs("approved");
          const pe = abs("pending");
          const de = abs("declined");
          if (ap + pe + de === 0) return null;
          return (
            <div className="mt-4 pt-4 border-t border-cc-brand-100">
              <DonutChart
                size={116}
                segments={[
                  { label: "Approved", value: ap, tone: "emerald", valueLabel: formatCentsCompact(ap) },
                  { label: "Pending", value: pe, tone: "amber", valueLabel: formatCentsCompact(pe) },
                  { label: "Declined", value: de, tone: "neutral", valueLabel: formatCentsCompact(de) },
                ]}
                centerValue={formatCentsCompact(ap + pe + de)}
                centerLabel={`${items.length} ${items.length === 1 ? "order" : "orders"}`}
              />
            </div>
          );
        })()}
      </section>

      {/* ── Add + list ── */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        {/* When there are no change orders yet, a big empty block left the
            page mostly white — open the add form so the page is immediately
            usable + a compact one-line intro instead of a tall empty state. */}
        {items.length === 0 && (
          <p className="text-[12px] text-ppp-charcoal-500 mb-3">
            No change orders yet. When scope changes mid-job, add one below — approved additions roll into the contract sum and bill on their own invoice.
          </p>
        )}
        <details className="group mb-3 border border-cc-brand-200 rounded-lg" open={addAttemptFailed || items.length === 0}>
          <summary className="cursor-pointer list-none px-3.5 py-2.5 min-h-[44px] flex items-center gap-2 text-[12px] font-semibold text-cc-brand-700 select-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="group-open:rotate-45 transition-transform">
              <path d="M12 5v14 M5 12h14" />
            </svg>
            Add a change order
          </summary>
          <form action={addAction} className="px-3.5 pb-3.5 pt-1 space-y-3">
            <input type="hidden" name="opp_id" value={oppId} />
            <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
            <div>
              <label className={LABEL_CLS} htmlFor="co-title">Title</label>
              <input id="co-title" name="title" required maxLength={200} defaultValue={addAttemptFailed ? preserveTitle ?? "" : ""} className={INPUT_CLS} placeholder="e.g. Add second-floor hallway repaint" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <DirectionToggle defaultDirection={addAttemptFailed && (preserveAmount ?? "").trim().startsWith("-") ? "deduct" : "add"} />
              <div>
                <label className={LABEL_CLS} htmlFor="co-amount">Amount</label>
                <input id="co-amount" name="amount" required inputMode="decimal" defaultValue={addAttemptFailed ? (preserveAmount ?? "").replace(/^-/, "") : ""} className={INPUT_CLS} placeholder="1,200.00" />
                <p className="text-[11px] text-ppp-charcoal-500 mt-1">Enter a positive amount — the toggle sets add vs deduct.</p>
              </div>
            </div>
            {proposals.length > 0 && (
              <ProposalPicker idPrefix="add" proposals={proposals} selectedId={null} />
            )}
            <div>
              <label className={LABEL_CLS} htmlFor="co-desc">Description <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
              <textarea id="co-desc" name="description" maxLength={4000} rows={2} defaultValue={addAttemptFailed ? preserveDesc ?? "" : ""} className={TEXTAREA_CLS} placeholder="What changed and why" />
            </div>
            <PendingSubmitButton pendingLabel="Adding…" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30">
              Add change order
            </PendingSubmitButton>
          </form>
        </details>

        {items.length === 0 ? null : (
          <ul className="space-y-2.5">
            {items.map((co) => {
              const billedLive = !!co.invoiced_invoice_id && liveInvoices.has(co.invoiced_invoice_id);
              const invoiceVoided = !!co.invoiced_invoice_id && !billedLive;
              const isEditing = editCoId === co.id && co.status === "pending" && !billedLive;
              const kind = changeOrderKind(co.amount_cents);
              return (
                <li key={co.id} className="border border-ppp-charcoal-100 rounded-lg p-3 sm:p-3.5">
                  {isEditing ? (
                    <form action={editAction} className="space-y-2.5">
                      <input type="hidden" name="opp_id" value={oppId} />
                      <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                      <input type="hidden" name="co_id" value={co.id} />
                      <div className="text-[12px] font-bold text-ppp-charcoal">{formatChangeOrderNumber(co.co_number)}</div>
                      <div>
                        <label className={LABEL_CLS} htmlFor={`edit-title-${co.id}`}>Title</label>
                        <input id={`edit-title-${co.id}`} name="title" required maxLength={200} defaultValue={preserveTitle ?? co.title} className={INPUT_CLS} />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <DirectionToggle defaultDirection={co.amount_cents < 0 ? "deduct" : "add"} />
                        <div>
                          <label className={LABEL_CLS} htmlFor={`edit-amount-${co.id}`}>Amount</label>
                          <input id={`edit-amount-${co.id}`} name="amount" required inputMode="decimal" defaultValue={preserveAmount ?? (Math.abs(co.amount_cents) / 100).toFixed(2)} className={INPUT_CLS} />
                          <p className="text-[11px] text-ppp-charcoal-500 mt-1">Positive amount — the toggle sets the sign.</p>
                        </div>
                      </div>
                      {proposals.length > 0 && (
                        <ProposalPicker idPrefix={`edit-${co.id}`} proposals={proposals} selectedId={co.proposal_id} />
                      )}
                      <div>
                        <label className={LABEL_CLS} htmlFor={`edit-desc-${co.id}`}>Description</label>
                        <textarea id={`edit-desc-${co.id}`} name="description" maxLength={4000} rows={2} defaultValue={preserveDesc ?? co.description ?? ""} className={TEXTAREA_CLS} />
                      </div>
                      <div className="flex items-center gap-2">
                        <PendingSubmitButton pendingLabel="Saving…" className="px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Save</PendingSubmitButton>
                        <Link href={basePath} className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] inline-flex items-center">Cancel</Link>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[12px] font-bold text-ppp-charcoal">{formatChangeOrderNumber(co.co_number)}</span>
                            <ChangeOrderPill status={co.status} />
                            {kind === "deduct" && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-ppp-charcoal-200 bg-ppp-charcoal-50 text-[11px] font-medium text-ppp-charcoal-600">Deduct</span>
                            )}
                          </div>
                          <div className="text-sm font-semibold text-ppp-charcoal mt-1 break-words">{co.title}</div>
                          {co.description && (
                            <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 break-words whitespace-pre-wrap">{co.description}</div>
                          )}
                          {(() => {
                            const prop = co.proposal_id ? proposalById.get(co.proposal_id) : null;
                            if (!prop) return null;
                            const eff = prop.totalCents != null ? Math.max(0, prop.totalCents + (netApprovedByProposal.get(prop.id) ?? 0)) : null;
                            return (
                              <div className="mt-1 space-y-0.5">
                                <div className="inline-flex items-center gap-1 text-[11px] text-ppp-charcoal-500 flex-wrap">
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" />
                                  </svg>
                                  Amends <span className="font-medium text-ppp-charcoal-700">{prop.label}</span>
                                  {eff != null && (
                                    <span className="text-ppp-charcoal-400">· contract → <span className="tabular-nums text-ppp-charcoal-700">{formatCentsFull(eff)}</span></span>
                                  )}
                                </div>
                                {prop.hasInvoice === false && (
                                  <div className="flex items-start gap-1 text-[10.5px] text-amber-700">
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01" /></svg>
                                    Not invoiced yet — this change order adjusts the proposal&rsquo;s contract total; bill it when ready.
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          {co.decided_at && (
                            <div className="text-[11px] text-ppp-charcoal-400 mt-1">
                              {co.status === "approved" ? "Approved" : "Declined"} {fmtEtDate(co.decided_at)}
                            </div>
                          )}
                        </div>
                        <div className={`text-base font-bold tabular-nums shrink-0 ${kind === "deduct" ? "text-rose-700" : "text-emerald-700"}`}>
                          {signedCents(co.amount_cents)}
                        </div>
                      </div>

                      {invoiceVoided && (
                        <p className="mt-2 text-[11px] text-ppp-charcoal-500 italic">
                          The invoice that billed this change order was voided or removed — you can bill it again.
                        </p>
                      )}
                      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                        {/* Standalone CO document for the GC to authorize — the
                            change, the dollar impact, the contract adjustment,
                            and a signature block. Available on every CO. */}
                        <a
                          href={`/api/commercial/change-orders/${co.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
                          title="Open the change-order document (PDF) to send to the GC"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 15h6 M9 11h2" />
                          </svg>
                          Document
                        </a>
                        {billedLive ? (
                          <>
                            {coChips.get(co.id)?.isDraft ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-[12px] font-semibold text-amber-800" title="On a draft invoice — not billed to the customer until you send it">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                                On {coChips.get(co.id)!.invoiceNumber} · draft — send to bill
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-[12px] font-semibold text-emerald-700">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                                On {coChips.get(co.id)?.invoiceNumber ?? "invoice"}
                                {coChips.get(co.id) ? ` · ${coChips.get(co.id)!.kind}` : ""}
                              </span>
                            )}
                            <Link
                              href={`/commercial/invoices/${co.invoiced_invoice_id}`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" />
                              </svg>
                              View invoice
                            </Link>
                            <form action={billAction}>
                              <input type="hidden" name="opp_id" value={oppId} />
                              <input type="hidden" name="account_id" value={accountId} />
                              <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                              <input type="hidden" name="co_id" value={co.id} />
                              <input type="hidden" name="on" value="0" />
                              <PendingSubmitButton pendingLabel="Removing…" className="inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-medium text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 min-h-[44px]">Remove from invoice</PendingSubmitButton>
                            </form>
                          </>
                        ) : (
                          <>
                            {co.status === "pending" && (
                              <>
                                <form action={decideAction}>
                                  <input type="hidden" name="opp_id" value={oppId} />
                                  <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                                  <input type="hidden" name="co_id" value={co.id} />
                                  <input type="hidden" name="decision" value="approved" />
                                  <PendingSubmitButton pendingLabel="Approving…" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 min-h-[44px]">Approve</PendingSubmitButton>
                                </form>
                                <form action={decideAction}>
                                  <input type="hidden" name="opp_id" value={oppId} />
                                  <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                                  <input type="hidden" name="co_id" value={co.id} />
                                  <input type="hidden" name="decision" value="declined" />
                                  <PendingSubmitButton pendingLabel="Declining…" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 bg-surface text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px]">Decline</PendingSubmitButton>
                                </form>
                                <Link href={joinUrl(`edit_co=${co.id}`)} className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]">Edit</Link>
                              </>
                            )}
                            {co.status === "approved" && (
                              <form action={billAction} className="flex items-center gap-2 flex-wrap">
                                <input type="hidden" name="opp_id" value={oppId} />
                                <input type="hidden" name="account_id" value={accountId} />
                                <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                                <input type="hidden" name="co_id" value={co.id} />
                                <input type="hidden" name="on" value="1" />
                                {/* Pick which invoice under this deal it lands on.
                                    Only DRAFTS are eligible (issued ones are
                                    frozen); "New invoice" bills it on its own
                                    fresh draft. No drafts → straight to a new one. */}
                                {draftInvoices.length > 0 ? (
                                  <label className="inline-flex items-center gap-1.5 text-[11px] text-ppp-charcoal-500">
                                    <span className="font-medium">Bill on</span>
                                    <select
                                      name="target_invoice_id"
                                      defaultValue={draftInvoices[0].id}
                                      aria-label="Which invoice to bill this change order on"
                                      className="px-2 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-medium text-ppp-charcoal min-h-[44px] max-w-[15rem]"
                                      style={SELECT_BG_STYLE}
                                    >
                                      {draftInvoices.map((d) => (
                                        <option key={d.id} value={d.id}>
                                          {d.number} · draft · {formatCentsCompact(d.subtotalCents)}
                                        </option>
                                      ))}
                                      <option value="new">+ New invoice</option>
                                    </select>
                                  </label>
                                ) : (
                                  <input type="hidden" name="target_invoice_id" value="new" />
                                )}
                                <PendingSubmitButton pendingLabel="Adding…" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <path d="M12 5v14 M5 12h14" />
                                  </svg>
                                  {kind === "deduct" ? "Add credit" : "Add to invoice"}
                                </PendingSubmitButton>
                              </form>
                            )}
                            {co.status === "declined" && (
                              <form action={decideAction}>
                                <input type="hidden" name="opp_id" value={oppId} />
                                <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                                <input type="hidden" name="co_id" value={co.id} />
                                <input type="hidden" name="decision" value="approved" />
                                <PendingSubmitButton pendingLabel="Reopening…" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-emerald-200 bg-surface text-[12px] font-semibold text-emerald-700 hover:bg-emerald-50 min-h-[44px]">Reopen &amp; approve</PendingSubmitButton>
                              </form>
                            )}
                            <form action={deleteAction} className="ml-auto">
                              <input type="hidden" name="opp_id" value={oppId} />
                              <input type="hidden" name="account_id" value={accountId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="from" value={from} />
                      <input type="hidden" name="origin" value={origin} />
                              <input type="hidden" name="co_id" value={co.id} />
                              <ConfirmSubmitButton
                                message={`Delete ${formatChangeOrderNumber(co.co_number)}? This can't be undone.`}
                                pendingLabel="Deleting…"
                                className="inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-medium text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 min-h-[44px]"
                              >
                                Delete
                              </ConfirmSubmitButton>
                            </form>
                          </>
                        )}
                      </div>

                      {/* Per-CO documents — signed CO PDFs / backup. File into the
                          deal Documents → Change Orders box automatically. */}
                      <details className="mt-2.5 group/codocs">
                        <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[44px] select-none">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/codocs:rotate-90"><path d="M9 18l6-6-6-6" /></svg>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
                          Documents
                          {(() => { const n = (coAttachments.get(co.id) ?? []).length; return n > 0 ? <span className="text-ppp-charcoal-400 tabular-nums">· {n}</span> : null; })()}
                        </summary>
                        <ChangeOrderAttachments
                          changeOrderId={co.id}
                          attachments={(coAttachments.get(co.id) ?? []).map((d) => ({ id: d.id, file_name: d.file_name }))}
                          canEdit
                        />
                      </details>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Add / Deduct segmented control. A pair of radios styled as a two-button
 * segment (peer-checked). Replaces the old "type a minus sign" convention with
 * an explicit choice — Karan 2026-07-29: "no way to tell... if we're adding or
 * taking away." Emits `direction` = "add" | "deduct".
 */
function DirectionToggle({ defaultDirection }: { defaultDirection: "add" | "deduct" }) {
  const seg =
    "relative overflow-hidden flex-1 cursor-pointer text-center px-3 py-2 min-h-[44px] inline-flex items-center justify-center gap-1.5 text-[12px] font-semibold rounded-md select-none transition-colors text-ppp-charcoal-600";
  return (
    <fieldset>
      <legend className={LABEL_CLS}>Direction</legend>
      <div className="mt-1 flex gap-1 rounded-lg border border-ppp-charcoal-200 bg-ppp-charcoal-50 p-1">
        <label className={seg}>
          <input type="radio" name="direction" value="add" defaultChecked={defaultDirection === "add"} className="peer sr-only" />
          <span className="absolute inset-0 rounded-md peer-checked:bg-emerald-600 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-cc-brand-600/50 pointer-events-none" aria-hidden />
          <span className="relative z-10 peer-checked:text-white inline-flex items-center gap-1">
            <span aria-hidden className="text-sm leading-none">+</span> Add scope
          </span>
        </label>
        <label className={seg}>
          <input type="radio" name="direction" value="deduct" defaultChecked={defaultDirection === "deduct"} className="peer sr-only" />
          <span className="absolute inset-0 rounded-md peer-checked:bg-rose-600 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-cc-brand-600/50 pointer-events-none" aria-hidden />
          <span className="relative z-10 peer-checked:text-white inline-flex items-center gap-1">
            <span aria-hidden className="text-sm leading-none">−</span> Deduct
          </span>
        </label>
      </div>
    </fieldset>
  );
}

/**
 * "Which proposal does this CO amend?" dropdown. Only rendered when the deal
 * has proposals. Emits `proposal_id` ("" = none). A native <select> is fine —
 * a project rarely carries more than a handful of proposals.
 */
function ProposalPicker({ idPrefix, proposals, selectedId }: { idPrefix: string; proposals: ProposalOption[]; selectedId: string | null }) {
  return (
    <div>
      <label className={LABEL_CLS} htmlFor={`${idPrefix}-proposal`}>
        Which proposal? <span className="font-normal text-ppp-charcoal-400">(optional)</span>
      </label>
      <select id={`${idPrefix}-proposal`} name="proposal_id" defaultValue={selectedId ?? ""} className={SELECT_CLS} style={SELECT_BG_STYLE}>
        <option value="">General change — no specific proposal</option>
        {proposals.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <p className="text-[11px] text-ppp-charcoal-500 mt-1">Ties this change to a proposal — once approved it adjusts that proposal&rsquo;s contract total (added scope raises it, a deduct lowers it).</p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "neutral",
  emphasize = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "emerald" | "rose" | "cc-brand";
  emphasize?: boolean;
}) {
  const valueCls =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "rose"
      ? "text-rose-700"
      : tone === "cc-brand"
      ? "text-cc-brand-800"
      : "text-ppp-charcoal";
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${emphasize ? "border-cc-brand-300 bg-surface" : "border-ppp-charcoal-100 bg-surface/70"}`}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 ${valueCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-amber-700 mt-0.5">{hint}</div>}
    </div>
  );
}
