import { agentStats, humanAgentStats, readinessChecks, activeWorkspaces } from "@/lib/messaging/db";

export const dynamic = "force-dynamic";

/**
 * Mirrors Hatch's reporting dashboard: an AI Agents table and a Human Agents
 * table, with the same measures, so the parallel run compares like for like
 * rather than through a mapping nobody trusts.
 *
 * Two honest omissions are stated on the page rather than left as blanks:
 * Hatch's voice columns, which this system does not have at all, and the
 * readiness checklist, which is the only useful view while there is no traffic.
 */
export default async function MessagingDashboard({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string }>;
}) {
  const sp = await searchParams;
  const workspaceId = sp.ws || undefined;
  const [stats, humans, ready, workspaces] = await Promise.all([
    agentStats(), humanAgentStats(workspaceId), readinessChecks(), activeWorkspaces(),
  ]);
  const wsName = workspaces.find((w) => w.id === workspaceId)?.name;

  const blockers = [
    { done: ready.activeWorkspaces > 0, label: `${ready.activeWorkspaces} workspaces live`, detail: "NY, NJ and Florida — one timezone." },
    { done: ready.missingNumbers === 0, label: ready.missingNumbers === 0 ? "Every live workspace has a number" : `${ready.missingNumbers} live workspace(s) with no number`, detail: "Without one it cannot send from the local area code the customer replies to." },
    { done: ready.optOuts > 0, label: ready.optOuts > 0 ? `${ready.optOuts} numbers suppressed` : "Opt-out list not imported", detail: "Hard gate on the first send. Somebody who told Hatch to stop has told PPP to stop." },
    { done: false, label: "Carrier not connected", detail: "Twilio or AWS, once the numbers are ported off Salesforce's account. Until then every send is recorded, never delivered." },
    { done: false, label: "Call forwarding not set on the new carrier", detail: "Voice features are out of scope (Karan, 2026-09-01) — but porting moves voice with the number, and an unconfigured number answers with a carrier error rather than going silent. One forward-to-(877) rule per number at cutover." },
    { done: ready.cronSecret, label: ready.cronSecret ? "Scheduler authenticated" : "CRON_SECRET not set", detail: "The tick refuses to run without it rather than running open." },
    { done: ready.activeCampaigns > 0, label: ready.activeCampaigns > 0 ? `${ready.activeCampaigns} campaigns active` : "No campaigns active", detail: "Imported from Hatch, then editable under Automations." },
  ];
  const remaining = blockers.filter((b) => !b.done).length;

  return (
    <main className="max-w-5xl mx-auto px-4 py-4 pb-safe space-y-5">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="font-bold text-ppp-charcoal truncate">{wsName ?? "All workspaces"}</h1>
        <span className="shrink-0 text-[12px] text-ppp-charcoal-500">{remaining} left to launch</span>
      </header>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 flex items-baseline justify-between gap-3">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Before the first message</h2>
          <span className="shrink-0 text-[11px] font-mono text-ppp-charcoal-500 tabular-nums">
            {blockers.length - remaining}/{blockers.length}
          </span>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {blockers.map((b) => (
            <li key={b.label} className="px-4 py-3 flex gap-3">
              <span aria-hidden className={["mt-0.5 shrink-0 h-4 w-4 rounded-full border-2 flex items-center justify-center", b.done ? "border-ppp-green bg-ppp-green" : "border-ppp-charcoal-300"].join(" ")}>
                {b.done && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
              </span>
              <div className="min-w-0">
                <p className={`text-[13px] font-semibold ${b.done ? "text-ppp-charcoal" : "text-ppp-charcoal-600"}`}>{b.label}</p>
                <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{b.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-1 font-semibold text-ppp-charcoal text-[14px]">AI agents</h2>
        <p className="mb-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          The five measures Hatch reports per workspace, kept identical so the two can be read side by side during the parallel run.
        </p>
        {stats.length === 0 ? (
          <Empty>No conversations yet. These fill in as leads arrive.</Empty>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {stats.map((s) => (
              <li key={s.workspace} className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
                <p className="font-semibold text-ppp-charcoal truncate text-[13.5px]">{s.workspace}</p>
                <div className="mt-2.5 grid grid-cols-3 sm:grid-cols-5 gap-y-2.5 gap-x-1.5 text-center">
                  {([["Active", String(s.active)], ["Done", String(s.completed)], ["Success", `${s.successPct}%`], ["Drop", `${s.dropOffPct}%`], ["Takeover", `${s.takeOverPct}%`]] as const).map(([l, v]) => (
                    <div key={l}>
                      <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums leading-none">{v}</div>
                      <div className="mt-1 text-[9.5px] uppercase tracking-wide text-ppp-charcoal-400 leading-tight">{l}</div>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold text-ppp-charcoal text-[14px]">Human agents</h2>
        <p className="mb-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Response time is measured the way Hatch measures it — from a customer&apos;s
          message to the next reply out. It is the number that actually predicts
          whether a lead converts.
        </p>
        {humans.length === 0 ? (
          <Empty>Nobody has taken over a conversation yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {humans.map((h) => (
              <li key={h.name} className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3 flex items-center gap-4">
                <span className="flex-1 min-w-0 font-medium text-ppp-charcoal truncate text-[13px]">{h.name}</span>
                <span className="shrink-0 text-center"><span className="block text-[14px] font-bold tabular-nums">{h.conversations}</span><span className="block text-[9.5px] uppercase tracking-wide text-ppp-charcoal-400">Conv</span></span>
                <span className="shrink-0 text-center"><span className="block text-[14px] font-bold tabular-nums">{h.successPct}%</span><span className="block text-[9.5px] uppercase tracking-wide text-ppp-charcoal-400">Success</span></span>
                <span className="shrink-0 text-center"><span className="block text-[14px] font-bold tabular-nums">{h.avgResponseMins == null ? "—" : `${h.avgResponseMins}m`}</span><span className="block text-[9.5px] uppercase tracking-wide text-ppp-charcoal-400">Resp</span></span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Hatch reports voice here as well. PPP is not carrying that over, so
          those columns are deliberately absent rather than pending.
        </p>
      </section>
    </main>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-7 text-center">
      <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed max-w-sm mx-auto">{children}</p>
    </div>
  );
}
