import Link from "next/link";
import { loadReporting, integrityChecks, activeWorkspaces, type ReportRange } from "@/lib/messaging/db";
import { humanSeconds, HATCH_POLL_SECONDS, TARGET_SECONDS } from "@/lib/messaging/metrics";

export const dynamic = "force-dynamic";

const RANGES: ReportRange[] = ["7d", "30d", "90d"];
const isRange = (v: unknown): v is ReportRange => RANGES.includes(v as ReportRange);

const TAKEOVER_LABEL: Record<string, string> = {
  low_confidence: "Bot was unsure", customer_asked_human: "Customer asked for a person",
  out_of_scope: "Work we do not do", complaint: "Complaint",
  pricing_pressure: "Pushed for a price", language: "Not English",
  repeated_confusion: "Bot repeated itself", media_received: "Photo it could not use",
  manual_review: "Draft review", other: "Other",
};

/**
 * The reporting console.
 *
 * Hatch reports the same five per-workspace measures and stops. Three things
 * here it structurally cannot do, and each is grounded in something PPP's own
 * data already showed:
 *
 *   THE FUNNEL     "NY NYC Leads: 0% success" and "everyone leaves at the
 *                  address question" are the same number, and only one of them
 *                  can be acted on.
 *   SPEED TO LEAD  Hatch does not measure it, and it is what PPP is buying.
 *   WAITING NOW    Hatch reported a 13h average response time and nobody
 *                  noticed. A number on a dashboard is not an alert.
 */
export default async function ReportingConsole({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; ws?: string }>;
}) {
  const sp = await searchParams;
  const range: ReportRange = isRange(sp.range) ? sp.range : "30d";
  const workspaceId = sp.ws || undefined;

  const [r, integrity, workspaces] = await Promise.all([
    loadReporting(range, workspaceId),
    integrityChecks(),
    activeWorkspaces(),
  ]);
  const wsName = workspaces.find((w) => w.id === workspaceId)?.name;
  const q = (extra: Record<string, string>) =>
    "?" + new URLSearchParams({ range, ...(workspaceId ? { ws: workspaceId } : {}), ...extra }).toString();

  const issues = [
    integrity.unroutedLeads > 0 && { n: integrity.unroutedLeads, label: "leads could not be routed", hint: "Each names its own reason — no phone, no workspace, or a region not live." },
    integrity.failedSends > 0 && { n: integrity.failedSends, label: "sends failed", hint: "Retrying cannot fix these; they need a person." },
    integrity.staleClaims > 0 && { n: integrity.staleClaims, label: "actions stuck claimed", hint: "A worker died mid-send. They return to pending on the next tick." },
    integrity.activeWithoutNumber > 0 && { n: integrity.activeWithoutNumber, label: "live workspaces have no number", hint: "They cannot send from a local area code." },
  ].filter(Boolean) as { n: number; label: string; hint: string }[];

  return (
    <main className="max-w-5xl mx-auto px-4 py-4 pb-safe space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-bold text-ppp-charcoal truncate">{wsName ?? "All workspaces"}</h1>
        <nav className="inline-flex rounded-lg bg-ppp-charcoal-100 p-0.5" aria-label="Date range">
          {RANGES.map((v) => (
            <Link key={v} href={q({ range: v })}
              className={["min-h-[34px] px-3 flex items-center rounded-[6px] text-[12.5px] font-medium touch-manipulation",
                v === range ? "bg-white text-ppp-charcoal shadow-sm" : "text-ppp-charcoal-500"].join(" ")}>
              {v === "7d" ? "7 days" : v === "30d" ? "30 days" : "90 days"}
            </Link>
          ))}
        </nav>
      </header>

      {r.error && (
        <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[13px] text-ppp-orange-700">
          Could not load reporting. {r.error}
        </div>
      )}

      {/* Waiting now. First, because it is the only thing on the page that
          somebody can fix in the next five minutes. */}
      {r.aging.length > 0 && (
        <section className="rounded-xl border-2 border-ppp-orange-100 bg-ppp-orange-50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-orange-100">
            <h2 className="font-semibold text-ppp-orange-700 text-[14px]">
              {r.aging.length} customer{r.aging.length === 1 ? "" : "s"} waiting on a reply
            </h2>
          </div>
          <ul className="divide-y divide-ppp-orange-100/60">
            {r.aging.slice(0, 6).map((a) => (
              <li key={a.id}>
                <Link href={`/messaging/${a.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 min-h-[48px] hover:bg-ppp-orange-50 touch-manipulation">
                  <span className="text-[13px] text-ppp-charcoal truncate min-w-0">{a.workspace}</span>
                  <span className="shrink-0 text-[13px] font-bold tabular-nums text-ppp-orange-700">
                    {humanSeconds(a.waitingSeconds)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {r.aging.length > 6 && (
            <p className="px-4 py-2 text-[12px] text-ppp-orange-700/80">and {r.aging.length - 6} more</p>
          )}
        </section>
      )}

      {/* Speed to lead — the headline, with Hatch as the baseline. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Speed to lead</h2>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
            Hatch polls Salesforce every 15 minutes, so {humanSeconds(HATCH_POLL_SECONDS)} is the
            best it can do even when everything else is instant.
          </p>
        </div>
        <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Median" value={humanSeconds(r.speed.medianSeconds)}
            note={delta(r.speed.medianSeconds, r.previousSpeed.medianSeconds)} />
          <Stat label="Slowest 10%" value={humanSeconds(r.speed.p90Seconds)} />
          <Stat label={`Under ${TARGET_SECONDS}s`} value={`${r.speed.withinTargetPct}%`} note="the target" />
          <Stat label="Beating Hatch" value={`${r.speed.beatingHatchPct}%`} />
        </div>
        {r.speed.measured === 0 && (
          <p className="px-4 pb-3 text-[12px] text-ppp-charcoal-500">
            Nothing measured yet. This fills in once leads start flowing.
          </p>
        )}
      </section>

      {/* The funnel — the part Hatch cannot show. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Where conversations stop</h2>
          <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">
            Emily collects four things in order. A success rate says how many
            finished; this says which question loses them.
          </p>
        </div>
        <ul className="px-4 py-3 space-y-2.5">
          {r.funnel.map((f) => (
            <li key={f.stage}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-[13px] text-ppp-charcoal">{f.label}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-ppp-charcoal-500">
                  {f.reached} · {f.reachedPct}%
                  {f.droppedHerePct > 0 && (
                    <span className="ml-2 text-ppp-orange-700">−{f.droppedHerePct}%</span>
                  )}
                </span>
              </div>
              <div className="h-2 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                <div className="h-full rounded-full bg-ppp-charcoal" style={{ width: `${f.reachedPct}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Why humans stepped in. */}
      {r.takeovers.length > 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
            <h2 className="font-semibold text-ppp-charcoal text-[14px]">Why a person had to step in</h2>
            <p className="mt-0.5 text-[12px] text-ppp-charcoal-500">
              Hatch counts takeovers. The reason is what turns the count into a list of fixes.
            </p>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {r.takeovers.map((t) => (
              <li key={t.reason} className="px-4 py-2.5 flex items-center justify-between gap-3">
                <span className="text-[13px] text-ppp-charcoal truncate min-w-0">
                  {TAKEOVER_LABEL[t.reason] ?? t.reason}
                </span>
                <span className="shrink-0 text-[13px] tabular-nums text-ppp-charcoal-500">
                  {t.count} · {t.pct}%
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Per workspace, with the losing question named. */}
      <section>
        <h2 className="mb-2 font-semibold text-ppp-charcoal text-[14px]">By workspace</h2>
        {r.health.length === 0 ? (
          <div className="rounded-xl border border-ppp-charcoal-100 bg-white px-5 py-7 text-center">
            <p className="text-[13px] text-ppp-charcoal-500">No conversations in this period.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {r.health.map((h) => (
              <li key={h.workspace} className="rounded-xl border border-ppp-charcoal-100 bg-white px-4 py-3">
                <p className="font-semibold text-ppp-charcoal truncate text-[13.5px]">{h.workspace}</p>
                <div className="mt-2.5 grid grid-cols-3 gap-y-2.5 gap-x-1.5 text-center">
                  {([["Active", String(h.active)], ["Done", String(h.completed)],
                     ["Success", `${h.successPct}%`], ["Drop", `${h.dropOffPct}%`],
                     ["Takeover", `${h.takeOverPct}%`],
                     ["1st reply", humanSeconds(h.medianFirstReplySeconds)]] as const).map(([l, v]) => (
                    <div key={l}>
                      <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums leading-none">{v}</div>
                      <div className="mt-1 text-[9.5px] uppercase tracking-wide text-ppp-charcoal-400 leading-tight">{l}</div>
                    </div>
                  ))}
                </div>
                {h.worstStage && (
                  <p className="mt-2.5 pt-2.5 border-t border-ppp-charcoal-100 text-[12px] text-ppp-charcoal-600 leading-relaxed">
                    Most stop at <strong>{h.worstStage.label.toLowerCase()}</strong> — {h.worstStage.droppedPct}% of
                    those who got that far.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Integrity. Asked every load, rather than discovered in an analysis
          two years later. */}
      <section className="rounded-xl border border-ppp-charcoal-100 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="font-semibold text-ppp-charcoal text-[14px]">Data integrity</h2>
        </div>
        {issues.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-ppp-charcoal-500">
            Nothing stuck. {integrity.suppressedNumbers} number{integrity.suppressedNumbers === 1 ? "" : "s"} suppressed.
          </p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {issues.map((i) => (
              <li key={i.label} className="px-4 py-3 flex gap-3">
                <span className="shrink-0 text-[15px] font-bold text-ppp-orange-700 tabular-nums">{i.n}</span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ppp-charcoal">{i.label}</p>
                  <p className="mt-0.5 text-[12px] text-ppp-charcoal-500 leading-relaxed">{i.hint}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div>
      <div className="text-[20px] font-bold text-ppp-charcoal tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[11px] text-ppp-charcoal-500">{label}</div>
      {note && <div className="mt-0.5 text-[11px] text-ppp-charcoal-400">{note}</div>}
    </div>
  );
}

/** Direction, in words. A number with no direction is a number nobody acts on. */
function delta(now: number | null, before: number | null): string | null {
  if (now === null || before === null || before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  if (Math.abs(change) < 5) return "about the same";
  // Lower is better for a speed measure.
  return change < 0 ? `${Math.abs(change)}% faster` : `${change}% slower`;
}
