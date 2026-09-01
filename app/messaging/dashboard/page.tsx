import { agentStats, readinessChecks } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

/**
 * Mirrors Hatch's reporting dashboard — the same five numbers per workspace, so
 * the Stage 7 shadow-run comparison is like-for-like rather than needing a
 * mapping nobody trusts.
 *
 * The readiness panel is the honest half. With no traffic yet, a page of zeroes
 * says nothing; what an operator actually needs to know is what is still
 * standing between here and the first message. So it says that, and each item
 * names who or what unblocks it.
 */
export default async function MessagingDashboard() {
  const [stats, ready] = await Promise.all([agentStats(), readinessChecks()]);

  const blockers = [
    {
      done: ready.activeWorkspaces > 0,
      label: `${ready.activeWorkspaces} workspaces live`,
      detail: "NY, NJ and Florida — all one timezone.",
    },
    {
      done: ready.missingNumbers === 0,
      label: ready.missingNumbers === 0 ? "Every live workspace has a number" : `${ready.missingNumbers} live workspace(s) without a number`,
      detail: "A workspace with no number cannot send from the local area code the customer replies to.",
    },
    {
      done: ready.optOuts > 0,
      label: ready.optOuts > 0 ? `${ready.optOuts} numbers suppressed` : "Opt-out list not imported",
      detail: "Hard gate on the first send. Someone who told Hatch to stop has told PPP to stop.",
    },
    {
      done: false,
      label: "Carrier not connected",
      detail: "Twilio or AWS, once the numbers are ported off the Salesforce account. Until then every send is recorded, not delivered.",
    },
    {
      done: ready.cronSecret,
      label: ready.cronSecret ? "Scheduler authenticated" : "CRON_SECRET not set",
      detail: "The tick refuses to run without it, rather than running open.",
    },
    {
      done: ready.activeCampaigns > 0,
      label: ready.activeCampaigns > 0 ? `${ready.activeCampaigns} campaigns active` : "No campaigns active",
      detail: "Imported from Hatch, then editable here.",
    },
  ];
  const remaining = blockers.filter((b) => !b.done).length;

  return (
    <main className="max-w-3xl mx-auto px-4 py-4 pb-safe">
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-baseline justify-between gap-3">
          <h2 className="font-bold text-ppp-charcoal">Before the first message</h2>
          <span className="shrink-0 text-[11px] font-mono text-ppp-charcoal-500">
            {blockers.length - remaining}/{blockers.length}
          </span>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {blockers.map((b) => (
            <li key={b.label} className="px-4 py-3 flex gap-3">
              <span
                aria-hidden
                className={[
                  "mt-0.5 shrink-0 h-4 w-4 rounded-full border-2 flex items-center justify-center",
                  b.done ? "border-ppp-green bg-ppp-green" : "border-ppp-charcoal-300",
                ].join(" ")}
              >
                {b.done && (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </span>
              <div className="min-w-0">
                <p className={`text-[13px] font-semibold ${b.done ? "text-ppp-charcoal" : "text-ppp-charcoal-600"}`}>
                  {b.label}
                </p>
                <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{b.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <h2 className="mt-6 mb-2 font-bold text-ppp-charcoal">Per workspace</h2>
      <p className="mb-3 text-[12px] text-ppp-charcoal-500 leading-relaxed">
        The same five measures Hatch reports, so the two can be compared directly
        during the parallel run.
      </p>

      {stats.length === 0 ? (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-8 text-center">
          <p className="font-semibold text-ppp-charcoal">No conversations yet</p>
          <p className="mt-2 text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">
            These fill in once leads start flowing. Until then the checklist above
            is the useful view.
          </p>
        </div>
      ) : (
        // Cards, not a table. Six columns across 430px means horizontal
        // scrolling to read a single row, and a metric you have to scroll to
        // see is a metric nobody checks.
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {stats.map((s) => (
            <li key={s.workspace} className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
              <p className="font-semibold text-ppp-charcoal truncate">{s.workspace}</p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                {[
                  ["Active", String(s.active)],
                  ["Done", String(s.completed)],
                  ["Success", `${s.successPct}%`],
                  ["Drop off", `${s.dropOffPct}%`],
                  ["Take over", `${s.takeOverPct}%`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="text-[15px] font-bold text-ppp-charcoal tabular-nums">{value}</div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-400">{label}</div>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
