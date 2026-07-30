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
} from "@/lib/commercial/change-orders/db";
import {
  CHANGE_ORDER_STATUS_META,
  formatChangeOrderNumber,
  changeOrderKind,
} from "@/lib/commercial/change-orders/constants";
import { formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import { INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
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
};

export async function ChangeOrdersPanel({
  oppId,
  accountId,
  baseContractCents,
  addAction,
  editAction,
  decideAction,
  billAction,
  deleteAction,
  okFlag,
  errorMessage,
  editCoId,
  preserveTitle,
  preserveAmount,
  preserveDesc,
}: {
  oppId: string;
  accountId: string;
  /** The deal's base bid (midpoint) — the "original contract" the COs adjust.
   *  Null when the deal has no bid range; the summary adapts. */
  baseContractCents: number | null;
  addAction: CoAction;
  editAction: CoAction;
  decideAction: CoAction;
  billAction: CoAction;
  deleteAction: CoAction;
  okFlag?: string | null;
  errorMessage?: string | null;
  editCoId?: string | null;
  preserveTitle?: string | null;
  preserveAmount?: string | null;
  preserveDesc?: string | null;
}) {
  const items = await listChangeOrders(oppId);
  const liveInvoices = await liveInvoiceIds(
    items.map((c) => c.invoiced_invoice_id).filter((x): x is string => !!x)
  );

  const approved = items.filter((c) => c.status === "approved");
  const netApprovedCents = approved.reduce((acc, c) => acc + c.amount_cents, 0);
  const pendingCount = items.filter((c) => c.status === "pending").length;
  // Billed = approved COs whose linked invoice is still live.
  const billedCents = approved
    .filter((c) => c.invoiced_invoice_id && liveInvoices.has(c.invoiced_invoice_id))
    .reduce((acc, c) => acc + c.amount_cents, 0);
  const contractToDateCents =
    baseContractCents != null ? baseContractCents + netApprovedCents : null;

  const basePath = `/commercial/accounts/${accountId}/change-orders/${oppId}`;
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
            hint={pendingCount > 0 ? `${pendingCount} pending` : undefined}
          />
        </div>
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
          <form action={addAction} className="px-3.5 pb-3.5 pt-1 space-y-2.5">
            <input type="hidden" name="opp_id" value={oppId} />
            <input type="hidden" name="account_id" value={accountId} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className={LABEL_CLS} htmlFor="co-title">Title</label>
                <input id="co-title" name="title" required maxLength={200} defaultValue={addAttemptFailed ? preserveTitle ?? "" : ""} className={INPUT_CLS} placeholder="e.g. Add second-floor hallway repaint" />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="co-amount">Amount</label>
                <input id="co-amount" name="amount" required inputMode="decimal" defaultValue={addAttemptFailed ? preserveAmount ?? "" : ""} className={INPUT_CLS} placeholder="1,200.00" />
                <p className="text-[11px] text-ppp-charcoal-500 mt-1">
                  Positive to add scope, or a minus sign to deduct (e.g. <span className="tabular-nums">-500.00</span>).
                </p>
              </div>
            </div>
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
                      <input type="hidden" name="co_id" value={co.id} />
                      <div className="text-[12px] font-bold text-ppp-charcoal">{formatChangeOrderNumber(co.co_number)}</div>
                      <div>
                        <label className={LABEL_CLS} htmlFor={`edit-title-${co.id}`}>Title</label>
                        <input id={`edit-title-${co.id}`} name="title" required maxLength={200} defaultValue={preserveTitle ?? co.title} className={INPUT_CLS} />
                      </div>
                      <div>
                        <label className={LABEL_CLS} htmlFor={`edit-amount-${co.id}`}>Amount</label>
                        <input id={`edit-amount-${co.id}`} name="amount" required inputMode="decimal" defaultValue={preserveAmount ?? (co.amount_cents / 100).toFixed(2)} className={INPUT_CLS} />
                        <p className="text-[11px] text-ppp-charcoal-500 mt-1">Minus sign = deduct.</p>
                      </div>
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
                        {billedLive ? (
                          <Link
                            href={`/commercial/invoices/${co.invoiced_invoice_id}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100 min-h-[44px]"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" />
                            </svg>
                            View invoice
                          </Link>
                        ) : (
                          <>
                            {co.status === "pending" && (
                              <>
                                <form action={decideAction}>
                                  <input type="hidden" name="opp_id" value={oppId} />
                                  <input type="hidden" name="account_id" value={accountId} />
                                  <input type="hidden" name="co_id" value={co.id} />
                                  <input type="hidden" name="decision" value="approved" />
                                  <PendingSubmitButton pendingLabel="Approving…" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 min-h-[44px]">Approve</PendingSubmitButton>
                                </form>
                                <form action={decideAction}>
                                  <input type="hidden" name="opp_id" value={oppId} />
                                  <input type="hidden" name="account_id" value={accountId} />
                                  <input type="hidden" name="co_id" value={co.id} />
                                  <input type="hidden" name="decision" value="declined" />
                                  <PendingSubmitButton pendingLabel="Declining…" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 bg-surface text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px]">Decline</PendingSubmitButton>
                                </form>
                                <Link href={`${basePath}?edit_co=${co.id}`} className="inline-flex items-center px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]">Edit</Link>
                              </>
                            )}
                            {co.status === "approved" && co.amount_cents > 0 && (
                              <form action={billAction}>
                                <input type="hidden" name="opp_id" value={oppId} />
                                <input type="hidden" name="account_id" value={accountId} />
                                <input type="hidden" name="co_id" value={co.id} />
                                <PendingSubmitButton pendingLabel="Creating invoice…" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                                  </svg>
                                  Bill this change order
                                </PendingSubmitButton>
                              </form>
                            )}
                            {co.status === "approved" && co.amount_cents < 0 && (
                              <span className="text-[11px] text-ppp-charcoal-500 italic">
                                Reflected in the contract sum — deduct change orders aren&rsquo;t billed separately.
                              </span>
                            )}
                            {co.status === "declined" && (
                              <form action={decideAction}>
                                <input type="hidden" name="opp_id" value={oppId} />
                                <input type="hidden" name="account_id" value={accountId} />
                                <input type="hidden" name="co_id" value={co.id} />
                                <input type="hidden" name="decision" value="approved" />
                                <PendingSubmitButton pendingLabel="Reopening…" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-emerald-200 bg-surface text-[12px] font-semibold text-emerald-700 hover:bg-emerald-50 min-h-[44px]">Reopen &amp; approve</PendingSubmitButton>
                              </form>
                            )}
                            <form action={deleteAction} className="ml-auto">
                              <input type="hidden" name="opp_id" value={oppId} />
                              <input type="hidden" name="account_id" value={accountId} />
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
