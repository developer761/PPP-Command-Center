import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";

/**
 * "Has this cleared the bank?" — on the tab named after deposits.
 *
 * Karan 2026-09-17: the Deposits tab listed every payment that had landed and
 * gave you no way to tick one off. The Mark button was on Transactions, behind
 * "More" — so the one tab you would open with a bank statement in your hand was
 * the one tab where you could not reconcile. It had been written up in the
 * handbook as a quirk to remember, which is the weaker fix: documenting a trap
 * still leaves somebody standing in it.
 *
 * Deliberately the same control and the same server action as the ledger's, so
 * ticking a payment here and ticking it there are the same act. It is a
 * one-click form and NOT a save-with-everything-else: reconciling is thirty of
 * these in a row, and anything heavier does not get done.
 */
export function DepositToggle({
  paymentId,
  deposited,
  action,
  queryString,
}: {
  paymentId: string;
  deposited: boolean;
  action: (formData: FormData) => Promise<void>;
  queryString: string;
}) {
  return (
    <form action={action} className="inline-flex">
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="deposited" value={deposited ? "0" : "1"} />
      <input type="hidden" name="qs" value={queryString} />
      <PendingSubmitButton
        pendingLabel="…"
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold min-h-[44px] sm:min-h-[30px] transition-colors ${
          deposited
            ? "bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100"
            : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-500 hover:border-cc-brand-300 hover:text-cc-brand-700"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block w-3 h-3 rounded-[3px] border ${
            deposited ? "bg-emerald-600 border-emerald-700" : "border-ppp-charcoal-300"
          }`}
        />
        {deposited ? "Deposited" : "Mark"}
      </PendingSubmitButton>
    </form>
  );
}
