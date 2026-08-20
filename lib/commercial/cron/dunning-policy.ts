/**
 * When we chase a customer for money, and when we stop.
 *
 * ONE policy for both ledgers. Invoices and AIA payment applications are
 * different documents with different emails, but a GC billed both ways on
 * different jobs must not be chased on two different clocks — and nothing
 * prevented that while each cron carried its own copy of the numbers.
 *
 * Client-safe (no server imports) so a settings screen can state the policy
 * without duplicating it a third time.
 */

/** Silence before the first reminder. */
export const DUNNING_PAST_DUE_DAYS = 15;

/** Minimum gap between reminders on the same document. */
export const DUNNING_REDUN_DAYS = 7;

/**
 * Past this, a person is told instead of the customer.
 *
 * A bill four months past a thirty-day due date is almost never someone who
 * forgot. It is a job that closed out with the last payment never recorded, a
 * write-off nobody voided, or a dispute already being handled by phone. An
 * automated demand built on that lands on the customer, weekly, forever —
 * which is precisely what an unbounded reminder does.
 *
 * 120 days past due is roughly five months from issue. Slow, but ordinary on
 * commercial work, so the ceiling doesn't catch a normal job.
 *
 * The money is never dropped from the chase: the internal reminder still
 * fires, saying a person should look. Escalating beats going quiet.
 */
export const DUNNING_STALE_AFTER_DAYS = 120;

/**
 * Should the CUSTOMER be emailed, as opposed to a person being told?
 *
 * Deliberately separate from "should this be chased at all": the two answers
 * diverge on an old bill, and collapsing them means either mailing a demand
 * nobody stands behind or losing real money off the list.
 */
export function shouldEmailCustomerAboutOverdue(daysPastDue: number): boolean {
  return daysPastDue <= DUNNING_STALE_AFTER_DAYS;
}
