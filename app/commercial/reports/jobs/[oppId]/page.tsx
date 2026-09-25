import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { roleAllowsReport } from "@/lib/commercial/reports/access-rule";
import { getJobReport, spendTotal, type JobReport } from "@/lib/commercial/reports/jobs";
import { JOB_GROUPS } from "@/lib/commercial/reports/jobs-rows";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";
// Full amounts, not compact: a report is where somebody checks a figure, and
// "$1.2M" is not a figure you can check. The compact form belongs on the index
// cards, where the number is a glance.
import { formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import { deriveInvoiceStatus, invoiceStatusLabel } from "@/lib/commercial/invoices/constants";
import { statusPillTone } from "@/lib/commercial/opportunities/status-tone";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import { opportunitySubStatusLabel } from "@/lib/commercial/opportunities/constants";
import { CHANGE_ORDER_STATUS_META, formatChangeOrderNumber } from "@/lib/commercial/change-orders/constants";
import { purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";
import { proposalStatusLabel } from "@/lib/commercial/proposals/constants";
import { proposalDisplayId } from "@/lib/commercial/proposals/db";
import { SIGNATURE_STATUS_LABEL, SIGNATURE_STATUS_TONE, formatSignedAt } from "@/lib/commercial/esign/constants";
import { opportunityAssignmentRoleLabel } from "@/lib/commercial/opportunities/assignments";
import { ExportCsvLink } from "@/components/commercial/export-csv-link";
import { PrintButton } from "@/components/commercial/reports/print-button";
import { PrintSheetStyles } from "@/components/commercial/print-sheet";

export const metadata = { title: "Job report" };

export const dynamic = "force-dynamic";

/**
 * ONE JOB — everything about it, on one page.
 *
 * Karan, 2026-09-15: *"we choose a job and have reports for that job only."*
 *
 * The money block is `getProjectFinancials` + `dealMargin` — literally the
 * helpers app/commercial/opportunities/[id]/page.tsx renders from. Not "the same
 * definitions": the same functions. A number that differed between this page and
 * the deal page would be a bug, and the only way to guarantee it can't happen is
 * to have no second implementation to disagree with.
 *
 * The period filter narrows the ITEMISED sections (invoices, costs, labor, COs,
 * paperwork) and pointedly does NOT touch the money block: a contract and an
 * open balance are positions as of today, not events inside a window, and
 * showing "$0 contract · last week" would be a lie told by a filter.
 *
 * Per-person pay (crew cost by worker) is gated to admin / account manager, the
 * same gate the Labor report puts on its people table — a folder that shares
 * this report must not become a back door to the payroll.
 */

type SP = Record<string, string | string[] | undefined>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JobReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ oppId: string }>;
  searchParams: Promise<SP>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  // Report folders: only reports in a folder you belong to (admins see all).
  // The nested route has no registry entry of its own — it IS the jobs report,
  // so it gates on the same key. A layout would not run for this check.
  const access = await requireReportAccess(user.id, user.email, "jobs");
  const canSeePay = roleAllowsReport({ requires: "people" }, access.role);

  const { oppId } = await params;
  if (!UUID_RE.test(oppId)) notFound();

  const sp = await searchParams;
  const preset = resolvePreset(sp.preset, ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
  const range = activityRange(preset);

  const report = await getJobReport(oppId, range);
  if (!report) notFound();

  const { opp, financials: fin, margin } = report;
  const backToList = "/commercial/reports/jobs";
  const periodHref = (k: string) =>
    k === ACTIVITY_DEFAULT ? `${backToList}/${oppId}` : `${backToList}/${oppId}?preset=${k}`;
  const windowLabel = range ? range.label : "Whole job";

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 pb-8 sm:px-6">
      <PrintSheetStyles id="job-report" />

      {/* ── Where you are, and the ways out ── */}
      <div data-print-hide className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <Link href={backToList} className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
          All jobs
        </Link>
        <Link href={`/commercial/opportunities/${oppId}`} className="inline-flex min-h-[44px] items-center font-semibold text-cc-brand-700 hover:underline">
          Open the deal →
        </Link>
      </div>

      <div id="job-report" className="space-y-4">
        {/* ── Header ── */}
        <header className="rounded-xl border border-ppp-charcoal-100 bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-condensed text-[22px] font-black leading-tight tracking-tight text-ppp-charcoal break-words sm:text-2xl">
                {report.jobName}
              </h2>
              <p className="mt-1 text-[13px] text-ppp-charcoal-600 break-words">
                {report.accountName}
                {report.address ? ` · ${report.address}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusChip status={opp.status} subStatus={opp.sub_status} />
                {opp.sub_status && (
                  <span className="text-[11px] text-ppp-charcoal-500">{opportunitySubStatusLabel(opp.sub_status)}</span>
                )}
                <span className="text-[11px] text-ppp-charcoal-400">
                  {JOB_GROUPS.find((g) => g.key === report.group)?.label}
                </span>
              </div>
            </div>
            <div data-print-hide className="flex shrink-0 flex-wrap items-center gap-2">
              <PrintButton />
              <ExportCsvLink
                href={`/api/commercial/reports/jobs/${oppId}/export`}
                preset={preset === ACTIVITY_DEFAULT ? undefined : preset}
                label="Export CSV"
              />
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-ppp-charcoal-50 pt-3.5 text-[12px] sm:grid-cols-4">
            <Fact label="Project no." value={opp.project_number ?? "Not assigned"} />
            <Fact label="Deal no." value={opp.deal_number ?? "—"} />
            <Fact label="Created" value={fmtEtDate(opp.created_at)} />
            <Fact
              label={report.group === "lost" ? "Lost" : "Won"}
              value={opp.decided_at ? fmtEtDate(opp.decided_at) : "Not decided yet"}
            />
            <Fact label="Planned start" value={opp.proposed_start_at ? fmtEtDate(opp.proposed_start_at) : "—"} />
            <Fact label="Planned finish" value={opp.proposed_end_at ? fmtEtDate(opp.proposed_end_at) : "—"} />
            <Fact label="Closed out" value={opp.closed_out_at ? fmtEtDate(opp.closed_out_at) : "—"} />
            <Fact label="Estimator" value={opp.estimator_name?.trim() || estimatorFromTeam(report) || "Not named"} />
          </dl>

          {report.team.length > 0 && (
            <div className="mt-3 border-t border-ppp-charcoal-50 pt-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Team</div>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ppp-charcoal-700">
                {report.team.map((p) => (
                  <li key={p.user_id}>
                    <span className="font-semibold">{p.user_full_name?.trim() || p.user_email}</span>
                    <span className="text-ppp-charcoal-500">
                      {" · "}
                      {p.assignments.map((a) => opportunityAssignmentRoleLabel(a.role)).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </header>

        {report.failed.length > 0 && (
          <Banner>
            Couldn&rsquo;t load {report.failed.join(", ")} just now, so {report.failed.length === 1 ? "that section is" : "those sections are"} empty rather than
            wrong. Everything else on this page is current — refresh to try again.
          </Banner>
        )}

        {/* ── Period ── */}
        <div data-print-hide className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-ppp-charcoal-100 bg-surface p-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Period</span>
          {ACTIVITY_PRESETS.map((p) => (
            <Link
              key={p.key}
              href={periodHref(p.key)}
              aria-current={p.key === preset ? "page" : undefined}
              className={`inline-flex min-h-[44px] items-center rounded-lg border px-2.5 text-[12px] font-semibold transition-colors sm:min-h-[34px] ${
                p.key === preset
                  ? "border-cc-brand-600 bg-cc-brand-600 text-white"
                  : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
            >
              {p.key === "all" ? "Whole job" : p.label}
            </Link>
          ))}
          <span className="w-full text-[11px] leading-snug text-ppp-charcoal-500 sm:w-auto sm:pl-1">
            Narrows the lists below. The money block stays whole-job — a contract isn&rsquo;t an event in a window.
          </span>
        </div>

        {/* ── Money ── */}
        <Section title="Money" note="Whole job, as of today.">
          {!fin ? (
            <Muted>Couldn&rsquo;t load this job&rsquo;s money. Nothing is shown rather than zeros.</Muted>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <Tile
                  label="Contract"
                  value={fin.hasContract ? formatCentsFull(fin.contractCents) : "Not set yet"}
                  sub={fin.hasContract ? "incl. approved change orders" : "no proposal, AIA or bid to price it from"}
                />
                <Tile label="Billed" value={fin.billedPreTaxCents > 0 ? formatCentsFull(fin.billedPreTaxCents) : "Nothing billed yet"} sub="pre-tax, incl. AIA" />
                <Tile
                  label="Collected"
                  value={fin.collectedCents > 0 ? formatCentsFull(fin.collectedCents) : fin.billedPreTaxCents > 0 ? "Nothing in yet" : "—"}
                  tone="emerald"
                />
                <Tile
                  label="Open balance"
                  value={fin.openBalanceCents > 0 ? formatCentsFull(fin.openBalanceCents) : fin.billedPreTaxCents > 0 ? "All paid" : "—"}
                  tone={fin.openBalanceCents > 0 ? "amber" : "neutral"}
                />
                <Tile
                  label="Retainage held"
                  value={fin.retainageHeldCents > 0 ? formatCentsFull(fin.retainageHeldCents) : "—"}
                  sub={fin.retainageHeldCents > 0 ? "not payable until close-out" : undefined}
                />
                <Tile
                  label="Credits"
                  value={fin.creditCents > 0 ? formatCentsFull(fin.creditCents) : "—"}
                  sub={fin.creditCents > 0 ? "overpaid — owed back or to apply" : undefined}
                  tone={fin.creditCents > 0 ? "amber" : "neutral"}
                />
                <Tile label="Cost" value={fin.totalCostCents > 0 ? formatCentsFull(fin.totalCostCents) : "None logged"} tone="amber" />
                <Tile
                  label={margin?.label ?? "Margin"}
                  value={margin?.pct === null || margin == null ? "—" : `${margin.pct}%`}
                  sub={margin?.caveat ?? (margin ? formatCentsFull(margin.cents) : undefined)}
                  tone={
                    margin == null || margin.pct === null || margin.provisional
                      ? "neutral"
                      : margin.pct < 0 ? "rose" : margin.pct < 15 ? "amber" : "emerald"
                  }
                />
              </div>
              {margin?.vsContract && (
                <p className="mt-2 text-[11.5px] text-ppp-charcoal-500">
                  {margin.vsContract.label}: <strong className="tabular-nums text-ppp-charcoal-700">{margin.vsContract.pct}%</strong>{" "}
                  ({formatCentsFull(margin.vsContract.cents)}) — how the job is tracking against what we sold, which is a different
                  question from the margin above (billed vs spent).
                </p>
              )}
              {fin.laborUnratedHours > 0 && (
                <p className="mt-1.5 text-[11.5px] text-amber-800">
                  Margin reads high: {fin.laborUnratedHours}h of crew time is not costed yet, so it counts as $0 here until that week is posted in Payroll.
                </p>
              )}
            </>
          )}
        </Section>

        {/* ── Invoices ── */}
        <Section title="Invoices" count={report.invoices.length} note={windowNote(range, windowLabel)}>
          {report.invoices.length === 0 ? (
            <Muted>{range ? `No invoices in ${windowLabel.toLowerCase()}.` : "Nothing has been invoiced on this job yet."}</Muted>
          ) : (
            <Table minWidth={720} head={["Invoice", "Status", "Issued", "Due", "Total", "Paid", "Balance"]}>
              {report.invoices.map((inv) => {
                const st = deriveInvoiceStatus(inv);
                return (
                  <tr key={inv.id} className="align-top hover:bg-ppp-charcoal-50/60">
                    <Td>
                      <Link href={`/commercial/invoices/${inv.id}`} className="font-semibold text-cc-brand-700 hover:underline">
                        {inv.invoice_number}
                      </Link>
                    </Td>
                    <Td className="text-ppp-charcoal-600">{invoiceStatusLabel(st)}</Td>
                    <Td className="text-ppp-charcoal-500">{inv.issued_at ? fmtEtDate(inv.issued_at) : "—"}</Td>
                    <Td className="text-ppp-charcoal-500">{inv.due_at ? fmtEtDate(inv.due_at) : "—"}</Td>
                    <TdNum>{formatCentsFull(inv.total_cents)}</TdNum>
                    <TdNum>{inv.paid_cents > 0 ? formatCentsFull(inv.paid_cents) : "—"}</TdNum>
                    <TdNum className={inv.balance_cents > 0 ? "text-amber-800" : undefined}>
                      {inv.balance_cents === 0 ? "Paid" : formatCentsFull(inv.balance_cents)}
                    </TdNum>
                  </tr>
                );
              })}
            </Table>
          )}
        </Section>

        {/* ── AIA ── */}
        {(report.aiaApps.length > 0 || (fin?.retainageHeldCents ?? 0) > 0) && (
          <Section title="AIA payment applications" count={report.aiaApps.length} note={windowNote(range, windowLabel)}>
            {report.aiaApps.length === 0 ? (
              <Muted>No applications in {windowLabel.toLowerCase()}.</Muted>
            ) : (
              <Table minWidth={620} head={["App #", "Status", "Period to", "Contract sum", "Retainage %"]}>
                {report.aiaApps.map((a) => (
                  <tr key={a.id} className="align-top hover:bg-ppp-charcoal-50/60">
                    <Td>
                      <Link href={`/commercial/opportunities/${oppId}?tab=aia`} className="font-semibold text-cc-brand-700 hover:underline">
                        #{a.application_number}
                      </Link>
                    </Td>
                    <Td className="capitalize text-ppp-charcoal-600">{a.status}</Td>
                    <Td className="text-ppp-charcoal-500">{a.period_to ? fmtEtDate(a.period_to) : "—"}</Td>
                    <TdNum>
                      {a.contract_sum_frozen_cents != null
                        ? formatCentsFull(a.contract_sum_frozen_cents)
                        : a.original_contract_cents > 0
                          ? formatCentsFull(a.original_contract_cents)
                          : "—"}
                    </TdNum>
                    <TdNum>{a.retainage_pct}%</TdNum>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        )}

        {/* ── Costs ── */}
        <Section
          title="Costs"
          count={report.purchases.length}
          note={windowNote(range, windowLabel)}
          right={report.purchases.length > 0 ? formatCentsFull(spendTotal(report.byCategory)) : undefined}
        >
          {report.purchases.length === 0 ? (
            <Muted>
              {range
                ? `No purchases logged in ${windowLabel.toLowerCase()}.`
                : "No purchases have been logged against this job. Crew labor, if any, is counted separately below."}
            </Muted>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <SubHead>By category</SubHead>
                <Table minWidth={280} head={["Category", "Items", "Amount"]}>
                  {report.byCategory.map((c) => (
                    <tr key={c.key} className="hover:bg-ppp-charcoal-50/60">
                      <Td className="text-ppp-charcoal-700">{c.label}</Td>
                      <TdNum className="text-ppp-charcoal-500">{c.count}</TdNum>
                      <TdNum>{formatCentsFull(c.cents)}</TdNum>
                    </tr>
                  ))}
                </Table>
              </div>
              <div>
                <SubHead>By vendor</SubHead>
                <Table minWidth={280} head={["Vendor", "Items", "Amount"]}>
                  {report.byVendor.map((v) => (
                    <tr key={v.vendor} className="hover:bg-ppp-charcoal-50/60">
                      <Td className="text-ppp-charcoal-700 break-words">{v.vendor}</Td>
                      <TdNum className="text-ppp-charcoal-500">{v.count}</TdNum>
                      <TdNum>{formatCentsFull(v.cents)}</TdNum>
                    </tr>
                  ))}
                </Table>
              </div>
              <div className="lg:col-span-2">
                <SubHead>Every purchase</SubHead>
                <Table minWidth={680} head={["Date", "Category", "Vendor", "Description", "Amount"]}>
                  {report.purchases.map((p) => (
                    <tr key={p.id} className="align-top hover:bg-ppp-charcoal-50/60">
                      <Td className="whitespace-nowrap text-ppp-charcoal-500">{fmtEtDate(p.purchased_at)}</Td>
                      <Td className="text-ppp-charcoal-600">{purchaseCategoryLabel(p.category)}</Td>
                      <Td className="text-ppp-charcoal-700 break-words">{(p.vendor ?? "").trim() || "—"}</Td>
                      <Td className="text-ppp-charcoal-500 break-words">{(p.description ?? "").trim() || "—"}</Td>
                      <TdNum>{formatCentsFull(p.amount_cents)}</TdNum>
                    </tr>
                  ))}
                </Table>
              </div>
            </div>
          )}
        </Section>

        {/* ── Labor ── */}
        <Section
          title="Labor"
          note={windowNote(range, windowLabel)}
          right={report.crew.days.length > 0 ? `${report.crew.days.length} ${report.crew.days.length === 1 ? "day" : "days"} on site` : undefined}
        >
          {report.crew.workers.length === 0 && report.subLabor.length === 0 ? (
            <Muted>
              {range
                ? `No settled crew hours in ${windowLabel.toLowerCase()}.`
                : "No approved crew hours and no subcontract-labor purchases on this job yet."}
            </Muted>
          ) : (
            <div className="space-y-4">
              {report.crew.workers.length > 0 && (
                <div>
                  <SubHead>
                    In-house crew · {fmtHours(report.crew.totalHours)}h
                    {report.crew.days.length > 0 && ` over ${report.crew.days.length} ${report.crew.days.length === 1 ? "day" : "days"}`}
                    {canSeePay && report.crew.costCents > 0 && ` · ${formatCentsFull(report.crew.costCents)}`}
                  </SubHead>
                  <Table
                    minWidth={canSeePay ? 560 : 400}
                    head={canSeePay ? ["Worker", "Days", "Hours", "Rate", "Cost"] : ["Worker", "Days", "Hours"]}
                  >
                    {report.crew.workers.map((w) => (
                      <tr key={w.employeeId} className="hover:bg-ppp-charcoal-50/60">
                        <Td className="text-ppp-charcoal-700 break-words">{w.name}</Td>
                        <TdNum className="text-ppp-charcoal-500">{w.days}</TdNum>
                        <TdNum className={w.unratedHours > 0 ? "text-amber-800" : undefined} >
                          {fmtHours(w.hours)}h
                          {w.unratedHours > 0 && <span className="ml-1 text-[10.5px]">({fmtHours(w.unratedHours)}h unpriced)</span>}
                        </TdNum>
                        {canSeePay && <TdNum className="text-ppp-charcoal-500">{w.currentRateCents != null ? `${formatCentsFull(w.currentRateCents)}/h` : "No rate"}</TdNum>}
                        {canSeePay && <TdNum>{w.costCents > 0 ? formatCentsFull(w.costCents) : "—"}</TdNum>}
                      </tr>
                    ))}
                  </Table>
                  {!canSeePay && (
                    <p className="mt-1.5 text-[11px] text-ppp-charcoal-500">
                      Hours only — per-person pay is admin / account-manager.
                    </p>
                  )}
                </div>
              )}

              {report.subLabor.length > 0 && (
                <div>
                  <SubHead>Subcontract labor (purchases) · whole job</SubHead>
                  <Table minWidth={canSeePay ? 480 : 360} head={canSeePay ? ["Worker", "Hours", "Cost"] : ["Worker", "Hours"]}>
                    {report.subLabor.map((w) => (
                      <tr key={w.worker} className="hover:bg-ppp-charcoal-50/60">
                        <Td className="text-ppp-charcoal-700 break-words">{w.worker}</Td>
                        <TdNum className="text-ppp-charcoal-500">{w.hours > 0 ? `${fmtHours(w.hours)}h` : "—"}</TdNum>
                        {canSeePay && <TdNum>{formatCentsFull(w.cost_cents)}</TdNum>}
                      </tr>
                    ))}
                  </Table>
                  <p className="mt-1.5 text-[11px] text-ppp-charcoal-500">
                    A different pot from the crew above: 1099 / day-labor booked as purchases, already counted in Costs.
                  </p>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* ── Change orders ── */}
        <Section title="Change orders" count={report.changeOrders.length} note={windowNote(range, windowLabel)}>
          {report.changeOrders.length === 0 ? (
            <Muted>{range ? `No change orders in ${windowLabel.toLowerCase()}.` : "No change orders on this job."}</Muted>
          ) : (
            <Table minWidth={620} head={["CO", "Title", "Status", "Decided", "Amount"]}>
              {report.changeOrders.map((co) => (
                <tr key={co.id} className="align-top hover:bg-ppp-charcoal-50/60">
                  <Td className="whitespace-nowrap font-semibold text-ppp-charcoal-700">{formatChangeOrderNumber(co.co_number)}</Td>
                  <Td className="text-ppp-charcoal-700 break-words">{co.title}</Td>
                  <Td className="text-ppp-charcoal-600">{CHANGE_ORDER_STATUS_META[co.status]?.label ?? co.status}</Td>
                  <Td className="text-ppp-charcoal-500">{co.decided_at ? fmtEtDate(co.decided_at) : "—"}</Td>
                  <TdNum className={co.amount_cents < 0 ? "text-rose-700" : undefined}>{formatCentsFull(co.amount_cents)}</TdNum>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* ── Proposals + signatures ── */}
        <Section title="Proposals &amp; signatures" count={report.proposals.length} note={windowNote(range, windowLabel)}>
          {report.proposals.length === 0 ? (
            <Muted>{range ? `No proposals in ${windowLabel.toLowerCase()}.` : "No proposals have been written for this job."}</Muted>
          ) : (
            <ul className="space-y-2.5">
              {report.proposals.map(({ proposal, signatures }) => (
                <li key={proposal.id} className="rounded-lg border border-ppp-charcoal-100 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <Link
                      href={`/commercial/accounts/${report.accountId}/deals/${oppId}/proposal/${proposal.id}`}
                      className="text-[13px] font-bold text-cc-brand-700 hover:underline"
                    >
                      {proposalDisplayId(proposal)}
                    </Link>
                    <span className="text-[11.5px] text-ppp-charcoal-500">
                      {proposalStatusLabel(proposal.status)}
                      {proposal.sent_at ? ` · sent ${fmtEtDate(proposal.sent_at)}` : ""}
                    </span>
                    <span className="ml-auto font-condensed text-[15px] font-black tabular-nums text-ppp-charcoal">
                      {formatCentsFull(proposal.final_price_override_cents ?? proposal.total_cents)}
                    </span>
                  </div>
                  {signatures.length === 0 ? (
                    <p className="mt-1 text-[11.5px] text-ppp-charcoal-400">Never sent for e-signature.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {signatures.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px]">
                          <SignatureChip status={s.status} />
                          <span className="text-ppp-charcoal-600 break-words">{s.signer_name?.trim() || s.signer_email}</span>
                          <span className="text-ppp-charcoal-400">{formatSignedAt(s.customer_signed_at)}</span>
                          <span data-print-hide className="ml-auto flex items-center gap-2">
                            {s.signed_document_id && (
                              <a href={`/api/commercial/signatures/${s.id}/signed`} target="_blank" rel="noopener noreferrer"
                                 className="inline-flex min-h-[44px] items-center font-semibold text-cc-brand-700 hover:underline sm:min-h-0">
                                Signed copy
                              </a>
                            )}
                            <a href={`/api/commercial/signatures/${s.id}/audit`} target="_blank" rel="noopener noreferrer"
                               className="inline-flex min-h-[44px] items-center font-semibold text-ppp-charcoal-600 hover:underline sm:min-h-0">
                              Audit trail
                            </a>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ── Documents ── */}
        <Section title="Documents" count={report.documents.length} note={windowNote(range, windowLabel)}>
          {report.documents.length === 0 ? (
            <Muted>{range ? `Nothing filed in ${windowLabel.toLowerCase()}.` : "No documents have been filed against this job."}</Muted>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {report.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-[12px]">
                  <a
                    href={`/api/commercial/documents/${d.id}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 break-words font-semibold text-cc-brand-700 hover:underline"
                  >
                    {d.file_name}
                  </a>
                  <span className="text-ppp-charcoal-500">{String(d.category).replace(/_/g, " ")}</span>
                  <span className="ml-auto whitespace-nowrap text-ppp-charcoal-400">{fmtEtDate(d.uploaded_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ── Notes ── */}
        <Section title="Notes" count={report.notes.length} note={windowNote(range, windowLabel)}>
          {report.notes.length === 0 ? (
            <Muted>{range ? `No notes in ${windowLabel.toLowerCase()}.` : "No notes have been written about this job."}</Muted>
          ) : (
            <ul className="space-y-2.5">
              {report.notes.map((n) => (
                <li key={n.id} className="rounded-lg border border-ppp-charcoal-100 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-ppp-charcoal-500">
                    <span className="font-semibold text-ppp-charcoal-700">{n.author_full_name?.trim() || n.author_email || "Someone"}</span>
                    <span>{fmtEtDate(n.created_at)}</span>
                    {n.kind === "auto_debrief" && <span className="text-ppp-charcoal-400">· win/loss debrief</span>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ppp-charcoal-700">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <p className="text-[10.5px] text-ppp-charcoal-400">
          {report.jobName} · {report.accountName} · {windowLabel} · Precision Painting Plus Commercial Command Center
        </p>
      </div>
    </div>
  );
}

// ─── Print ──────────────────────────────────────────────────────────────────

// ─── Small pieces ───────────────────────────────────────────────────────────

function estimatorFromTeam(r: JobReport): string | null {
  const est = r.team.find((p) => p.assignments.some((a) => a.role === "estimator"));
  return est ? est.user_full_name?.trim() || est.user_email : null;
}

function windowNote(range: { label: string } | null, label: string): string | undefined {
  return range ? label : undefined;
}

function fmtHours(h: number): string {
  return h.toLocaleString("en-US", { maximumFractionDigits: h < 100 ? 1 : 0 });
}

function Section({
  title,
  count,
  note,
  right,
  children,
}: {
  title: string;
  count?: number;
  note?: string;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-2 text-[13px] font-bold text-ppp-charcoal">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          {title}
          {count !== undefined && <span className="text-[11px] font-semibold tabular-nums text-ppp-charcoal-400">{count}</span>}
        </h3>
        <span className="text-[11px] text-ppp-charcoal-500">
          {right}
          {right && note ? " · " : ""}
          {note}
        </span>
      </div>
      {children}
    </section>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-ppp-charcoal-500">{children}</p>;
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-snug text-amber-900">
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</dt>
      <dd className="mt-0.5 break-words text-ppp-charcoal-700">{value}</dd>
    </div>
  );
}

function Tile({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: "neutral" | "emerald" | "amber" | "rose" }) {
  const color =
    tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-800" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider leading-tight text-ppp-charcoal-500">{label}</div>
      {/* break-words, not truncate: these are full amounts, and at 400px in a
          two-up grid a long one must wrap rather than be cut off — a silently
          clipped figure is worse than an ugly one. */}
      <div className={`font-condensed text-[19px] font-black leading-tight tabular-nums break-words ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10.5px] leading-snug text-ppp-charcoal-500">{sub}</div>}
    </div>
  );
}

function Table({ minWidth, head, children }: { minWidth: number; head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-ppp-charcoal-100">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]" style={{ minWidth }}>
          <thead>
            <tr className="bg-ppp-charcoal-50/60 text-left text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
              {head.map((h, i) => (
                <th key={h} scope="col" className={`px-3 py-2 ${i >= head.length - numericTail(head) ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ppp-charcoal-100">{children}</tbody>
        </table>
      </div>
    </div>
  );
}

/** How many trailing columns are numbers — they right-align. Every table here
 *  puts its figures last, so this is one rule instead of a per-table list. */
const NUMERIC_HEADS = new Set(["Total", "Paid", "Balance", "Amount", "Items", "Cost", "Hours", "Days", "Rate", "Retainage %", "Contract sum"]);
function numericTail(head: string[]): number {
  let n = 0;
  for (let i = head.length - 1; i >= 0 && NUMERIC_HEADS.has(head[i]); i--) n += 1;
  return n;
}

function Td({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function TdNum({ className, children }: { className?: string; children: React.ReactNode }) {
  return <td className={`px-3 py-2 text-right tabular-nums ${className ?? "text-ppp-charcoal-700"}`}>{children}</td>;
}

function StatusChip({ status, subStatus }: { status: string; subStatus: string | null }) {
  const { cls } = statusPillTone(status, subStatus);
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-semibold ${cls}`}>
      {oppStatusDisplayLabel(status, subStatus)}
    </span>
  );
}

function SignatureChip({ status }: { status: keyof typeof SIGNATURE_STATUS_LABEL }) {
  const tone = SIGNATURE_STATUS_TONE[status];
  const cls =
    tone === "green" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : tone === "amber" ? "bg-amber-50 text-amber-800 border-amber-200"
    : tone === "red" ? "bg-rose-50 text-rose-700 border-rose-200"
    : "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200";
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0 text-[10px] font-semibold ${cls}`}>{SIGNATURE_STATUS_LABEL[status]}</span>;
}
