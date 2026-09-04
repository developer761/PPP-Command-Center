import Link from "next/link";
import { proposalDisplayId, type CommercialProposal } from "@/lib/commercial/proposals/db";
import { proposalStatusLabel, proposalLabel} from "@/lib/commercial/proposals/constants";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";

/**
 * A deal's proposals.
 *
 * Extracted from the account page (2026-08-12, restructure step 3) because the
 * opportunity page hosts it now too. It was the only piece of the deal drill-in
 * still trapped inside `app/commercial/accounts/[id]/page.tsx` — everything
 * else already lived in a shared `*-tool.tsx`.
 *
 * `backHref` is a prop rather than a computed account URL: the same list now
 * appears in two places, and a proposal opened from the opportunity page must
 * return there rather than to the account.
 */
export function DealProposalsSection({
  accountId,
  oppId,
  proposals,
  backHref,
  errorMessage,
}: {
  accountId: string;
  oppId: string;
  proposals: CommercialProposal[];
  backHref: string;
  /** Surfaces a failed "New proposal" — createProposal errors used to redirect
   *  to a shim that discarded the message, so a failed create looked silent. */
  errorMessage?: string | null;
}) {
  const base = `/commercial/accounts/${accountId}/deals/${oppId}/proposal`;
  const sorted = [...proposals].sort((a, b) => b.revision_number - a.revision_number);
  return (
    <section
      id="deal-proposals"
      className="scroll-mt-4 bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ppp-charcoal-100">
        <span
          aria-hidden
          className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-ppp-blue-600 text-white shrink-0"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" />
          </svg>
        </span>
        <h3 className="text-[13px] font-bold text-ppp-charcoal">Proposals</h3>
        <span className="text-[10.5px] font-semibold text-ppp-charcoal-400 tabular-nums">
          {proposals.length}
        </span>
        <Link
          href={`${base}/new?back=${encodeURIComponent(backHref)}`}
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[36px]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          New proposal
        </Link>
      </div>
      {errorMessage && (
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[12.5px] text-rose-800">
          {errorMessage}
        </div>
      )}
      {sorted.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-ppp-charcoal-500">
          No proposals yet — build one from the button above (an opportunity
          doesn&rsquo;t need to be Won to propose).
        </p>
      ) : (
        <ul className="divide-y divide-ppp-charcoal-50">
          {sorted.map((pr) => {
            const num = proposalDisplayId(pr) || proposalLabel(pr);
            const status = proposalStatusLabel(pr.status);
            const tone =
              pr.status === "won"
                ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                : pr.status === "lost"
                  ? "text-rose-700 bg-rose-50 border-rose-200"
                  : pr.status === "sent"
                    ? "text-cc-brand-800 bg-cc-brand-50 border-cc-brand-200"
                    : pr.status === "approved"
                      ? "text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100"
                      : pr.status === "pending_approval"
                        ? "text-ppp-navy-700 bg-ppp-navy-50 border-ppp-navy-200"
                        : "text-ppp-charcoal-600 bg-ppp-charcoal-50 border-ppp-charcoal-200";
            return (
              <li key={pr.id}>
                {/* The editor is deliberately a full-width page — far too large
                    to render inline — so it is handed the surface to return to,
                    and keeps that through every save rather than losing it on
                    the first edit. */}
                <Link
                  href={`${base}/${pr.id}?back=${encodeURIComponent(backHref)}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-cc-brand-50/30 min-h-[44px] group"
                >
                  <span className="min-w-0 flex items-center gap-2">
                    <span className="font-mono text-[11.5px] font-bold text-ppp-charcoal group-hover:text-cc-brand-800">
                      {num}
                    </span>
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[9.5px] font-bold uppercase tracking-wide ${tone}`}
                    >
                      {status}
                    </span>
                  </span>
                  <span className="text-[12.5px] font-bold tabular-nums text-ppp-charcoal shrink-0">
                    {formatCentsCompact(pr.total_cents)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
