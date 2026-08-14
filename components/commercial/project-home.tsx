import Link from "next/link";
import type { DeliveryTool } from "./delivery-tools-strip";
import type { AttentionItem, ProjectMoney, ProjectSchedule } from "@/lib/commercial/projects/project-attention";
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

const TOOL_ACCENT: Record<DeliveryTool["status"], { border: string; iconBg: string; iconText: string; dot: string; state: string }> = {
  done: { border: "border-emerald-200 hover:border-emerald-300", iconBg: "bg-emerald-50", iconText: "text-emerald-600", dot: "bg-emerald-500", state: "text-emerald-700" },
  active: { border: "border-cc-brand-200 hover:border-cc-brand-300", iconBg: "bg-cc-brand-50", iconText: "text-cc-brand-600", dot: "bg-cc-brand-500", state: "text-ppp-charcoal-700" },
  todo: { border: "border-ppp-charcoal-100 hover:border-ppp-charcoal-200", iconBg: "bg-ppp-charcoal-50", iconText: "text-ppp-charcoal-400", dot: "bg-ppp-charcoal-300", state: "text-ppp-charcoal-400 italic" },
};

function ToolIcon({ toolKey }: { toolKey: string }) {
  const c = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (toolKey) {
    case "submittals": return <svg {...c}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>;
    case "work-order": return <svg {...c}><path d="M9 2h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zM9 4v1h6V4" /></svg>;
    case "change-orders": return <svg {...c}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>;
    case "costs": return <svg {...c}><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>;
    case "aia": return <svg {...c}><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>;
    case "invoices": return <svg {...c}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13h6M9 17h6" /></svg>;
    case "closeout": return <svg {...c}><path d="m9 12 2 2 4-4M12 2 4 5v6c0 5.5 3.8 8.9 8 10 4.2-1.1 8-4.5 8-10V5l-8-3z" /></svg>;
    default: return <svg {...c}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6" /></svg>;
  }
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

export function ProjectHome({
  attention,
  money: m,
  schedule: s,
  tools,
  stageMeaning,
}: {
  attention: AttentionItem[];
  money: ProjectMoney;
  schedule: ProjectSchedule;
  tools: DeliveryTool[];
  stageMeaning?: string | null;
}) {
  if (tools.length === 0) return null;

  // Group consecutive tools by phase (array already arrives in work order).
  const groups: { phase: string; tools: DeliveryTool[] }[] = [];
  for (const t of tools) {
    const last = groups[groups.length - 1];
    if (last && last.phase === t.phase) last.tools.push(t);
    else groups.push({ phase: t.phase, tools: [t] });
  }
  const done = tools.filter((t) => t.status === "done").length;
  const notStarted = tools.filter((t) => t.status === "todo").length;

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

      {/* ── DELIVERY TOOLS (jump-in row) ───────────────────────────────── */}
      <section aria-label="Project delivery" className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
        <header className="flex items-baseline justify-between gap-3 px-4 py-2.5 border-b border-ppp-charcoal-100">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-ppp-charcoal-600">Delivery</h2>
          <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">{done} done · {notStarted} not started · {tools.length} tools</span>
        </header>
        <div className="p-3 space-y-3">
          {groups.map((g) => (
            <div key={g.phase}>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1.5 px-0.5">{g.phase}</div>
              <div className="flex flex-wrap gap-2">
                {g.tools.map((t) => {
                  const a = TOOL_ACCENT[t.status];
                  return (
                    <Link key={t.key} href={t.href} className={`group flex-1 min-w-[220px] flex items-center gap-3 rounded-lg border bg-surface px-3 py-2.5 min-h-[44px] transition-all hover:shadow-sm ${a.border}`}>
                      <span className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${a.iconBg} ${a.iconText}`}><ToolIcon toolKey={t.key} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold text-ppp-charcoal group-hover:text-cc-brand-800 truncate leading-tight">{t.label}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span aria-hidden className={`h-1.5 w-1.5 rounded-full shrink-0 ${a.dot}`} />
                          <span className={`text-[11.5px] ${a.state} truncate`}>{t.state}</span>
                        </div>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ppp-charcoal-300 group-hover:text-cc-brand-600 group-hover:translate-x-0.5 transition-all"><path d="M9 18l6-6-6-6" /></svg>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {stageMeaning && (
          <p className="px-4 py-2.5 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/50 text-[11.5px] text-ppp-charcoal-600">
            <span className="font-semibold text-ppp-charcoal-700">Where it is now:</span> {stageMeaning}
          </p>
        )}
      </section>
    </div>
  );
}
