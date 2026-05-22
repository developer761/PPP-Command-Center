"use client";

import { useMemo, useState } from "react";
import PageHeader from "@/components/page-header";
import { fmtMoneyK } from "@/lib/format";
import {
  deriveOpenMaterialsWorkOrders,
  getSupplierName,
  type OpenWorkOrderForMaterials,
  type ResolvedWoli,
} from "@/lib/salesforce/materials";
import type { LiveDashboardBundle } from "@/lib/data-source";
import type { SnapshotPaintColor } from "@/lib/salesforce/queries";

type Props = { bundle: LiveDashboardBundle };

export default function MaterialsView({ bundle }: Props) {
  const { snapshot, viewer } = bundle;
  const repScopedToSelf = viewer?.scope === "my" && !!viewer.effectiveUserId;

  const openJobs = useMemo<OpenWorkOrderForMaterials[]>(
    () => (snapshot ? deriveOpenMaterialsWorkOrders(snapshot) : []),
    [snapshot]
  );

  const [activeWoId, setActiveWoId] = useState<string | null>(null);
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

      {/* Empty state */}
      {openJobs.length === 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-ppp-blue-50 text-ppp-blue flex items-center justify-center text-2xl mb-3">
            🎨
          </div>
          <h3 className="text-base font-semibold text-ppp-navy">No open work orders need materials</h3>
          <p className="text-sm text-ppp-charcoal-500 mt-2 max-w-md mx-auto">
            {repScopedToSelf
              ? "You don't have any open WOs with line items in the current snapshot. Once you book new jobs, paint orders will appear here."
              : "No open WOs with line items in the current snapshot."}
          </p>
        </div>
      )}

      {/* Job list + side panel */}
      {openJobs.length > 0 && (
        <section className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-5">
          <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
              <h3 className="text-sm font-semibold text-ppp-charcoal">Open work orders</h3>
              <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">Soonest jobs first</p>
            </div>
            <ul className="max-h-[640px] overflow-y-auto">
              {openJobs.map((j) => {
                const active = activeWoId === j.wo.id;
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
                          <div className="font-semibold text-ppp-charcoal text-sm truncate">
                            {j.wo.accountName ?? "(unknown account)"}
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
                            <Pill>{j.lineItems.length} rooms</Pill>
                            <Pill>{j.distinctColorCount} colors</Pill>
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
              <JobDetail snapshot={snapshot} job={activeJob} />
            ) : (
              <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center text-sm text-ppp-charcoal-500">
                Pick a work order to see paint colors per room and the supplier breakdown.
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function JobDetail({
  snapshot,
  job,
}: {
  snapshot: NonNullable<LiveDashboardBundle["snapshot"]>;
  job: OpenWorkOrderForMaterials;
}) {
  const [showDraft, setShowDraft] = useState(false);
  const supplierRows = useMemo(() => {
    return Array.from(job.bySupplier.entries())
      .map(([mfgId, count]) => ({
        manufacturerId: mfgId,
        name: getSupplierName(snapshot, mfgId === "unknown" ? null : mfgId),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [job, snapshot]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500">
              Work Order
            </div>
            <h3 className="text-lg font-bold text-ppp-navy">{job.wo.accountName ?? "(unknown account)"}</h3>
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
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowDraft(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-ppp-blue text-white text-sm font-medium hover:bg-ppp-blue-600 transition-colors shadow-sm shadow-ppp-blue/30"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 4h16v16H4z M4 4l8 8 8-8" />
            </svg>
            Draft order
          </button>
          <div className="text-[11px] text-ppp-charcoal-500 self-center italic">
            Review step before send — never auto-sends
          </div>
        </div>
      </div>

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

      {/* Draft preview modal */}
      {showDraft && (
        <DraftOrderModal job={job} snapshot={snapshot} onClose={() => setShowDraft(false)} />
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
  return (
    <div className="flex items-center gap-2 text-[11px] rounded-lg border border-ppp-charcoal-100 bg-[var(--color-surface-muted)] px-2.5 py-1.5">
      <div
        className="h-5 w-5 rounded border border-ppp-charcoal-100 shrink-0"
        style={{
          backgroundColor:
            color?.hexValue && /^#[0-9a-f]{3,8}$/i.test(color.hexValue)
              ? color.hexValue
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
        {finish && <div className="text-[10px] text-ppp-charcoal-500">{finish}</div>}
      </div>
    </div>
  );
}

function DraftOrderModal({
  job,
  snapshot,
  onClose,
}: {
  job: OpenWorkOrderForMaterials;
  snapshot: NonNullable<LiveDashboardBundle["snapshot"]>;
  onClose: () => void;
}) {
  // Aggregate by supplier × color × surface for the draft order body
  const groups = useMemo(() => {
    const byMfg = new Map<
      string,
      { name: string; colors: Map<string, { color: SnapshotPaintColor; rooms: string[] }> }
    >();
    for (const li of job.lineItems) {
      for (const slot of [li.wall, li.ceiling, li.trim, li.other, li.floor]) {
        if (!slot) continue;
        const mfgId = slot.manufacturerId ?? "unknown";
        let bucket = byMfg.get(mfgId);
        if (!bucket) {
          bucket = {
            name: getSupplierName(snapshot, mfgId === "unknown" ? null : mfgId),
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
                <div className="px-3 py-2 bg-ppp-blue-50 border-b border-ppp-blue-100">
                  <span className="text-xs font-semibold text-ppp-blue-700">{g.name}</span>
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
            Send mechanism pending PPP confirmation (email / PDF / API). Once Katie
            confirms, this becomes a real &quot;Review &amp; Send&quot; action with audit log.
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
              disabled
              title="Send mechanism pending PPP confirmation"
              className="px-3.5 py-2 rounded-lg bg-ppp-blue/60 text-white text-sm font-medium cursor-not-allowed"
            >
              Review &amp; Send (pending)
            </button>
          </div>
        </div>
      </div>
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
