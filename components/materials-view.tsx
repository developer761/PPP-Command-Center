"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import PageHeader from "@/components/page-header";
import SupplierPickerModal from "@/components/supplier-picker-modal";
import { useEscClose } from "@/lib/hooks/use-esc-close";
import { fmtMoneyK } from "@/lib/format";
import {
  deriveOpenMaterialsWorkOrders,
  getSupplierName,
  type OpenWorkOrderForMaterials,
  type ResolvedWoli,
} from "@/lib/salesforce/materials";
import type { LiveDashboardBundle } from "@/lib/data-source";
import type { SnapshotAccount, SnapshotPaintColor } from "@/lib/salesforce/queries";
import {
  estimateOrderGallons,
  summarizeOrder,
  formatBucketsCans,
  classifySurface,
  COVERAGE_CONFIG,
  type CoverageConfig,
  type RoomTakeoff,
  type RoomSurface,
} from "@/lib/supplier-order/estimate-gallons";
import type { FormStatus } from "@/lib/customer-form/wo-status";
import WorkOrderProgressBar, { type WoProgress } from "@/components/work-order-progress-bar";
import SupplierOrderModal from "@/components/supplier-order-modal";
import WoPastOrders from "@/components/wo-past-orders";

type Props = {
  bundle: LiveDashboardBundle;
  /** Customer-form lifecycle state per WO (from getFormStatusByWO).
   *  Used to render the per-WO status badge on the left rail + summary chip
   *  on the page header. Passed as an array (Map doesn't serialize over the
   *  server→client boundary in Next). */
  formStatuses?: FormStatus[];
  /** 8-stage progress timeline per WO. Same array-not-Map reason. */
  woProgress?: WoProgress[];
  /** Deep-link target — when set, this WO is pre-selected on load (links from
   *  Customer History, the mail timeline, the activity feed, search). */
  initialWoId?: string | null;
  /** Tuned coverage config (Settings → Coverage) so the WO-card paint estimate
   *  matches the order modal/email. Defaults to the code constants. */
  coverageConfig?: CoverageConfig;
};

export default function MaterialsView({ bundle, formStatuses = [], woProgress = [], initialWoId = null, coverageConfig = COVERAGE_CONFIG }: Props) {
  const { snapshot, viewer } = bundle;

  // Index form statuses by WO id for constant-time lookup in the render loop.
  const formStatusByWO = useMemo(() => {
    const m = new Map<string, FormStatus>();
    for (const s of formStatuses) m.set(s.woId, s);
    return m;
  }, [formStatuses]);

  // Same indexing for the progress timeline.
  const progressByWO = useMemo(() => {
    const m = new Map<string, WoProgress>();
    for (const p of woProgress) m.set(p.workOrderId, p);
    return m;
  }, [woProgress]);

  // Account lookup by NAME (WO carries accountName, not accountId). Used to
  // pre-fill customer email + delivery address in the Send Form modal +
  // Supplier Order modal. Built once per render of the parent.
  const accountByName = useMemo(() => {
    const m = new Map<string, SnapshotAccount>();
    if (snapshot?.accounts) {
      for (const a of snapshot.accounts) m.set(a.name, a);
    }
    return m;
  }, [snapshot]);

  // Modal open state — only one supplier order modal at a time.
  const [orderModal, setOrderModal] = useState<{
    workOrderId: string;
    workOrderNumber: string | null;
    supplierAccountId: string;
    supplierName: string;
    customerName: string | null;
    /** Worker chose this supplier via the manual picker (not auto-detected). */
    manual?: boolean;
  } | null>(null);

  // Counter bumped when the modal closes after a successful send — children
  // (past-orders strip) re-fetch when this changes so the new row shows up
  // without a manual page refresh.
  const [pastOrdersRefreshKey, setPastOrdersRefreshKey] = useState(0);

  // Roll-up for the page header chip — at a glance, how many forms are out?
  const formSummary = useMemo(() => {
    const summary = { sent: 0, opened: 0, submitted: 0, expired: 0 };
    for (const s of formStatuses) {
      if (s.status === "sent") summary.sent += 1;
      else if (s.status === "opened") summary.opened += 1;
      else if (s.status === "submitted") summary.submitted += 1;
      else if (s.status === "expired") summary.expired += 1;
    }
    return summary;
  }, [formStatuses]);
  const repScopedToSelf = viewer?.scope === "my" && !!viewer.effectiveUserId;

  const openJobs = useMemo<OpenWorkOrderForMaterials[]>(
    () => (snapshot ? deriveOpenMaterialsWorkOrders(snapshot) : []),
    [snapshot]
  );

  // Karan ask: search for work orders by customer name / WO# / status so
  // admins (who see hundreds of WOs) can find a specific one fast.
  // Workers usually have <20 WOs so search is less critical for them but
  // the field stays visible for both — same UX everyone.
  const [searchQuery, setSearchQuery] = useState("");
  const visibleJobs = useMemo<OpenWorkOrderForMaterials[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return openJobs;
    return openJobs.filter((j) => {
      // Match against the fields a worker/admin would actually type:
      // customer name, WO number, status string, line-item area labels
      // (so "kitchen" finds WOs with a kitchen room).
      const woNumber = (j.wo.workOrderNumber ?? "").toLowerCase();
      const accountName = (j.wo.accountName ?? "").toLowerCase();
      const status = (j.wo.status ?? "").toLowerCase();
      if (woNumber.includes(q) || accountName.includes(q) || status.includes(q)) return true;
      for (const li of j.lineItems) {
        if ((li.raw.areaLabel ?? "").toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [openJobs, searchQuery]);

  // Seed from the ?wo= deep-link when that WO is actually an open materials
  // job; otherwise start unselected (the WO may be closed / out of scope, in
  // which case showing the list is the right fallback rather than a dead select).
  const [activeWoId, setActiveWoId] = useState<string | null>(
    () => (initialWoId && openJobs.some((j) => j.wo.id === initialWoId) ? initialWoId : null)
  );
  const activeJob = useMemo(
    () => openJobs.find((j) => j.wo.id === activeWoId) ?? null,
    [openJobs, activeWoId]
  );

  // Aggregate stats across all open jobs for the top strip
  const stats = useMemo(() => {
    let totalSqFt = 0;
    const allColors = new Set<string>();
    const allSuppliers = new Set<string>();
    for (const j of openJobs) {
      totalSqFt += j.totalSqFt;
      for (const li of j.lineItems) {
        for (const slot of [li.wall, li.ceiling, li.trim, li.other, li.floor]) {
          if (!slot) continue;
          allColors.add(slot.id);
          if (slot.manufacturerId) allSuppliers.add(slot.manufacturerId);
        }
      }
    }
    return {
      openWoCount: openJobs.length,
      totalSqFt,
      distinctColors: allColors.size,
      distinctSuppliers: allSuppliers.size,
    };
  }, [openJobs]);

  // Actionable "what needs doing" rollup across open WOs (Alex/ops view).
  const needsAttention = useMemo(() => {
    const now = Date.now();
    const sevenDays = 7 * 86_400_000;
    let needsForm = 0, awaitingCustomer = 0, readyToOrder = 0, orderedThisWeek = 0, jobSoonNotOrdered = 0;
    for (const j of openJobs) {
      const prog = progressByWO.get(j.wo.id);
      const sentForm = !!prog?.formSentAt;
      const submitted = !!prog?.formSubmittedAt;
      const ordered = !!prog?.supplierSentAt;
      if (!sentForm) needsForm += 1;
      else if (!submitted) awaitingCustomer += 1;
      if (submitted && !ordered) readyToOrder += 1;
      if (ordered && prog?.supplierSentAt) {
        const t = new Date(prog.supplierSentAt).getTime();
        if (!Number.isNaN(t) && now - t <= sevenDays) orderedThisWeek += 1;
      }
      if (!ordered && j.wo.closeDate) {
        const t = new Date(j.wo.closeDate + "T00:00:00Z").getTime();
        if (!Number.isNaN(t) && t <= now + sevenDays) jobSoonNotOrdered += 1;
      }
    }
    return { needsForm, awaitingCustomer, readyToOrder, orderedThisWeek, jobSoonNotOrdered };
  }, [openJobs, progressByWO]);

  // Admin diagnostic: surface the underlying snapshot counts so we can debug
  // "why is it showing zero?" without crawling Vercel logs.
  const debug = useMemo(() => {
    if (!snapshot) return null;
    const woIds = new Set(snapshot.workOrders.map((w) => w.id));
    let openWoCount = 0;
    let materialsRelevantWoCount = 0;
    const skippedWorkTypes = new Map<string, number>();
    for (const w of snapshot.workOrders) {
      const s = (w.status ?? "").toLowerCase();
      const isOpen =
        !s.includes("paid in full") &&
        !s.includes("complete") &&
        !s.includes("cancel") &&
        !s.includes("closed");
      if (!isOpen) continue;
      openWoCount++;
      const wt = (w.workTypeName ?? "").toLowerCase();
      const isPreQuote =
        wt.includes("estimate") ||
        wt.includes("appointment") ||
        wt.includes("inspection") ||
        wt.includes("consultation");
      if (isPreQuote) {
        const key = w.workTypeName ?? "(no work type)";
        skippedWorkTypes.set(key, (skippedWorkTypes.get(key) ?? 0) + 1);
      } else {
        materialsRelevantWoCount++;
      }
    }
    const woliWithMatchingWo = snapshot.woLineItems.filter((l) => woIds.has(l.workOrderId)).length;
    return {
      woCount: snapshot.workOrders.length,
      openWoCount,
      materialsRelevantWoCount,
      skippedWorkTypes,
      woliCount: snapshot.woLineItems.length,
      woliMatchedToWo: woliWithMatchingWo,
      paintColorCount: snapshot.paintColors.length,
    };
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div className="animate-fade-up space-y-6">
        <PageHeader
          title="Materials Ordering"
          subtitle="Aggregate paint across upcoming work orders, group by supplier, generate orders"
        />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center text-sm text-ppp-charcoal-500">
          Salesforce isn&apos;t connected — materials ordering needs live data.
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-6 sm:space-y-8">
      <PageHeader
        title={repScopedToSelf ? "Your Materials Ordering" : "Materials Ordering"}
        subtitle={
          repScopedToSelf
            ? "Paint colors and quantities needed across your open work orders"
            : "Paint colors and quantities needed across open work orders, grouped by supplier"
        }
      />

      {/* Top stat strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="Open WOs" value={stats.openWoCount.toLocaleString()} accent="blue" />
        <StatCard
          label="Sq ft to paint"
          value={
            stats.totalSqFt >= 1000
              ? `${(stats.totalSqFt / 1000).toFixed(1)}K`
              : stats.totalSqFt.toLocaleString()
          }
          accent="navy"
        />
        <StatCard label="Distinct colors" value={stats.distinctColors.toLocaleString()} accent="orange" />
        <StatCard label="Suppliers" value={stats.distinctSuppliers.toLocaleString()} accent="green" />
      </section>

      {/* Needs-attention rollup — at-a-glance "what to do next" across all open
          WOs. Only renders chips with a count; urgent (job soon, not ordered)
          is highlighted. Hidden entirely when everything's handled. */}
      {(() => {
        const n = needsAttention;
        const anything = n.needsForm || n.awaitingCustomer || n.readyToOrder || n.jobSoonNotOrdered || n.orderedThisWeek;
        if (!anything) return null;
        const chip = (cond: boolean, label: string, value: number, tone: "blue" | "orange" | "green" | "charcoal") => {
          if (!cond) return null;
          const cls = {
            blue: "bg-ppp-blue-50 border-ppp-blue-100 text-ppp-blue-700",
            orange: "bg-ppp-orange-50 border-ppp-orange-100 text-ppp-orange-700",
            green: "bg-ppp-green-50 border-ppp-green-100 text-ppp-green-700",
            charcoal: "bg-ppp-charcoal-50 border-ppp-charcoal-100 text-ppp-charcoal-500",
          }[tone];
          return (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${cls}`}>
              <strong className="font-bold">{value}</strong> {label}
            </span>
          );
        };
        return (
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 sm:px-5 py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mr-1">Needs attention</span>
              {chip(n.jobSoonNotOrdered > 0, "job(s) start soon — not ordered", n.jobSoonNotOrdered, "orange")}
              {chip(n.needsForm > 0, "need a color form", n.needsForm, "blue")}
              {chip(n.awaitingCustomer > 0, "awaiting customer", n.awaitingCustomer, "charcoal")}
              {chip(n.readyToOrder > 0, "ready to order", n.readyToOrder, "green")}
              {chip(n.orderedThisWeek > 0, "ordered this week", n.orderedThisWeek, "charcoal")}
            </div>
          </section>
        );
      })()}

      {/* Customer-form pipeline summary — only when any form has been sent.
          Otherwise the row is hidden (avoids a "0 / 0 / 0 / 0" strip that
          adds clutter on day 0 of the rollout). */}
      {(formSummary.sent + formSummary.opened + formSummary.submitted + formSummary.expired) > 0 && (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 sm:px-5 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="font-condensed text-[11px] uppercase tracking-wider font-bold text-ppp-charcoal-500">
                Customer color forms
              </span>
              <span className="text-[11px] text-ppp-charcoal-500">
                in flight across these jobs
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold">
              {formSummary.submitted > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded border bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100">
                  ✓ {formSummary.submitted} submitted
                </span>
              )}
              {formSummary.opened > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded border bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100">
                  👁 {formSummary.opened} opened
                </span>
              )}
              {formSummary.sent > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded border bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100">
                  📨 {formSummary.sent} sent
                </span>
              )}
              {formSummary.expired > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded border bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100">
                  ⏳ {formSummary.expired} expired
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Admin-only diagnostic — always visible (not collapsed) so the numbers
          are right there. Hidden from non-admins entirely. */}
      {viewer?.isAdmin && debug && (
        <div className="bg-ppp-charcoal-50/40 border border-ppp-charcoal-100 rounded-lg px-4 py-3 text-[11px] text-ppp-charcoal-600">
          <div className="font-condensed font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-2">
            Snapshot diagnostic (admin only)
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            <DebugStat label="WOs in snapshot" value={debug.woCount} />
            <DebugStat label="Open WOs (status)" value={debug.openWoCount} />
            <DebugStat label="Open WOs (paint jobs)" value={debug.materialsRelevantWoCount} />
            <DebugStat label="WOLI rows" value={debug.woliCount} />
            <DebugStat label="WOLI matched to WO" value={debug.woliMatchedToWo} />
            <DebugStat label="Paint colors" value={debug.paintColorCount} />
          </div>
          {debug.skippedWorkTypes.size > 0 && (
            <div className="mt-2 text-ppp-charcoal-500">
              Skipped pre-quote work types:{" "}
              {Array.from(debug.skippedWorkTypes.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([name, count]) => `${name} (${count.toLocaleString()})`)
                .join(" · ")}
            </div>
          )}
          <div className="mt-2 text-ppp-charcoal-500 leading-relaxed">
            If WOs &gt; 0 but WOLI rows == 0, the WorkOrderLineItem SOQL is failing
            (check Vercel logs for &quot;[SF] WorkOrderLineItem query failed&quot;).
            If WOLI rows &gt; 0 but matched-to-WO == 0, the parent WOs are outside
            the 365-day window. If both &gt; 0 but Open WOs == 0, every WO is
            already Paid in Full / Complete / Cancelled. &quot;Paint jobs&quot;
            excludes pre-quote work types (Estimate, Appointment, etc.).
          </div>
        </div>
      )}

      {/* Empty state — only when there are truly zero open paint-job WOs. */}
      {openJobs.length === 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-ppp-blue-50 text-ppp-blue flex items-center justify-center text-2xl mb-3">
            🎨
          </div>
          <h3 className="text-base font-semibold text-ppp-navy">No open paint jobs in the snapshot</h3>
          <p className="text-sm text-ppp-charcoal-500 mt-2 max-w-md mx-auto">
            {repScopedToSelf
              ? "You don't have any open work orders right now. Once new jobs are scheduled, they'll appear here for materials ordering."
              : "No open paint jobs in the snapshot. Pre-quote stages (Estimate, Appointment) are filtered out — only billable jobs surface here."}
          </p>
        </div>
      )}

      {/* Informational banner when WOs exist but none have line items yet —
          PPP's process is to enter rooms/colors in SF later in the job
          lifecycle, so the materials page needs a context cue, not an
          empty state. */}
      {openJobs.length > 0 && stats.distinctColors === 0 && (
        <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 flex items-start gap-3 text-[13px]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-orange-700 mt-0.5 shrink-0" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4 M12 8h.01" />
          </svg>
          <div className="flex-1 min-w-0 text-ppp-charcoal-700">
            <div className="font-semibold text-ppp-charcoal">
              {openJobs.length} paint job{openJobs.length === 1 ? "" : "s"} waiting on line items
            </div>
            <div className="mt-0.5 text-ppp-charcoal-500">
              These work orders are scheduled but don&apos;t have rooms / colors
              entered in Salesforce yet. Materials ordering will surface
              automatically once line items are added. Click any WO below to
              see its details.
            </div>
          </div>
        </div>
      )}

      {/* Job list + side panel */}
      {openJobs.length > 0 && (
        <section className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5">
          <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] space-y-2.5">
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ppp-charcoal">Open work orders</h3>
                  <span className="text-[10px] text-ppp-charcoal-500 font-mono">
                    {visibleJobs.length}{searchQuery ? `/${openJobs.length}` : ""}
                  </span>
                </div>
                <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">Soonest jobs first</p>
              </div>
              {/* Search — instant client-side filter. Admins see hundreds
                  of WOs so this is critical for "find Mrs. Smith fast".
                  Matches customer name, WO #, status, or room labels. */}
              <div className="relative">
                <input
                  type="search"
                  inputMode="search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search customer, WO#, room…"
                  // text-base on mobile prevents iOS Safari auto-zoom-on-focus
                  // (anything <16px triggers zoom + layout shift on touch).
                  className="w-full pl-8 pr-3 py-2 sm:py-1.5 text-base sm:text-xs border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                />
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ppp-charcoal-500 pointer-events-none"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    // 32px hit target on mobile so finger taps actually land —
                    // the bare ✕ glyph was too small to hit on phones.
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center text-ppp-charcoal-500 hover:text-ppp-charcoal text-sm"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
            <ul className="max-h-[640px] overflow-y-auto">
              {visibleJobs.length === 0 && searchQuery && (
                <li className="px-5 py-6 text-center text-xs text-ppp-charcoal-500 italic">
                  No matches for &ldquo;{searchQuery}&rdquo;.
                </li>
              )}
              {visibleJobs.map((j) => {
                const active = activeWoId === j.wo.id;
                const formStatus = formStatusByWO.get(j.wo.id);
                return (
                  <li key={j.wo.id}>
                    <button
                      type="button"
                      onClick={() => setActiveWoId(j.wo.id)}
                      className={[
                        "w-full text-left px-5 py-3.5 transition-colors",
                        active
                          ? "bg-ppp-blue-50/60 border-l-2 border-l-ppp-blue"
                          : "hover:bg-ppp-charcoal-50/60 border-l-2 border-l-transparent",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-ppp-charcoal text-sm truncate">
                              {j.wo.accountName ?? "(unknown account)"}
                            </div>
                            <FormStatusBadge status={formStatus} />
                          </div>
                          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-2 truncate">
                            <span className="font-mono">{j.wo.workOrderNumber ?? j.wo.id.slice(-6)}</span>
                            <span>·</span>
                            <span>{j.wo.status ?? "Open"}</span>
                            {j.wo.closeDate && (
                              <>
                                <span>·</span>
                                <span>{j.wo.closeDate}</span>
                              </>
                            )}
                          </div>
                          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ppp-charcoal-500">
                            {j.lineItems.length === 0 ? (
                              <Pill tone="orange">No rooms entered</Pill>
                            ) : (
                              <Pill>{j.lineItems.length} room{j.lineItems.length === 1 ? "" : "s"}</Pill>
                            )}
                            {j.distinctColorCount > 0 && (
                              <Pill>
                                {j.distinctColorCount} color{j.distinctColorCount === 1 ? "" : "s"}
                              </Pill>
                            )}
                            {j.totalSqFt > 0 && <Pill>{j.totalSqFt.toLocaleString()} sq ft</Pill>}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Side panel */}
          <div className="lg:col-span-3">
            {activeJob ? (
              <div className="space-y-4">
                {/* Progress bar — sticky at the top so it's visible while
                    scrolling the long line-item list below. */}
                {progressByWO.get(activeJob.wo.id) && (
                  <WorkOrderProgressBar progress={progressByWO.get(activeJob.wo.id)!} />
                )}
                {/* Past supplier orders for this WO — renders nothing when
                    none. Self-refreshes when pastOrdersRefreshKey bumps
                    (after a fresh send via the modal). Includes inline
                    Mark Acknowledged / Mark Delivered / Cancel buttons. */}
                <WoPastOrders workOrderId={activeJob.wo.id} refreshKey={pastOrdersRefreshKey} />
                <JobDetail
                  snapshot={snapshot}
                  job={activeJob}
                  coverageConfig={coverageConfig}
                  onOpenOrderModal={(supplierAccountId, supplierName, manual) =>
                    setOrderModal({
                      workOrderId: activeJob.wo.id,
                      workOrderNumber: activeJob.wo.workOrderNumber,
                      supplierAccountId,
                      supplierName,
                      customerName: activeJob.wo.accountName ?? null,
                      manual: manual ?? false,
                    })
                  }
                />
              </div>
            ) : (
              <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center text-sm text-ppp-charcoal-500">
                Pick a work order to see paint colors per room and the supplier breakdown.
              </div>
            )}
          </div>
        </section>
      )}

      {/* Top-level Supplier Order Modal — only one open at a time. Closing
          triggers a past-orders refresh so a freshly-sent order shows in
          the strip without requiring a manual reload. */}
      {orderModal && (
        <SupplierOrderModal
          workOrderId={orderModal.workOrderId}
          workOrderNumber={orderModal.workOrderNumber}
          supplierAccountId={orderModal.supplierAccountId}
          supplierName={orderModal.supplierName}
          customerName={orderModal.customerName}
          manualSupplier={orderModal.manual ?? false}
          onClose={() => {
            // Close + refresh the past-orders strip so a freshly-sent order
            // shows without a manual reload. Idempotent, so a double-fire
            // (Esc + backdrop) is harmless.
            setOrderModal(null);
            setPastOrdersRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function JobDetail({
  snapshot,
  job,
  coverageConfig,
  onOpenOrderModal,
}: {
  snapshot: NonNullable<LiveDashboardBundle["snapshot"]>;
  job: OpenWorkOrderForMaterials;
  coverageConfig: CoverageConfig;
  /** Opens the Supplier Order Modal with a supplier pre-selected. `manual` is
   *  true when chosen via the store picker (vs auto-detected), so the builder
   *  includes all the WO's colors on that store's order. */
  onOpenOrderModal: (supplierAccountId: string, supplierName: string, manual?: boolean) => void;
}) {
  const [showDraft, setShowDraft] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  // Pre-fill data for the Send Color Form modal — pull the customer Account
  // from the snapshot via accountName. Empty when not in snapshot (vendor
  // WO or stale account) — admin types manually.
  const customerAccount = useMemo(() => {
    // Account.Id match first (reliable), then name as a fallback for legacy WOs.
    return (job.wo.accountId ? snapshot.accounts.find((a) => a.id === job.wo.accountId) : null)
      ?? (job.wo.accountName ? snapshot.accounts.find((a) => a.name === job.wo.accountName) : null)
      ?? null;
  }, [job, snapshot]);

  const supplierRows = useMemo(() => {
    return Array.from(job.bySupplier.entries())
      .map(([mfgId, count]) => ({
        manufacturerId: mfgId,
        name: getSupplierName(snapshot, mfgId === "unknown" ? null : mfgId),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [job, snapshot]);

  // At-a-glance paint estimate for the whole WO (all colors, no supplier
  // filter) — so the worker sees the job size before opening the order modal.
  const paintEstimate = useMemo(() => {
    const rooms: RoomTakeoff[] = [];
    for (const li of job.lineItems) {
      const surfaces: RoomSurface[] = [];
      const slots = [
        { label: "Walls", color: li.wall, finish: li.raw.finishWall },
        { label: "Ceiling", color: li.ceiling, finish: li.raw.finishCeiling },
        { label: "Trim", color: li.trim, finish: li.raw.finishTrim },
        { label: "Floor", color: li.floor, finish: li.raw.finishFloor },
        { label: "Other", color: li.other, finish: li.raw.finishOther },
      ];
      for (const s of slots) {
        if (!s.color) continue;
        surfaces.push({
          kind: classifySurface(s.label),
          surfaceLabel: s.label,
          colorId: s.color.id,
          colorName: s.color.name,
          colorCode: s.color.code,
          finish: s.finish,
        });
      }
      if (surfaces.length > 0) {
        rooms.push({
          woliId: li.raw.id,
          roomLabel: li.raw.areaLabel ?? "Area",
          floorAreaSqft: li.raw.sqFootage,
          wallSurfaceAreaSqft: li.raw.wallSurfaceArea,
          perimeterLf: li.raw.perimeter,
          heightFt: li.raw.heightFt,
          doors: li.raw.numDoors,
          windows: li.raw.numWindows,
          closets: li.raw.numClosets,
          coats: li.raw.numCoats,
          // Katie's rule: an explicit door count on the WOLI means those
          // room-facing door faces are in scope. Mirrors builder.ts:435 so
          // the WO-card chip can't disagree with the email.
          paintDoorFaces: li.raw.numDoors > 0,
          surfaces,
        });
      }
    }
    return summarizeOrder(estimateOrderGallons(rooms, coverageConfig));
  }, [job, coverageConfig]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500">
              Work Order
            </div>
            {/* Clickable customer name → per-customer history page. Only
                renders as a link when we have the SF Account.Id (post-Tier-1
                refactor); falls back to plain text for legacy WOs without
                accountId. Hover affordance signals it's interactive. */}
            {job.wo.accountId ? (
              <Link
                href={`/dashboard/customer/${encodeURIComponent(job.wo.accountId)}`}
                className="block text-lg font-bold text-ppp-navy hover:text-ppp-blue transition-colors group"
                title="View full customer history"
              >
                {job.wo.accountName ?? "(unknown account)"}
                <span className="ml-1.5 text-xs text-ppp-charcoal-500 group-hover:text-ppp-blue opacity-60 group-hover:opacity-100 transition-opacity">→</span>
              </Link>
            ) : (
              <h3 className="text-lg font-bold text-ppp-navy">{job.wo.accountName ?? "(unknown account)"}</h3>
            )}
            <div className="text-xs text-ppp-charcoal-500 mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="font-mono">{job.wo.workOrderNumber ?? job.wo.id.slice(-6)}</span>
              <span>·</span>
              <span>{job.wo.status ?? "Open"}</span>
              {job.wo.closeDate && (
                <>
                  <span>·</span>
                  <span>Close {job.wo.closeDate}</span>
                </>
              )}
              {job.wo.ownerName && (
                <>
                  <span>·</span>
                  <span>{job.wo.ownerName}</span>
                </>
              )}
            </div>
          </div>
          {job.wo.amount > 0 && (
            <div className="text-right shrink-0">
              <div className="font-condensed text-2xl font-bold text-ppp-navy">{fmtMoneyK(job.wo.amount / 1000)}</div>
              <div className="text-[11px] text-ppp-charcoal-500">Quoted value</div>
            </div>
          )}
        </div>

        {/* Supplier breakdown row */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {supplierRows.map((s) => (
            <div
              key={s.manufacturerId}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ppp-blue-50 border border-ppp-blue-100 text-[11px] font-medium text-ppp-blue-700"
            >
              <span className="font-semibold">{s.name}</span>
              <span className="text-ppp-charcoal-500">· {s.count} color{s.count === 1 ? "" : "s"}</span>
            </div>
          ))}
          {/* At-a-glance paint estimate (whole WO, all brands) — job size before
              opening the order. "est." since it's the spec calculator's number. */}
          {(paintEstimate.buckets > 0 || paintEstimate.cans > 0) && (
            <div
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ppp-green-50 border border-ppp-green-100 text-[11px] font-medium text-ppp-green-700"
              title="System estimate of total paint for this work order — review in the order modal before sending"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10" />
              </svg>
              <span className="font-semibold">~{formatBucketsCans(paintEstimate.buckets, paintEstimate.cans)}</span>
              <span className="text-ppp-charcoal-500">est.{paintEstimate.reviewColors > 0 ? ` · ${paintEstimate.reviewColors} to confirm` : ""}</span>
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <SendColorFormButton
            workOrderId={job.wo.id}
            accountName={job.wo.accountName ?? null}
            defaultEmail={customerAccount?.email ?? null}
          />
          {/* Order materials = pick a STORE (Katie's model: PPP buys paint of
              any brand from stores like Aboffs/Willis, not from the manufacturer).
              The picker lists PPP's configured vendors; the chosen store's order
              includes the whole WO's colors. The manufacturer breakdown above is
              informational only (it's what the email describes as "what to buy"). */}
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors shadow-sm shadow-ppp-blue/30"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 3h18v18H3z M3 9h18 M9 21V9" />
            </svg>
            Order materials
          </button>
          {/* Preview colors — review the per-room color breakdown before ordering. */}
          <button
            type="button"
            onClick={() => setShowDraft(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal text-sm font-medium hover:bg-ppp-charcoal-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
            </svg>
            Preview colors
          </button>
          {/* Mail history for this WO — deep-link into the Mail Hub
              pre-filtered to messages tied to this work order. Faster than
              hunting through the full inbox/sent feeds when admin wants
              "what's been sent to this customer + replies". */}
          <Link
            href={`/dashboard/inbox?wo=${encodeURIComponent(job.wo.id)}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal text-sm font-medium hover:bg-ppp-charcoal-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 4h16v16H4z M22 6l-10 7L2 6" />
            </svg>
            Mail history
          </Link>
          {/* General Supplies — extras-only order (rollers, brushes, tape,
              drop cloths) sent to PPP's warehouse/Home Depot email, NOT a
              paint vendor. Same modal flow as paint orders so the worker
              flow stays consistent. */}
          <button
            type="button"
            onClick={() => onOpenOrderModal("__general__", "General Supplies")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal text-sm font-medium hover:bg-ppp-charcoal-50 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="7" width="18" height="14" rx="2" />
              <path d="M8 7V5a4 4 0 0 1 8 0v2" />
            </svg>
            General Supplies
          </button>
        </div>
      </div>

      {showPicker && (
        <SupplierPickerModal
          onClose={() => setShowPicker(false)}
          // manual=true: this supplier was hand-picked (not auto-detected from
          // the colors' manufacturer), so the builder must attribute the WO's
          // unattributed colors to it instead of sending an empty order.
          onPick={(s) => onOpenOrderModal(s.accountId, s.name, true)}
          excludeIds={supplierRows
            .map((r) => r.manufacturerId)
            .filter((id) => id && id !== "unknown") as string[]}
        />
      )}

      {/* Line items per room */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
          <h4 className="text-sm font-semibold text-ppp-charcoal">Rooms &amp; colors</h4>
          <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
            {job.lineItems.length} line item{job.lineItems.length === 1 ? "" : "s"} on this WO
          </p>
        </div>
        <ul className="divide-y divide-ppp-charcoal-100">
          {job.lineItems.map((li) => (
            <LineItemRow key={li.raw.id} item={li} />
          ))}
        </ul>
      </div>

      {/* Color preview modal — read-only review, then order from a store */}
      {showDraft && (
        <DraftOrderModal
          job={job}
          snapshot={snapshot}
          onClose={() => setShowDraft(false)}
          onOrderMaterials={() => {
            setShowDraft(false);
            setShowPicker(true);
          }}
        />
      )}
    </div>
  );
}

function LineItemRow({ item }: { item: ResolvedWoli }) {
  const surfaces = (item.raw.surfaces ?? "").split(";").filter(Boolean);
  const slots: Array<{ label: string; surface: string; color: SnapshotPaintColor | null; finish: string | null }> = [
    { label: "Walls", surface: "Walls", color: item.wall, finish: item.raw.finishWall },
    { label: "Ceiling", surface: "Ceiling", color: item.ceiling, finish: item.raw.finishCeiling },
    { label: "Trim", surface: "Trim", color: item.trim, finish: item.raw.finishTrim },
    { label: "Floor", surface: "Floor", color: item.floor, finish: item.raw.finishFloor },
    { label: "Other", surface: "Other", color: item.other, finish: item.raw.finishOther },
  ].filter((s) => surfaces.includes(s.surface) || s.color);

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-ppp-charcoal text-sm">
              {item.raw.areaLabel?.trim() || "Area"}
            </span>
            {item.raw.changeOrderRelated && (
              <Pill tone="orange">Change order</Pill>
            )}
          </div>
          <div className="text-[11px] text-ppp-charcoal-500 flex flex-wrap gap-x-2 gap-y-0.5">
            {item.raw.productFamily && <span>{item.raw.productFamily}</span>}
            {item.raw.numCoats > 0 && <span>{item.raw.numCoats}-coat</span>}
            {item.raw.primer && <span>Primer: {item.raw.primer}</span>}
            {item.raw.prepLevel && <span>Prep: {item.raw.prepLevel}</span>}
            {item.raw.sqFootage > 0 && <span>{item.raw.sqFootage.toLocaleString()} sq ft</span>}
            {item.raw.wallSurfaceArea > 0 && item.raw.sqFootage === 0 && (
              <span>{item.raw.wallSurfaceArea.toLocaleString()} sq ft wall</span>
            )}
          </div>
        </div>
      </div>

      {/* Color chips per surface */}
      {slots.length > 0 && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {slots.map((s, i) => (
            <ColorChip
              key={i}
              surface={s.label}
              color={s.color}
              finish={s.finish}
            />
          ))}
        </div>
      )}

      {item.raw.colorNotes && (
        <div className="mt-2.5 text-[11px] text-ppp-charcoal-500 italic">
          Notes: {item.raw.colorNotes}
        </div>
      )}
    </li>
  );
}

function ColorChip({
  surface,
  color,
  finish,
}: {
  surface: string;
  color: SnapshotPaintColor | null;
  finish: string | null;
}) {
  // Strict hex validation — only #RGB, #RRGGBB, #RRGGBBAA shapes render.
  // PPP's HexValue__c is mostly null on production data so most chips hit
  // the neutral-gray + code-badge fallback path.
  const validHex =
    color?.hexValue && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color.hexValue);
  return (
    <div className="flex items-center gap-2 text-[11px] rounded-lg border border-ppp-charcoal-100 bg-[var(--color-surface-muted)] px-2.5 py-1.5">
      <div
        className="h-5 w-5 rounded border border-ppp-charcoal-100 shrink-0"
        style={{
          backgroundColor: validHex
            ? color!.hexValue!
            : color
              ? "var(--color-ppp-charcoal-100, #e5e7eb)"
              : "transparent",
        }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-condensed text-[10px] uppercase tracking-wider text-ppp-charcoal-500">
          {surface}
        </div>
        <div className="font-medium text-ppp-charcoal truncate">
          {color ? color.name : "—"}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-ppp-charcoal-500 mt-0.5">
          {/* Fallback for missing hex: show the SKU code as a mono badge so
              the rep has SOMETHING actionable to verify against the can. */}
          {color?.code && !validHex && (
            <span className="font-mono px-1 py-px rounded bg-ppp-charcoal-100/70 text-ppp-charcoal">
              {color.code}
            </span>
          )}
          {finish && <span className="truncate">{finish}</span>}
        </div>
      </div>
    </div>
  );
}

function DraftOrderModal({
  job,
  snapshot,
  onClose,
  onOrderMaterials,
}: {
  job: OpenWorkOrderForMaterials;
  snapshot: NonNullable<LiveDashboardBundle["snapshot"]>;
  onClose: () => void;
  /** Proceed to order — opens the store picker (PPP orders from stores). */
  onOrderMaterials: () => void;
}) {
  // Esc key closes the modal — keyboard a11y for the rest of Phase 2.
  useEscClose(onClose);

  // Aggregate by brand × color × surface for the read-only color preview
  const groups = useMemo(() => {
    const byMfg = new Map<
      string,
      { name: string; supplierAccountId: string | null; colors: Map<string, { color: SnapshotPaintColor; rooms: string[] }> }
    >();
    for (const li of job.lineItems) {
      for (const slot of [li.wall, li.ceiling, li.trim, li.other, li.floor]) {
        if (!slot) continue;
        const mfgId = slot.manufacturerId ?? "unknown";
        let bucket = byMfg.get(mfgId);
        if (!bucket) {
          bucket = {
            name: getSupplierName(snapshot, mfgId === "unknown" ? null : mfgId),
            supplierAccountId: mfgId === "unknown" ? null : mfgId,
            colors: new Map(),
          };
          byMfg.set(mfgId, bucket);
        }
        let entry = bucket.colors.get(slot.id);
        if (!entry) {
          entry = { color: slot, rooms: [] };
          bucket.colors.set(slot.id, entry);
        }
        const room = li.raw.areaLabel?.trim() || "Area";
        if (!entry.rooms.includes(room)) entry.rooms.push(room);
      }
    }
    return Array.from(byMfg.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [job, snapshot]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-ppp-navy/40 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 w-full sm:max-w-3xl max-h-[92vh] bg-white border border-ppp-charcoal-100 rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-ppp-charcoal/20 overflow-hidden flex flex-col animate-fade-up">
        <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-ppp-navy">Draft materials order</h3>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
              {job.wo.accountName ?? "(unknown account)"} · WO {job.wo.workOrderNumber ?? job.wo.id.slice(-6)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 h-9 w-9 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 transition-colors flex items-center justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 overflow-y-auto flex-1">
          {/* LEFT — supplier context + raw line items */}
          <div className="border-b lg:border-b-0 lg:border-r border-ppp-charcoal-100 p-5 space-y-4 bg-[var(--color-surface-muted)]/40">
            <div>
              <div className="text-[11px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500 mb-1">
                Source data (Salesforce)
              </div>
              <h4 className="text-sm font-semibold text-ppp-charcoal">Line items on this WO</h4>
            </div>
            {job.lineItems.map((li) => (
              <div key={li.raw.id} className="text-xs">
                <div className="font-semibold text-ppp-charcoal">{li.raw.areaLabel?.trim() || "Area"}</div>
                <div className="text-ppp-charcoal-500 mt-0.5">
                  {[li.raw.productFamily, li.raw.numCoats ? `${li.raw.numCoats} coats` : null, li.raw.primer]
                    .filter(Boolean)
                    .join(" · ")}
                  {li.raw.sqFootage > 0 ? ` · ${li.raw.sqFootage.toLocaleString()} sq ft` : ""}
                </div>
              </div>
            ))}
          </div>

          {/* RIGHT — the would-be order email/PDF */}
          <div className="p-5 space-y-4">
            <div>
              <div className="text-[11px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500 mb-1">
                Order draft preview
              </div>
              <h4 className="text-sm font-semibold text-ppp-charcoal">Group by supplier → color → rooms</h4>
            </div>
            {groups.map((g) => (
              <div key={g.name} className="border border-ppp-charcoal-100 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-ppp-blue-50 border-b border-ppp-blue-100 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ppp-blue-700 truncate">{g.name}</span>
                  <span className="shrink-0 text-[10px] text-ppp-charcoal-500">{g.colors.size} color{g.colors.size === 1 ? "" : "s"}</span>
                </div>
                <ul className="divide-y divide-ppp-charcoal-100 text-xs">
                  {Array.from(g.colors.values()).map(({ color, rooms }) => (
                    <li key={color.id} className="px-3 py-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-ppp-charcoal">{color.name}</div>
                        {color.code && (
                          <div className="text-[10px] text-ppp-charcoal-500 font-mono">{color.code}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0 text-[11px] text-ppp-charcoal-500">
                        {rooms.slice(0, 3).join(", ")}
                        {rooms.length > 3 && ` +${rooms.length - 3} more`}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 sm:px-6 py-3.5 border-t border-ppp-charcoal-100 bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-[11px] text-ppp-charcoal-500 italic">
            Review the colors, then <strong>Order materials</strong> to pick the store you&apos;re buying from.
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onOrderMaterials}
              className="px-3.5 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors shadow-sm shadow-ppp-blue/30"
            >
              Order materials →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DebugStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-ppp-charcoal-500 text-[10px]">{label}</div>
      <div className="font-mono text-ppp-charcoal font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "blue" | "navy" | "orange" | "green";
}) {
  const tone =
    accent === "blue"
      ? "text-ppp-blue-700"
      : accent === "navy"
        ? "text-ppp-navy"
        : accent === "orange"
          ? "text-ppp-orange-700"
          : "text-ppp-green-700";
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
      <div className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`mt-1 font-condensed text-2xl sm:text-3xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}

/**
 * Customer-form lifecycle badge rendered on every WO card in the left rail.
 * Tiny, status-coded chip that lets the rep/admin scan the column at a
 * glance: green = customer picked colors (ready to order materials), blue =
 * customer opened the email, charcoal = email sent (waiting), orange = the
 * token expired so admin should resend, no chip = no form sent yet.
 *
 * Renders nothing when status === "none" so cards without a form stay clean.
 */
function FormStatusBadge({ status }: { status: FormStatus | undefined }) {
  if (!status || status.status === "none") return null;

  const config: Record<Exclude<FormStatus["status"], "none">, { label: string; cls: string; title: string }> = {
    submitted: {
      label: "✓ Submitted",
      cls: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100",
      title: "Customer submitted colors — ready to order materials",
    },
    opened: {
      label: "👁 Opened",
      cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100",
      title: "Customer opened the form but hasn't submitted yet",
    },
    sent: {
      label: "📨 Sent",
      cls: "bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100",
      title: "Email delivered — waiting on customer",
    },
    expired: {
      label: "⏳ Expired",
      cls: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100",
      title: "Token expired — resend the form to get fresh access",
    },
  };
  const c = config[status.status];
  // Tooltip-rich span (title attribute) — gives admins context on hover
  // without crowding the rail layout. Inline so the row stays single-line.
  return (
    <span
      title={c.title}
      className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "orange" }) {
  const cls =
    tone === "orange"
      ? "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100"
      : "bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {children}
    </span>
  );
}

/* ─── Send Color Form button (Phase 2 — Customer Color Form trigger) ─── */

function SendColorFormButton({
  workOrderId,
  accountName,
  defaultEmail,
}: {
  workOrderId: string;
  accountName: string | null;
  /** Customer email from Account.PersonEmail (pre-fills the input).
   *  Null when SF returned no email — admin must type, and we'll write
   *  the typed value back to SF in a future enhancement. */
  defaultEmail?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [customerEmail, setCustomerEmail] = useState(defaultEmail ?? "");
  const [customerName, setCustomerName] = useState(accountName ?? "");
  const [sending, setSending] = useState(false);
  // When the snapshot didn't carry the email (customer not in the top-5k, or a
  // name mismatch), look it up DIRECTLY from Salesforce by the WO on open so
  // the worker never has to type it. Only fetches once, and only if still blank.
  const [lookingUpEmail, setLookingUpEmail] = useState(false);
  const emailLookedUp = useRef(false);
  useEffect(() => {
    if (!open || emailLookedUp.current || customerEmail.trim()) return;
    emailLookedUp.current = true;
    let cancelled = false;
    setLookingUpEmail(true);
    (async () => {
      try {
        const res = await fetch(`/api/admin/customer-form/wo-email?workOrderId=${encodeURIComponent(workOrderId)}`);
        const data = await res.json();
        if (!cancelled && res.ok && data.ok) {
          if (data.email) setCustomerEmail((cur) => cur.trim() || data.email);
          if (data.customerName) setCustomerName((cur) => cur.trim() || data.customerName);
        }
      } catch {
        // soft — worker can still type
      } finally {
        if (!cancelled) setLookingUpEmail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, customerEmail, workOrderId]);
  // Synchronous double-fire guard. The create endpoint has no idempotency —
  // each call mints a NEW token + sends a NEW email — so two rapid clicks
  // (React batches setSending) would create two live links for one WO. The ref
  // updates synchronously, catching the second click before state commits.
  const sendInFlight = useRef(false);
  const [result, setResult] = useState<
    | null
    | { ok: true; formUrl: string; resendId: string }
    | { ok: false; error: string }
  >(null);

  // Esc closes the send-form modal. Not while a send is in flight — admin
  // shouldn't accidentally dismiss right as the email is going out.
  useEscClose(() => { if (open) setOpen(false); }, {
    enabled: open,
    allowDuring: !sending,
  });

  const reset = () => {
    setResult(null);
    setSending(false);
    setOpen(false);
  };

  const send = async () => {
    if (!customerEmail.trim()) return;
    if (sendInFlight.current || sending) return;
    sendInFlight.current = true;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/customer-form/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workOrderId,
          customerEmail: customerEmail.trim(),
          customerName: customerName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setResult({ ok: false, error: data.message ?? data.error ?? `HTTP ${res.status}` });
      } else {
        setResult({ ok: true, formUrl: data.formUrl, resendId: data.resendMessageId });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setResult({ ok: false, error: m });
    } finally {
      setSending(false);
      sendInFlight.current = false;
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-ppp-blue text-white text-sm font-medium hover:bg-ppp-blue-600 transition-colors shadow-sm shadow-ppp-blue/30"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 4h16v16H4z M22 6l-10 7L2 6" />
        </svg>
        Send Color Form
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            className="absolute inset-0 bg-ppp-navy/40 backdrop-blur-sm animate-fade-in"
            onClick={() => !sending && reset()}
            aria-hidden
          />
          <div className="relative z-10 w-full sm:max-w-md bg-white border border-ppp-charcoal-100 rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-ppp-charcoal/20 overflow-hidden animate-fade-up">
            <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100">
              <h3 className="text-base font-bold text-ppp-navy">Send Color Form</h3>
              <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                Email a link to the customer so they can pick their paint colors.
              </p>
            </div>

            {!result && (
              <div className="p-5 sm:p-6 space-y-4">
                <div>
                  <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                    Customer email
                  </label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    placeholder={lookingUpEmail ? "Looking up from Salesforce…" : "customer@example.com"}
                    className="w-full px-3 py-2.5 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                  />
                  {lookingUpEmail && (
                    <p className="text-[11px] text-ppp-charcoal-500 mt-1">Looking up the customer&apos;s email from Salesforce…</p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                    Customer name (optional)
                  </label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder={accountName ?? "Customer or company name"}
                    className="w-full px-3 py-2.5 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                  />
                </div>
                <div className="text-[11px] text-ppp-charcoal-500 italic">
                  Link expires 24 hours before the job&apos;s scheduled start (up to 30 days out). Customer can&apos;t see it&apos;s from PPP staff.
                </div>
              </div>
            )}

            {result?.ok === true && (
              <div className="p-5 sm:p-6 space-y-3 text-sm">
                <div className="flex items-center gap-2 text-ppp-green-700 font-semibold">
                  <span>✓</span> Email sent to {customerEmail}
                </div>
                <div className="text-xs text-ppp-charcoal-500">
                  Resend message id: <span className="font-mono">{result.resendId}</span>
                </div>
                <div className="text-xs text-ppp-charcoal-500 break-all">
                  Form link: <a href={result.formUrl} target="_blank" rel="noopener noreferrer" className="text-ppp-blue hover:underline">{result.formUrl}</a>
                </div>
                <div className="text-[11px] text-ppp-charcoal-500 italic">
                  You can also share this link manually if the customer didn&apos;t get the email.
                </div>
              </div>
            )}

            {result?.ok === false && (
              <div className="p-5 sm:p-6 space-y-3 text-sm">
                <div className="text-ppp-orange-700 font-semibold">Couldn&apos;t send.</div>
                <div className="text-xs text-ppp-charcoal-500">{result.error}</div>
              </div>
            )}

            <div className="px-5 sm:px-6 py-3.5 border-t border-ppp-charcoal-100 bg-white flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={reset}
                disabled={sending}
                className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-60"
              >
                {result ? "Close" : "Cancel"}
              </button>
              {!result && (
                <button
                  type="button"
                  onClick={send}
                  disabled={sending || !customerEmail.trim()}
                  className="px-3.5 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {sending ? "Sending…" : "Send Form"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
