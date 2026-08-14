import Link from "next/link";
import type { DeliveryTool } from "./delivery-tools-strip";
import type { AttentionItem, ProjectMoney, ProjectSchedule, SpineStage } from "@/lib/commercial/projects/project-attention";
import { deriveDeliverySpine } from "@/lib/commercial/projects/project-attention";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";

/**
 * The Project HOME — a command center for a live job, not a launcher.
 *
 * Karan 2026-08-14: the tool-card launcher "feels obsolete." It listed where
 * things live; a home should say how the job is doing and what to do next. So,
 * top to bottom: what NEEDS ATTENTION (ranked actions), the MONEY (a mini P&L),
 * the SCHEDULE (dates + crew), and only then the delivery tools as the jump-in
 * row. Each block wins a different person — Alex (on track?), Katie (owed / to
 * bill?), Brendan (waiting on the GC?), Stephanie (ready for site?).
 */

const SEV: Record<AttentionItem["severity"], { rail: string; bg: string; dot: string }> = {
  high: { rail: "bg-rose-500", bg: "hover:bg-rose-50/50", dot: "bg-rose-500" },
  med: { rail: "bg-amber-400", bg: "hover:bg-amber-50/50", dot: "bg-amber-400" },
  low: { rail: "bg-ppp-charcoal-300", bg: "hover:bg-cc-brand-50/40", dot: "bg-ppp-charcoal-300" },
};

const money = (c: number) => formatCentsCompact(c);

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const ymd = iso.slice(0, 10);
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

function startRelLabel(s: ProjectSchedule): string | null {
  if (s.onSite) return "on site";
  if (s.startInDays === null) return null;
  if (s.startInDays === 0) return "starts today";
  if (s.startInDays > 0) return `in ${s.startInDays} day${s.startInDays === 1 ? "" : "s"}`;
  return `${Math.abs(s.startInDays)} day${Math.abs(s.startInDays) === 1 ? "" : "s"} ago`;
}

function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-600">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const v = tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : tone === "bad" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500 truncate">{label}</div>
      <div className={`font-condensed text-[17px] font-black tabular-nums leading-tight truncate ${v}`}>{value}</div>
    </div>
  );
}

const SPINE_TONE: Record<SpineStage["state"], { bar: string; dot: string; lbl: string; meta: string }> = {
  done: { bar: "bg-emerald-500", dot: "bg-emerald-500 border-emerald-500", lbl: "text-ppp-charcoal", meta: "text-emerald-700" },
  current: { bar: "bg-gradient-to-r from-emerald-500 to-cc-brand-500", dot: "bg-cc-brand-500 border-cc-brand-500 ring-4 ring-cc-brand-500/20", lbl: "text-cc-brand-700", meta: "text-cc-brand-700" },
  todo: { bar: "bg-ppp-charcoal-100", dot: "bg-surface border-ppp-charcoal-200", lbl: "text-ppp-charcoal-400", meta: "text-ppp-charcoal-400" },
};

/**
 * The delivery SPINE — where the job is in its lifecycle, at a glance. Replaces
 * the old tool-card grid, which just duplicated the deal's tab bar. A horizontal
 * run of six stages (Won → Close-out); scrolls on a narrow phone rather than
 * wrapping, so the sequence always reads left-to-right.
 */
function DeliverySpine({ stages, stageMeaning }: { stages: SpineStage[]; stageMeaning?: string | null }) {
  const doneN = stages.filter((st) => st.state === "done").length;
  return (
    <section aria-label="Project delivery" className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-ppp-charcoal-100">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-600">Delivery</h2>
        <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">{doneN} of {stages.length} stages complete</span>
      </header>
      <div className="px-4 pt-5 pb-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ol className="flex min-w-[380px]">
          {stages.map((st, i) => {
            const t = SPINE_TONE[st.state];
            const first = i === 0;
            const last = i === stages.length - 1;
            return (
              <li key={st.key} className="relative flex-1 min-w-[62px] text-center pt-7 px-0.5">
                <span aria-hidden className={`absolute top-[9px] h-[3px] ${t.bar} ${first ? "left-1/2 right-0" : last ? "left-0 right-1/2" : "left-0 right-0"}`} />
                <span
                  aria-hidden
                  className={`absolute left-1/2 -translate-x-1/2 rounded-full border-[3px] z-10 ${t.dot} ${st.state === "current" ? "top-[1px] h-[17px] w-[17px]" : "top-[2px] h-[15px] w-[15px]"}`}
                />
                <div className={`text-[11px] font-bold leading-tight ${t.lbl}`}>{st.label}</div>
                {st.meta && <div className={`text-[9.5px] mt-0.5 truncate ${t.meta}`}>{st.meta}</div>}
              </li>
            );
          })}
        </ol>
      </div>
      {stageMeaning && (
        <p className="px-4 py-2.5 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/50 text-[11.5px] text-ppp-charcoal-600">
          <span aria-hidden className="text-cc-brand-600 font-bold">▸ </span>
          <span className="font-semibold text-ppp-charcoal-700">Where it is now:</span> {stageMeaning}
        </p>
      )}
    </section>
  );
}

export function ProjectHome({
  status,
  attention,
  money: m,
  schedule: s,
  tools,
  stageMeaning,
}: {
  status: string;
  attention: AttentionItem[];
  money: ProjectMoney;
  schedule: ProjectSchedule;
  tools: DeliveryTool[];
  stageMeaning?: string | null;
}) {
  if (tools.length === 0) return null;

  // Build the delivery spine from the pipeline status + the tools that carry
  // their own state (submittals, billing = invoices/AIA, close-out).
  const toolByKey = (k: string) => {
    const t = tools.find((x) => x.key === k);
    return t ? { status: t.status, label: t.state } : null;
  };
  const spine = deriveDeliverySpine({
    status,
    wonLabel: fmtDate(s.wonIso),
    onSite: s.onSite,
    submittals: toolByKey("submittals"),
    billing: toolByKey("invoices") ?? toolByKey("aia"),
    closeout: toolByKey("closeout"),
  });

  const billedPct = m.hasContract && m.contractCents > 0 ? Math.round((m.billedCents / m.contractCents) * 100) : 0;
  const collectedPct = m.hasContract && m.contractCents > 0 ? Math.round((m.collectedCents / m.contractCents) * 100) : 0;
  const startRel = startRelLabel(s);

  return (
    <div className="space-y-4">
      {/* ── A. NEEDS ATTENTION ─────────────────────────────────────────── */}
      {attention.length > 0 && (
        <Panel
          title="Needs attention"
          right={<span className="text-[11px] font-bold tabular-nums text-rose-700">{attention.length}</span>}
        >
          <ul className="divide-y divide-ppp-charcoal-100">
            {attention.map((a) => {
              const sv = SEV[a.severity];
              return (
                <li key={a.key}>
                  <Link href={a.href} className={`group flex items-center gap-3 pl-0 pr-3.5 py-2.5 min-h-[44px] transition-colors ${sv.bg}`}>
                    <span aria-hidden className={`w-1 self-stretch shrink-0 ${sv.rail}`} />
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full shrink-0 ${sv.dot}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-ppp-charcoal group-hover:text-cc-brand-800 truncate">{a.title}</span>
                      {a.detail && <span className="block text-[11.5px] text-ppp-charcoal-500 tabular-nums truncate">{a.detail}</span>}
                    </span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ppp-charcoal-300 group-hover:text-cc-brand-600 group-hover:translate-x-0.5 transition-all"><path d="M9 18l6-6-6-6" /></svg>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {/* ── B. MONEY + C. SCHEDULE ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* B. Money — mini P&L */}
        <Panel title="Money">
          <div className="p-4 space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Contract</div>
                <div className="font-condensed text-[22px] font-black tabular-nums leading-none text-ppp-charcoal">
                  {m.hasContract ? money(m.contractCents) : "not set"}
                </div>
                {m.approvedCoCents !== 0 && (
                  <div className="text-[10.5px] text-ppp-charcoal-500 tabular-nums mt-0.5">
                    base {money(m.baseCents)} {m.approvedCoCents >= 0 ? "+" : "−"} COs {money(Math.abs(m.approvedCoCents))}
                  </div>
                )}
              </div>
              {m.hasContract && (
                <div className="text-right">
                  <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Billed</div>
                  <div className="font-condensed text-[22px] font-black tabular-nums leading-none text-cc-brand-700">{billedPct}%</div>
                </div>
              )}
            </div>

            {m.hasContract && (
              <div className="relative h-2 rounded-full bg-ppp-charcoal-100 overflow-hidden" aria-hidden>
                <div className="absolute inset-y-0 left-0 bg-cc-brand-300" style={{ width: `${Math.min(100, billedPct)}%` }} />
                <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${Math.min(100, collectedPct)}%` }} />
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-0.5">
              <Stat label="Collected" value={money(m.collectedCents)} tone={m.collectedCents > 0 ? "good" : undefined} />
              <Stat label="Outstanding" value={money(m.outstandingCents)} tone={m.outstandingCents > 0 ? "warn" : undefined} />
              {m.retainageCents > 0 && <Stat label="Retainage held" value={money(m.retainageCents)} tone="warn" />}
              {m.costsCents > 0 && <Stat label="Costs" value={money(m.costsCents)} />}
              {m.hasContract && m.marginPct !== null && (
                <Stat label="Margin" value={`${m.marginPct}%`} tone={m.marginPct < 0 ? "bad" : m.marginPct < 15 ? "warn" : "good"} />
              )}
            </div>
          </div>
        </Panel>

        {/* C. Schedule */}
        <Panel title="Schedule" right={s.crewHours > 0 ? <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">{s.crewHours} crew hrs</span> : undefined}>
          <div className="p-4 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Won</div>
              <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums">{fmtDate(s.wonIso) ?? "—"}</div>
            </div>
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Start</div>
              <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums">{fmtDate(s.targetStartIso) ?? "—"}</div>
              {startRel && (
                <div className={`text-[10.5px] mt-0.5 ${s.onSite ? "text-emerald-700 font-semibold" : "text-ppp-charcoal-500"}`}>{startRel}</div>
              )}
            </div>
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Target end</div>
              <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums">{fmtDate(s.targetEndIso) ?? "—"}</div>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── DELIVERY SPINE — where the job is, not a second copy of the tabs ── */}
      <DeliverySpine stages={spine} stageMeaning={stageMeaning} />
    </div>
  );
}
