import Link from "next/link";
import { loadReporting, readinessChecks, activeWorkspaces, type ReportRange } from "@/lib/messaging/db";
import { humanSeconds } from "@/lib/messaging/metrics";
import { transportChoice } from "@/lib/messaging/transport-config";

export const dynamic = "force-dynamic";

const isRange = (v: unknown): v is ReportRange =>
  v === "7d" || v === "30d" || v === "90d";

const RANGES: { key: ReportRange; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

/**
 * The one screen that answers "how is it going".
 *
 * Mirrors Hatch's dashboard — an AI agents table and a human agents table with
 * the same measures — because the parallel run only proves something if the two
 * can be read side by side rather than through a mapping nobody trusts.
 *
 * Three deliberate differences, stated on the page rather than left as blanks:
 *
 *   Voice columns. Hatch reports Calls and Avg. Duration here. PPP is not
 *   carrying voice over, so a column that can only ever say "-" is noise
 *   pretending to be parity.
 *
 *   Phone Pricing counts as a success. It is one — "qualifies for an off-site
 *   quote and everything needed is collected" is PPP's own definition — and
 *   scoring it as a failure would make the workspaces doing the most off-site
 *   quoting look like the worst ones.
 *
 *   Percentages are of COMPLETED, never of everything. A conversation still
 *   running has not failed; counting it as one makes a busy workspace look
 *   worse than a dead workspace.
 */
export default async function MessagingDashboard({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; range?: string }>;
}) {
  const sp = await searchParams;
  const range: ReportRange = isRange(sp.range) ? sp.range : "30d";
  const workspaceId = sp.ws || undefined;

  const [r, ready, workspaces] = await Promise.all([
    loadReporting(range, workspaceId),
    readinessChecks(),
    activeWorkspaces(),
  ]);
  const wsName = workspaces.find((w) => w.id === workspaceId)?.name;
  const transport = transportChoice();
  const href = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { range, ws: workspaceId, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "range" && v === "30d")) p.set(k, v);
    const q = p.toString();
    return `/messaging/dashboard${q ? `?${q}` : ""}`;
  };

  const blockers = [
    { done: ready.activeWorkspaces > 0, label: `${ready.activeWorkspaces} workspaces live`, detail: "NY, NJ and Florida — one timezone." },
    { done: ready.missingNumbers === 0, label: ready.missingNumbers === 0 ? "Every live workspace has a number" : `${ready.missingNumbers} live workspace(s) with no number`, detail: "Without one it cannot send from the local area code the customer replies to." },
    { done: ready.optOuts > 0, label: ready.optOuts > 0 ? `${ready.optOuts} numbers suppressed` : "Opt-out list not imported", detail: "Hard gate on the first send. Somebody who told Hatch to stop has told PPP to stop." },
    { done: transport.live, label: transport.live ? "Carrier connected — messages are being delivered" : "Carrier not delivering", detail: transport.why },
    { done: true, label: "Inbound replies can be received", detail: "POST /api/webhooks/sms-inbound, SNS-signature verified. Point the End User Messaging topic at it once the numbers exist." },
    { done: ready.cronSecret, label: ready.cronSecret ? "Scheduler authenticated" : "CRON_SECRET not set", detail: "The tick refuses to run without it rather than running open." },
    { done: ready.activeCampaigns > 0, label: ready.activeCampaigns > 0 ? `${ready.activeCampaigns} campaigns active` : "No campaigns active", detail: "Imported from Hatch, then editable under Automations." },
  ];
  const remaining = blockers.filter((b) => !b.done).length;

  return (
    <main className="max-w-5xl mx-auto px-4 py-4 pb-safe space-y-5">
      {/* The single most important fact on the page, and the one somebody
          testing must never have to guess at. */}
      {!transport.live && (
        <section className="rounded-xl border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ppp-charcoal">Nothing is being delivered</p>
          <p className="mt-1 text-[12.5px] text-ppp-charcoal-600 leading-relaxed">
            {transport.why} Drafts are written down and the whole system runs
            end to end — this is the state to test in.
          </p>
        </section>
      )}

      <header className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-bold text-ppp-charcoal truncate">{wsName ?? "All workspaces"}</h1>
          <span className="shrink-0 text-[12px] text-ppp-charcoal-500">{remaining} left to launch</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-lg border border-ppp-charcoal-200 overflow-hidden">
            {RANGES.map((x) => (
              <Link key={x.key} href={href({ range: x.key })}
                className={[
                  "min-h-[44px] px-3 flex items-center text-[12.5px] font-medium touch-manipulation",
                  range === x.key ? "bg-ppp-charcoal text-white" : "bg-white text-ppp-charcoal-600",
                ].join(" ")}>
                {x.label}
              </Link>
            ))}
          </div>
        </div>
      </header>

      {/* Workspaces as links rather than a select: this is a server page, and
          a select with no form around it is a control that looks like it works
          and does nothing. */}
      <nav className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        <Link href={href({ ws: undefined })}
          className={[
            "shrink-0 min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium flex items-center touch-manipulation",
            !workspaceId ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
          ].join(" ")}>
          All
        </Link>
        {workspaces.map((w) => (
          <Link key={w.id} href={href({ ws: w.id })}
            className={[
              "shrink-0 min-h-[36px] px-3 rounded-lg text-[12.5px] font-medium flex items-center whitespace-nowrap touch-manipulation",
              workspaceId === w.id ? "bg-ppp-charcoal text-white" : "bg-white border border-ppp-charcoal-200 text-ppp-charcoal-600",
            ].join(" ")}>
            {w.name}
          </Link>
        ))}
      </nav>

      {/* Launch readiness first. While there is no traffic it is the only view
          that says anything true, and a number on a dashboard is not an alert. */}
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
              <span aria-hidden className={["mt-0.5 shrink-0 h-4 w-4 rounded-full border-2 flex items-center justify-center", b.done ? "border-ppp-green-700 bg-ppp-green-50 text-ppp-green-700" : "border-ppp-charcoal-200"].join(" ")}>
                {b.done && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
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
          Hatch&apos;s columns, kept identical so the two reports can be read side
          by side. Percentages are of completed conversations — one still running
          has not failed yet.
        </p>
        {r.agents.length === 0 ? (
          <Empty>No conversations in this window. These fill in as leads arrive.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-ppp-charcoal-100 bg-white">
            <table className="w-full text-[12.5px] min-w-[560px]">
              <thead>
                <tr className="border-b border-ppp-charcoal-100 text-left">
                  {["Agent", "Workspace", "Active", "Done", "Success", "Drop off", "Take over", "Trigger"].map((h, i) => (
                    <th key={h} className={`px-3 py-2 font-semibold text-ppp-charcoal-500 text-[11px] uppercase tracking-wide ${i >= 2 && i <= 6 ? "text-right" : ""}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {r.agents.map((a) => (
                  <tr key={`${a.agent}-${a.workspace}`}>
                    <td className="px-3 py-2.5 font-medium text-ppp-charcoal whitespace-nowrap">{a.agent}</td>
                    <td className="px-3 py-2.5 text-ppp-charcoal-600 whitespace-nowrap">{a.workspace}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{a.active}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{a.completed}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{a.successPct}%</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{a.dropOffPct}%</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{a.takeOverPct}%</td>
                    <td className="px-3 py-2.5 text-ppp-charcoal-500">{a.trigger ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold text-ppp-charcoal text-[14px]">People</h2>
        <p className="mb-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Response time is measured the way Hatch measures it — from a
          customer&apos;s message to the next reply out. Shown as a median, because
          one thread left open over a weekend turns an average into nonsense.
        </p>
        {r.people.length === 0 ? (
          <Empty>Nobody has replied to a conversation yet.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-ppp-charcoal-100 bg-white">
            <table className="w-full text-[12.5px] min-w-[460px]">
              <thead>
                <tr className="border-b border-ppp-charcoal-100 text-left">
                  {["Name", "Conversations", "Success", "Handle time", "Response"].map((h, i) => (
                    <th key={h} className={`px-3 py-2 font-semibold text-ppp-charcoal-500 text-[11px] uppercase tracking-wide ${i >= 1 ? "text-right" : ""}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {r.people.map((h) => (
                  <tr key={h.name}>
                    <td className="px-3 py-2.5 font-medium text-ppp-charcoal">{h.name}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{h.conversations}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{h.successPct}%</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{humanSeconds(h.medianHandleSeconds)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{humanSeconds(h.medianResponseSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
          Hatch reports calls and call duration here too. PPP is not carrying
          voice over, so those columns are deliberately absent rather than
          pending.
        </p>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
        <h2 className="font-semibold text-ppp-charcoal text-[14px]">Going deeper</h2>
        <ul className="mt-1.5 space-y-1.5">
          {[
            ["/messaging/reporting", "Reports", "Where conversations stop, speed to lead, why a person stepped in, data integrity."],
            ["/messaging/agent", "Chatbot", "The rules Emily follows, per state and per workspace."],
            ["/messaging/settings", "Settings", "Hours, timezone and after-hours replies for each workspace."],
            ["/messaging/training/coverage", "Training", "What the corpus can and cannot teach yet."],
          ].map(([to, label, why]) => (
            <li key={to as string}>
              <Link href={to as string} className="block min-h-[44px] py-1 group">
                <span className="text-[13px] font-medium text-ppp-charcoal group-hover:underline">{label}</span>
                <span className="block text-[12px] text-ppp-charcoal-500 leading-relaxed">{why}</span>
              </Link>
            </li>
          ))}
        </ul>
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
