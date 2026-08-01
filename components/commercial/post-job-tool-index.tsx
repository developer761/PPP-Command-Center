/**
 * PostJobToolIndex — the shared layout for a production-tool sidebar tab
 * (Change Orders / AIA Billing / Submittals / Closeout).
 *
 * One consistent shape: a header, an optional KPI strip, then every project
 * GROUPED BY ACCOUNT (avatar header + a divider between accounts, so many
 * projects across many GCs never turn into a wall) with a per-tool status chip
 * and a link straight into that project's tool page. Finished projects fold
 * into a collapsed "Completed" section so they don't crowd active work.
 *
 * Data comes from the ONE source of truth (`listProjects`) so the count/status
 * shown here always matches the Projects tab, the account, and the tool page.
 */
import Link from "next/link";
import { AccountAvatar } from "@/components/commercial/account-avatar";
import { derivedOppName, formatOpportunityNumber } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import type { ProjectRow } from "@/lib/commercial/projects/db";

export type ToolStatusTone = "neutral" | "amber" | "emerald" | "brand" | "rose";

const TONE_CLS: Record<ToolStatusTone, string> = {
  neutral: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  brand: "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
};

/** Per-tool accent so the four tool pages read as distinct surfaces instead of
 *  four identical orange-header lists. Full literal class strings so Tailwind's
 *  JIT keeps them. */
export type ToolAccent = "brand" | "blue" | "emerald" | "navy";
const ACCENT: Record<ToolAccent, { tile: string; chevron: string; hover: string; groupHover: string; groupTint: string; heroText: string; heroRule: string }> = {
  brand: { tile: "bg-cc-brand-600", chevron: "text-cc-brand-500", hover: "hover:bg-cc-brand-50/60", groupHover: "group-hover:text-cc-brand-800", groupTint: "from-surface to-cc-brand-50/20", heroText: "text-cc-brand-700", heroRule: "bg-cc-brand-500" },
  blue: { tile: "bg-ppp-blue-600", chevron: "text-ppp-blue-500", hover: "hover:bg-ppp-blue-50/60", groupHover: "group-hover:text-ppp-blue-800", groupTint: "from-surface to-ppp-blue-50/25", heroText: "text-ppp-blue-700", heroRule: "bg-ppp-blue-500" },
  emerald: { tile: "bg-emerald-600", chevron: "text-emerald-500", hover: "hover:bg-emerald-50/60", groupHover: "group-hover:text-emerald-800", groupTint: "from-surface to-emerald-50/25", heroText: "text-emerald-700", heroRule: "bg-emerald-500" },
  navy: { tile: "bg-ppp-navy-700", chevron: "text-ppp-navy-500", hover: "hover:bg-ppp-navy-50/60", groupHover: "group-hover:text-ppp-navy-800", groupTint: "from-surface to-ppp-navy-50/25", heroText: "text-ppp-navy-700", heroRule: "bg-ppp-navy-600" },
};

function groupByAccount(projects: ProjectRow[]): { accountId: string; accountName: string; rows: ProjectRow[] }[] {
  const map = new Map<string, { accountId: string; accountName: string; rows: ProjectRow[] }>();
  for (const p of projects) {
    const g = map.get(p.accountId) ?? { accountId: p.accountId, accountName: p.accountName, rows: [] };
    g.rows.push(p);
    map.set(p.accountId, g);
  }
  // Alphabetical by account so the list is stable + scannable.
  return Array.from(map.values()).sort((a, b) => a.accountName.localeCompare(b.accountName));
}

function ProjectRowLink({
  p,
  status,
  hrefFor,
  rowMeta,
  accent,
}: {
  p: ProjectRow;
  status: (p: ProjectRow) => { label: string; tone: ToolStatusTone };
  hrefFor: (p: ProjectRow) => string;
  rowMeta?: (p: ProjectRow) => React.ReactNode;
  accent: ToolAccent;
}) {
  const name = derivedOppName(p.opp, p.accountName);
  const code = formatOpportunityNumber(p.opp.project_number);
  const st = status(p);
  const a = ACCENT[accent];
  const meta = rowMeta?.(p);
  return (
    <Link
      href={hrefFor(p)}
      className={`flex items-center justify-between gap-3 pl-5 pr-3 py-2.5 rounded-lg ${a.hover} min-h-[52px] touch-manipulation group`}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-[13.5px] font-semibold text-ppp-charcoal truncate ${a.groupHover}`}>{name}</div>
        <div className="text-[10.5px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
          {code && <span className="font-mono">{code}</span>}
          {code && <span aria-hidden className="text-ppp-charcoal-300">·</span>}
          <span>{oppStatusDisplayLabel(p.opp.status, p.opp.sub_status)}</span>
          {meta && <><span aria-hidden className="text-ppp-charcoal-300">·</span>{meta}</>}
        </div>
      </div>
      <span className={`inline-flex items-center px-2 py-1 rounded-md border text-[11px] font-semibold tabular-nums shrink-0 ${TONE_CLS[st.tone]}`}>
        {st.label}
      </span>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`${a.chevron} shrink-0 group-hover:translate-x-0.5 transition-transform`}><path d="M9 18l6-6-6-6" /></svg>
    </Link>
  );
}

function AccountGroup({
  group,
  status,
  hrefFor,
  rowMeta,
  accent,
}: {
  group: { accountId: string; accountName: string; rows: ProjectRow[] };
  status: (p: ProjectRow) => { label: string; tone: ToolStatusTone };
  hrefFor: (p: ProjectRow) => string;
  rowMeta?: (p: ProjectRow) => React.ReactNode;
  accent: ToolAccent;
}) {
  const a = ACCENT[accent];
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className={`flex items-center gap-2 px-4 py-2.5 border-b border-ppp-charcoal-100 bg-gradient-to-br ${a.groupTint}`}>
        <AccountAvatar accountId={group.accountId} name={group.accountName} size="xs" />
        <Link href={`/commercial/accounts/${group.accountId}?tab=projects`} className="text-[13px] font-bold text-ppp-charcoal truncate hover:text-cc-brand-700">
          {group.accountName}
        </Link>
        <span className="ml-auto shrink-0 text-[10px] font-semibold text-ppp-charcoal-400 tabular-nums">
          {group.rows.length} project{group.rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="divide-y divide-ppp-charcoal-50 p-1.5">
        {group.rows.map((p) => (
          <li key={p.opp.id}>
            <ProjectRowLink p={p} status={status} hrefFor={hrefFor} rowMeta={rowMeta} accent={accent} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PostJobToolIndex({
  title,
  subtitle,
  icon,
  projects,
  status,
  hrefFor,
  emptyHint,
  kpis,
  rowMeta,
  accent = "brand",
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  projects: ProjectRow[];
  status: (p: ProjectRow) => { label: string; tone: ToolStatusTone };
  hrefFor: (p: ProjectRow) => string;
  emptyHint: string;
  kpis?: React.ReactNode;
  /** Optional per-tool secondary detail shown on each project row. */
  rowMeta?: (p: ProjectRow) => React.ReactNode;
  /** Per-tool accent so the four tool pages read as distinct surfaces. */
  accent?: ToolAccent;
}) {
  const active = projects.filter((p) => p.opp.status !== "post_sale_closed");
  const completed = projects.filter((p) => p.opp.status === "post_sale_closed");
  const activeGroups = groupByAccount(active);
  const completedGroups = groupByAccount(completed);
  const a = ACCENT[accent];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <header>
        <div className="flex items-center gap-2.5">
          <span aria-hidden className={`inline-flex items-center justify-center h-10 w-10 rounded-xl ${a.tile} text-white shrink-0`}>{icon}</span>
          <div>
            <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">{title}</h1>
            <p className="text-[12px] text-ppp-charcoal-500 mt-1">{subtitle}</p>
          </div>
        </div>
        <div className={`mt-3 h-0.5 w-full rounded-full ${a.heroRule} opacity-70`} />
      </header>

      {kpis}

      {projects.length === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No projects yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">{emptyHint}</p>
          <Link href="/commercial/opportunities" className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">
            Go to Pipeline
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {activeGroups.map((g) => (
            <AccountGroup key={g.accountId} group={g} status={status} hrefFor={hrefFor} rowMeta={rowMeta} accent={accent} />
          ))}
          {completedGroups.length > 0 && (
            <details className="group">
              <summary className="list-none cursor-pointer flex items-center gap-2 text-[12px] font-semibold text-ppp-charcoal-600 min-h-[44px] sm:min-h-[36px] select-none">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-90"><path d="M9 18l6-6-6-6" /></svg>
                Completed projects · {completed.length}
              </summary>
              <div className="space-y-3 mt-2">
                {completedGroups.map((g) => (
                  <AccountGroup key={g.accountId} group={g} status={status} hrefFor={hrefFor} rowMeta={rowMeta} accent={accent} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
