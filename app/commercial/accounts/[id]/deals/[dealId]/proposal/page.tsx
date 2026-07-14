/**
 * Proposals list for a deal — Phase F.2 route scaffold.
 *
 * Lists R1, R2, R3... newest first with status pills + totals. Empty
 * state offers the "Start proposal" CTA that creates the first R1
 * (hydrated from account + deal snapshot per hydrateProposalContext).
 *
 * URL: /commercial/accounts/[id]/deals/[dealId]/proposal
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
} from "@/lib/commercial/opportunities/db";
import { listProposalsForOpp } from "@/lib/commercial/proposals/db";
import { proposalStatusLabel } from "@/lib/commercial/proposals/constants";
import { UUID_RE } from "@/lib/commercial/uuid";

export const dynamic = "force-dynamic";

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function statusPillCls(status: string): string {
  switch (status) {
    case "sent":
      return "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200";
    case "won":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "lost":
    case "expired":
      return "bg-rose-50 text-rose-800 border-rose-200";
    case "pending_approval":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "superseded":
      return "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-200";
    default:
      return "bg-white text-ppp-charcoal-700 border-ppp-charcoal-200";
  }
}

export default async function ProposalRevisionsPage({
  params,
}: {
  params: Promise<{ id: string; dealId: string }>;
}) {
  const { id: accountId, dealId } = await params;
  if (!UUID_RE.test(accountId) || !UUID_RE.test(dealId)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) redirect("/commercial");

  const [account, opp, proposals] = await Promise.all([
    getCommercialAccount(accountId),
    getCommercialOpportunity(dealId),
    listProposalsForOpp(dealId),
  ]);
  if (!account) notFound();
  if (!opp || opp.account_id !== accountId) notFound();

  const oppName = derivedOppName(opp, account.company_name);
  const backHref = `/commercial/accounts/${accountId}?tab=opportunities&edit=${dealId}#deal-row-${dealId}`;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        <Link href={backHref} className="hover:text-cc-brand-700 inline-flex items-center gap-1 min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
          <span>{account.company_name}</span>
        </Link>
        <span aria-hidden className="text-ppp-charcoal-300">·</span>
        <span className="text-ppp-charcoal-700 truncate">{oppName}</span>
        <span aria-hidden className="text-ppp-charcoal-300">·</span>
        <span className="text-ppp-charcoal-900 font-medium">Proposals</span>
      </nav>

      {/* Header */}
      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700 mb-1.5">
              Proposal builder
            </div>
            <h1 className="text-xl font-bold tracking-tight text-ppp-charcoal">
              {oppName}
            </h1>
            <p className="text-[13px] text-ppp-charcoal-500 mt-1">
              {proposals.length === 0
                ? "No proposals yet."
                : `${proposals.length} revision${proposals.length === 1 ? "" : "s"} on file.`}
            </p>
          </div>
          <Link
            href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/new`}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[40px]"
          >
            {proposals.length === 0 ? "Start proposal" : "New revision"}
            <span aria-hidden>+</span>
          </Link>
        </div>
      </header>

      {/* Revisions list or empty state */}
      {proposals.length === 0 ? (
        <div className="bg-white border border-dashed border-ppp-charcoal-200 rounded-xl p-8 text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-cc-brand-50 flex items-center justify-center" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cc-brand-700">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-ppp-charcoal mb-1">
            No proposals for this deal yet.
          </p>
          <p className="text-[13px] text-ppp-charcoal-500 max-w-md mx-auto">
            Start one — the header, standard exclusions, and estimator sign-off pre-fill from this deal so you land on the line items.
          </p>
        </div>
      ) : (
        <ul className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
          {proposals.map((p) => (
            <li key={p.id} className="flex items-stretch hover:bg-ppp-charcoal-50">
              <Link
                href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/${p.id}`}
                className="flex items-center gap-3 px-4 py-3 min-h-[52px] flex-1 min-w-0"
              >
                <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-ppp-charcoal">R{p.revision_number}</span>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${statusPillCls(p.status)}`}>
                    {proposalStatusLabel(p.status)}
                  </span>
                  {p.sent_at && (
                    <span className="text-[11px] text-ppp-charcoal-500">
                      sent {new Date(p.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
                    </span>
                  )}
                </div>
                <span className="text-sm font-semibold text-ppp-charcoal-800 tabular-nums shrink-0">
                  {formatDollars(p.total_cents)}
                </span>
              </Link>
              <a
                href={`/api/commercial/proposals/${p.id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-3 py-3 text-[11px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 hover:bg-white border-l border-ppp-charcoal-100 shrink-0"
                title="Open the customer PDF in a new tab"
                aria-label={`Open PDF for revision ${p.revision_number}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="hidden sm:inline">PDF</span>
              </a>
              <Link
                href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/${p.id}`}
                aria-label={`Open revision ${p.revision_number}`}
                className="flex items-center px-3 border-l border-ppp-charcoal-100 shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300" aria-hidden>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
