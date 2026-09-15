import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getJobCostsReport, COST_BUCKET_COLUMNS, type CostBuckets, type JobCostsReport } from "@/lib/commercial/reports/job-costs";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { monthlyBilledSeries } from "@/lib/commercial/invoices/monthly";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";
import TrendChart from "@/components/trend-chart";
import { flashMessage } from "@/lib/commercial/flash";
import { getReportAccess, getViewerFolders } from "@/lib/commercial/reports/access";
import {
  ALL_REPORTS_VIEW,
  FOLDER_COOKIE,
  folderReports,
  pickActiveView,
  showAllView,
} from "@/lib/commercial/reports/access-rule";
import { REPORT_GROUPS, isReportKey, reportDef, type ReportKey } from "@/lib/commercial/reports/registry";
import { loadCardMetrics, type CardMetrics, type MetricTone } from "@/lib/commercial/reports/card-metrics";
import { countFolderMembers, listCommercialAdminNames, type FolderView } from "@/lib/commercial/reports/folders-db";
import { FolderNav, type FolderNavItem } from "@/components/commercial/reports/folder-nav";
import { FolderGlyph, PathIcon } from "@/components/commercial/reports/folder-glyph";
import { RememberReportFolder } from "@/components/commercial/reports/remember-folder";
import { ReportCardMenu } from "@/components/commercial/reports/report-card-menu";
import { PersonalFolderMenu } from "@/components/commercial/reports/personal-folder-controls";
import {
  createPersonalFolderAction,
  renamePersonalFolderAction,
  deletePersonalFolderAction,
  movePersonalFolderAction,
  addReportToPersonalFolderAction,
  removeReportFromPersonalFolderAction,
  moveReportInPersonalFolderAction,
} from "./folder-actions";

export const dynamic = "force-dynamic";

/**
 * REPORTS — folder-first (Katie + Karan, 2026-09-15).
 *
 * Reports live in folders. Team folders (Manager, Finance, Field Users…) are
 * made by admins in Settings → Report folders and decide who sees what; "My
 * folders" are anyone's own tidy view and grant nothing. Admins also get "All
 * reports". The folder you last opened is remembered, so Alex lands where he
 * left off.
 *
 * Only the cards in the open folder are loaded — a report you can't see, or
 * one in another folder, never runs its query.
 */

const BUCKET_TONE: Record<keyof CostBuckets, ChartTone> = {
  materials: "brand", crewLabor: "emerald", subLabor: "blue", subcontractor: "navy", equipment: "amber", permit: "neutral", other: "neutral",
};

const toneText: Record<MetricTone, string> = {
  brand: "text-cc-brand-700",
  navy: "text-ppp-navy-700",
  amber: "text-amber-700",
  emerald: "text-emerald-700",
  rose: "text-rose-700",
  neutral: "text-ppp-charcoal",
};

type View =
  | { kind: "all"; id: string; title: string; keys: ReportKey[] }
  | { kind: "shared" | "personal"; id: string; title: string; keys: ReportKey[]; folder: FolderView };

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ReportsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const sp = await searchParams;
  const access = await getReportAccess(user.id, user.email);
  const { isAdmin } = access;
  // Accounting gates on admin / account manager (Mary keeps the book and isn't
  // a platform admin), so its link is only offered to someone who can open it.
  const canSeeFinance = access.role === "admin" || access.role === "account_manager";

  const list = await getViewerFolders(user.id, isAdmin);
  const shared = list.ok ? list.shared : [];
  const personal = list.ok ? list.personal : [];
  const keysOf = (f: FolderView) =>
    folderReports(f.id, f.reportKeys.map((k, i) => ({ folder_id: f.id, report_key: k, sort_order: i })), access.visible);

  const showAll = showAllView(isAdmin, shared.length);
  const remembered = (await cookies()).get(FOLDER_COOKIE)?.value ?? null;
  const activeId = pickActiveView({
    requested: pick(sp.folder),
    remembered,
    folderIds: [...shared, ...personal].map((f) => f.id),
    showAll,
  });

  const views: View[] = [
    ...(showAll ? [{ kind: "all" as const, id: ALL_REPORTS_VIEW, title: "All reports", keys: [...access.visibleList] }] : []),
    ...shared.map((f) => ({ kind: "shared" as const, id: f.id, title: f.name, keys: keysOf(f), folder: f })),
    ...personal.map((f) => ({ kind: "personal" as const, id: f.id, title: f.name, keys: keysOf(f), folder: f })),
  ];
  const current = views.find((v) => v.id === activeId) ?? null;
  const navItems: FolderNavItem[] = views.map((v) => ({
    id: v.id,
    label: v.title,
    icon: v.kind === "all" ? "all" : v.folder.icon,
    count: v.keys.length,
    kind: v.kind,
  }));

  const hasNothing = !isAdmin && shared.length === 0 && access.visibleList.length === 0;
  const denied = pick(sp.denied);
  const deniedTitle = denied && isReportKey(denied) ? reportDef(denied).title : null;
  const needAdminNames = hasNothing || !!deniedTitle;
  const adminNames = needAdminNames ? await listCommercialAdminNames() : [];
  const askWho = adminNames.length > 0 ? `ask an admin (${joinNames(adminNames)})` : "ask an admin";

  // ── Cards for the open view only ──
  const keys = current?.keys ?? [];
  const wantsSnapshot = keys.includes("job-costs");
  const jobCostsP: Promise<JobCostsReport> | undefined = wantsSnapshot ? getJobCostsReport() : undefined;
  // Swallow here; the job-costs card reports its own failure by name.
  jobCostsP?.catch(() => {});
  const [{ metrics, failed }, snapshot, memberCount] = await Promise.all([
    loadCardMetrics(keys, { jobCosts: jobCostsP }),
    jobCostsP ? loadSnapshot(jobCostsP) : Promise.resolve(null),
    isAdmin && current?.kind === "shared" ? countFolderMembers(current.id) : Promise.resolve(null),
  ]);

  const personalMenuFolders = (key: ReportKey) =>
    personal.map((f) => ({ id: f.id, name: f.name, icon: f.icon, has: f.reportKeys.includes(key) }));
  const cardActions = {
    add: addReportToPersonalFolderAction,
    remove: removeReportFromPersonalFolderAction,
    move: moveReportInPersonalFolderAction,
    create: createPersonalFolderAction,
  };
  const view = activeId ?? "";

  const renderCard = (key: ReportKey, idx: number, all: ReportKey[]) => (
    <ReportCard
      key={key}
      reportKey={key}
      metrics={metrics.get(key) ?? null}
      menu={
        <ReportCardMenu
          reportKey={key}
          reportTitle={reportDef(key).title}
          view={view}
          personalFolders={personalMenuFolders(key)}
          inCurrentPersonalFolder={
            current?.kind === "personal"
              ? { folderId: current.id, isFirst: idx === 0, isLast: idx === all.length - 1 }
              : null
          }
          position={`${idx + 1} of ${all.length}`}
          actions={cardActions}
        />
      }
    />
  );

  const notice = flashMessage(sp.notice);
  const folderError = flashMessage(sp.folder_error);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      {activeId && <RememberReportFolder value={activeId} />}

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-ppp-charcoal">Reports</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-xl">
            {isAdmin
              ? "Every report, organised into folders. Team folders decide who sees what; your own folders are just for you."
              : "The reports shared with you, in folders. Open any report to drill in and export."}
          </p>
        </div>
        {isAdmin && (
          <Link
            href="/commercial/settings/report-folders"
            className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 touch-manipulation"
          >
            <FolderGlyph icon="folder" size={15} className="text-ppp-charcoal-500" />
            Manage team folders
          </Link>
        )}
      </div>

      {/* ── Banners: said out loud, never a silent empty page ── */}
      {deniedTitle && (
        <Banner tone="amber">
          You don&rsquo;t have access to <strong>{deniedTitle}</strong>. Reports are shared through folders — {askWho} to add you to one that has it.
        </Banner>
      )}
      {notice && <Banner tone="emerald">{notice}</Banner>}
      {folderError && <Banner tone="rose">{folderError}</Banner>}
      {access.lookupFailed && (
        <Banner tone="amber">
          We couldn&rsquo;t check which reports are shared with you just now, so none are shown rather than guessing. Refresh to try again.
        </Banner>
      )}
      {!list.ok && (isAdmin || !access.lookupFailed) && (
        <Banner tone="amber">
          {list.notSetUp
            ? isAdmin
              ? "Report folders aren’t switched on yet (migration 20260915190000). You still see every report under All reports; team folders appear once it’s applied."
              : "Report folders aren’t set up yet. Your admin is on it."
            : `Couldn’t load your folders just now — ${list.error}`}
        </Banner>
      )}
      {failed.length > 0 && (
        <Banner tone="amber">
          Couldn&rsquo;t load {failed.join(", ")} just now, so {failed.length === 1 ? "that card is" : "those cards are"} showing a dash rather than a number. Everything else here is current — refresh to try again.
        </Banner>
      )}

      {hasNothing && !access.lookupFailed ? (
        <div className="text-center py-14 px-5 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <span aria-hidden className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-3">
            <FolderGlyph icon="folder" size={24} />
          </span>
          <p className="text-[15px] font-bold text-ppp-charcoal">No reports shared with you yet</p>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1.5 max-w-md mx-auto leading-relaxed">
            Reports are organised into folders — Manager, Finance, Field Users — and an admin decides who&rsquo;s in each one.
            To see reports here, {askWho} to add you to a folder.
          </p>
        </div>
      ) : (
        <div className="lg:flex lg:items-start lg:gap-6 space-y-4 lg:space-y-0">
          <FolderNav
            items={navItems}
            activeId={activeId}
            sharedLabel={isAdmin ? "Team folders" : "Shared with you"}
            createAction={createPersonalFolderAction}
          />

          <div className="flex-1 min-w-0 space-y-4">
            {current ? (
              <FolderHeader
                current={current}
                isAdmin={isAdmin}
                memberCount={memberCount}
                personalIndex={current.kind === "personal" ? personal.findIndex((f) => f.id === current.id) : -1}
                personalCount={personal.length}
              />
            ) : null}

            {snapshot && <SnapshotVisuals {...snapshot} />}

            {current && current.keys.length === 0 ? (
              <EmptyFolder current={current} isAdmin={isAdmin} fallbackHref={showAll ? `/commercial/reports?folder=${ALL_REPORTS_VIEW}` : null} />
            ) : current?.kind === "all" ? (
              REPORT_GROUPS.map((g) => {
                const inGroup = current.keys.filter((k) => reportDef(k).group === g.key);
                if (inGroup.length === 0) return null;
                return (
                  <section key={g.key} className="space-y-2">
                    <div className="flex items-baseline justify-between gap-3 flex-wrap">
                      <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                        <h3 className="font-condensed text-[13px] font-bold uppercase tracking-[0.14em] text-ppp-navy-700">{g.label}</h3>
                        {g.blurb && <span className="text-[11.5px] text-ppp-charcoal-500">{g.blurb}</span>}
                      </div>
                      {/* Four of the money reports also exist as views on
                          Accounting; say which one owns the detail. */}
                      {g.key === "money" && canSeeFinance && (
                        <Link href="/commercial/accounting" className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline shrink-0 min-h-[44px] inline-flex items-center">
                          Full detail on Accounting →
                        </Link>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {inGroup.map((k, i) => renderCard(k, i, inGroup))}
                    </div>
                  </section>
                );
              })
            ) : current ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {current.keys.map((k, i) => renderCard(k, i, current.keys))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function joinNames(names: string[]): string {
  const n = names.slice(0, 3);
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} or ${n[1]}`;
  return `${n[0]}, ${n[1]} or ${n[2]}`;
}

function Banner({ tone, children }: { tone: "amber" | "emerald" | "rose"; children: React.ReactNode }) {
  const cls =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : tone === "rose"
        ? "border-rose-200 bg-rose-50 text-rose-800"
        : "border-amber-200 bg-amber-50 text-amber-900";
  return <div role={tone === "rose" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-[12.5px] leading-snug ${cls}`}>{children}</div>;
}

function FolderHeader({
  current,
  isAdmin,
  memberCount,
  personalIndex,
  personalCount,
}: {
  current: View;
  isAdmin: boolean;
  memberCount: number | null;
  personalIndex: number;
  personalCount: number;
}) {
  const count = `${current.keys.length} ${current.keys.length === 1 ? "report" : "reports"}`;
  const meta =
    current.kind === "all"
      ? isAdmin
        ? `${count} · admins see every report`
        : `${count} · everything shared with you`
      : current.kind === "shared"
        ? isAdmin
          ? `${count} · team folder${memberCount !== null ? ` · ${memberCount} ${memberCount === 1 ? "person" : "people"}` : ""}`
          : `${count} · shared with you`
        : `${count} · only you see this folder`;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3 min-w-0">
        <span aria-hidden className="hidden sm:inline-flex h-10 w-10 items-center justify-center rounded-xl bg-ppp-navy-50 text-ppp-navy-700 shrink-0">
          <FolderGlyph icon={current.kind === "all" ? "all" : current.folder.icon} size={20} />
        </span>
        <div className="min-w-0">
          <h3 className="font-condensed text-[22px] sm:text-2xl font-black text-ppp-charcoal leading-tight tracking-tight break-words">{current.title}</h3>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{meta}</p>
          {current.kind !== "all" && current.folder.description && (
            <p className="text-[12.5px] text-ppp-charcoal-600 mt-1 max-w-xl">{current.folder.description}</p>
          )}
        </div>
      </div>
      {current.kind === "shared" && isAdmin && (
        <Link
          href={`/commercial/settings/report-folders?folder=${current.id}`}
          className="shrink-0 inline-flex items-center px-3 min-h-[44px] rounded-lg text-[13px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50/60 touch-manipulation"
        >
          Manage
        </Link>
      )}
      {current.kind === "personal" && (
        <div className="shrink-0">
          <PersonalFolderMenu
            folder={{ id: current.id, name: current.title }}
            view={current.id}
            isFirst={personalIndex <= 0}
            isLast={personalIndex === personalCount - 1}
            actions={{ rename: renamePersonalFolderAction, move: movePersonalFolderAction, remove: deletePersonalFolderAction }}
          />
        </div>
      )}
    </div>
  );
}

function EmptyFolder({ current, isAdmin, fallbackHref }: { current: View; isAdmin: boolean; fallbackHref: string | null }) {
  const [title, body] =
    current.kind === "personal"
      ? ["Nothing in this folder yet", "Open the ⋯ on any report card and tick this folder to add it here."]
      : current.kind === "shared"
        ? isAdmin
          ? ["No reports in this folder yet", "Choose which reports belong here — everyone in the folder will see them."]
          : ["Nothing here you can open yet", "An admin can add reports to this folder."]
        : ["No reports yet", "Nothing is shared with you right now."];
  return (
    <div className="text-center py-12 px-5 bg-surface border border-dashed border-ppp-charcoal-200 rounded-xl">
      <p className="text-[14px] font-semibold text-ppp-charcoal">{title}</p>
      <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">{body}</p>
      <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
        {current.kind === "shared" && isAdmin && (
          <Link href={`/commercial/settings/report-folders?folder=${current.id}`} className="inline-flex items-center px-3.5 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700">
            Choose reports
          </Link>
        )}
        {current.kind === "personal" && fallbackHref && (
          <Link href={fallbackHref} className="inline-flex items-center px-3.5 min-h-[44px] rounded-lg border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50">
            Browse all reports
          </Link>
        )}
      </div>
    </div>
  );
}

/** One report card. The whole card opens the report (a stretched link); the ⋯
 *  sits above that link so it's its own control — never a button inside an
 *  anchor, which is invalid and swallows taps on iOS. */
function ReportCard({ reportKey, metrics, menu }: { reportKey: ReportKey; metrics: CardMetrics | null; menu: React.ReactNode }) {
  const d = reportDef(reportKey);
  return (
    <div className="group relative bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 hover:border-cc-brand-300 hover:shadow-sm transition-colors flex flex-col focus-within:border-cc-brand-400">
      <div className="flex items-start gap-3 pr-9">
        <span aria-hidden className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-50 text-cc-brand-700 shrink-0">
          <PathIcon paths={d.icon} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[14px] font-bold text-ppp-charcoal">
              <Link href={d.href} className="after:absolute after:inset-0 after:rounded-xl after:content-[''] focus:outline-none focus-visible:underline">
                {d.title}
              </Link>
            </h3>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-300 group-hover:text-cc-brand-600 group-hover:translate-x-0.5 transition-all shrink-0"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </div>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5 leading-snug">{d.blurb}</p>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-ppp-charcoal-50 grid grid-cols-2 gap-3">
        {metrics ? (
          <>
            <Metric label={metrics.primary.label} value={metrics.primary.value} tone={metrics.primary.tone} />
            <Metric label={metrics.secondary.label} value={metrics.secondary.value} tone={metrics.secondary.tone ?? "neutral"} />
          </>
        ) : (
          <>
            <Metric label="Couldn't load" value="—" tone="neutral" />
            <Metric label="Open to see it" value="—" tone="neutral" />
          </>
        )}
      </div>
      <div className="absolute top-1.5 right-1.5 z-10">{menu}</div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: MetricTone }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 truncate">{label}</div>
      <div className={`font-condensed text-[20px] font-black tabular-nums leading-tight mt-0.5 truncate ${toneText[tone]}`}>{value}</div>
    </div>
  );
}

type Snapshot = {
  billingTrend: { label: string; value: number }[];
  trendTotalCents: number;
  costSegments: DonutSegment[];
  totalCostCents: number;
};

/** Company billing trend + cost mix. Shown with the job-costs card, because
 *  both are cut from the same job-cost data. Failure hides the row; the
 *  job-costs card already names the failure. */
async function loadSnapshot(jobCostsP: Promise<JobCostsReport>): Promise<Snapshot | null> {
  try {
    const jobCosts = await jobCostsP;
    const allOppIds = new Set(jobCosts.groups.flatMap((g) => g.deals.map((d) => d.oppId)));
    const invoices = await listCommercialInvoices({});
    const billingTrend = monthlyBilledSeries(invoices, { months: 6, oppIds: allOppIds, nowIso: new Date().toISOString() });
    // monthlyBilledSeries returns $K (cents / 100_000) for TrendChart's axis.
    const trendTotalCents = Math.round(billingTrend.reduce((n, p) => n + p.value, 0) * 100_000);
    const costSegments: DonutSegment[] = COST_BUCKET_COLUMNS
      .filter((c) => jobCosts.totals.buckets[c.key] > 0)
      .map((c) => ({ label: c.label, value: jobCosts.totals.buckets[c.key], tone: BUCKET_TONE[c.key], valueLabel: formatCentsCompact(jobCosts.totals.buckets[c.key]) }));
    return { billingTrend, trendTotalCents, costSegments, totalCostCents: jobCosts.totals.totalCostCents };
  } catch (err) {
    console.error("[reports] snapshot failed:", err);
    return null;
  }
}

function SnapshotVisuals({ billingTrend, trendTotalCents, costSegments, totalCostCents }: Snapshot) {
  const hasTrend = billingTrend.some((p) => p.value > 0);
  const hasMix = costSegments.length > 0;
  if (!hasTrend && !hasMix) return null;
  // Span the row when the other card is absent — a two-thirds trend with an
  // empty third reads as a broken layout (Karan, 2026-08-19).
  const trendSpan = hasMix ? "lg:col-span-2" : "lg:col-span-3";
  const mixSpan = hasTrend ? "lg:col-span-1" : "lg:col-span-3";
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {hasTrend && (
        <div className={`${trendSpan} bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 min-w-0`}>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <div className="flex items-baseline gap-2 min-w-0">
              <h3 className="text-[13px] font-bold text-ppp-charcoal">Revenue billed / month</h3>
              <span className="font-condensed text-[15px] font-black tabular-nums text-cc-brand-700">{formatCentsCompact(trendTotalCents)}</span>
            </div>
            <span className="text-[11px] text-ppp-charcoal-400 shrink-0">last 6 months</span>
          </div>
          <TrendChart data={billingTrend} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[150px]" />
        </div>
      )}
      {hasMix && (
        <div className={`${mixSpan} bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 min-w-0`}>
          <h3 className="text-[13px] font-bold text-ppp-charcoal mb-2">Cost mix</h3>
          <DonutChart size={132} segments={costSegments} centerValue={formatCentsCompact(totalCostCents)} centerLabel="total cost" legend={false} />
        </div>
      )}
    </div>
  );
}
