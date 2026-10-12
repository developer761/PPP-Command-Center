import Link from "next/link";
import { redirect } from "next/navigation";
import PageHeader from "@/components/page-header";
import { PaymentsFilters } from "@/components/pay/payments-filters";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { listLedgerPayments, loadJobSchedules, paymentsConfig, type JobSchedule } from "@/lib/payments/service";
import { formatCents, type Milestone } from "@/lib/payments/schedule";
import {
  PAID_WITH_LABEL,
  RANGE_LABEL,
  STAGE_LABEL,
  filterLedger,
  ledgerQueryString,
  paidWith,
  parseLedgerQuery,
  paymentDateEt,
  stageOf,
  totalsOf,
  type LedgerPayment,
  type LedgerQuery,
  type PaidWith,
  type Stage,
} from "@/lib/payments/ledger";
import { etTodayIso } from "@/lib/date-et";
import { paymentsSalesforceBaseUrl } from "@/lib/salesforce/payments-org";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments · PPP Command Center" };

/**
 * Payments — every online invoice payment, with the BASE amount (what pays
 * down the job and what Salesforce gets) and the 3% CREDIT-CARD FEE (collected
 * on top, never booked into the Payment In) kept apart, plus what Stripe
 * charged PPP to process them. Filter by period / how it was paid; Export
 * downloads exactly what's on screen (same query string, same parser).
 *
 * Admin-only: it's company revenue.
 */

type SP = Promise<Record<string, string | string[] | undefined>>;

const SF_FALLBACK = (process.env.SF_LOGIN_URL ?? "https://precisionplus.my.salesforce.com").replace(/\/$/, "");
/** A record link in the org the payments code is on (production, or the sandbox when testing). */
const sfLink = (base: string, id: string) => `${base}/${id}`;
const stripeLink = (pi: string, live: boolean) => `https://dashboard.stripe.com/${live ? "" : "test/"}payments/${pi}`;

/** Short on screen; the full STAGE_LABEL is the tooltip and the export column. */
const STAGE_SHORT: Record<Stage, string> = {
  processing: "Clearing",
  awaiting_payout: "Awaiting payout",
  cleared: "Cleared",
  booked: "Booked",
  booking_failed: "Booking failed",
  refunded: "Refunded",
};
const STAGE_CLS: Record<Stage, string> = {
  processing: "bg-ppp-blue-50 text-ppp-blue-700",
  awaiting_payout: "bg-ppp-orange-50 text-ppp-orange-700",
  cleared: "bg-ppp-green-50 text-ppp-green-700",
  booked: "bg-ppp-green-50 text-ppp-green-700",
  booking_failed: "bg-red-50 text-red-700",
  refunded: "bg-ppp-charcoal-50 text-ppp-charcoal-600",
};

const METHOD_SHORT: Record<PaidWith, string> = {
  bank: "Bank",
  credit: "Credit",
  debit: "Debit",
  prepaid: "Prepaid",
  card: "Card",
};
/** One color per method — the mix bar, its legend and each row's dot agree. */
const METHOD_DOT: Record<PaidWith, string> = {
  bank: "bg-ppp-blue-500",
  credit: "bg-ppp-orange-500",
  debit: "bg-ppp-green-500",
  prepaid: "bg-ppp-navy-400",
  card: "bg-ppp-charcoal-300",
};

function fmtDay(iso: string, thisYear: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(String(y) === thisYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

function periodText(q: LedgerQuery, thisYear: string): string {
  if (q.preset !== "custom") return RANGE_LABEL[q.preset];
  if (q.from && q.to) return `${fmtDay(q.from, thisYear)} – ${fmtDay(q.to, thisYear)}`;
  if (q.from) return `Since ${fmtDay(q.from, thisYear)}`;
  if (q.to) return `Through ${fmtDay(q.to, thisYear)}`;
  return "All time";
}

/** The stage a Work Order's row shows: the one that most needs someone. */
const STAGE_URGENCY: Stage[] = ["booking_failed", "processing", "awaiting_payout", "cleared", "booked", "refunded"];

type WorkOrderGroup = {
  workOrderId: string;
  workOrderNumber: string;
  customer: string;
  /** Oldest first, so the terms read Deposit → Progress → Final. */
  rows: LedgerPayment[];
  totals: ReturnType<typeof totalsOf>;
  stage: Stage;
  lastDay: string;
};

/** Payments grouped under their Work Order, most recently paid first. */
function groupByWorkOrder(rows: LedgerPayment[]): WorkOrderGroup[] {
  const by = new Map<string, LedgerPayment[]>();
  for (const p of rows) by.set(p.work_order_id, [...(by.get(p.work_order_id) ?? []), p]);
  return [...by.values()]
    .map((list) => {
      const sorted = [...list].sort(
        (a, b) => paymentDateEt(a).localeCompare(paymentDateEt(b)) || a.created_at.localeCompare(b.created_at),
      );
      const stages = new Set(sorted.map(stageOf));
      const last = sorted[sorted.length - 1];
      return {
        workOrderId: last.work_order_id,
        workOrderNumber: last.work_order_number,
        customer: sorted.find((p) => p.customer_name)?.customer_name ?? "—",
        rows: sorted,
        totals: totalsOf(sorted),
        stage: STAGE_URGENCY.find((st) => stages.has(st)) ?? "booked",
        lastDay: paymentDateEt(last),
      };
    })
    .sort((a, b) => b.lastDay.localeCompare(a.lastDay));
}

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  if (!(await getSignedInAdminEmail())) redirect("/dashboard");
  const sp = await searchParams;
  const cfg = paymentsConfig();
  const today = etTodayIso();
  const thisYear = today.slice(0, 4);
  // Show the mode the Stripe key is in, so a test setup isn't an empty page.
  const q = parseLedgerQuery(sp, today, cfg.stripeMode !== "test");
  const sfBase = await paymentsSalesforceBaseUrl().catch(() => SF_FALLBACK);

  let all: LedgerPayment[] = [];
  let loadError: string | null = null;
  try {
    all = (await listLedgerPayments()) as LedgerPayment[];
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  const rows = filterLedger(all, q);
  const t = totalsOf(rows);
  const period = periodText(q, thisYear);
  const failed = rows.filter((p) => stageOf(p) === "booking_failed").length;
  const methods = (Object.keys(PAID_WITH_LABEL) as PaidWith[]).filter((w) => t.byPaidWith[w].count > 0);
  const groups = groupByWorkOrder(rows);
  // What's still owed on each listed job, live from Salesforce in one batch.
  // A Salesforce hiccup must not take the payments list down with it.
  let schedules = new Map<string, JobSchedule>();
  let scheduleError = false;
  if (groups.length) {
    try {
      schedules = await loadJobSchedules(all, groups.map((g) => g.workOrderId));
    } catch (e) {
      console.error("[payments] payment terms read failed:", e);
      scheduleError = true;
    }
  }
  const stillOwedCents = groups.reduce((s, g) => s + (schedules.get(g.workOrderId)?.schedule.payableBalanceCents ?? 0), 0);
  // The Real/Test switch only earns its space once a test payment exists.
  const showModeToggle = !q.livemode || all.some((p) => !p.livemode);

  return (
    <div className="animate-fade-up space-y-5">
      <PageHeader
        title="Payments"
        subtitle="Online invoice payments. Salesforce gets the base amount; card fees are tracked here."
        actions={
          <a
            href={`/api/payments/export?${ledgerQueryString(q)}`}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-ppp-navy text-white px-4 min-h-[44px] text-sm font-semibold hover:bg-ppp-navy-900"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v12 M7 10l5 5 5-5 M5 21h14" />
            </svg>
            Export to Excel
          </a>
        }
      />

      {loadError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Couldn&rsquo;t load payments: {loadError}
        </div>
      )}

      {failed > 0 && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <span>
            <strong>{failed}</strong> payment{failed === 1 ? "" : "s"} didn&rsquo;t book in Salesforce.
          </span>
          <Link href="/dashboard/settings/payments" className="font-semibold underline underline-offset-2">
            Retry in Online Payments
          </Link>
        </div>
      )}

      <section className="rounded-xl bg-white border border-ppp-charcoal-100 p-3 sm:p-4">
        <PaymentsFilters q={q} showModeToggle={showModeToggle} />
        {!q.livemode && (
          <p className="mt-3 text-[12px] text-ppp-orange-700">
            Showing Stripe <strong>test</strong> payments — not real money.
          </p>
        )}
      </section>

      {/* Totals */}
      <section className="rounded-xl bg-white border border-ppp-charcoal-100 p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-end gap-5 lg:gap-10">
          <div className="min-w-0">
            <div className="text-[12px] font-medium uppercase tracking-wide text-ppp-charcoal-500">
              Collected · {period}
            </div>
            <div className="mt-1 font-condensed text-4xl sm:text-5xl font-bold text-ppp-navy tabular-nums">
              {formatCents(t.baseCents)}
            </div>
            <div className="mt-1 text-[13px] text-ppp-charcoal-600">
              {t.count} payment{t.count === 1 ? "" : "s"} · the amount booked in Salesforce
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-3 sm:gap-6 lg:ml-auto">
            <Stat label="Card fees" value={formatCents(t.feeCents)} sub="3% on credit cards" />
            <Stat label="Total charged" value={formatCents(t.totalCents)} sub="Base + fees" />
            <Stat
              label="Stripe's cost"
              value={t.stripeFeeKnownCount ? formatCents(t.stripeFeeCents) : "Pending"}
              sub={
                t.stripeFeeKnownCount
                  ? t.feeNetCents >= 0
                    ? `Fees cover it (+${formatCents(t.feeNetCents)})`
                    : `Short ${formatCents(-t.feeNetCents)}`
                  : "Known after payout"
              }
              muted={!t.stripeFeeKnownCount}
            />
          </dl>
        </div>

        {methods.length > 0 && (
          <div className="mt-6">
            <div className="flex h-2 overflow-hidden rounded-full bg-ppp-charcoal-100" aria-hidden>
              {methods.map((w) => (
                <div
                  key={w}
                  className={METHOD_DOT[w]}
                  style={{ width: `${(t.byPaidWith[w].totalCents / Math.max(1, t.totalCents)) * 100}%` }}
                />
              ))}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
              {methods.map((w) => (
                <li key={w} className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${METHOD_DOT[w]}`} aria-hidden />
                  <span className="text-ppp-charcoal-700">{PAID_WITH_LABEL[w]}</span>
                  <span className="font-semibold text-ppp-navy tabular-nums">{formatCents(t.byPaidWith[w].baseCents)}</span>
                  <span className="text-ppp-charcoal-500">· {t.byPaidWith[w].count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {t.refundedCount > 0 && (
          <p className="mt-3 text-[12px] text-ppp-charcoal-500">
            Not counted: {t.refundedCount} refunded ({formatCents(t.refundedCents)}).
          </p>
        )}
      </section>

      {/* The payments — one row per Work Order; open it for its payment terms. */}
      <details className="group/list rounded-xl bg-white border border-ppp-charcoal-100 overflow-hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 min-h-[56px] hover:bg-ppp-charcoal-50 [&::-webkit-details-marker]:hidden">
          <h2 className="text-base font-semibold text-ppp-charcoal">
            Payments <span className="font-normal text-ppp-charcoal-500">· {rows.length}</span>
            {groups.length > 0 && (
              <span className="ml-2 text-[13px] font-normal text-ppp-charcoal-500">
                across {groups.length} work order{groups.length === 1 ? "" : "s"}
              </span>
            )}
            {stillOwedCents > 0 && (
              <span className="ml-2 text-[13px] font-semibold text-ppp-orange-700 whitespace-nowrap">
                · {formatCents(stillOwedCents)} still owed
              </span>
            )}
          </h2>
          <Chevron className="group-open/list:rotate-90" />
        </summary>
        {rows.length === 0 ? (
          <div className="border-t border-ppp-charcoal-100 px-5 pb-8 pt-6 text-center">
            <p className="text-sm text-ppp-charcoal-600">
              No payments {q.preset === "all" ? "yet" : `for ${period.toLowerCase()}`}
              {q.paidWith !== "all" ? ` by ${PAID_WITH_LABEL[q.paidWith].toLowerCase()}` : ""}.
            </p>
            {(q.preset !== "all" || q.paidWith !== "all") && (
              <Link
                href={`?${ledgerQueryString(q, { preset: "all", paidWith: "all" })}`}
                className="mt-2 inline-block text-sm font-semibold text-ppp-navy underline underline-offset-2"
              >
                Show all payments
              </Link>
            )}
          </div>
        ) : (
          <ul className="border-t border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100">
            {groups.map((g) => (
              <li key={g.workOrderId}>
                <details className="group/wo">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 sm:px-5 py-3 min-h-[56px] hover:bg-ppp-charcoal-50 [&::-webkit-details-marker]:hidden">
                    <Chevron className="group-open/wo:rotate-90" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-ppp-charcoal" title={g.customer}>
                        {g.customer}
                      </div>
                      <div className="truncate text-[12px] text-ppp-charcoal-500">
                        WO {g.workOrderNumber} · {g.rows.length} payment{g.rows.length === 1 ? "" : "s"} · last{" "}
                        {fmtDay(g.lastDay, thisYear)}
                      </div>
                    </div>
                    <div className="hidden sm:block">
                      <StagePill stage={g.stage} />
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      <div className="font-semibold text-ppp-navy">{formatCents(g.totals.baseCents)} paid</div>
                      <OwedLine job={schedules.get(g.workOrderId)} />
                    </div>
                  </summary>

                  <div className="bg-ppp-charcoal-50 px-4 sm:px-5 pb-3 pt-1">
                    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div className="sm:hidden">
                        <StagePill stage={g.stage} />
                      </div>
                      <a
                        href={sfLink(sfBase, g.workOrderId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[12px] font-semibold text-ppp-navy hover:underline underline-offset-2 min-h-[44px] sm:min-h-0 sm:ml-auto"
                      >
                        Open Work Order in Salesforce <ArrowOut />
                      </a>
                    </div>
                    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">Payment terms</h3>
                    <TermsList job={schedules.get(g.workOrderId)} failed={scheduleError} />
                    <h3 className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500">
                      Paid online
                      {g.totals.feeCents > 0 && (
                        <span className="ml-2 normal-case tracking-normal font-normal text-ppp-orange-700">
                          + {formatCents(g.totals.feeCents)} card fees
                        </span>
                      )}
                    </h3>
                    <ol className="divide-y divide-ppp-charcoal-100 overflow-hidden rounded-lg border border-ppp-charcoal-100 bg-white">
                      {g.rows.map((p) => (
                        <li key={p.id} className="px-3 sm:px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-semibold text-ppp-charcoal">{p.milestone_label}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ppp-charcoal-500">
                                <span>{fmtDay(paymentDateEt(p), thisYear)}</span>
                                <Method p={p} />
                              </div>
                            </div>
                            <div className="shrink-0 text-right tabular-nums">
                              <div className="font-semibold text-ppp-navy">{formatCents(p.base_cents)}</div>
                              {p.fee_cents > 0 && (
                                <div className="text-[12px] text-ppp-orange-700">+ {formatCents(p.fee_cents)} fee</div>
                              )}
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                            <StagePill stage={stageOf(p)} />
                            <RowLinks p={p} sfBase={sfBase} />
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </details>

      <p className="text-[12px] text-ppp-charcoal-500">
        Payment links and Stripe settings are in{" "}
        <Link href="/dashboard/settings/payments" className="underline underline-offset-2">
          Settings → Online Payments
        </Link>
        .
      </p>
    </div>
  );
}

function Stat({ label, value, sub, muted }: { label: string; value: string; sub: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ppp-charcoal-500">{label}</dt>
      <dd className={`mt-1 font-condensed text-xl sm:text-2xl font-bold tabular-nums ${muted ? "text-ppp-charcoal-400" : "text-ppp-navy"}`}>
        {value}
      </dd>
      <dd className="text-[11px] sm:text-[12px] text-ppp-charcoal-500">{sub}</dd>
    </div>
  );
}

function Method({ p }: { p: LedgerPayment }) {
  const w = paidWith(p);
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ppp-charcoal-700" title={PAID_WITH_LABEL[w]}>
      <span className={`h-2 w-2 rounded-full ${METHOD_DOT[w]}`} aria-hidden />
      {METHOD_SHORT[w]}
    </span>
  );
}

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span
      title={STAGE_LABEL[stage]}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${STAGE_CLS[stage]}`}
    >
      {STAGE_SHORT[stage]}
    </span>
  );
}

const TERM_STATUS: Record<Milestone["status"], { text: string; cls: string }> = {
  paid: { text: "Paid", cls: "bg-ppp-green-50 text-ppp-green-700" },
  processing: { text: "Clearing", cls: "bg-ppp-blue-50 text-ppp-blue-700" },
  due: { text: "Due now", cls: "bg-ppp-orange-50 text-ppp-orange-700" },
  upcoming: { text: "Upcoming", cls: "bg-ppp-charcoal-50 text-ppp-charcoal-600" },
};

/** Under each job's "paid" total: what's left, or that it's done. */
function OwedLine({ job }: { job: JobSchedule | undefined }) {
  if (!job) return null;
  const owed = job.schedule.payableBalanceCents;
  if (owed <= 0) return <div className="text-[12px] font-semibold text-ppp-green-700">Paid in full</div>;
  return <div className="text-[12px] font-semibold text-ppp-orange-700">{formatCents(owed)} owed</div>;
}

/** The job's Payment Terms from Salesforce — paid, clearing, due, upcoming. */
function TermsList({ job, failed }: { job: JobSchedule | undefined; failed: boolean }) {
  if (!job) {
    return (
      <p className="rounded-lg border border-ppp-charcoal-100 bg-white px-3 py-2.5 text-[13px] text-ppp-charcoal-600">
        {failed
          ? "Couldn't read the payment terms from Salesforce just now — refresh to try again."
          : "This Work Order wasn't found in Salesforce."}
      </p>
    );
  }
  const { schedule } = job;
  return (
    <div className="space-y-1.5">
      {job.closed && (
        <p className="text-[12px] text-ppp-charcoal-600">This job is closed in Salesforce — nothing more is collected online.</p>
      )}
      {schedule.milestones.length === 0 ? (
        <p className="rounded-lg border border-ppp-charcoal-100 bg-white px-3 py-2.5 text-[13px] text-ppp-charcoal-600">
          No payment terms on this Work Order in Salesforce.
        </p>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-100 overflow-hidden rounded-lg border border-ppp-charcoal-100 bg-white">
          {schedule.milestones.map((m) => {
            const st = TERM_STATUS[m.status];
            return (
              <li key={m.key} className="flex items-center justify-between gap-3 px-3 sm:px-4 py-2.5">
                <div className="min-w-0">
                  <div className="font-semibold text-ppp-charcoal">
                    {m.label}
                    {m.percent != null && <span className="ml-1.5 font-normal text-ppp-charcoal-500">{m.percent}%</span>}
                  </div>
                  {m.partlyPaid && (
                    <div className="text-[12px] text-ppp-charcoal-500 tabular-nums">
                      {formatCents(m.amountCents - m.remainingCents)} of {formatCents(m.amountCents)} paid
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="text-right font-semibold tabular-nums text-ppp-navy">
                    {formatCents(m.status === "paid" || m.status === "processing" ? m.amountCents : m.remainingCents)}
                  </span>
                  <span className={`inline-flex w-[76px] justify-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${st.cls}`}>
                    {st.text}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {schedule.warnings.map((w) => (
        <p key={w} className="text-[12px] text-ppp-charcoal-600">
          {w}
        </p>
      ))}
    </div>
  );
}

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-ppp-charcoal-400 transition-transform ${className}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ArrowOut() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17L17 7 M8 7h9v9" />
    </svg>
  );
}

function RowLinks({ p, sfBase }: { p: LedgerPayment; sfBase: string }) {
  const cls =
    "inline-flex items-center gap-1 rounded-md border border-ppp-charcoal-200 bg-white px-2.5 min-h-[44px] sm:min-h-[32px] text-[12px] font-semibold text-ppp-navy hover:bg-ppp-charcoal-50";
  return (
    <div className="inline-flex gap-1.5">
      {p.payment_intent_id && (
        <a href={stripeLink(p.payment_intent_id, p.livemode)} target="_blank" rel="noreferrer" className={cls} title="Open in Stripe">
          Stripe <ArrowOut />
        </a>
      )}
      {p.sf_transaction_id && (
        <a href={sfLink(sfBase, p.sf_transaction_id)} target="_blank" rel="noreferrer" className={cls} title="Open the Payment In in Salesforce">
          Payment In <ArrowOut />
        </a>
      )}
    </div>
  );
}
