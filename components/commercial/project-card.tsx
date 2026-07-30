/**
 * ProjectCard — one post-sale project (a Won deal in delivery) with its
 * contract-to-date, % complete, AIA + change-order status, and a segmented
 * footer that jumps straight into that project's four production tools:
 * Change Orders · AIA Billing · Submittals · Closeout.
 *
 * Shared by the cross-account Projects page (`/commercial/projects`) and the
 * per-account **Projects tab** on Account 360, so a deal reads identically
 * wherever you find it. Multiple deals under one account each render as their
 * own card, so nothing clusters.
 */
import Link from "next/link";
import { derivedOppName, formatOpportunityNumber } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { AIA_STATUS_META } from "@/lib/commercial/aia/constants";
import type { ProjectRow } from "@/lib/commercial/projects/db";

function projectStatusTone(status: string): { stripe: string; pill: string } {
  switch (status) {
    case "pre_sale_closed":
      return { stripe: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "pre_construction":
      return { stripe: "bg-ppp-navy-500", pill: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
    case "in_progress":
      return { stripe: "bg-ppp-blue-500", pill: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
    case "billing":
      return { stripe: "bg-amber-500", pill: "bg-amber-50 text-amber-700 border-amber-200" };
    case "post_sale_closed":
      return { stripe: "bg-ppp-charcoal-400", pill: "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200" };
    default:
      return { stripe: "bg-ppp-charcoal-300", pill: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" };
  }
}

const AIA_TONE_TEXT: Record<"charcoal" | "ppp-blue" | "emerald", string> = {
  charcoal: "text-ppp-charcoal-600",
  "ppp-blue": "text-ppp-blue-700",
  emerald: "text-emerald-700",
};

function MoneyStat({ label, value, tone }: { label: string; value: string; tone?: "emerald" }) {
  return (
    <div className="min-w-0">
      <div className="text-[8.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">{label}</div>
      <div className={`font-condensed text-[15px] font-black tabular-nums leading-none mt-0.5 truncate ${tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal"}`}>{value}</div>
    </div>
  );
}

const FOOTER_LINK =
  "bg-surface inline-flex items-center justify-center gap-1.5 min-h-[44px] px-1 text-center text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:text-cc-brand-800 touch-manipulation";

export function ProjectCard({ p, hideAccountName = false }: { p: ProjectRow; hideAccountName?: boolean }) {
  const name = derivedOppName(p.opp, p.accountName);
  const pct = p.percentCompleteBps != null ? Math.min(100, Math.round(p.percentCompleteBps / 100)) : null;
  const oppCode = formatOpportunityNumber(p.opp.project_number);
  const location = p.opp.property_street?.trim() || null;
  const tone = projectStatusTone(p.opp.status);
  const hasContract = p.contractToDateCents > 0;
  // Billing-honest: % billed = invoiced ÷ contract (the number that moves when
  // you invoice). Production % (AIA completed) shown as a secondary note.
  const pctBilled = hasContract ? Math.min(100, Math.round((p.invoicedCents / p.contractToDateCents) * 100)) : 0;
  // Card title → the project's HOME under the account (folded), NOT the edit
  // sheet. Pointing at ?edit= made the edit form auto-pop on navigation
  // (2026-07-29 bug). The project home is a read view with the tool jumps;
  // editing deal details is an explicit button there.
  const overviewHref = `/commercial/accounts/${p.accountId}?tab=projects&project=${p.opp.id}`;
  const coHref = `/commercial/accounts/${p.accountId}/change-orders/${p.opp.id}`;
  const aiaHref = `/commercial/accounts/${p.accountId}/aia/${p.opp.id}`;
  const submittalsHref = `/commercial/accounts/${p.accountId}/submittals/${p.opp.id}`;
  const closeoutHref = `/commercial/accounts/${p.accountId}/closeout/${p.opp.id}`;

  return (
    <li className="relative bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden hover:border-cc-brand-200 hover:shadow-md transition-all">
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${tone.stripe}`} />

      <div className="pl-5 pr-4 py-3.5">
        <div className="flex items-center justify-between gap-2 mb-1">
          {oppCode ? (
            <span className="text-[9.5px] font-mono text-ppp-navy-600 truncate" title="Opportunity ID">{oppCode}</span>
          ) : <span />}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9.5px] font-bold uppercase tracking-wide shrink-0 ${tone.pill}`}>
            {oppStatusDisplayLabel(p.opp.status, p.opp.sub_status)}
          </span>
        </div>

        <Link href={overviewHref} className="block text-[15px] font-bold text-ppp-charcoal hover:text-cc-brand-800 leading-snug break-words">
          {name}
        </Link>
        {(!hideAccountName || location) && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ppp-charcoal-500 min-w-0">
            {!hideAccountName && <span className="truncate font-medium">{p.accountName}</span>}
            {!hideAccountName && location && <span aria-hidden className="text-ppp-charcoal-300">·</span>}
            {location && <span className="truncate">{location}</span>}
          </div>
        )}

        {hasContract ? (
          <div className="mt-3 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/50 px-3 py-2.5">
            <div className="grid grid-cols-3 gap-2 text-center">
              <MoneyStat label="Contract" value={formatCentsCompact(p.contractToDateCents)} />
              <MoneyStat label="Invoiced" value={formatCentsCompact(p.invoicedCents)} tone="emerald" />
              <MoneyStat label={p.overBilled ? "Over-billed" : "Left to bill"} value={p.overBilled ? formatCentsCompact(p.invoicedCents - p.contractToDateCents) : formatCentsCompact(p.leftToBillCents)} />
            </div>
            <div className="mt-2.5">
              <div className="h-1.5 rounded-full bg-ppp-charcoal-200/70 overflow-hidden">
                <div className={`h-full rounded-full transition-all ${p.overBilled ? "bg-amber-500" : "bg-cc-brand-500"}`} style={{ width: `${pctBilled}%` }} aria-label={`${pctBilled}% billed`} />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px]">
                <span className={`tabular-nums font-semibold ${p.overBilled ? "text-amber-700" : "text-cc-brand-700"}`}>{pctBilled}% billed{p.overBilled ? " · over contract" : ""}</span>
                <span className="tabular-nums font-medium text-ppp-charcoal-500">
                  {pct != null ? `${pct}% complete` : ""}
                  {p.netApprovedCoCents !== 0 && (
                    <span className={p.netApprovedCoCents < 0 ? "text-rose-700" : "text-emerald-700"}>
                      {pct != null ? " · " : ""}{p.netApprovedCoCents < 0 ? "−" : "+"}{formatCentsCompact(Math.abs(p.netApprovedCoCents))} COs
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-3 py-2.5 text-[11.5px] text-amber-800">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 mt-0.5">
              <path d="M12 9v4 M12 17h.01 M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            <span>{p.hasBilling ? "Set the contract value on the AIA screen to track progress." : "No contract value yet — add the bid range or start AIA billing."}</span>
          </div>
        )}

        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-ppp-charcoal-100 bg-surface px-2 py-1 text-[11px]">
            <span className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">AIA</span>
            {p.latestAppNumber != null ? (
              <span className="font-semibold text-ppp-charcoal-700">
                App {p.latestAppNumber} · <span className={p.latestAppStatus ? AIA_TONE_TEXT[AIA_STATUS_META[p.latestAppStatus].tone] : ""}>{p.latestAppStatus ? AIA_STATUS_META[p.latestAppStatus].label : ""}</span>
              </span>
            ) : (
              <span className="text-ppp-charcoal-400">Not started</span>
            )}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${p.pendingCoCount > 0 ? "border-amber-200 bg-amber-50/50" : "border-ppp-charcoal-100 bg-surface"}`}>
            <span className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">COs</span>
            {p.pendingCoCount > 0 ? (
              <span className="font-semibold text-amber-700">{p.pendingCoCount} pending</span>
            ) : (
              <span className="text-ppp-charcoal-400">None pending</span>
            )}
          </span>
        </div>
      </div>

      {/* Segmented action footer — all four production tools. 2×2 on phones,
          one row of four on wider screens. gap-px over a charcoal backing
          draws crisp 1px dividers without per-cell border bookkeeping. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-ppp-charcoal-100 border-t border-ppp-charcoal-100 text-[12px] font-semibold">
        <Link href={coHref} className={FOOTER_LINK}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5" /></svg>
          Change Orders
        </Link>
        <Link href={aiaHref} className={FOOTER_LINK}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
          AIA Billing
        </Link>
        <Link href={submittalsHref} className={FOOTER_LINK}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h5 M8 17h4" /></svg>
          Submittals
        </Link>
        <Link href={closeoutHref} className={FOOTER_LINK}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
          Closeout
        </Link>
      </div>
    </li>
  );
}

export default ProjectCard;
