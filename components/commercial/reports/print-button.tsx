"use client";

/**
 * Print / Save-as-PDF for a report page.
 *
 * Deliberately the BROWSER's print dialog and not a new PDF renderer: every
 * server-rendered PDF here (proposal, invoice, CO, work order) is a customer
 * document with a fixed one-page layout and a test pinning its page count. A
 * job report is an internal read whose length is whatever the job is, so giving
 * it a renderer of its own would mean a second layout of every number on the
 * page — and a second place for them to drift.
 *
 * The page carries the print stylesheet; this is only the control. It renders
 * nothing at all when print isn't available (it is, everywhere) and hides
 * itself from the printed page.
 */
export function PrintButton({ label = "Print / PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      data-print-hide
      onClick={() => window.print()}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface px-3 text-[13px] font-semibold text-ppp-charcoal-700 transition-colors hover:border-cc-brand-300 hover:bg-ppp-charcoal-50 hover:text-cc-brand-700 touch-manipulation"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z" />
      </svg>
      {label}
    </button>
  );
}
