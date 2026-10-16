/**
 * An account, reduced to what the Materials hub's browser code reads.
 *
 * The full `SnapshotAccount` carries about twenty-five fields — billing
 * address, lifetime revenue, won/lost opportunity counts, lead group,
 * territory. The Materials client uses exactly two of them: a supplier's
 * `name`, and the customer's `email` to prefill the send-color-form dialog.
 *
 * Measured on 2026-10-16: 2,144 accounts, 1,424KB of a 4,530KB payload.
 */
export type AccountLite = {
  id: string;
  name: string;
  email: string | null;
};
