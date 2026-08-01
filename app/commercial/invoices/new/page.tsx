/**
 * `/commercial/invoices/new?opp=<uuid>` — a deal's invoicing page, IN the
 * Invoices section (Karan 2026-08).
 *
 * Click a deal on the Invoices list → land HERE: the deal's own page with the
 * same header shape as the production tools (deal · OPP · status), a connected
 * Money summary (Contract → Invoiced → Collected → Balance → Margin), the deal's
 * existing invoices, and a "New invoice for this deal" builder inline (flat OR
 * milestones — the SAME builder the deal tab uses). Create stays on this page.
 * No teleport to the account, no bare form.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { isWon } from "@/lib/commercial/opportunities/constants";
import { listProposalsForOpp } from "@/lib/commercial/proposals/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus, invoiceStatusLabel } from "@/lib/commercial/invoices/constants";
import { formatCentsFull, formatCentsCompact, fmtEtDate } from "@/lib/commercial/invoices/format";
import { getProjectFinancials } from "@/lib/commercial/projects/financials";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { DealNewInvoiceForm } from "../../accounts/[id]/page";

export const dynamic = "force-dynamic";

type SP = Promise<{ opp?: string; error?: string; created?: string }>;

export default async function DealInvoicesPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  const opp_id = pickFirst(sp.opp);
  if (!opp_id || !UUID_RE.test(opp_id)) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Pick a deal first"));
  }
  const opp = await getCommercialOpportunity(opp_id!);
  if (!opp) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Deal not found"));
  }
  const billable =
    isWon(opp!) ||
    opp!.status === "pre_construction" ||
    opp!.status === "in_progress" ||
    opp!.status === "billing" ||
    opp!.status === "post_sale_closed";
  if (!billable) {
    redirect("/commercial/invoices?error=" + encodeURIComponent("Only Won deals can be invoiced"));
  }

  const account = await getCommercialAccount(opp!.account_id);
  const [proposals, invoices, fin] = await Promise.all([
    listProposalsForOpp(opp!.id),
    listCommercialInvoices({ opportunityId: opp!.id }),
    getProjectFinancials(opp!.id),
  ]);
  const dealName = derivedOppName(opp!, account?.company_name ?? "");
  const returnTo = `/commercial/invoices/new?opp=${opp!.id}`;
  // Issued invoices, newest first (drafts shown but tagged).
  const shown = invoices
    .filter((i) => i.status !== "void")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      {/* Header — same shape as the production tools */}
      <div className="flex items-start gap-2">
        <Link
          href="/commercial/invoices"
          aria-label="Back to all invoices"
          className="inline-flex items-center justify-center w-9 h-9 rounded-md text-ppp-charcoal-500 hover:text-ppp-charcoal hover:bg-ppp-charcoal-100 touch-manipulation shrink-0 mt-1"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
        </Link>
        <div className="min-w-0">
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none truncate">{dealName}</h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1">
            {account?.company_name} · <span className="font-medium">{oppStatusDisplayLabel(opp!.status, opp!.sub_status)}</span>
          </p>
        </div>
      </div>

      {/* Connected money summary — Contract → Invoiced → Collected → Balance → Margin */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <MoneyTile label="Contract" value={fin.hasContract ? formatCentsCompact(fin.contractCents) : "—"} />
        <MoneyTile label="Invoiced" value={formatCentsCompact(fin.invoicedCents)} />
        <MoneyTile label="Collected" value={formatCentsCompact(fin.collectedCents)} tone="emerald" />
        <MoneyTile
          label={fin.creditCents > 0 && fin.openBalanceCents === 0 ? "Credit" : "Balance"}
          value={formatCentsCompact(fin.openBalanceCents > 0 ? fin.openBalanceCents : fin.creditCents)}
          tone={fin.creditCents > 0 && fin.openBalanceCents === 0 ? "emerald" : fin.openBalanceCents > 0 ? "amber" : "neutral"}
        />
        <MoneyTile
          label="Margin"
          value={fin.costs.total === 0 ? "—" : `${fin.grossMarginCents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(fin.grossMarginCents))}`}
          sub={fin.grossMarginPct == null || fin.costs.total === 0 ? undefined : `${fin.grossMarginPct}%`}
          tone={fin.costs.total === 0 ? "neutral" : fin.grossMarginPct != null && fin.grossMarginPct < 0 ? "rose" : "emerald"}
          href={`/commercial/accounts/${opp!.account_id}/costs/${opp!.id}?back=${encodeURIComponent(returnTo)}`}
        />
      </div>

      {sp.created === "1" ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg>
          Invoice created — it&rsquo;s in the list below.
        </div>
      ) : null}
      {sp.error ? (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">{sp.error}</div>
      ) : null}

      {/* New invoice for this deal — the shared builder, inline */}
      <DealNewInvoiceForm
        accountId={opp!.account_id}
        oppId={opp!.id}
        propertyZip={opp!.property_zip ?? null}
        proposals={proposals}
        invoices={invoices}
        returnTo={returnTo}
      />

      {/* This deal's invoices */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-center gap-2">
          <h2 className="text-[13px] font-bold text-ppp-charcoal">Invoices</h2>
          <span className="text-[10.5px] font-semibold text-ppp-charcoal-400 tabular-nums">{shown.length}</span>
        </div>
        {shown.length === 0 ? (
          <p className="px-4 py-4 text-[12px] text-ppp-charcoal-500">No invoices yet — use “New invoice for this deal” above.</p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {shown.map((inv) => {
              const st = deriveInvoiceStatus(inv);
              const tone = st === "paid" ? "text-emerald-700 bg-emerald-50 border-emerald-200" : st === "overdue" ? "text-rose-700 bg-rose-50 border-rose-200" : st === "draft" ? "text-ppp-charcoal-600 bg-ppp-charcoal-50 border-ppp-charcoal-200" : "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-200";
              return (
                <li key={inv.id}>
                  <Link href={`/commercial/invoices/${inv.id}?from=${encodeURIComponent(returnTo)}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-ppp-blue-50/30 min-h-[44px] group">
                    <span className="min-w-0 flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11.5px] font-bold text-ppp-charcoal group-hover:text-ppp-blue-800">{inv.invoice_number}</span>
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[9.5px] font-bold uppercase tracking-wide ${tone}`}>{invoiceStatusLabel(st)}</span>
                      {inv.due_at ? <span className="text-[10.5px] text-ppp-charcoal-400">due {fmtEtDate(inv.due_at)}</span> : null}
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-[12.5px] font-bold text-ppp-charcoal tabular-nums">{formatCentsFull(inv.total_cents)}</span>
                      {inv.balance_cents > 0 && st !== "void" ? <span className="block text-[10px] text-ppp-charcoal-500 tabular-nums">{formatCentsFull(inv.balance_cents)} due</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function MoneyTile({ label, value, sub, tone = "neutral", href }: { label: string; value: string; sub?: string; tone?: "neutral" | "emerald" | "amber" | "rose"; href?: string }) {
  const cls = tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  const inner = (
    <>
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 ${cls}`}>{value}</div>
      {sub ? <div className={`text-[10px] mt-0.5 ${cls}`}>{sub}</div> : null}
    </>
  );
  return href ? (
    <Link href={href} className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2 hover:border-ppp-blue-200 hover:bg-ppp-blue-50/30 transition-colors">{inner}</Link>
  ) : (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2">{inner}</div>
  );
}
