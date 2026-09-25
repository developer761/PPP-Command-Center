import Link from "next/link";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";
import { PasteCostsBox } from "@/components/commercial/paste-costs-box";
import { CopyHoursButton } from "@/components/commercial/copy-hours-button";
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

/** "Saturday, Sep 19" — parsed as UTC so a date never slips a day. */
const longDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
};

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
  lastHoursWeekHref,
  approvalsHref,
  laborPaymentsHref,
}: {
  week: PayrollWeek;
  saveCostsAction: (formData: FormData) => void | Promise<void>;
  postAction: (formData: FormData) => void | Promise<void>;
  /** Which job the detail panel is showing. */
  selectedJobId: string | null;
  /** For the week arrows and the job picker, which are links not forms. */
  basePath: string;
  /** The week the most recent hours are in, for an empty week to point at. */
  lastHoursWeekHref: string | null;
  /** Where unapproved hours get approved. A blocker that says "approve them
   *  first" without saying where is a dead end. */
  approvalsHref: string;
  /** The Labor payments tab, where a posted week's payouts show up. */
  laborPaymentsHref: string;
}) {
  const posted = week.status === "allocated";
  const empty = week.employees.length === 0;
  // An empty week is never postable, and it carries no blockers on purpose —
  // nothing is wrong with it. Both halves have to be said, or the button goes
  // live over a week with nothing in it.
  const canPost = week.blockers.length === 0 && !empty && !week.awaitingCosts;
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
            id: e.employeeId,
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
      {/* ── A WEEK WITH NOTHING IN IT ───────────────────────────────────
          Not a warning. Hours arrive from the crew's clock-ins and the
          overnight attendance sync, so the week in progress is empty until it
          has been worked — and this screen answered that with "No approved
          hours for any W-2 employee in this week yet", styled amber, which
          read as a fault and gave her nowhere to go.

          Say where hours come from, when the last ones arrived, and offer the
          week that has them. */}
      {empty && (
        <div className="rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50/60 px-3.5 py-3">
          <p className="text-[12px] font-bold text-ppp-charcoal">
            No hours in this week yet
          </p>
          <p className="mt-1 text-[12px] text-ppp-charcoal-600 leading-snug">
            Hours come from the crew&rsquo;s approved time, which lands overnight. A week
            fills in as it is worked, so the current week is normally empty until it ends.
            {week.lastW2HoursDate ? (
              <>
                {" "}
                The most recent day with hours is{" "}
                <span className="font-semibold text-ppp-charcoal">
                  {longDate(week.lastW2HoursDate)}
                </span>
                .
              </>
            ) : (
              " No W-2 hours have been recorded at all yet."
            )}
          </p>
          {lastHoursWeekHref && (
            <Link
              href={lastHoursWeekHref}
              className="mt-2 inline-flex items-center min-h-[44px] text-[12px] font-semibold text-cc-brand-700 hover:underline"
            >
              Go to the week with the latest hours →
            </Link>
          )}
        </div>
      )}

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
          {/* "Approve them first" with no way to approve them is a dead end;
              the approvals queue is on a different section of the platform and
              Mary has no reason to know that. */}
          {week.unapprovedHours > 0 && (
            <Link
              href={approvalsHref}
              className="mt-2 inline-flex items-center min-h-[44px] text-[12px] font-semibold text-amber-900 underline hover:no-underline"
            >
              Go to hour approvals →
            </Link>
          )}
        </div>
      )}

      {posted && (() => {
        // READ BACK, NOT RECOMPUTED. This used to print the live total and say
        // it was on the jobs — but the live total moves the moment a late
        // entry is approved or a Gusto figure is corrected without re-posting,
        // and the sentence became untrue with nothing indicating it.
        const onJobs = week.postedCents ?? 0;
        // Totals AND distribution. The total alone missed an hour moved
        // between two jobs, which leaves the sum identical and both jobs
        // wrong — see `postedDrift`.
        const drifted = onJobs !== week.totals.allocatedCents || week.postedDrift;
        return (
          <div
            className={`rounded-xl border px-3.5 py-2.5 ${
              drifted ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"
            }`}
          >
            <p className={`text-[12px] ${drifted ? "text-amber-900" : "text-emerald-900"}`}>
              <span className="font-bold">This week is posted.</span> {money(onJobs)} is on the
              jobs as labor cost.
              {drifted ? (
                onJobs === week.totals.allocatedCents ? (
                  <>
                    {" "}
                    Something has changed since — the same total, but split across the jobs
                    differently. Hours have moved between jobs, so at least two of them carry
                    the wrong labor cost right now. Post again to correct them; it replaces what
                    it wrote last time rather than adding to it.
                  </>
                ) : (
                  <>
                    {" "}
                    Something has changed since — the split now comes to{" "}
                    <span className="font-bold">{money(week.totals.allocatedCents)}</span>. Post
                    again to put that on the jobs; it replaces what it wrote last time rather
                    than adding to it.
                  </>
                )
              ) : (
                " Change a Gusto figure and post again — it replaces what it wrote last time rather than adding to it."
              )}
            </p>
            {/* What it wrote is a set of labor payouts, and those live on
                another tab. Saying "it is on the jobs" without a way to look
                is the same dead end as telling her to pick a job from a panel
                that is empty. */}
            <Link
              href={laborPaymentsHref}
              className={`mt-1.5 inline-flex items-center min-h-[44px] text-[12px] font-semibold hover:underline ${
                drifted ? "text-amber-900" : "text-emerald-900"
              }`}
            >
              See the payouts it wrote →
            </Link>
          </div>
        );
      })()}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── 1. HOURS — what goes to Gusto ───────────────────────────── */}
        <section className={CARD}>
          <div className={HEAD}>
            <h3 className={TITLE} data-tour="payroll:hours">Hours this week</h3>
            <span className={SUB}>
              Approved time only. This is what gets submitted to Gusto.
            </span>
          </div>
          {week.employees.length === 0 ? (
            <p className="px-3.5 py-4 text-[12px] text-ppp-charcoal-500">
              Nothing logged against this week. Hours appear here once the crew&rsquo;s time is
              approved.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[300px]">
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
          {/* Who is NOT here. An absence has no row, so it cannot be spotted —
              and Gusto pays from the roster, not from this list. */}
          {!empty && week.w2WithoutHours.length > 0 && (
            <p className="px-3.5 pb-2.5 pt-1 text-[11px] text-ppp-charcoal-500 leading-snug border-t border-ppp-charcoal-100 mt-1 pt-2">
              No hours this week for{" "}
              <span className="font-semibold text-ppp-charcoal-700">
                {week.w2WithoutHours.map((e) => e.name).join(", ")}
              </span>
              . If Gusto paid {week.w2WithoutHours.length === 1 ? "them" : "any of them"}, the
              hours never got approved —{" "}
              <Link href={approvalsHref} className="font-semibold text-cc-brand-700 hover:underline">
                check approvals
              </Link>
              .
            </p>
          )}
          {!empty && (
            <div className="px-3.5 pb-3 pt-2 border-t border-ppp-charcoal-100">
              {/* Total paid hours, job and off-job together — Gusto pays both.
                  The panel splits them because the SPLIT only uses job hours;
                  Gusto does not care about that distinction. */}
              <CopyHoursButton
                rows={week.employees.map((e) => ({
                  name: e.name,
                  hours: e.jobHours + e.unassignedHours,
                }))}
              />
            </div>
          )}
          {week.totals.unassignedHours > 0 && (
            <p className="px-3.5 pb-3 pt-1 text-[11px] text-ppp-charcoal-500 leading-snug">
              Vacation and shop time are paid but sit on no job. Pick the job each
              person&rsquo;s off-job hours should be charged to in the next panel — they are
              included in the split once you do, all on that one job.
            </p>
          )}
        </section>

        {/* ── 2. GUSTO — what came back ───────────────────────────────── */}
        <section className={CARD}>
          <div className={HEAD}>
            <h3 className={TITLE} data-tour="payroll:gusto-costs">Actual cost from Gusto</h3>
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
              {/* ONE field per person, laid out responsively.
                  This used to be a phone card list AND a desktop table, both
                  rendered, one hidden by CSS. Both are still in the DOM and
                  both still POST, so every employee had two `cost_` inputs
                  under one name — and the save loop takes the last one it
                  sees. On a phone that meant Mary typed a figure into the card
                  she could see, and the hidden desktop input's stale value
                  overwrote it on save: the cost silently reverted. Pasting a
                  column had the mirror failure on desktop, filling the hidden
                  card and appearing to do nothing.

                  A field that exists twice under one name is a money bug
                  waiting for whichever layout is hidden, so there is now
                  exactly one of each and the LAYOUT flexes instead. */}
              <ul className="divide-y divide-ppp-charcoal-100">
                {week.employees.map((e) => (
                  <li
                    key={e.employeeId}
                    className="px-3.5 py-3 sm:py-2 sm:flex sm:items-center sm:gap-3"
                  >
                    <div className="sm:flex-1 sm:min-w-0 flex items-baseline justify-between gap-2 sm:block">
                      <span className="text-[13px] sm:text-[12.5px] font-semibold sm:font-normal text-ppp-charcoal truncate">
                        {e.name}
                      </span>
                      <span className="text-[11.5px] text-ppp-charcoal-500 tabular-nums shrink-0 sm:block">
                        {hrs(e.jobHours)}
                      </span>
                    </div>
                    {e.unassignedHours > 0 && (
                      <select
                        name={`pto_${e.employeeId}`}
                        defaultValue={e.unassignedOpportunityId ?? ""}
                        aria-label={`Job to charge ${e.name}'s ${e.unassignedHours}h of non-job time to`}
                        className={`${SELECT_CLS} mt-2 sm:mt-0 sm:w-[180px] sm:shrink-0 text-[12px] border-amber-300 bg-amber-50`}
                        style={SELECT_BG_STYLE}
                      >
                        {/* Mary 2026-09-24: vacation and shop time are
                            "included... BD had me put it against a job", and
                            "he picks a job that can handle the expense". So it
                            is a choice, offered next to the money, and the week
                            will not post until it is made. */}
                        <option value="">Charge {e.unassignedHours}h off-job to&hellip;</option>
                        {e.jobs.map((j) => (
                          <option key={j.opportunityId} value={j.opportunityId}>
                            {j.jobName}
                          </option>
                        ))}
                      </select>
                    )}
                    <label className="block mt-2 sm:mt-0 sm:shrink-0">
                      <span className="block sm:hidden text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
                        Company cost from Gusto
                      </span>
                      <input
                        name={`cost_${e.employeeId}`}
                        inputMode="decimal"
                        defaultValue={
                          e.actualCostCents == null ? "" : (e.actualCostCents / 100).toFixed(2)
                        }
                        placeholder="0.00"
                        aria-label={`Actual Gusto cost for ${e.name}`}
                        className={`${INPUT} max-w-none sm:max-w-[130px] sm:w-[130px]`}
                      />
                    </label>
                  </li>
                ))}
              </ul>
              <div className="px-3.5 py-2 bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-200 flex items-baseline justify-between">
                <span className="text-[12px] font-bold text-ppp-charcoal">Total</span>
                <span className="text-[12.5px] font-bold text-ppp-charcoal tabular-nums">
                  {money(week.totals.actualCostCents)}
                </span>
              </div>
              <div className="px-3.5 py-3 border-t border-ppp-charcoal-100 space-y-2.5">
                {/* Katie asked for an upload; this is the safer half of it.
                    The figures land in the boxes beside the names, and nothing
                    is saved until Save is pressed — so a column that is one row
                    short is visible now rather than in a margin next month. */}
                <PasteCostsBox
                  employees={week.employees.map((e) => ({ id: e.employeeId, name: e.name }))}
                />
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
            <h3 className={TITLE} data-tour="payroll:allocation">Job cost allocation</h3>
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
              <table className="w-full min-w-[300px]">
                <thead className="bg-ppp-charcoal-50/60">
                  <tr>
                    <th className={TH}>Job</th>
                    <th className={`${TH} text-right`}>Hours</th>
                    <th className={`${TH} text-right`}>Labor cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {week.byJob.map((j) => {
                    /**
                     * MARK THE ROW YOU PICKED.
                     *
                     * This table is the master; Labor detail beside it is the
                     * detail. Clicking a job changed the panel on the right and
                     * left NOTHING on the left to say which row did it — same
                     * classes on every link, no aria-current. With a dozen jobs
                     * in the week, Mary picks one, the right-hand panel
                     * changes, and she cannot tell which line she is looking at
                     * without reading the heading over there and matching it
                     * back by name.
                     *
                     * `detailJob` above already resolves the selected job (falling
                     * back to the first row when nothing is chosen), so the
                     * highlight follows exactly what the right-hand panel is
                     * showing — including on first load, where the panel is
                     * already showing row one.
                     */
                    const isSelected = detailJob?.opportunityId === j.opportunityId;
                    return (
                    <tr
                      key={j.opportunityId}
                      aria-current={isSelected ? "true" : undefined}
                      className={isSelected ? "bg-cc-brand-50" : undefined}
                    >
                      <td className={TD}>
                        <Link
                          href={`${basePath}&job=${j.opportunityId}`}
                          className={`hover:text-cc-brand-800 hover:underline ${
                            isSelected ? "font-bold text-cc-brand-800" : ""
                          }`}
                        >
                          {j.jobName}
                        </Link>
                      </td>
                      <td className={NUM}>{hrs(j.hours)}</td>
                      <td className={NUM}>{j.costCents > 0 ? money(j.costCents) : "—"}</td>
                    </tr>
                    );
                  })}
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
              <h3 className={TITLE} data-tour="payroll:labor-detail">Labor detail</h3>
              <span className={SUB}>Who worked it, and what each of them cost it.</span>
            </div>
          </div>
          {!detailJob ? (
            // "Pick a job from the allocation panel" was never true: a job is
            // auto-selected whenever there IS one, so this only ever showed
            // when the allocation panel was empty too — telling her to go and
            // click something that was not there. Say what is actually true
            // for the case that reaches this branch.
            <p className="px-3.5 py-4 text-[12px] text-ppp-charcoal-500 leading-snug">
              {empty
                ? "Nothing to show until this week has hours in it."
                : "This appears once the hours are split across jobs."}
            </p>
          ) : (
            <>
              <div className="px-3.5 pt-3 pb-1">
                <p className="text-[12.5px] font-semibold text-ppp-charcoal truncate">
                  {detailJob.jobName}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[340px]">
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
                      <tr key={r.id}>
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
            : empty
              ? "Nothing to post — this week has no hours in it."
              : week.awaitingCosts
                ? "Run the hours through Gusto, then enter what each person cost above."
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
  isThisWeek,
}: {
  startDate: string;
  endDate: string;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  /** The tab opens on the latest week WITH hours, not the calendar week, so
   *  "This week" is only worth offering when you are not already on it. */
  isThisWeek: boolean;
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
      {isThisWeek ? (
        <span className="text-[11.5px] font-semibold text-ppp-charcoal-400 px-1 min-h-[44px] inline-flex items-center">
          This week
        </span>
      ) : (
        <Link
          href={todayHref}
          className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline px-1 min-h-[44px] inline-flex items-center"
        >
          This week
        </Link>
      )}
      {/* No free date picker on purpose: a payroll week is a Monday–Sunday
          block, and letting somebody land on a Wednesday would split overtime
          across two half-weeks. The arrows can only produce whole weeks. */}
    </div>
  );
}
