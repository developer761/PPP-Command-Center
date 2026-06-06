"use client";

import { useMemo } from "react";
import { useEscClose } from "@/lib/hooks/use-esc-close";
import {
  getSupplierName,
  type OpenWorkOrderForMaterials,
} from "@/lib/salesforce/materials";
import type { LiveDashboardBundle } from "@/lib/data-source";
import type { SnapshotPaintColor } from "@/lib/salesforce/queries";

/**
 * Read-only color preview ("Preview colors" button on the JobDetail panel).
 * Extracted from materials-view.tsx on 2026-06-06 so the materials page's
 * first-paint bundle no longer pays for this ~210-line modal until the
 * worker actually clicks Preview. Saves ~15KB on initial JS.
 */
export default function DraftOrderModal({
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
  useEscClose(onClose);

  const groups = useMemo(() => {
    const byMfg = new Map<
      string,
      {
        name: string;
        supplierAccountId: string | null;
        colors: Map<string, { color: SnapshotPaintColor; rooms: string[] }>;
      }
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

          <div className="p-5 space-y-4">
            <div>
              <div className="text-[11px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500 mb-1">
                Order draft preview
              </div>
              <h4 className="text-sm font-semibold text-ppp-charcoal">Group by supplier → color → rooms</h4>
              {/* Material Type — the paint product line. Pulled from
                  WorkOrder.MaterialType__c (admin pre-set OR customer's pick
                  via the color form). Yellow chip when not set so admin
                  knows the vendor won't know which BM / SW line to mix. */}
              <div className="mt-2">
                {job.wo.materialType ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ppp-blue-50 border border-ppp-blue-100 text-[10px] font-semibold text-ppp-blue-700">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 3l18 18 M3 21L21 3" />
                    </svg>
                    Paint line: {job.wo.materialType}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ppp-orange-50 border border-ppp-orange-200 text-[10px] font-semibold text-ppp-orange-700">
                    ⚠ Paint line not set — customer or admin needs to pick
                  </span>
                )}
              </div>
            </div>
            {groups.length === 0 ? (
              <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg p-4 text-xs text-ppp-orange-700">
                <strong>No colors picked yet.</strong> The customer hasn&apos;t submitted the color form, or the WOLIs in Salesforce don&apos;t have ColorWall__c / ColorCeiling__c / etc. set. Send the color form (or wait for the customer&apos;s submission) to populate this view.
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.name} className="border border-ppp-charcoal-100 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-ppp-blue-50 border-b border-ppp-blue-100 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ppp-blue-700 truncate">{g.name}</span>
                    <span className="shrink-0 text-[10px] text-ppp-charcoal-500">{g.colors.size} color{g.colors.size === 1 ? "" : "s"}</span>
                  </div>
                  <ul className="divide-y divide-ppp-charcoal-100 text-xs">
                    {Array.from(g.colors.values()).map(({ color, rooms }) => (
                      <li key={color.id} className="px-3 py-2 flex items-start justify-between gap-2">
                        <div className="min-w-0 flex items-start gap-2">
                          <span
                            aria-hidden
                            className="h-5 w-5 mt-0.5 rounded border border-ppp-charcoal-200 shrink-0"
                            style={(() => {
                              const hex = color.hexValue?.trim() ?? "";
                              const valid = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex);
                              if (valid) {
                                const withHash = hex.startsWith("#") ? hex : `#${hex}`;
                                return { backgroundColor: withHash };
                              }
                              return { backgroundImage: "repeating-linear-gradient(45deg, #ddd 0 4px, #fafafa 4px 8px)" };
                            })()}
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-ppp-charcoal">{color.name}</div>
                            {color.code && (
                              <div className="text-[10px] text-ppp-charcoal-500 font-mono">{color.code}</div>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0 text-[11px] text-ppp-charcoal-500">
                          {rooms.slice(0, 3).join(", ")}
                          {rooms.length > 3 && ` +${rooms.length - 3} more`}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
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
