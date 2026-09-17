/**
 * Print rules for a page that has to come out as a clean sheet of paper.
 *
 * Karan 2026-09-16, for Accounting: "could we also have a Print / PDF button so
 * we can send in a clean PDF format." Mary sends these on to the bookkeeper, so
 * what prints has to be the report — not the sidebar, the tab strip, the filter
 * bars and the buttons that only mean something on a screen.
 *
 * THE VISIBILITY TRICK, not hiding the shell by selector: the app shell's markup
 * is not a page's to know, and a print stylesheet that silently stops working
 * when somebody renames a wrapper is worse than none. Everything is hidden, then
 * the one subtree is made visible and floated to the top-left.
 *
 * Mark anything screen-only inside it with `data-print-hide`.
 *
 * This started life inside the per-job report. It is here because Accounting
 * needs exactly the same rules, and two copies of a print stylesheet is two
 * places for the page-break handling to drift.
 */
export function PrintSheetStyles({ id }: { id: string }) {
  return (
    <style>{`
      @media print {
        @page { margin: 14mm 12mm; }
        body { background: #fff !important; }
        body * { visibility: hidden !important; }
        #${id}, #${id} * { visibility: visible !important; }
        #${id} { position: absolute !important; left: 0; top: 0; width: 100%; }
        #${id} [data-print-hide] { display: none !important; }
        #${id} section, #${id} header, #${id} li { break-inside: avoid; page-break-inside: avoid; }
        #${id} table { break-inside: auto; }
        #${id} tr { break-inside: avoid; page-break-inside: avoid; }
        #${id} thead { display: table-header-group; }
        /* A horizontal scroller has no meaning on paper. */
        #${id} .overflow-x-auto { overflow: visible !important; }
        #${id} table[class*="min-w-"] { min-width: 0 !important; }
        /* Tailwind's own print: utilities are honoured by the app shell; this
           covers the elements inside the sheet that use them. */
        #${id} .print\\:hidden { display: none !important; }
        /* Controls inside the DATA are flattened, not hidden.
           The tempting rule is \`button, select { display: none }\`, and it
           loses information: on the ledger the deposited state IS a button, so
           hiding it prints an empty column on the sheet Mary sends to the
           bookkeeper. Stripped of their chrome they read as the text they
           already are — "Deposited", a chase note — which is what belongs on
           paper. Whole screen-only blocks still carry \`data-print-hide\`. */
        #${id} input:not([type="hidden"]), #${id} textarea, #${id} button {
          border: none !important;
          background: transparent !important;
          padding: 0 !important;
          min-height: 0 !important;
          box-shadow: none !important;
          color: inherit !important;
        }
        #${id} select { display: none !important; }
      }
      /* The printed header exists only on paper — a second title on screen
         would just repeat the one already there. */
      [data-print-only] { display: none; }
      @media print { [data-print-only] { display: block !important; } }
    `}</style>
  );
}

/**
 * The line at the top of the printed sheet: what this is, and when it was run.
 *
 * A page sent to a bookkeeper with no date on it is one nobody can file, and
 * one that can't be told apart from the same report run a month later.
 */
export function PrintHeader({ company, title, subtitle }: { company: string; title: string; subtitle?: string }) {
  return (
    <div data-print-only className="mb-3 border-b border-ppp-charcoal-300 pb-2">
      <div className="text-[15px] font-bold text-ppp-charcoal">
        {company} — {title}
      </div>
      {subtitle && <div className="text-[11px] text-ppp-charcoal-600">{subtitle}</div>}
    </div>
  );
}
