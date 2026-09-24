import Link from "next/link";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import type { PayrollWeek } from "@/lib/commercial/field-ops/payroll-week";

/**
 * Mary's payroll week, on one screen.
 *
 * Katie 2026-09-24: *"The less complicated that we can make Mary's job, the
 * better. Right now the calculations are manual."*
 *
 * Four panels, in the order she works: the hours that go to Gusto, the cost
 * that comes back, the split it produces, and the per-job detail. They read
 * left to right and top to bottom because that is the sequence — a screen that
 * shows the answer above the question makes you scroll to check it.
 *
 * ── THE ONE THING THIS SCREEN MUST NEVER DO ────────────────────────────────
 *
 * Show two totals that disagree. Tomco's mockup did: 192 hours in the first
 * panel against 254 in the third, $5,875 of Gusto cost against $6,777
 * allocated. Every figure here comes from one read of one week, so the panels
 * are the same numbers grouped differently and cannot drift. Where something
 * genuinely does not add up — an unapproved entry, a cost with no hours — it
 * is stated at the top as a blocker rather than left for her to find by
 * subtracting one panel from another.
 */

const money = (c: number | null | undefined) =>
  c == null
    ? "—"
    : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const hrs = (h: number) => `${Number(h).toLocaleString("en-US", { maximumFractionDigits: 2 })}h`;

const CARD = "rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden";
const HEAD = "px-3.5 py-2.5 border-b border-ppp-charcoal-100";
const TITLE = "text-[12.5px] font-bold text-ppp-charcoal";
const SUB = "text-[11px] text-ppp-charcoal-500 mt-0.5 block";
const TH =
  "text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400 px-3.5 py-1.5 text-left";
const TD = "px-3.5 py-2 text-[12.5px] text-ppp-charcoal-800 align-middle";
const NUM = `${TD} text-right tabular-nums`;
const INPUT =
  "w-full max-w-[130px] rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-[12.5px] text-right tabular-nums min-h-[44px] focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600";

export function PayrollWeekPanels({
  week,
  saveCostsAction,
  postAction,
  selectedJobId,
  basePath,
}: {
  week: PayrollWeek;
  saveCostsAction: (formData: FormData) => void | Promise<void>;
  postAction: (formData: FormData) => void | Promise<void>;
  /** Which job the detail panel is showing. */
  selectedJobId: string | null;
  /** For the week arrows and the job picker, which are links not forms. */
  basePath: string;
}) {
  const posted = week.status === "allocated";
  const canPost = week.blockers.length === 0;
  const detailJob =
    week.byJob.find((j) => j.opportunityId === selectedJobId) ?? week.byJob[0] ?? null;

  /** Everyone who worked the selected job, with what they cost it. */
  const detailRows = detailJob
    ? week.employees
        .map((e) => {
          const j = e.jobs.find((x) => x.opportunityId === detailJob.opportunityId);
          const a = e.allocation.find((x) => x.opportunityId === detailJob.opportunityId);
          if (!j) return null;
          return {
            name: e.name,
            hours: j.hours,
            costCents: a?.amountCents ?? null,
            // This person's loaded rate ON THIS JOB — cost ÷ hours here, which
            // equals their weekly loaded rate. Shown per row because that is
            // the number an estimator reuses when pricing the next job.
            loadedCents: a && j.hours > 0 ? Math.round(a.amountCents / j.hours) : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.hours - a.hours)
    : [];

  return (
    <div className="space-y-3">
      {/* ── What is stopping this week, before anything else ───────────── */}
      {week.blockers.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
          <p className="text-[12px] font-bold text-amber-900">
            {week.blockers.length === 1
              ? "One thing to sort out before posting"
              : `${week.blockers.length} things to sort out before posting`}
          </p>
          <ul className="mt-1.5 space-y-1">
            {week.blockers.map((b, i) => (
              <li key={i} className="text-[12px] text-amber-900 leading-snug">
                · {b}
              </li>
            ))}
          </ul>
        </div>
      )}

      {posted && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5">
          <p className="text-[12px] text-emerald-900">
            <span className="font-bold">This week is posted.</span> {money(week.totals.allocatedCents)}{" "}
            is on the jobs below as labor cost. Change a Gusto figure and post again — it
            replaces what it wrote last time rather than adding to it.
          </p>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── 1. HOURS — what goes to Gusto ───────────────────────────── */}
        <section className={CARD}>
          <div className={HEAD}>
            <h3 className={TITLE}>Hours this week</h3>
            <span className={SUB}>
              Approved time only. This is what gets submitted to Gusto.
            </span>
          </div>
          {week.employees.length === 0 ? (
            <p className="px-3.5 py-4 text-[12px] text-ppp-charcoal-500">
              No approved hours in this week yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead className="bg-ppp-charcoal-50/60">
                  <tr>
                    <th className={TH}>Employee</th>
                    <th className={`${TH} text-right`}>On jobs</th>
                    <th className={`${TH} text-right`}>Not on a job</th>
                    <th className={`${TH} text-right`}>Jobs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {week.employees.map((e) => (
                    <tr key={e.employeeId}>
                      <td className={TD}>{e.name}</td>
                      <td className={NUM}>{hrs(e.jobHours)}</td>
                      <td className={`${NUM} ${e.unassignedHours > 0 ? "text-amber-700 font-semibold" : "text-ppp-charcoal-400"}`}>
                        {e.unassignedHours > 0 ? hrs(e.unassignedHours) : "—"}
                      </td>
                      <td className={`${NUM} text-ppp-charcoal-500`}>{e.jobs.length}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-200">
                  <tr>
                    <td className={`${TD} font-bold`}>Total</td>
                    <td className={`${NUM} font-bold`}>{hrs(week.totals.jobHours)}</td>
                    <td className={`${NUM} font-bold`}>
                      {week.totals.unassignedHours > 0 ? hrs(week.totals.unassignedHours) : "—"}
                    </td>
                    <td className={NUM} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {week.totals.unassignedHours > 0 && (
            <p className="px-3.5 pb-3 pt-1 text-[11px] text-ppp-charcoal-500 leading-snug">
              Hours not on a job are paid but not charged to anything — they stay out of
              the split, so no job absorbs time nobody worked on it.
            </p>
          )}
        </section>

        {/* ── 2. GUSTO — what came back ───────────────────────────────── */}
        <section className={CARD}>
          <div className={HEAD}>
            <h3 className={TITLE}>Actual cost from Gusto</h3>
            <span className={SUB}>
              What Gusto took out of the bank: wages plus payroll taxes. Not the gross.
            </span>
          </div>
          {week.employees.length === 0 ? (
            <p className="px-3.5 py-4 text-[12px] text-ppp-charcoal-500">
              Nothing to cost until there are approved hours.
            </p>
          ) : (
            <form action={saveCostsAction}>
              <input type="hidden" name="start" value={week.startDate} />
              <input type="hidden" name="end" value={week.endDate} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]">
                  <thead className="bg-ppp-charcoal-50/60">
                    <tr>
                      <th className={TH}>Employee</th>
                      <th className={`${TH} text-right`}>Hours</th>
                      <th className={`${TH} text-right`}>Company cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ppp-charcoal-100">
                    {week.employees.map((e) => (
                      <tr key={e.employeeId}>
                        <td className={TD}>{e.name}</td>
                        <td className={`${NUM} text-ppp-charcoal-500`}>{hrs(e.jobHours)}</td>
                        <td className="px-3.5 py-1.5 text-right">
                          <input
                            name={`cost_${e.employeeId}`}
                            inputMode="decimal"
                            defaultValue={
                              e.actualCostCents == null ? "" : (e.actualCostCents / 100).toFixed(2)
                            }
                            placeholder="0.00"
                            aria-label={`Actual Gusto cost for ${e.name}`}
                            className={INPUT}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-200">
                    <tr>
                      <td className={`${TD} font-bold`}>Total</td>
                      <td className={NUM} />
                      <td className={`${NUM} font-bold`}>{money(week.totals.actualCostCents)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="px-3.5 py-3 border-t border-ppp-charcoal-100">
                <PendingSubmitButton
                  pendingLabel="Saving…"
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
                >
                  Save Gusto costs
                </PendingSubmitButton>
              </div>
            </form>
          )}
        </section>

        {/* ── 3. THE SPLIT ────────────────────────────────────────────── */}
        <section className={CARD}>
          <div className={HEAD}>
            <h3 className={TITLE}>Job cost allocation</h3>
            <span className={SUB}>
              Each person&rsquo;s cost split across the jobs they worked, by hours.
            </span>
          </div>
          {week.byJob.length === 0 ? (
            <p className="px-3.5 py-4 text-[12px] text-ppp-charcoal-500">
              Nothing to allocate yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead className="bg-ppp-charcoal-50/60">
                  <tr>
                    <th className={TH}>Job</th>
                    <th className={`${TH} text-right`}>Hours</th>
                    <th className={`${TH} text-right`}>Labor cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {week.byJob.map((j) => (
                    <tr key={j.opportunityId}>
                      <td className={TD}>
                        <Link
                          href={`${basePath}&job=${j.opportunityId}`}
                          className="hover:text-cc-brand-800 hover:underline"
                        >
                          {j.jobName}
                        </Link>
                      </td>
                      <td className={NUM}>{hrs(j.hours)}</td>
                      <td className={NUM}>{j.costCents > 0 ? money(j.costCents) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-200">
                  <tr>
                    <td className={`${TD} font-bold`}>Total</td>
                    <td className={`${NUM} font-bold`}>{hrs(week.totals.jobHours)}</td>
                    <td className={`${NUM} font-bold`}>{money(week.totals.allocatedCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {/* THE TIE-OUT, SAID OUT LOUD. Same money, grouped two ways — if these
              ever differ the screen says so instead of letting her find it. */}
          {week.totals.actualCostCents > 0 && (
            <p
              className={`px-3.5 pb-3 pt-2 text-[11px] leading-snug ${
                week.totals.allocatedCents === week.totals.actualCostCents
                  ? "text-ppp-charcoal-500"
                  : "text-rose-700 font-semibold"
              }`}
            >
              {week.totals.allocatedCents === week.totals.actualCostCents
                ? `Ties to the ${money(week.totals.actualCostCents)} from Gusto, to the cent.`
                : `Does NOT tie: ${money(week.totals.allocatedCents)} allocated against ${money(week.totals.actualCostCents)} from Gusto. Do not post this week.`}
            </p>
          )}
        </section>

        {/* ── 4. ONE JOB, IN DETAIL ───────────────────────────────────── */}
        <section className={CARD}>
          <div className={`${HEAD} flex items-baseline justify-between gap-3 flex-wrap`}>
            <div className="min-w-0">
              <h3 className={TITLE}>Labor detail</h3>
              <span className={SUB}>Who worked it, and what each of them cost it.</span>
            </div>
          </div>
          {!detailJob ? (
            <p className="px-3.5 py-4 text-[12px] text-ppp-charcoal-500">
              Pick a job from the allocation panel.
            </p>
          ) : (
            <>
              <div className="px-3.5 pt-3 pb-1">
                <p className="text-[12.5px] font-semibold text-ppp-charcoal truncate">
                  {detailJob.jobName}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]">
                  <thead className="bg-ppp-charcoal-50/60">
                    <tr>
                      <th className={TH}>Employee</th>
                      <th className={`${TH} text-right`}>Hours</th>
                      <th className={`${TH} text-right`}>Cost</th>
                      <th className={`${TH} text-right`}>Loaded $/hr</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ppp-charcoal-100">
                    {detailRows.map((r) => (
                      <tr key={r.name}>
                        <td className={TD}>{r.name}</td>
                        <td className={NUM}>{hrs(r.hours)}</td>
                        <td className={NUM}>{money(r.costCents)}</td>
                        <td className={`${NUM} text-ppp-charcoal-500`}>{money(r.loadedCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-200">
                    <tr>
                      <td className={`${TD} font-bold`}>Total</td>
                      <td className={`${NUM} font-bold`}>{hrs(detailJob.hours)}</td>
                      <td className={`${NUM} font-bold`}>
                        {detailJob.costCents > 0 ? money(detailJob.costCents) : "—"}
                      </td>
                      <td className={`${NUM} font-bold`}>
                        {detailJob.costCents > 0 && detailJob.hours > 0
                          ? money(Math.round(detailJob.costCents / detailJob.hours))
                          : "—"}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── POST ────────────────────────────────────────────────────────── */}
      <form action={postAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="start" value={week.startDate} />
        <input type="hidden" name="end" value={week.endDate} />
        {!canPost ? (
          // A disabled BUTTON, not a disabled ConfirmSubmitButton — the shared
          // component does not take `disabled`, and bending it for one caller
          // is how a control used in thirty places grows a quiet edge case.
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold min-h-[44px] bg-ppp-charcoal-100 text-ppp-charcoal-400 cursor-not-allowed"
          >
            {posted ? "Post again" : "Post to job costs"}
          </button>
        ) : (
        <ConfirmSubmitButton
          message={
            posted
              ? `Post this week again? It replaces the ${money(week.totals.allocatedCents)} it wrote last time — it does not add to it.`
              : `Post ${money(week.totals.allocatedCents)} of labor cost across ${week.byJob.filter((j) => j.costCents > 0).length} job${week.byJob.filter((j) => j.costCents > 0).length === 1 ? "" : "s"}?`
          }
          pendingLabel="Posting…"
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold min-h-[44px] touch-manipulation bg-ppp-navy-600 text-white hover:bg-ppp-navy-700"
        >
          {posted ? "Post again" : "Post to job costs"}
        </ConfirmSubmitButton>
        )}
        <span className="text-[11.5px] text-ppp-charcoal-500">
          {canPost
            ? "Writes a labor payout on each job, the same as a crew payment."
            : "Sort the items above first."}
        </span>
      </form>
    </div>
  );
}

/** The week arrows + date, which are links so the URL is shareable. */
export function PayrollWeekHeader({
  startDate,
  endDate,
  prevHref,
  nextHref,
  todayHref,
}: {
  startDate: string;
  endDate: string;
  prevHref: string;
  nextHref: string;
  todayHref: string;
}) {
  const label = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={prevHref}
        aria-label="Previous week"
        className="inline-flex items-center justify-center h-11 w-11 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 touch-manipulation"
      >
        ‹
      </Link>
      <span className="text-[13px] font-bold text-ppp-charcoal tabular-nums">
        {label(startDate)} – {label(endDate)}
      </span>
      <Link
        href={nextHref}
        aria-label="Next week"
        className="inline-flex items-center justify-center h-11 w-11 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 touch-manipulation"
      >
        ›
      </Link>
      <Link
        href={todayHref}
        className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline px-1 min-h-[44px] inline-flex items-center"
      >
        This week
      </Link>
      {/* No free date picker on purpose: a payroll week is a Monday–Sunday
          block, and letting somebody land on a Wednesday would split overtime
          across two half-weeks. The arrows can only produce whole weeks. */}
    </div>
  );
}
