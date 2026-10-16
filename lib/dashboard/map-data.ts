import type { SalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * Map points, projected on the server.
 *
 * /dashboard/map measured 35.1MB and 3.2 seconds against production on
 * 2026-10-16. The page already read the THIN snapshot — which is exactly
 * why it is worth stating plainly that thin did not help: thin cut what the
 * SERVER fetches, and the cost here was what the page SENDS. <MapView> is a
 * "use client" component, so React serialized every work order into the
 * HTML so the browser could build GeoJSON out of it.
 *
 * The browser does genuinely need a point per job — that is the map. What
 * it does not need is the whole work-order record behind each one. This
 * projects each plottable job down to coordinates plus the six fields the
 * popup shows, which is the honest floor for this page.
 *
 * `closeDate` rides along so the period dropdown can keep filtering in the
 * browser with no round trip. It is the one field here that is not drawn.
 */
export type MapPoint = {
  id: string;
  lng: number;
  lat: number;
  amount: number;
  account: string;
  status: string;
  rep: string;
  wo: string;
  /** ISO date (yyyy-mm-dd). Drives the client-side period filter. */
  closeDate: string;
};

export type MapData = {
  isSandbox: boolean;
  points: MapPoint[];
};

export function deriveMapData(snapshot: SalesforceSnapshot): MapData {
  const points: MapPoint[] = [];
  for (const w of snapshot.workOrders) {
    if (typeof w.latitude !== "number" || typeof w.longitude !== "number") continue;
    if (w.latitude === 0 || w.longitude === 0) continue;
    // Exclude zero AND negative amounts — credits/refunds shouldn't appear
    // as job markers (they have no physical job site to plot).
    if (w.amount <= 0) continue;
    if (!w.closeDate) continue;
    points.push({
      id: w.id,
      lng: w.longitude,
      lat: w.latitude,
      amount: w.amount,
      account: w.accountName ?? "",
      status: w.status ?? "",
      rep: w.ownerName ?? "",
      wo: w.workOrderNumber ?? "",
      closeDate: w.closeDate,
    });
  }
  return { isSandbox: !!snapshot.isSandbox, points };
}
